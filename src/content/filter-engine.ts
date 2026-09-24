import { filterChains, type FilterSettings } from '../shared/filters';
import type { Settings } from '../shared/types';
import type { Engine } from './engine';
import { StyleInjector } from './injector';

// Outermost media only: an <img> inside a <picture> must not be re-inverted twice.
const MEDIA = 'img,video,canvas,picture,iframe,embed,object,[style*="url(" i]';

/**
 * Filter mode: invert the whole page, then invert media back so photos and video keep their real colours.
 * Cheap and works everywhere (shadow DOM, canvas UIs), at the cost of less faithful colours than the dynamic engine.
 * Every frame runs its own copy; the parent re-inverts <iframe> so embeds aren't inverted twice.
 */
export function buildFilterCss(s: FilterSettings): string {
  const { root, media } = filterChains(s);
  return [
    // Specificity 0: any background the page sets on <html> wins; otherwise the canvas is white and inverts to dark.
    ':where(html){background-color:#fff}',
    `:root{filter:${root} !important}`,
    `:root :is(${MEDIA}):not(:is(${MEDIA}) *){filter:${media} !important}`,
  ].join('\n');
}

export class FilterEngine implements Engine {
  private readonly inj = new StyleInjector();

  start(s: Settings): void {
    this.inj.set(buildFilterCss(s));
  }

  update(s: Settings): void {
    this.inj.set(buildFilterCss(s));
  }

  stop(): void {
    this.inj.remove();
  }

  probe<T>(fn: () => T): T {
    return this.inj.detached(fn);
  }
}
