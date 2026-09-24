import { rewriteValue, type RewriteCtx, type Role } from '../shared/color';

/** Properties rewritten on inline `style=""` attributes (which beat any stylesheet we can generate). */
const PROPS: ReadonlyArray<readonly [string, Role]> = [
  ['color', 'fg'],
  ['background-color', 'bg'],
  ['background-image', 'bg'],
  ['border-top-color', 'bd'],
  ['border-right-color', 'bd'],
  ['border-bottom-color', 'bd'],
  ['border-left-color', 'bd'],
  ['outline-color', 'bd'],
  ['box-shadow', 'bg'],
  ['fill', 'fg'],
  ['stroke', 'fg'],
];
const SVG_ATTRS = new Set(['fill', 'stroke']);
const SELECTOR = '[style],[fill],[stroke]';

interface Rec {
  orig: string;
  pri: string;
  /** The value as read back from the CSSOM after we wrote it — used to recognise our own writes. */
  applied: string;
}

/**
 * Rewrites colours set through inline styles and SVG presentation attributes, and undoes every change on stop().
 * Originals are tracked per element/property so page scripts that later write the same property are honoured.
 */
export class InlineProcessor {
  private records = new WeakMap<Element, Map<string, Rec>>();
  private touched = new Set<WeakRef<Element>>();
  private queue = new Set<Element>();
  private observer: MutationObserver | null = null;
  private timer = 0;

  constructor(private ctx: RewriteCtx) {}

  start(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') this.queue.add(m.target as Element);
        else for (const n of m.addedNodes) if (n.nodeType === 1) this.enqueueTree(n as Element);
      }
      this.flushSoon();
    });
    this.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'fill', 'stroke'],
    });
    this.rescan();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.queue.clear();
    this.restoreAll();
  }

  setContext(ctx: RewriteCtx): void {
    this.ctx = ctx;
    if (!this.observer) return;
    this.restoreAll();
    this.rescan();
  }

  /** Runs `fn` with all inline rewrites undone, then re-applies them. */
  suspend<T>(fn: () => T): T {
    this.restoreAll();
    try {
      return fn();
    } finally {
      if (this.observer) this.rescan();
    }
  }

  private rescan(): void {
    if (document.documentElement) this.enqueueTree(document.documentElement);
    this.flushSoon();
  }

  private enqueueTree(root: Element): void {
    if (root.matches(SELECTOR)) this.queue.add(root);
    for (const el of root.querySelectorAll(SELECTOR)) this.queue.add(el);
  }

  private flushSoon(): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      const batch = [...this.queue];
      this.queue.clear();
      for (const el of batch) if (el.isConnected) this.process(el);
    }, 30);
  }

  private process(el: Element): void {
    const st = (el as HTMLElement).style;
    if (!st) return;
    let rec = this.records.get(el);

    for (const [prop, role] of PROPS) {
      let cur = st.getPropertyValue(prop);
      const fromAttr = !cur && SVG_ATTRS.has(prop);
      if (fromAttr) cur = el.getAttribute(prop) ?? '';
      if (!cur) continue;

      const known = rec?.get(prop);
      if (known && known.applied === cur) continue; // our own write

      const next = rewriteValue(cur, role, this.ctx);
      if (next === cur) {
        rec?.delete(prop);
        continue;
      }
      const pri = fromAttr ? '' : st.getPropertyPriority(prop);
      st.setProperty(prop, next, pri);
      if (!rec) {
        rec = new Map();
        this.records.set(el, rec);
        this.touched.add(new WeakRef(el));
      }
      rec.set(prop, { orig: fromAttr ? '' : cur, pri, applied: st.getPropertyValue(prop) });
    }
  }

  private restoreAll(): void {
    for (const ref of this.touched) {
      const el = ref.deref();
      const rec = el && this.records.get(el);
      if (!el || !rec) continue;
      const st = (el as HTMLElement).style;
      for (const [prop, r] of rec) {
        if (st.getPropertyValue(prop) !== r.applied) continue; // the page changed it since; leave it
        if (r.orig) st.setProperty(prop, r.orig, r.pri);
        else st.removeProperty(prop);
      }
      this.records.delete(el);
    }
    this.touched.clear();
  }
}
