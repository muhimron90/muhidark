// build.mjs — Zero-config build for the Bun runtime.
// Usage:
//   bun run build.mjs             (dev, with sourcemaps)
//   bun run build.mjs --prod      (minified, no sourcemaps)
//   bun --watch run build.mjs     (re-run on change)
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const prod = process.argv.includes("--prod");
const watch = process.argv.includes("--watch");

const out = "dist";

// --- static files

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/popup`, { recursive: true });

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
manifest.version = pkg.version;
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));

cpSync("public/icons", `${out}/icons`, { recursive: true });
cpSync("src/popup/popup.html", `${out}/popup/popup.html`);
cpSync("src/popup/popup.css", `${out}/popup/popup.css`);

// --- bundling

const shared = {
  target: "browser",
  minify: prod,
  SourceMap: prod ? "none" : "linked",
};

const jobs = [
  {
    entrypoints: ["src/content/index.ts"],
    outdir: out,
    naming: "content.js",
    format: "iife",
  },
  {
    entrypoints: ["src/background/index.ts"],
    outdir: out,
    naming: "background.js",
    format: "esm",
  },
  {
    entrypoints: ["src/popup/popup.ts"],
    outdir: `${out}/popup`,
    naming: "popup.js",
    format: "iife",
  },
];

const buildAll = async () => {
  const results = await Promise.all(
    jobs.map((job) => Bun.build({ ...shared, ...job })),
  );
  for (const r of results) {
    if (!r.success) {
      for (const log of r.logs) {
        console.error(log);
        process.exit(1);
      }
    }
  }
};

await buildAll();

if (watch) {
  console.log(
    "watching… run with `bun --watch run build.mjs` so the script re-executes on changes.\n" +
      "Static files in public/ and popup.html/css need a manual rebuild.",
  );
}
