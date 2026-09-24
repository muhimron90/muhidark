import { describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import {
  contrastRatio,
  hslToRgb,
  parseColor,
  RGBA,
  rgbToHsl,
} from "../src/shared/color";

const rgb = (s: string): RGBA => {
  const c = parseColor(s, false);
  assert.ok(c, `could not parse ${s}`);
  return c!;
};
// const DEFAULT = themeFromSettings({ brightness: 100, contrast: 90 });
// const themeBg = (t: typeof DEFAULT): RGBA =>
//   hslToRgb({ h: 220, s: 0.07, l: t.bgBase, a: 1 });

describe("parseColor", () => {
  it("parses hex in 3, 6 and 8 digit forms", () => {
    expect(rgb(`#abc`)).toStrictEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(rgb(`#1a73e8`)).toStrictEqual({ r: 26, g: 115, b: 232, a: 1 });
    assert.ok(Math.abs(rgb(`#aabbccdd`).a - 0xdd / 255) < 1e-9);
  });
  it("prases modern and legacy functional syntax", () => {
    expect(rgb(`rgb(255 0 0 / .5)`)).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(rgb(`rgba(1, 2, 3, 1)`)).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(rgb(`hsl(200 50% 50%)`)).toEqual({ r: 64, g: 149, b: 191, a: 1 });
  });
  it("returns null for things that are not colours", () => {
    for (const bad of [
      "nonsense",
      "",
      "#12",
      "#ggg",
      "rgb(",
      "12px",
      "url(x.png)",
    ]) {
      // assert.equal(parseColor(bad, false), null, bad);
      expect(parseColor(bad, false)).toBeNull();
    }
  });
});

describe("conversions", () => {
  it("round-trips rgb -> hsl -> rgb within one step", () => {
    let seed = 42;
    const rnd = (): number =>
      (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 500; i++) {
      const c: RGBA = {
        r: Math.floor(rnd() * 256),
        g: Math.floor(rnd() * 256),
        b: Math.floor(rnd() * 256),
        a: 1,
      };
      const back = hslToRgb(rgbToHsl(c));
      assert.ok(
        Math.abs(back.r - c.r) <= 1 &&
          Math.abs(back.g - c.g) <= 1 &&
          Math.abs(back.b - c.b) <= 1,
        JSON.stringify([c, back]),
      );
    }
  });
  it("computes WCAG contrast", () => {
    assert.ok(Math.abs(contrastRatio(rgb("#fff"), rgb("#000")) - 21) < 0.01);
    expect(contrastRatio(rgb("#123456"), rgb("#fedcba"))).toEqual(
      contrastRatio(rgb("#fedcba"), rgb("#123456")),
    );
    assert.ok(Math.abs(contrastRatio(rgb("#777"), rgb("#777")) - 1) < 1e-9);
  });
});
