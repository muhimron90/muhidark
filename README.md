# MuhiDark

Fast, private dark mode for every site. Manifest V3, TypeScript, built for Brave (works in any Chromium browser 111+).

## How it works

Two rendering engines behind one `Engine` interface, chosen per user setting:

- **Filter**: `invert(1) hue-rotate(180deg)` on the root, with media re-inverted. Cheap, works on any page including canvas UIs and shadow DOM.
- **Dynamic**: reads the page's real CSSOM and rewrites every colour declaration by role (background, text, border) using HSL transforms. Preserves cascade, specificity, `@media`/`@supports`, custom properties (including aliases), gradients, shadows and inline styles; text is corrected to WCAG AA contrast against the themed background. Cross-origin stylesheets are fetched by the service worker (no cookies, size/time bounded, CSS-only). Late-inserted stylesheets and CSS-in-JS `insertRule` calls are picked up.

Pages that are already dark are detected and left alone (toggle off in the popup, or force a site with **Force dark on this site**).

```
src/shared/      pure logic: colour math, settings validation, site rules, messages
src/content/     content script: engines, style injector, inline-style processor, native-dark probe
src/background/  service worker: stylesheet fetcher, toolbar icon state, shortcuts, first-install injection
src/popup/       popup UI (its preview uses the same colour code as the engines)
```

## Privacy

Settings live in `chrome.storage.local` and never leave the device. No analytics, no remote code, no network requests other than fetching stylesheets a page already loads.
