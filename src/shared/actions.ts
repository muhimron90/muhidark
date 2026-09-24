import type { StateResponse } from './messages';
import { hostKey, parseSupportedUrl, resolveSite, withSiteEnabled } from './site';
import { updateSettings } from './store';

/** Asks the top frame's content script what it is doing. Null when it isn't there (unsupported page, or not reloaded yet). */
export async function queryPageState(tabId: number): Promise<StateResponse | null> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'get-state' }, { frameId: 0 })) as StateResponse | undefined;
    return res ?? null;
  } catch {
    return null;
  }
}

/** Shared by the popup button and the keyboard shortcut so both behave identically. */
export async function toggleSiteForTab(tabId: number, url: string | undefined): Promise<void> {
  const u = parseSupportedUrl(url);
  if (!u) return;
  const host = hostKey(u);
  const page = await queryPageState(tabId);
  const skipped = page?.state === 'native-dark';
  await updateSettings((s) => {
    if (!s.enabled) return;
    const showingDark = resolveSite(host, s).enabled && !skipped;
    s.siteRules = withSiteEnabled(s.siteRules, host, !showingDark, skipped);
  });
}
