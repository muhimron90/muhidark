import type { ContentRequest, StateResponse, WorkerRequest } from '../shared/messages';
import { hostKey, parseSupportedUrl, resolveSite } from '../shared/site';
import { loadSettings, watchSettings } from '../shared/store';
import type { Mode, PageState, Settings } from '../shared/types';
import { DynamicEngine } from './dynamic-engine';
import type { Engine } from './engine';
import { FilterEngine } from './filter-engine';
import { isNativelyDark } from './native-dark';

// Kick off the storage read before anything else: at document_start every millisecond is a potential white flash.
const initial = loadSettings();

let settings: Settings | null = null;
let engine: Engine | null = null;
let engineMode: Mode | null = null;
let state: PageState = 'off';
let reported: PageState | null = null;
/** The page was found to be dark already; remembered so slider tweaks don't flash the engine on and off. */
let nativeDark = false;

function currentHost(): string {
  const own = parseSupportedUrl(location.href);
  if (own) return hostKey(own);
  try {
    // about:blank / srcdoc frames inherit the decision of their parent.
    const parent = parseSupportedUrl(window.parent.location.href);
    if (parent) return hostKey(parent);
  } catch {
    /* cross-origin parent */
  }
  return '';
}

function setState(next: PageState): void {
  state = next;
  if (window !== window.top || reported === next) return;
  reported = next;
  const msg: WorkerRequest = { type: 'report-state', state: next };
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function teardown(): void {
  engine?.stop();
  engine = null;
  engineMode = null;
}

function reconcile(): void {
  if (!settings) return;
  const res = resolveSite(currentHost(), settings);
  if (!res.enabled) {
    nativeDark = false;
    teardown();
    setState('off');
    return;
  }

  const detect = settings.skipNativeDark && !res.force;
  if (!detect) nativeDark = false;
  if (detect && nativeDark) {
    teardown();
    setState('native-dark');
    return;
  }

  if (!engine || engineMode !== settings.mode) {
    teardown();
    engine = settings.mode === 'filter' ? new FilterEngine() : new DynamicEngine();
    engineMode = settings.mode;
    engine.start(settings);
  } else {
    engine.update(settings);
  }
  setState('active');
  if (detect && document.readyState !== 'loading') checkNative();
}

function checkNative(): void {
  if (!engine || !settings || nativeDark) return;
  const res = resolveSite(currentHost(), settings);
  if (!settings.skipNativeDark || res.force) return;
  try {
    if (engine.probe(isNativelyDark)) {
      nativeDark = true;
      teardown();
      setState('native-dark');
    }
  } catch (err) {
    console.debug('[MuhiDark] native-dark probe failed', err);
  }
}

// Styles are usually settled by DOMContentLoaded; look again on load for late-arriving stylesheets.
document.addEventListener('DOMContentLoaded', checkNative);
window.addEventListener('load', checkNative);

chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, respond) => {
  if (msg?.type !== 'get-state') return;
  const res: StateResponse = { state, mode: settings?.mode ?? 'filter', host: currentHost() };
  respond(res);
});

initial
  .then((s) => {
    settings = s;
    reconcile();
    watchSettings((next) => {
      settings = next;
      reconcile();
    });
  })
  .catch((err) => console.debug('[MuhiDark] failed to load settings', err));
