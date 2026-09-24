import type { Settings } from './types';

export function parseSupportedUrl(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:' ? u : null;
  } catch {
    return null;
  }
}

/** Stable key used in `siteRules`. `www.` is dropped so example.com and www.example.com share a rule. */
export function hostKey(u: URL): string {
  if (u.protocol === 'file:') return 'local-files';
  return u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** Most specific rule wins: a.b.example.com -> b.example.com -> example.com -> com */
export function lookupRule(host: string, rules: Record<string, boolean>): boolean | undefined {
  let h = host;
  while (h) {
    if (Object.hasOwn(rules, h)) return rules[h];
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return undefined;
}

export interface Resolution {
  enabled: boolean;
  /** Explicitly enabled by the user: skip native-dark detection. */
  force: boolean;
}

export function resolveSite(host: string, s: Settings): Resolution {
  if (!s.enabled) return { enabled: false, force: false };
  const rule = lookupRule(host, s.siteRules);
  if (rule === false) return { enabled: false, force: false };
  return { enabled: true, force: rule === true };
}

/**
 * Returns the new rule set after the user turns a site on or off.
 * Turning on stores an explicit `true` only when it's needed (site was skipped as already dark, or a
 * parent-domain rule disables it); otherwise the override is removed and the site goes back to automatic.
 */
export function withSiteEnabled(
  rules: Record<string, boolean>,
  host: string,
  enabled: boolean,
  wasSkippedAsDark: boolean,
): Record<string, boolean> {
  const next = { ...rules };
  if (!enabled) {
    next[host] = false;
    return next;
  }
  delete next[host];
  if (wasSkippedAsDark || lookupRule(host, next) === false) next[host] = true;
  return next;
}
