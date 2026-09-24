import { parseColor, relativeLuminance } from '../shared/color';

const DARK_LUMINANCE = 0.18;

/**
 * True when the page already paints a dark background of its own. Call it while the engine is switched off
 * (`engine.probe`), otherwise it measures our own output.
 */
export function isNativelyDark(): boolean {
  const root = document.documentElement;
  if (!root) return false;

  for (const el of [document.body, root]) {
    if (!el) continue;
    const c = parseColor(getComputedStyle(el).backgroundColor);
    if (c && c.a > 0.5) return relativeLuminance(c) < DARK_LUMINANCE;
  }

  // No explicit background: the canvas is dark only if the page opted into a dark colour scheme.
  const scheme = getComputedStyle(root).getPropertyValue('color-scheme');
  if (!/\bdark\b/.test(scheme)) return false;
  return !/\blight\b/.test(scheme) || matchMedia('(prefers-color-scheme: dark)').matches;
}
