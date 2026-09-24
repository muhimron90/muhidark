import {
  ALIAS_RE,
  deriveVarDecls,
  hslToRgb,
  parseColor,
  rewriteValue,
  themeFromSettings,
  toCss,
  type RewriteCtx,
  type Role,
  type Theme,
} from "../shared/color";
import type { FetchCssResponse, WorkerRequest } from "../shared/messages";
import type { Settings } from "../shared/types";
import type { Engine } from "./engine";
import { StyleInjector } from "./injector";
import { InlineProcessor } from "./inline";

/*
 * Dynamic mode: read the page's own CSS, rewrite every colour declaration, and inject the result as one override
 * stylesheet that sits after all author styles.
 *
 * Because each override keeps its original selector, at-rule wrappers (@media/@supports/@layer/@container) and
 * relative position in the cascade, specificity and ordering behave as they did in the source. `!important` is only
 * emitted when the source declaration had it.
 */

type Decl = readonly [prop: string, value: string, important: boolean];
type RuleNode =
  | { k: "style"; sel: string; decls: Decl[]; kids: RuleNode[] }
  | { k: "at"; head: string; kids: RuleNode[] };

interface VarInfo {
  colors: string[];
  aliases: Array<[name: string, target: string]>;
}
interface Chunk {
  nodes: RuleNode[];
  vars: VarInfo;
  /** Cache key (theme + known-variable count) under which `text` was generated. */
  key: string;
  text: string;
}
interface Entry {
  sheet: CSSStyleSheet;
  wrap: string[];
  /** Number of top-level rules already extracted. Sheets that grow (CSS-in-JS insertRule) are extracted incrementally. */
  count: number;
  chunks: Chunk[];
  /** Constructed copy of a cross-origin sheet, fetched through the service worker. */
  parsed: CSSStyleSheet | null;
  fetch: "none" | "pending" | "done" | "failed";
}

const PROP_ROLE: Readonly<Record<string, Role>> = {
  color: "fg",
  "caret-color": "fg",
  "text-decoration-color": "fg",
  "text-emphasis-color": "fg",
  "-webkit-text-fill-color": "fg",
  "-webkit-text-stroke-color": "fg",
  fill: "fg",
  stroke: "fg",
  "background-color": "bg",
  "background-image": "bg",
  "box-shadow": "bg",
  "text-shadow": "bg",
  "scrollbar-color": "bg",
  "border-color": "bd",
  "border-top-color": "bd",
  "border-right-color": "bd",
  "border-bottom-color": "bd",
  "border-left-color": "bd",
  "border-block-start-color": "bd",
  "border-block-end-color": "bd",
  "border-inline-start-color": "bd",
  "border-inline-end-color": "bd",
  "outline-color": "bd",
  "column-rule-color": "bd",
};
const WATCHED = Object.keys(PROP_ROLE);

// `background: var(--x)` makes every longhand read back as "" — recover the colour from the shorthand instead.
const SHORTHAND_COLOR: ReadonlyArray<readonly [string, string]> = [
  ["background", "background-color"],
  ["border", "border-color"],
  ["border-top", "border-top-color"],
  ["border-right", "border-right-color"],
  ["border-bottom", "border-bottom-color"],
  ["border-left", "border-left-color"],
  ["outline", "outline-color"],
];
const VAR_ANY = /var\((?:[^()]|\([^()]*\))*\)/gi;

const isCustom = (p: string): boolean =>
  p.charCodeAt(0) === 45 && p.charCodeAt(1) === 45;

/** Makes url() absolute so declarations copied out of a fetched sheet keep working from the document's base URL. */
function absolutize(value: string, base: string): string {
  return value.replace(
    /url\(\s*(["']?)([^"')]*)\1\s*\)/gi,
    (m, _q: string, u: string) => {
      try {
        return `url("${new URL(u, base).href}")`;
      } catch {
        return m;
      }
    },
  );
}

function declsOf(
  st: CSSStyleDeclaration,
  vars: VarInfo,
  base: string | null,
): Decl[] {
  const fix = (v: string): string => (base ? absolutize(v, base) : v);
  const out: Decl[] = [];

  for (const prop of WATCHED) {
    const v = st.getPropertyValue(prop);
    if (v)
      out.push([prop, fix(v), st.getPropertyPriority(prop) === "important"]);
  }

  for (const [shorthand, target] of SHORTHAND_COLOR) {
    const v = st.getPropertyValue(shorthand);
    if (!v || !/var\(/i.test(v) || st.getPropertyValue(target)) continue;
    const imp = st.getPropertyPriority(shorthand) === "important";
    for (const m of v.matchAll(VAR_ANY)) out.push([target, m[0], imp]);
  }

  for (let i = 0; i < st.length; i++) {
    const p = st[i];
    if (!isCustom(p)) continue;
    const val = st.getPropertyValue(p).trim();
    if (!val) continue;
    out.push([p, val, false]);
    if (parseColor(val)) vars.colors.push(p);
    else {
      const a = ALIAS_RE.exec(val);
      if (a) vars.aliases.push([p, a[1]]);
    }
  }
  return out;
}

function extract(
  rules: CSSRuleList,
  from: number,
  to: number,
  vars: VarInfo,
  base: string | null,
): RuleNode[] {
  const out: RuleNode[] = [];
  const group = (head: string, rule: CSSGroupingRule): void => {
    const kids = extract(rule.cssRules, 0, rule.cssRules.length, vars, base);
    if (kids.length) out.push({ k: "at", head, kids });
  };

  for (let i = from; i < to; i++) {
    const rule = rules[i];
    if (rule instanceof CSSStyleRule) {
      const decls = declsOf(rule.style, vars, base);
      const n = rule.cssRules?.length ?? 0; // native CSS nesting
      const kids = n ? extract(rule.cssRules, 0, n, vars, base) : [];
      if (decls.length || kids.length)
        out.push({ k: "style", sel: rule.selectorText, decls, kids });
    } else if (rule instanceof CSSMediaRule) {
      const cond = rule.media.mediaText.trim();
      if (cond !== "print") group(`@media ${cond}`, rule);
    } else if (rule instanceof CSSSupportsRule) {
      group(`@supports ${rule.conditionText}`, rule);
    } else if (rule instanceof CSSGroupingRule) {
      // @layer blocks and @container: keep the wrapper so layer/container semantics survive.
      const text = rule.cssText;
      const head = text.slice(0, text.indexOf("{")).trim();
      if (head.startsWith("@layer") || head.startsWith("@container"))
        group(head, rule);
    }
  }
  return out;
}

function emitDecls(decls: Decl[], ctx: RewriteCtx): string {
  let s = "";
  for (const [prop, value, important] of decls) {
    if (isCustom(prop)) {
      for (const d of deriveVarDecls(prop, value, ctx)) s += `${d};`;
      continue;
    }
    // Unchanged declarations are copied too so their cascade order relative to rewritten ones is preserved.
    s += `${prop}:${rewriteValue(value, PROP_ROLE[prop], ctx)}${important ? " !important" : ""};`;
  }
  return s;
}

function emit(nodes: RuleNode[], ctx: RewriteCtx): string {
  let s = "";
  for (const n of nodes) {
    if (n.k === "at") {
      const inner = emit(n.kids, ctx);
      if (inner) s += `${n.head}{${inner}}`;
    } else {
      const body = emitDecls(n.decls, ctx) + emit(n.kids, ctx);
      if (body) s += `${n.sel}{${body}}`;
    }
  }
  return s;
}

function knownColorVars(entries: Entry[]): Set<string> {
  const known = new Set<string>();
  const aliases: Array<[string, string]> = [];
  for (const e of entries) {
    for (const c of e.chunks) {
      for (const n of c.vars.colors) known.add(n);
      for (const a of c.vars.aliases) aliases.push(a);
    }
  }
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [name, target] of aliases) {
      if (!known.has(name) && known.has(target)) {
        known.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return known;
}

const mediaWrap = (mediaText: string | undefined): string[] => {
  const m = mediaText?.trim();
  return m && m !== "all" ? [`@media ${m}`] : [];
};

export class DynamicEngine implements Engine {
  private readonly inj = new StyleInjector();
  private readonly inline = new InlineProcessor({
    theme: { bgBase: 0.09, fgTop: 0.9 },
    colorVars: new Set(),
  });
  private entries = new Map<CSSStyleSheet, Entry>();
  private theme: Theme = { bgBase: 0.09, fgTop: 0.9 };
  private themeKey = "";
  private baseCss = "";
  private running = false;
  private timer = 0;
  private poll = 0;
  private sig = -1;
  private mo: MutationObserver | null = null;

  start(s: Settings): void {
    this.running = true;
    this.configure(s);
    this.inj.set(this.baseCss); // instant dark canvas while the real work happens
    this.inline.setContext({ theme: this.theme, colorVars: new Set() });
    this.inline.start();

    this.mo = new MutationObserver((muts) => {
      if (muts.some((m) => this.isStyleMutation(m))) this.schedule(80);
    });
    this.mo.observe(document, { childList: true, subtree: true });
    document.addEventListener("load", this.onResourceLoad, true);
    document.addEventListener("DOMContentLoaded", this.onReady);
    // CSS-in-JS libraries call insertRule(), which fires no DOM event: poll cheaply for rule-count changes.
    this.poll = window.setInterval(() => {
      if (!document.hidden && this.signature() !== this.sig) this.schedule(0);
    }, 1500);
    this.schedule(0);
  }

  update(s: Settings): void {
    this.configure(s);
    this.inline.setContext({ theme: this.theme, colorVars: new Set() });
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    window.clearTimeout(this.timer);
    window.clearInterval(this.poll);
    this.timer = this.poll = 0;
    this.mo?.disconnect();
    this.mo = null;
    document.removeEventListener("load", this.onResourceLoad, true);
    document.removeEventListener("DOMContentLoaded", this.onReady);
    this.inline.stop();
    this.inj.remove();
    this.entries.clear();
  }

  probe<T>(fn: () => T): T {
    return this.inline.suspend(() => this.inj.detached(fn));
  }

  // --- internals

  private readonly onResourceLoad = (e: Event): void => {
    if (e.target instanceof HTMLLinkElement) this.schedule(0);
  };
  private readonly onReady = (): void => this.schedule(0);

  private configure(s: Settings): void {
    this.theme = themeFromSettings(s);
    this.themeKey = `${this.theme.bgBase.toFixed(3)}|${this.theme.fgTop.toFixed(3)}`;
    const bg = toCss(hslToRgb({ h: 200, s: 0.07, l: this.theme.bgBase, a: 1 }));
    const fx = [
      s.sepia ? `sepia(${s.sepia / 100})` : "",
      s.grayscale ? `grayscale(${s.grayscale / 100})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    // `html` (specificity 0,0,1) so the page's own — rewritten — html/body backgrounds, emitted later, take over.
    this.baseCss = `html{background-color:${bg}}:root{color-scheme:dark${fx ? `;filter:${fx}` : ""}}`;
  }

  private isStyleMutation(m: MutationRecord): boolean {
    if (m.target === this.inj.element) return false;
    if (m.target.nodeName === "STYLE") return true;
    for (const n of m.addedNodes)
      if (n.nodeName === "STYLE" || n.nodeName === "LINK") return true;
    for (const n of m.removedNodes)
      if (n.nodeName === "STYLE" || n.nodeName === "LINK") return true;
    return false;
  }

  private schedule(delay: number): void {
    if (this.timer || !this.running) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      try {
        this.regen();
      } catch (err) {
        console.debug("[MuhiDark] regen failed", err);
      }
    }, delay);
  }

  private signature(): number {
    let n =
      document.styleSheets.length * 1_000_003 +
      document.adoptedStyleSheets.length;
    for (const s of document.styleSheets) {
      try {
        n += s.cssRules.length;
      } catch {
        /* cross-origin: handled through the fetch path */
      }
    }
    for (const s of document.adoptedStyleSheets) n += s.cssRules.length;
    return n;
  }

  private collect(): Entry[] {
    const out: Entry[] = [];
    const seen = new Set<CSSStyleSheet>();
    for (const sheet of document.styleSheets)
      this.visit(sheet, [], out, seen, 0);
    for (const sheet of document.adoptedStyleSheets)
      this.visit(sheet, [], out, seen, 0);
    return out;
  }

  private visit(
    sheet: CSSStyleSheet,
    outer: string[],
    out: Entry[],
    seen: Set<CSSStyleSheet>,
    depth: number,
  ): void {
    if (depth > 5 || seen.has(sheet) || sheet.disabled || this.inj.owns(sheet))
      return;
    seen.add(sheet);
    const media = sheet.media?.mediaText;
    if (media?.trim() === "print") return;

    let entry = this.entries.get(sheet);
    if (!entry) {
      entry = {
        sheet,
        wrap: [],
        count: 0,
        chunks: [],
        parsed: null,
        fetch: "none",
      };
      this.entries.set(sheet, entry);
    }
    entry.wrap = [...outer, ...mediaWrap(media)];

    const rules = this.rulesOf(entry);
    if (rules) {
      // @import rules always come first; their sheets precede the importing sheet in the cascade.
      for (let i = 0; i < rules.length && i < 64; i++) {
        const r = rules[i];
        if (r instanceof CSSImportRule) {
          const layer = (r as CSSImportRule & { layerName?: string | null })
            .layerName;
          const wrap = [
            ...entry.wrap,
            ...(layer ? [`@layer ${layer}`] : []),
            ...mediaWrap(r.media?.mediaText),
          ];
          if (r.styleSheet)
            this.visit(r.styleSheet, wrap, out, seen, depth + 1);
        } else if (r instanceof CSSStyleRule) break;
      }
    }
    out.push(entry);
  }

  private rulesOf(entry: Entry): CSSRuleList | null {
    if (entry.parsed) return entry.parsed.cssRules;
    try {
      return entry.sheet.cssRules;
    } catch {
      this.fetchSheet(entry);
      return null;
    }
  }

  /** Cross-origin sheets are unreadable from the page; the service worker can fetch them (text/css only). */
  private fetchSheet(entry: Entry): void {
    const href = entry.sheet.href;
    if (entry.fetch !== "none" || !href || !/^https?:/i.test(href)) return;
    entry.fetch = "pending";
    const msg: WorkerRequest = { type: "fetch-css", url: href };
    chrome.runtime
      .sendMessage(msg)
      .then((res: FetchCssResponse | undefined) => {
        if (!this.running) return;
        if (!res?.ok) {
          entry.fetch = "failed";
          return;
        }
        const copy = new CSSStyleSheet();
        copy.replaceSync(res.text);
        entry.parsed = copy;
        entry.count = 0;
        entry.chunks = [];
        entry.fetch = "done";
        this.schedule(0);
      })
      .catch(() => {
        entry.fetch = "failed";
      });
  }

  private refresh(entry: Entry): void {
    const rules = this.rulesOf(entry);
    if (!rules) return;
    const n = rules.length;
    if (n < entry.count) {
      entry.chunks = [];
      entry.count = 0;
    }
    if (n > entry.count) {
      const vars: VarInfo = { colors: [], aliases: [] };
      const base = entry.parsed ? entry.sheet.href : null;
      const nodes = extract(rules, entry.count, n, vars, base);
      entry.chunks.push({ nodes, vars, key: "", text: "" });
      entry.count = n;
    }
  }

  private regen(): void {
    if (!this.running) return;
    const entries = this.collect();
    for (const e of entries) this.refresh(e);

    const known = knownColorVars(entries);
    const ctx: RewriteCtx = { theme: this.theme, colorVars: known };
    const key = `${this.themeKey}|${known.size}`;

    let css = this.baseCss;
    for (const e of entries) {
      let text = "";
      for (const c of e.chunks) {
        if (c.key !== key) {
          c.text = emit(c.nodes, ctx);
          c.key = key;
        }
        text += c.text;
      }
      if (text)
        css += e.wrap.reduceRight((acc, head) => `${head}{${acc}}`, text);
    }

    const live = new Set(entries.map((e) => e.sheet));
    for (const s of this.entries.keys())
      if (!live.has(s)) this.entries.delete(s);

    this.inj.set(css);
    this.sig = this.signature();
  }
}
