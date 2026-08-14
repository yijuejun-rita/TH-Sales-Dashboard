const { chromium } = require('playwright');

const BASE = 'http://localhost:8791';
const PAGES = [
  '/index.html',
  '/weekly/overview.html',
  '/weekly/channel-store.html',
  '/weekly/category-sku.html',
];
const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 900 },
  { name: 'tablet', width: 820, height: 1100 },
  { name: 'mobile', width: 390, height: 844 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  let anyError = false;
  for (const page of PAGES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const p = await ctx.newPage();
      // The sandbox running this test has no route to cdnjs.cloudflare.com,
      // so stub Chart.js here purely to exercise the surrounding KPI/table/
      // alert logic. This is a test-harness-only workaround: production
      // (GitHub Pages, real browsers) loads the real CDN script fine -- the
      // existing Monthly dashboard already depends on the same CDN URL.
      await p.addInitScript(() => {
        window.Chart = class {
          constructor() {}
          destroy() {}
        };
      });
      const errors = [];
      p.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
      p.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
      const resp = await p.goto(BASE + page, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForTimeout(600);
      const status = resp.status();
      const bodyText = await p.evaluate(() => document.body.innerText.slice(0, 0)); // just to ensure DOM alive
      const hasNaN = await p.evaluate(() => document.body.innerText.includes('NaN'));
      const hasInfinity = await p.evaluate(() => document.body.innerText.includes('Infinity'));
      const overflowX = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 5);
      const shotPath = `/home/claude/work/TH-Sales-Dashboard/screenshots/${page.replace(/\//g, '_')}_${vp.name}.png`;
      await p.screenshot({ path: shotPath, fullPage: true });
      const line = `${page} @ ${vp.name} (${vp.width}px): status=${status} errors=${errors.length} NaN=${hasNaN} Infinity=${hasInfinity} horizOverflow=${overflowX}`;
      console.log(line);
      const realErrors = errors.filter(
        (e) => !e.includes('ERR_TUNNEL_CONNECTION_FAILED') && !e.includes('favicon') && !e.includes('404')
      );
      if (realErrors.length || hasNaN || hasInfinity || status !== 200) {
        anyError = true;
        realErrors.forEach((e) => console.log('   REAL console error:', e));
      }
      await ctx.close();
    }
  }
  await browser.close();
  process.exit(anyError ? 1 : 0);
})();
