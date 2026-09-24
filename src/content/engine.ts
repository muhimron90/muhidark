import type { Settings } from '../shared/types';

export interface Engine {
  start(settings: Settings): void;
  update(settings: Settings): void;
  stop(): void;
  /** Runs `fn` with every effect of the engine temporarily switched off. */
  probe<T>(fn: () => T): T;
}
