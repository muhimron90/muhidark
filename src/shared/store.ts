import { DEFAULT_SETTINGS, LIMITS, type Settings } from './types';

const KEY = 'settings';
const MAX_SITE_RULES = 5000;
const HOST_RE = /^[a-z0-9.\-:[\]]{1,253}$/;

const clampInt = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** Validates untrusted storage content. Never throws; unknown or invalid fields fall back to defaults. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;

  const siteRules: Record<string, boolean> = {};
  if (r.siteRules && typeof r.siteRules === 'object') {
    let count = 0;
    for (const [host, v] of Object.entries(r.siteRules as Record<string, unknown>)) {
      if (count >= MAX_SITE_RULES) break;
      const key = host.toLowerCase();
      if (typeof v === 'boolean' && HOST_RE.test(key)) {
        siteRules[key] = v;
        count++;
      }
    }
  }

  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    mode: r.mode === 'filter' || r.mode === 'dynamic' ? r.mode : d.mode,
    brightness: clampInt(r.brightness, LIMITS.brightness, d.brightness),
    contrast: clampInt(r.contrast, LIMITS.contrast, d.contrast),
    sepia: clampInt(r.sepia, LIMITS.sepia, d.sepia),
    grayscale: clampInt(r.grayscale, LIMITS.grayscale, d.grayscale),
    skipNativeDark: typeof r.skipNativeDark === 'boolean' ? r.skipNativeDark : d.skipNativeDark,
    siteRules,
  };
}

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(KEY);
  return normalizeSettings(res[KEY]);
}

// Serialises read-modify-write cycles issued from the same context so rapid UI events can't lose updates.
let queue: Promise<unknown> = Promise.resolve();

export function updateSettings(mutate: (draft: Settings) => Settings | void): Promise<Settings> {
  const run = queue.then(async () => {
    const draft = await loadSettings();
    const next = normalizeSettings(mutate(draft) ?? draft);
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

export function watchSettings(cb: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(normalizeSettings(changes[KEY].newValue));
  });
}
