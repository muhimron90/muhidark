import type { Settings } from './types';

export type FilterSettings = Pick<Settings, 'brightness' | 'contrast' | 'sepia' | 'grayscale'>;

const r = (n: number): number => +n.toFixed(3);

/** The two filter chains of filter mode. Shared with the popup preview so it always matches the real thing. */
export function filterChains(s: FilterSettings): { root: string; media: string } {
  const b = s.brightness / 100;
  const c = s.contrast / 100;
  const root = ['invert(1)', 'hue-rotate(180deg)'];
  if (b !== 1) root.push(`brightness(${r(b)})`);
  if (c !== 1) root.push(`contrast(${r(c)})`);
  if (s.sepia) root.push(`sepia(${r(s.sepia / 100)})`);
  if (s.grayscale) root.push(`grayscale(${r(s.grayscale / 100)})`);

  // The exact inverse of the tint-free part of the root filter, applied in reverse order.
  const rev: string[] = [];
  if (c !== 1) rev.push(`contrast(${r(1 / c)})`);
  if (b !== 1) rev.push(`brightness(${r(1 / b)})`);
  rev.push('hue-rotate(180deg)', 'invert(1)');
  return { root: root.join(' '), media: rev.join(' ') };
}
