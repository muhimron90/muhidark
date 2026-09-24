/**
 * Owns one stylesheet inside the page.
 *
 * Prefers constructable stylesheets (`adoptedStyleSheets`):
 *  - not subject to page CSP `style-src` (no inline <style> parsing),
 *  - always ordered after every author stylesheet, so our rules win ties without re-appending,
 *  - the page's DOM stays untouched.
 * Falls back to a <style> element if adoptedStyleSheets is unavailable or rejected.
 */
export class StyleInjector {
  private sheet: CSSStyleSheet | null = null;
  private el: HTMLStyleElement | null = null;
  private useElement = false;
  private guard = 0;

  /** The fallback <style> element, if that mode is in use. */
  get element(): HTMLStyleElement | null {
    return this.el;
  }

  owns(sheet: CSSStyleSheet): boolean {
    return sheet === this.sheet || (this.el !== null && sheet.ownerNode === this.el);
  }

  set(css: string): void {
    if (!this.useElement) {
      try {
        this.sheet ??= new CSSStyleSheet();
        this.sheet.replaceSync(css);
        this.attach();
        return;
      } catch {
        this.useElement = true;
        this.sheet = null;
      }
    }
    this.el ??= Object.assign(document.createElement('style'), { id: 'muhidark' });
    this.el.textContent = css;
    this.attach();
  }

  /** Re-adds our sheet if the page replaced `adoptedStyleSheets` or removed the fallback element. */
  attach(): void {
    if (this.sheet) {
      const cur = document.adoptedStyleSheets;
      if (!cur.includes(this.sheet)) document.adoptedStyleSheets = [...cur, this.sheet];
    } else if (this.el && !this.el.isConnected) {
      const parent = document.head ?? document.documentElement;
      if (parent) parent.appendChild(this.el);
      else document.addEventListener('readystatechange', () => this.attach(), { once: true });
    }
    if (!this.guard) this.guard = window.setInterval(() => this.attach(), 2500);
  }

  /** Runs `fn` with our styles switched off, e.g. to measure what the page looks like natively. */
  detached<T>(fn: () => T): T {
    const s = this.sheet ?? this.el?.sheet ?? null;
    if (!s) return fn();
    const prev = s.disabled;
    s.disabled = true;
    try {
      return fn();
    } finally {
      s.disabled = prev;
    }
  }

  remove(): void {
    window.clearInterval(this.guard);
    this.guard = 0;
    if (this.sheet) {
      const sheet = this.sheet;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      this.sheet = null;
    }
    this.el?.remove();
    this.el = null;
  }
}
