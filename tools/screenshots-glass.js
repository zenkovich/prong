// Renders the glass dialog/menu with full Chrome for Testing (the headless shell does not draw backdrop-filter).
// CHROME="$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" node tools/screenshots-glass.js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ['--headless=new', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForSelector('text=Repositories', { timeout: 120000 });
  await page.click('text=~/work/zenkovich.space/prong');
  await page.waitForTimeout(800);
  await page.click('text=/^Rebase$/'); await page.waitForTimeout(500);
  await page.screenshot({ path: 'glass-dialog.png', clip: { x: 380, y: 200, width: 700, height: 520 } });
  await page.click('text=/^Cancel$/'); await page.waitForTimeout(300);
  await page.click('text=Rebase dialog: onto picker with branch search', { button: 'right' }); await page.waitForTimeout(400);
  await page.screenshot({ path: 'glass-menu.png', clip: { x: 380, y: 150, width: 520, height: 360 } });
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
