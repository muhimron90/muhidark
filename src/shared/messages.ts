import type { Mode, PageState } from './types';

/** popup / worker -> content script (top frame) */
export type ContentRequest = { type: 'get-state' };
export interface StateResponse {
  state: PageState;
  mode: Mode;
  host: string;
}

/** content script -> service worker */
export type WorkerRequest =
  | { type: 'report-state'; state: PageState }
  | { type: 'fetch-css'; url: string };

export type FetchCssResponse = { ok: true; text: string } | { ok: false; error: string };
