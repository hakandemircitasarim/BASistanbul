// Headless screenshot harness for the game (Chromium + SwiftShader WebGL). Track I.
//
// Usage:
//   node scripts/screenshot.mjs <url> <out.png> [--wait ms] [--click selector] [--keys "KeyW:1500,KeyE:150"] [--w 1280] [--h 720] [--trace]
// Example (dev server on :8080):
//   node scripts/screenshot.mjs "http://127.0.0.1:8080/?autostart=1&hour=19&quality=low&nearcar=1" /tmp/drive.png --keys "KeyE:200,KeyW:4000"
//
// Requirements: `playwright-core` (npm i -D playwright-core, or set PLAYWRIGHT_CORE to a directory containing it) and a
// Chromium binary (CHROMIUM_PATH, default /opt/pw-browsers/chromium-1194/chrome-linux/chrome). SwiftShader renders at a few fps,
// so the simulation runs slower than real time — use long key holds and long --wait values.
//
// Debug URL options understood by the game: ?autostart=1 (skip the menu), ?hour=19, ?quality=low|high, ?seed=7, ?stars=2 (wanted level),
// ?nearcar=1 (spawn beside the nearest parked car), ?debug=1 (city validation + F3 panel). The page exposes window.__GAME_DEBUG__()
// which this script prints (fps, draw calls, tick ms, entity counts, speed, inVehicle, wanted, phase, player position, captured errors).
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = ['playwright-core'];
  if (process.env.PLAYWRIGHT_CORE) candidates.unshift(path.join(process.env.PLAYWRIGHT_CORE, 'node_modules', 'playwright-core'), process.env.PLAYWRIGHT_CORE);
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  console.error('playwright-core not found: npm i -D playwright-core (or set PLAYWRIGHT_CORE=<dir with node_modules/playwright-core>)');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
if (!url || !out) {
  console.error('usage: node scripts/screenshot.mjs <url> <out.png> [--wait ms] [--click selector] [--keys "KeyW:1500,KeyE:150"] [--w px] [--h px] [--trace]');
  process.exit(2);
}
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const wait = Number(opt('--wait', 4000));
const click = opt('--click', null);
const keys = opt('--keys', null);
const trace = args.includes('--trace');
const W = Number(opt('--w', 1280));
const H = Number(opt('--h', 720));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const debug = async () => page.evaluate(() => (window.__GAME_DEBUG__ ? window.__GAME_DEBUG__() : null));
const sample = async (tag) => {
  const s = await debug();
  console.log(tag.padEnd(14), s ? `x=${s.playerX.toFixed(1)} z=${s.playerZ.toFixed(1)} inV=${s.inVehicle} spd=${s.speed} wanted=${s.wanted} phase=${s.phase} veh=${s.vehicles} peds=${s.peds} police=${s.police}` : 'no __GAME_DEBUG__');
};

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1500);
if (trace) await sample('start');
if (click) {
  try { await page.click(click, { timeout: 5000 }); } catch (e) { errors.push(`[click failed] ${click}: ${e.message}`); }
}
if (keys) {
  for (const spec of keys.split(',')) {
    const [code, ms] = spec.split(':');
    const total = Number(ms || 500);
    await page.keyboard.down(code);
    if (trace) {
      let t = 0;
      while (t < total) { const step = Math.min(500, total - t); await page.waitForTimeout(step); t += step; await sample(`${code} +${t}`); }
    } else {
      await page.waitForTimeout(total);
    }
    await page.keyboard.up(code);
  }
}
await page.waitForTimeout(wait);
const info = await debug();
await page.screenshot({ path: out });
console.log('screenshot:', out);
console.log('debug:', info ? JSON.stringify(info) : 'no __GAME_DEBUG__');
console.log('console errors/warnings:', errors.length);
for (const e of errors.slice(0, 30)) console.log('  ' + e);
await browser.close();
