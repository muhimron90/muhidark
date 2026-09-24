import { queryPageState, toggleSiteForTab } from "../shared/actions";
import type { FetchCssResponse, WorkerRequest } from "../shared/messages";
import { loadSettings, updateSettings } from "../shared/store";
import type { PageState } from "../shared/types";

// ---  Cross-origin stylesheet fetching (for DynamicEngine)
//
// The content script cannot read rules of cross-origin sheets, so it asks us. This is a privileged
// fetch (we hold host permissions), so it is deliberately narrow: our own content scripts only,
// http(s) only, no cookies, bounded time and size, and only CSS-looking responses.

const FETCH_TIMEOUT_MS = 8_000;
const MAX_CSS_BYTES = 2 * 1024 * 1024;
const CACHE_BUDGET_BYTES = 6 * 1024 * 1024;
const CSS_TYPES = /^(text\/css|text\/plain|application\/octet-stream)\b/i;

interface CacheEntry {
  text: string;
  bytes: number;
}
const cache = new Map<string, CacheEntry>(); // insertion order == LRU order
const inflight = new Map<string, Promise<FetchCssResponse>>();
let cacheBytes = 0;

function remember(url: string, text: string): void {
  const bytes = text.length * 2;
  if (bytes > CACHE_BUDGET_BYTES / 4) return;
  cache.set(url, { text, bytes });
  cacheBytes += bytes;
  for (const [key, entry] of cache) {
    if (cacheBytes <= CACHE_BUDGET_BYTES) break;
    cache.delete(key);
    cacheBytes -= entry.bytes;
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CSS_BYTES) {
      void reader.cancel();
      throw new Error("stylesheet too large");
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

async function fetchCss(url: string): Promise<FetchCssResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, error: "unsupported scheme" };

  const hit = cache.get(url);
  if (hit) {
    cache.delete(url); // refresh LRU position
    cache.set(url, hit);
    return { ok: true, text: hit.text };
  }
  const pending = inflight.get(url);
  if (pending) return pending;

  const job = (async (): Promise<FetchCssResponse> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(parsed, {
        credentials: "omit",
        redirect: "follow",
        signal: ctl.signal,
        cache: "force-cache",
      });
      if (!res.ok) return { ok: false, error: `http ${res.status}` };
      const type = res.headers.get("content-type") ?? "";
      if (type && !CSS_TYPES.test(type))
        return { ok: false, error: "not a stylesheet" };
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_CSS_BYTES)
        return { ok: false, error: "stylesheet too large" };
      const text = await readCapped(res);
      remember(url, text);
      return { ok: true, text };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "fetch failed",
      };
    } finally {
      clearTimeout(timer);
      inflight.delete(url);
    }
  })();
  inflight.set(url, job);
  return job;
}

// --- Toolbar icon + tooltip per tab

const TITLES: Record<PageState, string> = {
  active: "MuhiDark: dark on this site",
  off: "MuhiDark: off on this site",
  "native-dark": "MuhiDark: this site is already dark",
};

function paintAction(tabId: number, state: PageState): void {
  const suffix = state === "active" ? "" : "-off";
  const path = {
    16: `icons/icon${suffix}-16.png`,
    32: `icons/icon${suffix}-32.png`,
  };
  // Tabs close and navigate constantly; failures here are expected and harmless.
  void chrome.action.setIcon({ tabId, path }).catch(() => undefined);
  void chrome.action
    .setTitle({ tabId, title: TITLES[state] })
    .catch(() => undefined);
}

const isState = (v: unknown): v is PageState =>
  v === "off" || v === "active" || v === "native-dark";

// Listeners must be registered synchronously at the top level: the worker is torn down when idle
// and restarted on demand, and only listeners present on that first tick are woken.
chrome.runtime.onMessage.addListener((msg: WorkerRequest, sender, respond) => {
  // Only our own content scripts. Pages cannot reach us (no externally_connectable), but be strict anyway.
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object")
    return;

  if (msg.type === "report-state") {
    if (
      sender.tab?.id !== undefined &&
      sender.frameId === 0 &&
      isState(msg.state)
    )
      paintAction(sender.tab.id, msg.state);
    return;
  }
  if (msg.type === "fetch-css") {
    if (!sender.tab || typeof msg.url !== "string") {
      respond({ ok: false, error: "rejected" } satisfies FetchCssResponse);
      return;
    }
    void fetchCss(msg.url).then(respond);
    return true; // keep the channel open for the async response
  }
  return;
});

// --- Keyboard commands

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "toggle-global") {
      await updateSettings((s) => {
        s.enabled = !s.enabled;
      });
    } else if (command === "toggle-site") {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab?.id !== undefined) await toggleSiteForTab(tab.id, tab.url);
    }
  } catch (err) {
    console.error("[MuhiDark] command failed", command, err);
  }
});

//  First install: dark mode should work in tabs that are already open, not only after a reload.

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return; // on update the old content scripts are still alive in their tabs
  try {
    await loadSettings(); // touch storage early so a broken profile surfaces during install, not on first page
    const tabs = await chrome.tabs.query({
      url: ["http://*/*", "https://*/*"],
    });
    await Promise.allSettled(
      tabs.map(async (tab) => {
        if (tab.id === undefined || tab.discarded) return;
        if (await queryPageState(tab.id)) return; // a content script is already there
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content.js"],
        });
      }),
    );
  } catch (err) {
    console.debug("[MuhiDark] could not inject into existing tabs", err);
  }
});
