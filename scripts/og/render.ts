// Renders og.html to public/og-image.png (1200×630) and the favicon PNGs.
// Usage: node scripts/og/render.ts   (needs playwright-core + local Google Chrome)
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const require = createRequire(process.env.PW_PATH ?? "/private/tmp/pw/");
const { chromium } = require("playwright-core");
const root = resolve(import.meta.dirname, "../..");
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(resolve(root, "scripts/og/og.html")).href);
await page.evaluate(() => document.fonts.ready);
const fontOk = await page.evaluate(() => document.fonts.check('800 68px "Inter Variable"'));
if (!fontOk) throw new Error("Inter Variable did not load; refusing to render with a fallback font");
await page.screenshot({ path: resolve(root, "public/og-image.png"), clip: { x: 0, y: 0, width: 1200, height: 630 } });
const svg = (await import("node:fs")).readFileSync(resolve(root, "public/favicon.svg"), "utf8");
for (const [name, size, pad] of [["favicon-32.png", 32, 0], ["apple-touch-icon.png", 180, 1]] as const) {
  const p = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = pad ? `<div style="width:${size}px;height:${size}px;background:#06080c;display:grid;place-items:center"><div style="width:${size * 0.72}px;height:${size * 0.72}px">${svg}</div></div>` : svg;
  await p.setContent(`<style>body{margin:0}svg{width:100%;height:100%;display:block}</style>${inner}`);
  await p.screenshot({ path: resolve(root, "public/" + name), omitBackground: !pad });
}
await browser.close();
