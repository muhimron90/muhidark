/**
 * Pure colour math for the dynamic engine. No DOM access except the optional canvas lookup used to
 * resolve named colours (red, rebeccapurple, …) in a real browser.
 */

export type Role = "bg" | "fg" | "bd";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface HSLA {
  h: number;
  s: number;
  l: number;
  a: number;
}
export interface Theme {
  /** HSL lightness of the page background (0..1). */
  bgBase: number;
  /** HSL lightness that pure-black text is mapped to (0..1). */
  fgTop: number;
}
export interface RewriteCtx {
  theme: Theme;
  /** Custom properties known to hold colours; references to them are re-pointed at derived variables. */
  colorVars: ReadonlySet<string>;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

export function themeFromSettings(s: {
  brightness: number;
  contrast: number;
}): Theme {
  return {
    bgBase: clamp(0.09 * (s.brightness / 100), 0.03, 0.3),
    fgTop: clamp(0.75 + 0.16 * (s.contrast / 100), 0.6, 0.98),
  };
}

// --- conversions

export function rgbToHsl({ r, g, b, a }: RGBA): HSLA {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0,
    s = 0;
  if (d > 1e-9) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: clamp(s, 0, 1), l, a };
}

export function hslToRgb({ h, s, l, a }: HSLA): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a,
  };
}

export function relativeLuminance({ r, g, b }: RGBA): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = relativeLuminance(a),
    lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function toCss({ r, g, b, a }: RGBA): string {
  const R = clamp(Math.round(r), 0, 255),
    G = clamp(Math.round(g), 0, 255),
    B = clamp(Math.round(b), 0, 255);
  return a >= 1
    ? `rgb(${R}, ${G}, ${B})`
    : `rgba(${R}, ${G}, ${B}, ${+a.toFixed(3)})`;
}

// --- parsing

const cache = new Map<string, RGBA | null>();
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const NON_COLOR = new Set([
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "none",
  "auto",
]);

/** Parses #hex, rgb[a](), hsl[a]() and — inside a browser — any named colour. Returns null when it isn't a plain colour. */
export function parseColor(input: string, allowResolve = true): RGBA | null {
  const v = input.trim().toLowerCase();
  if (!v || v.length > 64) return null;
  const hit = cache.get(v);
  if (hit !== undefined) return hit;
  const out = parseUncached(v, allowResolve);
  if (cache.size > 4000) cache.clear();
  cache.set(v, out);
  return out;
}

function parseUncached(v: string, allowResolve: boolean): RGBA | null {
  if (v[0] === "#") return parseHex(v);
  const m = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(v);
  if (m)
    return m[1].startsWith("rgb") ? parseRgbArgs(m[2]) : parseHslArgs(m[2]);
  if (allowResolve && /^[a-z]+$/.test(v)) return resolveKeyword(v);
  return null;
}

function parseHex(v: string): RGBA | null {
  if (!HEX.test(v)) return null;
  let h = v.slice(1);
  if (h.length <= 4) h = h.replace(/./g, (c) => c + c);
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const splitArgs = (args: string): string[] =>
  args
    .trim()
    .split(/[\s,/]+/)
    .filter(Boolean);

function channel(tok: string, full: number): number | null {
  const n = parseFloat(tok);
  if (!Number.isFinite(n)) return null;
  return tok.endsWith("%") ? (n / 100) * full : n;
}

function parseRgbArgs(args: string): RGBA | null {
  const p = splitArgs(args);
  if (p.length < 3 || p.length > 4) return null;
  const r = channel(p[0], 255),
    g = channel(p[1], 255),
    b = channel(p[2], 255);
  const a = p.length === 4 ? channel(p[3], 1) : 1;
  if (r === null || g === null || b === null || a === null) return null;
  return {
    r: clamp(r, 0, 255),
    g: clamp(g, 0, 255),
    b: clamp(b, 0, 255),
    a: clamp(a, 0, 1),
  };
}

function parseHslArgs(args: string): RGBA | null {
  const p = splitArgs(args);
  if (p.length < 3 || p.length > 4) return null;
  const h = parseFloat(p[0]),
    s = parseFloat(p[1]),
    l = parseFloat(p[2]);
  const a = p.length === 4 ? channel(p[3], 1) : 1;
  if (![h, s, l].every(Number.isFinite) || a === null) return null;
  return hslToRgb({
    h,
    s: clamp(s / 100, 0, 1),
    l: clamp(l / 100, 0, 1),
    a: clamp(a, 0, 1),
  });
}

type Ctx2D = { fillStyle: string | CanvasGradient | CanvasPattern };
let canvasCtx: Ctx2D | null | undefined;

function getCtx(): Ctx2D | null {
  if (canvasCtx !== undefined) return canvasCtx;
  try {
    if (typeof OffscreenCanvas !== "undefined")
      canvasCtx = new OffscreenCanvas(1, 1).getContext("2d");
    else if (typeof document !== "undefined")
      canvasCtx = document.createElement("canvas").getContext("2d");
    else canvasCtx = null;
  } catch {
    canvasCtx = null;
  }
  return canvasCtx;
}

/**
 * Lets the browser normalise named colours. Assigning an invalid value to fillStyle is ignored, so a word is a valid
 * colour only if two different sentinel starting points end up at the same result.
 */
function resolveKeyword(word: string): RGBA | null {
  if (NON_COLOR.has(word)) return null;
  const ctx = getCtx();
  if (!ctx) return null;
  ctx.fillStyle = "#000000";
  ctx.fillStyle = word;
  const a = String(ctx.fillStyle);
  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = word;
  const b = String(ctx.fillStyle);
  return a === b ? parseColor(a, false) : null;
}

// --- transforms

const BG_PIVOT = 0.45;
const FG_PIVOT = 0.55;
const COOL_HUE = 200;
const WARM_HUE = 40;

/** Light surfaces become dark; already-dark and mid-tone surfaces (brand colours, buttons) are left mostly alone. */
export function transformBackground(c: RGBA, t: Theme): RGBA {
  const src = rgbToHsl(c);
  let { h, s, l } = src;
  if (l > BG_PIVOT) {
    const k = (l - BG_PIVOT) / (1 - BG_PIVOT);
    l = BG_PIVOT - (BG_PIVOT - t.bgBase) * k ** 0.6;
    s *= 1 - 0.25 * k;
  }
  if (s < 0.12) {
    h = COOL_HUE;
    s = Math.max(s, 0.06);
  }
  return hslToRgb({ h, s, l, a: src.a });
}

/** Dark text becomes light, then is nudged until it clears WCAG AA (4.5:1) against the page background. */
export function transformForeground(c: RGBA, t: Theme): RGBA {
  const src = rgbToHsl(c);
  let { h, s, l } = src;
  if (l < FG_PIVOT) {
    const k = (FG_PIVOT - l) / FG_PIVOT;
    l = FG_PIVOT + (t.fgTop - FG_PIVOT) * k ** 0.6;
    s *= 1 - 0.3 * k;
  }
  if (s < 0.12) {
    h = WARM_HUE;
    s = Math.max(s, 0.04);
  }
  let out = hslToRgb({ h, s, l, a: src.a });
  const bg = hslToRgb({ h: COOL_HUE, s: 0.07, l: t.bgBase, a: 1 });
  const minLum = 4.5 * (relativeLuminance(bg) + 0.05) - 0.05;
  for (let i = 0; i < 24 && relativeLuminance(out) < minLum && l < 0.96; i++) {
    l = Math.min(0.96, l + 0.02);
    out = hslToRgb({ h, s, l, a: src.a });
  }
  return out;
}

/** Borders invert: light hairlines become subtle dark ones, black outlines become visible grey. */
export function transformBorder(c: RGBA, t: Theme): RGBA {
  const src = rgbToHsl(c);
  let { h, s } = src;
  const l = t.bgBase + 0.09 + (1 - src.l) * 0.3;
  s *= 0.85;
  if (s < 0.12) {
    h = COOL_HUE;
    s = Math.max(s, 0.05);
  }
  return hslToRgb({ h, s, l, a: src.a });
}

export function transformColor(c: RGBA, role: Role, t: Theme): RGBA {
  return role === "bg"
    ? transformBackground(c, t)
    : role === "fg"
      ? transformForeground(c, t)
      : transformBorder(c, t);
}

// --- value rewriting

const TOKEN =
  /url\([^)]*\)|var\((?:[^()]|\([^()]*\))*\)|#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)|[a-z][a-z-]*/gi;
/** A value that is exactly one var() reference: `var(--x)` or `var(--x, fallback)`. */
export const ALIAS_RE = /^var\(\s*(--[^,\s)]+)\s*(?:,[^()]*)?\)$/i;

function rewriteVar(tok: string, role: Role, ctx: RewriteCtx): string {
  const m = /^var\(\s*(--[^,\s)]+)/i.exec(tok);
  if (!m || !ctx.colorVars.has(m[1])) return tok;
  return `var(--muhidark-${role}-${m[1].slice(2)}, ${tok})`;
}

/**
 * Rewrites every colour inside a declaration value (shorthands, gradients, shadows) for the given role.
 * url() is never touched. var() references are re-pointed at derived variables when the target is a known colour variable.
 */
export function rewriteValue(
  value: string,
  role: Role,
  ctx: RewriteCtx,
): string {
  return value.replace(TOKEN, (tok) => {
    const low = tok.toLowerCase();
    if (low.startsWith("url(")) return tok;
    if (low.startsWith("var(")) return rewriteVar(tok, role, ctx);
    const c = parseColor(tok);
    if (!c || c.a === 0) return tok;
    return toCss(transformColor(c, role, ctx.theme));
  });
}

const ROLES: readonly Role[] = ["bg", "fg", "bd"];

/**
 * For a custom property that holds a colour (or aliases one), returns declarations for three derived variables
 * (`--muhidark-bg-*`, `-fg-*`, `-bd-*`). Places that use the variable are then rewritten to read the derived one.
 */
export function deriveVarDecls(
  name: string,
  value: string,
  ctx: RewriteCtx,
): string[] {
  const suffix = name.slice(2);
  const color = parseColor(value);
  if (color)
    return ROLES.map(
      (role) =>
        `--muhidark-${role}-${suffix}:${toCss(transformColor(color, role, ctx.theme))}`,
    );
  if (!ALIAS_RE.test(value)) return [];
  const out: string[] = [];
  for (const role of ROLES) {
    const alias = rewriteVar(value, role, ctx);
    if (alias !== value) out.push(`--muhidark-${role}-${suffix}:${alias}`);
  }
  return out;
}
