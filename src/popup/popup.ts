import { queryPageState, toggleSiteForTab } from "../shared/actions";
import {
  parseColor,
  themeFromSettings,
  toCss,
  transformBackground,
  transformBorder,
  transformForeground,
} from "../shared/color";
import { filterChains } from "../shared/filters";
import type { StateResponse } from "../shared/messages";
import { hostKey, parseSupportedUrl, resolveSite } from "../shared/site";
import { loadSettings, updateSettings, watchSettings } from "../shared/store";
import {
  DEFAULT_SETTINGS,
  LIMITS,
  type Mode,
  type PageState,
  type Settings,
} from "../shared/types";

type View = PageState | "unsupported" | "stale";
type Look = "brightness" | "contrast" | "sepia" | "grayscale";

interface Model {
  settings: Settings;
  tabId: number | null;
  url: URL | null;
  page: StateResponse | null;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup: missing #${id}`);
  return el as T;
};

const SLIDERS: ReadonlyArray<{ key: Look; label: string }> = [
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "sepia", label: "Sepia" },
  { key: "grayscale", label: "Grayscale" },
];

const MODE_NOTES: Record<Mode, string> = {
  filter: "Inverts the page and keeps photos. Fast.",
  dynamic: "Recolors each site. Truer look, more memory.",
};

// --- Model

const model: Model = {
  settings: { ...DEFAULT_SETTINGS, siteRules: {} },
  tabId: null,
  url: null,
  page: null,
};
/** Values the user changed that haven't reached storage yet; they win over incoming storage events. */
let pending: Partial<Pick<Settings, Look>> = {};
let persistTimer: number | undefined;
let refreshTimer: number | undefined;

/** What the page is (or is about to be) doing. Computed locally so toggles feel instant. */
function viewOf(m: Model): View {
  if (!m.url) return "unsupported";
  if (!m.page) return "stale";
  if (!m.settings.enabled) return "off";
  const res = resolveSite(hostKey(m.url), m.settings);
  if (!res.enabled) return "off";
  if (m.page.state === "native-dark" && m.settings.skipNativeDark && !res.force)
    return "native-dark";
  return "active";
}

async function refreshPage(): Promise<void> {
  if (model.tabId === null || !model.url) return;
  model.page = await queryPageState(model.tabId);
  render();
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  // Native-dark detection settles after the engine has run once, so look again a beat later.
  refreshTimer = window.setTimeout(() => void refreshPage(), 180);
}

function persist(): void {
  clearTimeout(persistTimer);
  const batch = pending;
  pending = {};
  if (Object.keys(batch).length)
    void updateSettings((s) => void Object.assign(s, batch));
}

function setLook(key: Look, value: number): void {
  model.settings = { ...model.settings, [key]: value };
  pending[key] = value;
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persist, 80);
  render();
}

// Preview: a small page drawn twice. The dark copy is revealed with a wipe, and is coloured by the
// same code the engines use, so what you see is what the page will get.

const PV = {
  page: { bg: "#ffffff", fg: "#1c1e21" },
  nav: { bg: "#f4f5f7", fg: "#1c1e21", bd: "#dadde1" },
  muted: { fg: "#5a5f6a" },
  link: { fg: "#1a5fd0" },
  accent: { bg: "#1a5fd0", fg: "#ffffff" },
} as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** Tags an element with the colours it has on the light page; `paint` reads them back. */
function tag(
  node: HTMLElement,
  c: { bg?: string; fg?: string; bd?: string },
): HTMLElement {
  if (c.bg) node.dataset.bg = c.bg;
  if (c.fg) node.dataset.fg = c.fg;
  if (c.bd) node.dataset.bd = c.bd;
  return node;
}

function buildPage(dark: boolean): HTMLElement {
  const root = tag(el("div", dark ? "pv pv-dark" : "pv"), PV.page);
  const nav = tag(el("div", "pv-nav"), PV.nav);
  nav.append(
    tag(el("span", "pv-dot"), { bg: PV.accent.bg }),
    document.createTextNode("Nightly"),
  );

  const row = el("div", "pv-row");
  row.append(
    tag(el("span", "", "Read more"), { fg: PV.link.fg }),
    tag(el("span", "pv-btn", "Continue"), PV.accent),
  );
  const copy = el("div", "pv-copy");
  copy.append(
    tag(el("b", "", "Reading at night"), { fg: PV.page.fg }),
    tag(el("span", "", "Easy on tired eyes."), { fg: PV.muted.fg }),
    row,
  );

  const img = el("div", "pv-img");
  img.dataset.media = "1";
  const body = el("div", "pv-body");
  body.append(copy, img);
  root.append(nav, body);
  paint(root, null);
  return root;
}

/** Paints one layer: original colours (light copy), filter chains (filter mode) or rewritten colours (dynamic mode). */
function paint(root: HTMLElement, s: Settings | null): void {
  const theme = s ? themeFromSettings(s) : null;
  const dynamic = s?.mode === "dynamic";
  [
    root,
    ...root.querySelectorAll<HTMLElement>("[data-bg],[data-fg],[data-bd]"),
  ].forEach((node) => {
    const { bg, fg, bd } = node.dataset;
    const swap = (
      src: string | undefined,
      fn: typeof transformBackground,
    ): string => {
      if (!src) return "";
      const c = parseColor(src, false);
      return !c ? src : toCss(dynamic && theme ? fn(c, theme) : c);
    };
    node.style.backgroundColor = swap(bg, transformBackground);
    node.style.color = swap(fg, transformForeground);
    node.style.borderColor = swap(bd, transformBorder);
  });
  if (!s) return;
  if (dynamic) {
    const fx = [
      s.sepia ? `sepia(${s.sepia / 100})` : "",
      s.grayscale ? `grayscale(${s.grayscale / 100})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    root.style.filter = fx;
    root
      .querySelectorAll<HTMLElement>("[data-media]")
      .forEach((m) => (m.style.filter = ""));
  } else {
    const { root: rootFx, media } = filterChains(s);
    root.style.filter = rootFx;
    root
      .querySelectorAll<HTMLElement>("[data-media]")
      .forEach((m) => (m.style.filter = media));
  }
}

let darkLayer: HTMLElement;

// --- Render

function copyFor(
  view: View,
  host: string,
): { title: string; status: string; action: string | null } {
  switch (view) {
    case "unsupported":
      return {
        title: "This page",
        status: "MuhiDark can't change this page.",
        action: null,
      };
    case "stale":
      return {
        title: host,
        status: "Reload this tab to apply MuhiDark.",
        action: "Reload tab",
      };
    case "active":
      return {
        title: host,
        status: "Dark on this site.",
        action: "Turn off for this site",
      };
    case "native-dark":
      return {
        title: host,
        status: "Already dark, left alone.",
        action: "Force dark on this site",
      };
    case "off":
      return {
        title: host,
        status: model.settings.enabled
          ? "Off for this site."
          : "Paused everywhere.",
        action: model.settings.enabled
          ? "Turn on for this site"
          : "Resume everywhere",
      };
  }
}

function render(): void {
  const { settings: s, url } = model;
  const view = viewOf(model);
  const host = url ? hostKey(url) : "";
  const copy = copyFor(view, host);

  $("host").textContent = copy.title;
  $("host").title = copy.title;
  $("status").textContent = copy.status;
  $<HTMLInputElement>("master").checked = s.enabled;

  const action = $<HTMLButtonElement>("site");
  action.hidden = copy.action === null;
  if (copy.action) action.textContent = copy.action;
  action.dataset.view = view;

  // The wipe shows the result of the current state; on pages we can't touch it demonstrates the current settings.
  $("stage").dataset.on = String(
    s.enabled &&
      (view === "active" || view === "native-dark" || view === "unsupported"),
  );
  paint(darkLayer, s);

  document
    .querySelectorAll<HTMLInputElement>('input[name="mode"]')
    .forEach((r) => (r.checked = r.value === s.mode));
  $("mode-note").textContent = MODE_NOTES[s.mode];
  $<HTMLInputElement>("skip").checked = s.skipNativeDark;
  $("sliders").closest<HTMLElement>(".look")!.dataset.paused = String(
    !s.enabled,
  );

  for (const { key } of SLIDERS) {
    const input = $<HTMLInputElement>(key);
    const [lo, hi] = LIMITS[key];
    if (document.activeElement !== input) input.value = String(s[key]);
    input.style.setProperty("--pct", `${((s[key] - lo) / (hi - lo)) * 100}%`);
    $(`${key}-out`).textContent = `${s[key]}%`;
  }
}

// --- Wiring

function buildSliders(): void {
  const wrap = $("sliders");
  for (const { key, label } of SLIDERS) {
    const row = el("div", "row");
    const lab = el("label", "", label);
    lab.htmlFor = key;
    const out = el("output", "");
    out.id = `${key}-out`;
    out.htmlFor = key;
    const input = el("input", "");
    input.type = "range";
    input.id = key;
    [input.min, input.max] = LIMITS[key].map(String) as [string, string];
    input.step = "1";
    input.addEventListener("input", () => setLook(key, Number(input.value)));
    row.append(lab, out, input);
    wrap.append(row);
  }
}

function bind(): void {
  $<HTMLInputElement>("master").addEventListener("change", (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    model.settings = { ...model.settings, enabled };
    render();
    void updateSettings((s) => void (s.enabled = enabled));
  });

  $("site").addEventListener("click", async () => {
    const view = viewOf(model);
    if (view === "stale") {
      if (model.tabId !== null) await chrome.tabs.reload(model.tabId);
      window.close();
    } else if (!model.settings.enabled) {
      void updateSettings((s) => void (s.enabled = true));
    } else if (model.tabId !== null) {
      await toggleSiteForTab(model.tabId, model.url?.href);
    }
  });

  document
    .querySelectorAll<HTMLInputElement>('input[name="mode"]')
    .forEach((r) =>
      r.addEventListener("change", () => {
        if (!r.checked) return;
        const mode = r.value as Mode;
        model.settings = { ...model.settings, mode };
        render();
        void updateSettings((s) => void (s.mode = mode));
      }),
    );

  $<HTMLInputElement>("skip").addEventListener("change", (e) => {
    const skipNativeDark = (e.target as HTMLInputElement).checked;
    model.settings = { ...model.settings, skipNativeDark };
    render();
    void updateSettings((s) => void (s.skipNativeDark = skipNativeDark));
  });

  $("reset").addEventListener("click", () => {
    const { brightness, contrast, sepia, grayscale } = DEFAULT_SETTINGS;
    pending = {};
    clearTimeout(persistTimer);
    model.settings = {
      ...model.settings,
      brightness,
      contrast,
      sepia,
      grayscale,
    };
    render();
    void updateSettings(
      (s) => void Object.assign(s, { brightness, contrast, sepia, grayscale }),
    );
  });

  watchSettings((next) => {
    model.settings = { ...next, ...pending };
    render();
    scheduleRefresh();
  });

  // The content script tells the worker when it changes state; the worker doesn't relay, but extension pages hear it too.
  chrome.runtime.onMessage.addListener((msg: { type?: string }, sender) => {
    if (msg?.type === "report-state" && sender.tab?.id === model.tabId)
      scheduleRefresh();
  });
}

async function init(): Promise<void> {
  const stage = $("stage");
  stage.append(buildPage(false));
  darkLayer = buildPage(true);
  stage.append(darkLayer);
  buildSliders();
  bind();

  const [settings, [tab]] = await Promise.all([
    loadSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  model.settings = settings;
  model.tabId = tab?.id ?? null;
  model.url = parseSupportedUrl(tab?.url);
  if (model.tabId !== null && model.url)
    model.page = await queryPageState(model.tabId);

  render();
  $("app").hidden = false;
}

init().catch((err) => {
  console.error("[MuhiDark] popup failed to start", err);
  document.body.textContent =
    "MuhiDark could not start. Try reloading the extension.";
});
