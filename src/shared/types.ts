export type Mode = 'filter' | 'dynamic';

/** What the content script is doing on a page, reported to the popup and the badge. */
export type PageState = 'off' | 'active' | 'native-dark';

export interface Settings {
  /** Master switch. */
  enabled: boolean;
  mode: Mode;
  /** 50..150 (%) */
  brightness: number;
  /** 50..150 (%) */
  contrast: number;
  /** 0..100 (%) */
  sepia: number;
  /** 0..100 (%) */
  grayscale: number;
  /** Leave pages alone when they already have a dark background. */
  skipNativeDark: boolean;
  /** hostname -> true: force dark (ignores native-dark detection), false: never. Absent: automatic. */
  siteRules: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  mode: 'filter',
  brightness: 100,
  contrast: 90,
  sepia: 0,
  grayscale: 0,
  skipNativeDark: true,
  siteRules: {},
});

export const LIMITS = {
  brightness: [50, 150],
  contrast: [50, 150],
  sepia: [0, 100],
  grayscale: [0, 100],
} as const;
