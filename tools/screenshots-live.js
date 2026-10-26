const { chromium } = require('playwright');
const REPO = '/private/tmp/claude-501/-Users-andreizenkovich-work-zenkovich-space/ce766384-5c8b-415b-b7de-22ec15e9108c/scratchpad/livefixture/work';
(async () => {
  // register fixture repo with the engine first
  await fetch('http://127.0.0.1:8790/api/repos/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: REPO, workspace: 'work' }) });
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
  await page.goto('http://localhost:8099/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('text=Repositories', { timeout: 120000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'l1-welcome.png' });
  await page.getByText(REPO, { exact: true }).click(); await page.waitForTimeout(1500);
  await page.screenshot({ path: 'l2-commits.png' });
  await page.click('text=/^Changes$/'); await page.waitForTimeout(800);
  await page.click('text=a.ts'); await page.waitForTimeout(800);
  await page.screenshot({ path: 'l3-changes.png' });
  // stage a.ts via hover button is hard; use Stage file button in diff header
  await page.click('text=/^Stage file$/i'); await page.waitForTimeout(1200);
  await page.screenshot({ path: 'l4-staged.png' });
  await page.fill('input[placeholder="Commit summary"]', 'Commit from Prong UI'); await page.waitForTimeout(200);
  await page.click('text=/^Commit$/i'); await page.waitForTimeout(1500);
  await page.click('text=/^All Commits$/'); await page.waitForTimeout(1200);
  await page.screenshot({ path: 'l5-after-commit.png' });
  await page.click('text=/^Push$/i'); await page.waitForTimeout(2500);
  await page.screenshot({ path: 'l6-after-push.png' });
  console.log('errors:', errors.length, errors.join(' | '));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
