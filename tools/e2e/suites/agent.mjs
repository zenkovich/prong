/**
 * The agent, as a user works it: the AGENT button that unfolds into a command line (⌘J, Escape), the live status
 * of a run and its stop buttons, the cards a finished run leaves, the full chat panel (⌘⇧J) with its Markdown
 * answers, steps, follow-ups and targets, the versions of Prong's own interface (revert, re-apply, roll back,
 * reset to factory), the agent settings, and "Ask AI" from the error window, the connection test and a crashed
 * panel.
 *
 * The agent is always the stand-in tools/fake-claude.sh (no network, no cost): its prompt steers it ("slow task",
 * "fake-fail", "edit-ui", "markdown-demo", "retarget-app") and it logs what it was asked, where and with which
 * options to the harness's agentLog. Repository work runs in repositories of this suite's own; interface changes
 * go to the harness's app sources (a plain folder: the engine keeps a shadow log of it). Check names start with
 * the part ("agent bar", "chat", "versions"…), so E2E_ONLY='versions' runs one part.
 */
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { ROOT, base, page, check, expect, waitText, until, git, root, tmp, appSources, agentLog, freshRepo, finish, pageErrors, statusHas } from '../harness.mjs';

const SHOTS = path.join(ROOT, '..', 'shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `agent-${n}.png`) }).catch(() => {});
const tid = (id) => page.getByTestId(id);
const has = async (id) => (await tid(id).count()) > 0;
const waitGone = (id, ms = 6000) => page.waitForFunction((id) => !document.querySelector(`[data-testid="${CSS.escape(id)}"]`), id, { timeout: ms });
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const sameDir = (a, b) => !!a && !!b && (a === b || real(a) === real(b));
const FAKE = path.join(ROOT, 'tools/fake-claude.sh');
const BASELINE = 'export const themeButton = true;\n';
const toolbarSrc = () => readFileSync(path.join(appSources, 'src/Toolbar.tsx'), 'utf8');
const sidebarFile = path.join(appSources, 'src/Sidebar.tsx');
const sidebarSrc = () => (existsSync(sidebarFile) ? readFileSync(sidebarFile, 'utf8') : '');
/** page errors a check provokes on purpose (a crash, a refused revert) */
const expectedErrors = [/e2e agent:/, /Minified React error #31/, /Objects are not valid as a React child/];

// ---------- the repositories the agent works in, the system calls, links, the clipboard ----------

const WORK = await freshRepo('agent-work', { 'README.md': '# agent work\n', 'notes.txt': 'one\n' });
// its origin is a folder that does not exist: the connection test fails there
git(WORK, 'remote', 'add', 'origin', path.join(tmp, 'origins/agent-missing.git'));
const OTHER = await freshRepo('agent-other', { 'README.md': '# other\n' });
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
/** what the page asked the system for (open in an app, reveal, a link): answered here, never by the engine */
const systemCalls = [];
await page.route('**/api/system/**', (route) => {
  const req = route.request();
  systemCalls.push({ what: new URL(req.url()).pathname.split('/').pop(), body: req.postDataJSON() });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
// a link the chat opens lands here, never on the network
await page.context().route(/^https?:\/\/[^/]*example\.invalid\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>opened link</title>opened' }));
await page.waitForTimeout(1200); // the saved session restores its tabs a moment after a reload

// ---------- helpers ----------

/** what the fake agent was asked: one entry per run, oldest first */
const entries = () =>
  (existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '')
    .split('\n---\n')
    .filter((e) => e.trim())
    .map((e) => {
      const lines = e.split('\n');
      const field = (k) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2) ?? (lines.includes(`${k}:`) ? '' : '');
      const sys = lines.findIndex((l) => l.startsWith('system: '));
      return { cwd: field('cwd'), resume: field('resume'), apply: field('apply'), model: field('model'), prompt: lines.slice(sys + 1).join('\n'), raw: e };
    });
const clearLog = () => rmSync(agentLog, { force: true });
const waitEntries = async (n, ms = 15000) => {
  await until(async () => entries().length >= n, `the agent ran ${n} time(s)`, ms);
  return entries();
};
const settings = () => fetch(base + '/api/settings').then((r) => r.json());
const putSettings = (agent) => fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent }) }).then((r) => r.json());
const versionsNow = () => fetch(base + '/api/app/versions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: appSources }) }).then((r) => r.json());
const buildMark = () => page.evaluate(() => document.querySelector('meta[name="prong-build"]')?.getAttribute('content') ?? null);
/** the window reloaded into a new interface build (an agent change, a revert): waits for the new build's mark */
async function waitNewBuild(before, ms = 30000) {
  await page.waitForFunction((b) => {
    const m = document.querySelector('meta[name="prong-build"]')?.getAttribute('content');
    return !!m && m !== b;
  }, before, { timeout: ms });
  await page.waitForTimeout(800); // the chat and the tabs come back a moment after the load
}

/** the agent is idle: no status line, no working row */
const idle = () => page.evaluate(() => !document.querySelector('[data-testid="agent-status"]') && !document.querySelector('[data-testid="agent-working"]')).catch(() => false);
const waitIdle = (ms = 20000) => until(idle, 'the agent finished', ms);
const panelOpen = () => has('agent-panel');
const barOpen = () => has('agent-input');
async function openBar() {
  if (!(await barOpen())) await tid('agent-button').click();
  await tid('agent-input').waitFor({ timeout: 3000 });
}
async function openPanel() {
  if (!(await panelOpen())) await page.keyboard.press('Meta+Shift+J');
  await tid('agent-panel').waitFor({ timeout: 3000 });
}
async function tab(name) {
  await tid(`agent-tab-${name}`).click();
  await page.waitForTimeout(150);
}
/** the tab the panel shows, by what is on it */
const activeTab = () =>
  page.evaluate(() => {
    const p = document.querySelector('[data-testid="agent-panel"]');
    if (!p) return null;
    if (p.querySelector('[data-testid="agent-chat-input"]')) return 'chat';
    if (p.querySelector('[data-testid="agent-versions-head"]')) return 'changes';
    if (p.querySelector('[data-testid="agent-set-model"]')) return 'settings';
    return 'unknown';
  });
/** the chat composer of the panel */
const composer = () => tid('agent-chat-input');
async function closeNotices() {
  for (let i = 0; i < 10 && (await has('agent-notice-close')); i++) await tid('agent-notice-close').first().click();
}
/** a run from the command line in the tab bar, to its end */
async function runFromBar(prompt, { reload = false } = {}) {
  const mark = await buildMark();
  await openBar();
  await tid('agent-input').fill(prompt);
  await tid('agent-input').press('Enter');
  if (reload) return waitNewBuild(mark);
  await tid('agent-status').waitFor({ timeout: 2500 }).catch(() => {});
  await waitIdle();
}
/** a run from the chat panel, to its end */
async function runFromChat(prompt, { reload = false } = {}) {
  const mark = await buildMark();
  await openPanel();
  if ((await activeTab()) !== 'chat') await tab('chat');
  await composer().fill(prompt);
  await composer().press('Enter');
  if (reload) return waitNewBuild(mark);
  await tid('agent-working').waitFor({ timeout: 2500 }).catch(() => {});
  await waitIdle();
}
const cards = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-notice-card"]')].map((e) => e.innerText));
const userMsgs = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-msg-user"]')].map((e) => e.innerText));
const agentMsgs = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-msg-agent"]')].map((e) => e.innerText));
const lastAgent = async () => (await agentMsgs()).pop() ?? '';
/** the target of the next request, as the bar's chip shows it */
const barTarget = async () => (await tid('agent-target').innerText()).trim().toLowerCase();
/** the chat's target switch */
const pickTarget = (v) => tid('agent-panel').getByLabel(v, { exact: true }).click();
/** the chat's target, as its composer says it */
const chatTarget = async () => ({ 'команда для репозитория или интерфейса': 'auto', 'что сделать в репозитории': 'repo', 'что изменить в интерфейсе': 'app' })[await composer().getAttribute('placeholder')] ?? null;
/** opens a repository of this suite */
async function openRepoTab(name) {
  if (await has(`tab-${name}`)) await tid(`tab-${name}`).click();
  else {
    await tid('home-button').click();
    await page.getByText(name, { exact: true }).first().click();
  }
  await tid(`tab-${name}`).waitFor({ timeout: 10000 });
  await waitText('All Commits');
}
/** the pointer off the panel: a row under it shows its hover buttons instead of its status */
const away = () => page.mouse.move(100, 880);
const focusedTestId = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null);
/** the computed style of the innermost element whose own text is `s` */
const styleOf = (s, within = 'body') =>
  page.evaluate(
    ([s, within]) => {
      const root = document.querySelector(within) ?? document.body;
      const el = [...root.querySelectorAll('*')].reverse().find((e) => e.textContent === s);
      if (!el) return null;
      const c = getComputedStyle(el);
      return { fontStyle: c.fontStyle, decoration: c.textDecorationLine, bg: c.backgroundColor, weight: c.fontWeight, family: c.fontFamily, tag: el.tagName, href: el.getAttribute('href') };
    },
    [s, within],
  );
/** back to a known state before every check: no dialog, the agent idle, cards closed, the panel and the bar closed */
async function calm() {
  for (let i = 0; i < 4 && (await page.locator('[data-testid="context-menu"], [data-testid="modal"], [data-testid="error-dialog"]').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  if (!(await idle())) {
    if (await has('agent-stop')) await tid('agent-stop').click();
    await waitIdle().catch(() => {});
  }
  await closeNotices();
  if (await panelOpen()) await tid('agent-close').click();
  if (await barOpen()) await tid('agent-fold-bar').click();
}
const step = (name, fn) =>
  check(name, async () => {
    await calm();
    await fn();
  });

// ---------- the bar ----------

await step('agent bar: the AGENT button unfolds a command line with the cursor in it; its × folds it back', async () => {
  await openRepoTab('agent-work');
  await tid('agent-button').click();
  await tid('agent-input').waitFor({ timeout: 3000 });
  await page.waitForTimeout(100);
  expect((await focusedTestId()) === 'agent-input', 'the cursor is in the command line: ' + (await focusedTestId()));
  await shot('bar-open');
  await tid('agent-fold-bar').click();
  await waitGone('agent-input');
  expect(await has('agent-button'), 'the AGENT button is back');
});

await step('agent bar: ⌘J unfolds and folds the command line; Escape folds it from the line and from the rest of the window', async () => {
  await page.locator('body').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('Meta+j');
  await tid('agent-input').waitFor({ timeout: 3000 });
  await page.keyboard.press('Meta+j');
  await waitGone('agent-input');
  await page.keyboard.press('Meta+j');
  await tid('agent-input').waitFor({ timeout: 3000 });
  await tid('agent-input').press('Escape');
  await waitGone('agent-input');
  await tid('agent-button').click();
  await tid('agent-input').waitFor({ timeout: 3000 });
  await page.getByText('All Commits', { exact: true }).first().click(); // the cursor leaves the line
  await page.keyboard.press('Escape');
  await waitGone('agent-input');
});

await step('agent bar: an Escape that closes a menu leaves the command line open (it folded both)', async () => {
  await openBar();
  await page.getByTestId('branch-main').first().click({ button: 'right' });
  await tid('context-menu').waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await waitGone('context-menu');
  await page.waitForTimeout(150);
  expect(await barOpen(), 'the command line is still open');
  await page.keyboard.press('Escape');
  await waitGone('agent-input');
});

await step('agent bar: the target chip cycles auto → repo → app → auto, and the chat shows the same target', async () => {
  await openBar();
  expect((await barTarget()) === 'auto', 'starts on auto: ' + (await barTarget()));
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await tid('agent-target').click();
    seen.push(await barTarget());
  }
  expect(seen.join(' ') === 'repo app auto', 'cycles: ' + seen.join(' '));
  await tid('agent-target').click(); // repo
  await tid('agent-expand').click();
  await tid('agent-panel').waitFor({ timeout: 3000 });
  expect((await chatTarget()) === 'repo', 'the chat has the same target: ' + (await chatTarget()));
  await pickTarget('auto');
  expect((await chatTarget()) === 'auto', 'back on auto');
});

await step('agent bar: an empty or blank command is not sent: Send is disabled and Enter does nothing', async () => {
  clearLog();
  await openBar();
  expect((await tid('agent-send').getAttribute('aria-disabled')) === 'true', 'Send disabled on an empty line');
  await tid('agent-input').fill('   ');
  expect((await tid('agent-send').getAttribute('aria-disabled')) === 'true', 'Send disabled on blanks');
  await tid('agent-input').press('Enter');
  await page.waitForTimeout(600);
  expect(!(await has('agent-status')) && entries().length === 0, 'nothing ran');
  expect((await tid('agent-input').inputValue()) === '   ', 'what was typed stays');
});

await step('agent bar: Enter runs the command in the open repository: the line shows what the agent does and the seconds, then a card says what was done', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await openBar();
  await tid('agent-input').fill('покажи последние коммиты');
  await tid('agent-input').press('Enter');
  await tid('agent-status').waitFor({ timeout: 5000 });
  const seen = new Set();
  let seconds = '';
  for (let i = 0; i < 40 && (await has('agent-status')); i++) {
    seen.add(await tid('agent-status').innerText().catch(() => ''));
    seconds = (await tid('agent-bar').innerText().catch(() => '')) || seconds;
    await page.waitForTimeout(60);
  }
  expect([...seen].some((s) => /Reading store\.ts|Type-checking|Thinking|Writing the answer/.test(s)), 'the line follows the agent: ' + [...seen].join(' | '));
  expect(/\b\d+ s\b/.test(seconds), 'the seconds run: ' + seconds);
  await tid('agent-notice-card').first().waitFor({ timeout: 10000 });
  const [card] = await cards();
  await shot('card');
  expect(/done/i.test(card) && /repo · \d+(\.\d)? s · \$0\.012/.test(card), 'title, target, time and cost: ' + card);
  expect(card.includes('Done: checked src/state/store.ts') && !card.includes('**') && !card.includes('```'), 'the answer, as Markdown: ' + card);
  expect(card.includes('1 read · 1 command') && !/more step/.test(card), 'what it did: ' + card);
  const [e] = await waitEntries(1);
  expect(sameDir(e.cwd, WORK) && e.prompt.startsWith('покажи последние коммиты') && e.resume === '' && e.apply === 'yes', 'ran in agent-work, a new conversation: ' + JSON.stringify(e).slice(0, 300));
  expect(await barOpen(), 'the command line is back for the next command');
});

await step('agent card: open chat shows the run in the chat, on the Chat tab even when the panel was left on Settings', async () => {
  await openPanel();
  await tab('settings');
  await tid('agent-close').click();
  await runFromBar('покажи статус git');
  await tid('agent-notice-open').first().click();
  await tid('agent-panel').waitFor({ timeout: 3000 });
  expect((await activeTab()) === 'chat', 'the Chat tab: ' + (await activeTab()));
  expect((await userMsgs()).pop()?.includes('покажи статус git'), 'the request is in the chat');
  expect((await lastAgent()).includes('Done: checked src/state/store.ts'), 'and its answer');
});

await step('agent card: reply unfolds the command line with the cursor in it; the reply continues the conversation', async () => {
  clearLog();
  await runFromBar('посмотри git log');
  await tid('agent-fold-bar').click();
  await tid('agent-notice-reply').first().click();
  await tid('agent-input').waitFor({ timeout: 3000 });
  await page.waitForTimeout(100);
  expect((await focusedTestId()) === 'agent-input', 'the cursor is in the line');
  await tid('agent-input').fill('да, сделай');
  await tid('agent-input').press('Enter');
  const [, second] = await waitEntries(2);
  await waitIdle();
  expect(second.resume === 'fake-session' && sameDir(second.cwd, WORK), 'continued in agent-work: ' + JSON.stringify(second).slice(0, 200));
});

await step('agent card: a failed run says Failed with the agent’s error, red; a stopped one says Stopped', async () => {
  await runFromBar('запусти git fsck fake-fail');
  const [card] = await cards();
  expect(/failed/i.test(card) && card.includes('fake failure'), 'Failed with the error: ' + card);
  const color = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="agent-notice-card"]')).borderLeftColor);
  // the chat has it too, under what the agent did before it failed
  await tid('agent-notice-open').first().click();
  await tid('agent-panel').waitFor({ timeout: 3000 });
  expect((await lastAgent()).includes('⚠ fake failure') && /2 steps/.test(await lastAgent()), 'in the chat: ' + (await lastAgent()));
  await tid('agent-close').click();
  await closeNotices();
  await openBar();
  await tid('agent-input').fill('git gc slow task');
  await tid('agent-input').press('Enter');
  await page.waitForFunction(() => /Type-checking/.test(document.querySelector('[data-testid="agent-status"]')?.textContent ?? ''), null, { timeout: 8000 });
  await tid('agent-stop').click();
  await tid('agent-notice-card').first().waitFor({ timeout: 8000 });
  const [stopped] = await cards();
  expect(/stopped/i.test(stopped) && !/failed/i.test(stopped.split('\n')[0]), 'Stopped, not failed: ' + stopped);
  const color2 = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="agent-notice-card"]')).borderLeftColor);
  expect(color !== color2, 'a failure and a stop look different: ' + color + ' / ' + color2);
});

await step('agent bar: the stop in the status panel stops a running agent too', async () => {
  await openBar();
  await tid('agent-input').fill('git gc slow task');
  await tid('agent-input').press('Enter');
  await page.waitForFunction(() => /Type-checking/.test(document.querySelector('[data-testid="agent-status"]')?.textContent ?? ''), null, { timeout: 8000 });
  await tid('activity-stop').click();
  await tid('agent-notice-card').first().waitFor({ timeout: 8000 });
  expect(/stopped/i.test((await cards())[0]), 'stopped: ' + (await cards())[0]);
});

await step('agent cards: three at most, then “+N more”; each × closes only its own card', async () => {
  for (const p of ['git log one', 'git log two', 'git log three', 'git log four']) await runFromBar(p);
  expect((await cards()).length === 3, 'three cards: ' + (await cards()).length);
  expect((await tid('agent-notice-more').innerText()).includes('+1 more'), 'the fourth is counted');
  // the folded AGENT button counts them all
  await tid('agent-fold-bar').click();
  expect(/agent\s*4/i.test(await tid('agent-button').innerText()), 'the button counts four: ' + (await tid('agent-button').innerText()));
  const before = await cards();
  await tid('agent-notice-close').nth(1).click();
  await page.waitForTimeout(150);
  const after = await cards();
  expect(after.length === 3 && !(await has('agent-notice-more')), 'the hidden one moves up: ' + after.length);
  expect(after[0] === before[0], 'the first card stays');
});

await step('agent bar: when a run ends while the user types elsewhere, the cursor stays there', async () => {
  await openRepoTab('agent-work');
  await page.getByText('Changes', { exact: true }).first().click();
  const summary = page.getByPlaceholder('Commit summary');
  await summary.waitFor({ timeout: 5000 });
  await openBar();
  await tid('agent-input').fill('git log about focus');
  await tid('agent-input').press('Enter');
  await tid('agent-status').waitFor({ timeout: 5000 });
  await summary.click();
  await page.keyboard.type('wip');
  await waitIdle();
  await page.waitForTimeout(300);
  await page.keyboard.type(' more');
  expect((await summary.inputValue()) === 'wip more', 'the typing went on in the summary: ' + JSON.stringify(await summary.inputValue()));
  await summary.fill('');
  await page.getByText('All Commits', { exact: true }).first().click();
});

await step('agent bar: the status line opens the chat on the running request; ⤢ opens the full panel', async () => {
  await openBar();
  await tid('agent-input').fill('git gc slow task');
  await tid('agent-input').press('Enter');
  await tid('agent-status-open').waitFor({ timeout: 5000 });
  await tid('agent-status-open').click();
  await tid('agent-panel').waitFor({ timeout: 3000 });
  await tid('agent-working').waitFor({ timeout: 3000 });
  expect((await userMsgs()).pop()?.includes('git gc slow task'), 'the running request is in the chat');
  await tid('agent-close').click();
  await tid('agent-busy-expand').click();
  await tid('agent-panel').waitFor({ timeout: 3000 });
  await tid('agent-stop').click();
  await waitIdle();
});

// ---------- the panel ----------

await step('agent panel: ⌘⇧J opens it with the cursor in the composer and the connection in its header; × and ⌘⇧J close it; ⤡ folds it into the command line', async () => {
  await page.keyboard.press('Meta+Shift+J');
  await tid('agent-panel').waitFor({ timeout: 3000 });
  await page.waitForTimeout(150);
  expect((await focusedTestId()) === 'agent-chat-input', 'the cursor is in the composer: ' + (await focusedTestId()));
  expect((await tid('agent-connection').innerText()).includes('claude code 9.9.9 · local'), 'connected: ' + (await tid('agent-connection').innerText()));
  await shot('panel');
  await tid('agent-close').click();
  await waitGone('agent-panel');
  await page.keyboard.press('Meta+Shift+J');
  await tid('agent-panel').waitFor({ timeout: 3000 });
  await composer().click();
  await page.keyboard.press('Meta+Shift+J');
  await waitGone('agent-panel');
  await page.keyboard.press('Meta+Shift+J');
  await tid('agent-fold').click();
  await waitGone('agent-panel');
  await tid('agent-input').waitFor({ timeout: 3000 });
  // and ⌘J from the panel does the same
  await tid('agent-expand').click();
  await tid('agent-panel').waitFor({ timeout: 3000 });
  await page.keyboard.press('Meta+j');
  await waitGone('agent-panel');
  expect(await barOpen(), '⌘J folded the panel into the line');
});

await step('agent panel: the command palette opens the command line and the chat window', async () => {
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('input[placeholder="type a command"]', { timeout: 3000 });
  await page.keyboard.type('Ask the agent');
  await page.keyboard.press('Enter');
  await tid('agent-input').waitFor({ timeout: 3000 });
  await page.waitForTimeout(100);
  expect((await focusedTestId()) === 'agent-input', 'the cursor is in the command line');
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('input[placeholder="type a command"]', { timeout: 3000 });
  await page.keyboard.type('Agent chat window');
  await page.keyboard.press('Enter');
  await tid('agent-panel').waitFor({ timeout: 3000 });
  expect(!(await barOpen()), 'the command line folded into the window');
});

await step('agent panel: its left edge drags it wider and narrower, within limits', async () => {
  await openPanel();
  const box = async () => (await tid('agent-panel').boundingBox()).width;
  const w0 = await box();
  const edge = await tid('agent-panel').boundingBox();
  const drag = async (dx) => {
    const b = await tid('agent-panel').boundingBox();
    await page.mouse.move(b.x - 2, b.y + 300);
    await page.mouse.down();
    await page.mouse.move(b.x - 2 + dx, b.y + 300, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  };
  await drag(-100);
  const w1 = await box();
  expect(w1 > w0 + 60, `wider: ${w0} → ${w1}`);
  await drag(-800);
  expect((await box()) <= 641, 'at most 640: ' + (await box()));
  await drag(900);
  expect((await box()) >= 279 && (await box()) <= 300, 'at least 280: ' + (await box()));
  await drag(-(w0 - (await box())));
  void edge;
});

// ---------- the chat ----------

await step('chat: Enter sends and the cursor stays for the next message; Shift+Enter starts a new line; Send sends; an empty message is not sent', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await openPanel();
  await composer().click();
  await page.keyboard.type('first line of git log');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  expect((await composer().inputValue()) === 'first line of git log\nsecond line', 'two lines: ' + JSON.stringify(await composer().inputValue()));
  await page.keyboard.press('Enter');
  await tid('agent-working').waitFor({ timeout: 5000 });
  expect((await composer().inputValue()) === '', 'the composer is emptied');
  expect((await focusedTestId()) === 'agent-chat-input', 'the cursor stays in the composer: ' + (await focusedTestId()));
  expect((await tid('agent-chat-send').getAttribute('aria-disabled')) === 'true', 'Send waits while the agent works');
  await waitIdle();
  const [e] = await waitEntries(1);
  expect(e.prompt.startsWith('first line of git log\nsecond line'), 'the agent got both lines: ' + JSON.stringify(e.prompt.slice(0, 60)));
  const shown = (await userMsgs()).pop();
  expect(shown.includes('first line of git log\nsecond line'), 'the chat shows both lines: ' + JSON.stringify(shown));
  // the Send button, and nothing for blanks
  await composer().fill('  ');
  expect((await tid('agent-chat-send').getAttribute('aria-disabled')) === 'true', 'Send disabled on blanks');
  await composer().press('Enter');
  await page.waitForTimeout(500);
  expect(entries().length === 1, 'blanks are not sent');
  await composer().fill('git status via the button');
  await tid('agent-chat-send').click();
  await waitEntries(2);
  await waitIdle();
});

await step('chat: a run shows a working row with what the agent does and its steps live; after, the steps fold into “▸ 2 steps” and the cost', async () => {
  await openPanel();
  await composer().fill('git gc slow task');
  await composer().press('Enter');
  await tid('agent-working').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => /Type-checking/.test(document.querySelector('[data-testid="agent-working"]')?.textContent ?? ''), null, { timeout: 8000 });
  const live = await lastAgent();
  expect(/Read\s*\/repo\/src\/state\/store\.ts/.test(live) && /Bash\s*npx tsc --noEmit/.test(live), 'the steps so far, live: ' + live);
  await tid('agent-stop').click();
  await waitIdle();
  expect((await lastAgent()).includes('⚠ Stopped'), 'a stopped run says so in the chat: ' + (await lastAgent()));
  await runFromChat('git log for the steps');
  const msg = tid('agent-msg-agent').last();
  expect(/▸\s*2 steps/.test(await msg.getByTestId('agent-steps').innerText()), 'folded: ' + (await msg.getByTestId('agent-steps').innerText()));
  expect(!(await msg.innerText()).includes('/repo/src/state/store.ts'), 'the steps are hidden');
  expect((await msg.innerText()).includes('cost $0.012'), 'the cost: ' + (await msg.innerText()));
  await msg.getByTestId('agent-steps').click();
  await page.waitForTimeout(150);
  const open = await msg.innerText();
  expect(open.includes('/repo/src/state/store.ts') && open.includes('npx tsc --noEmit') && /session fake-ses/.test(open) && /▾/.test(open), 'unfolded, with the session line: ' + open);
  await msg.getByTestId('agent-steps').click();
  await page.waitForTimeout(150);
  expect(!(await msg.innerText()).includes('/repo/src/state/store.ts'), 'folded again');
});

await step('chat: Markdown answers: a heading, bold, italics, strikethrough, inline code, numbered and nested lists, a quote, a table, a rule and code with its language and Copy', async () => {
  await runFromChat('git log markdown-demo');
  const msg = tid('agent-msg-agent').last();
  const said = await msg.innerText();
  await shot('markdown');
  for (const raw of ['## ', '**', '~~', '|---', '> a quoted', '```', '](https']) expect(!said.includes(raw), `no raw “${raw}”: ` + said);
  for (const words of ['Report', 'Bold line', 'italics', 'struck', 'inline code', 'first step', 'second step', 'nested point', 'a quoted note', 'Branch', 'Ahead', 'feature/x', 'the docs', 'https://example.invalid/raw', 'const answer = 42;']) expect(said.includes(words), `shows “${words}”`);
  expect((await styleOf('italics'))?.fontStyle === 'italic', 'italics are italic: ' + JSON.stringify(await styleOf('italics')));
  expect((await styleOf('struck'))?.decoration.includes('line-through'), 'struck is struck through');
  expect((await styleOf('inline code'))?.bg !== 'rgba(0, 0, 0, 0)', 'inline code on a ground');
  expect(/1\.\s*first step/.test(said) && /2\.\s*second step/.test(said) && /•\s*nested point/.test(said), 'numbered list with a nested point: ' + said);
  const table = await page.evaluate(() => {
    const m = [...document.querySelectorAll('[data-testid="agent-msg-agent"]')].pop();
    let row = [...m.querySelectorAll('*')].reverse().find((e) => e.textContent === 'feature/x');
    while (row && row.textContent !== 'feature/x0') row = row.parentElement;
    return row ? row.innerText.replace(/\s+/g, ' ').trim() : null;
  });
  expect(table === 'feature/x 0', 'the table row has its cells: ' + table);
  const code = msg.getByTestId('md-code');
  expect((await code.count()) === 1 && /^js\b/i.test((await code.innerText()).trim()), 'the code block says its language: ' + (await code.innerText()));
  await msg.getByTestId('md-code-copy').click();
  await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === 'const answer = 42;', 'Copy put the code on the clipboard');
  await statusHas(/Copied/);
});

await step('chat: a link opens in a browser tab once, and Prong stays in its window', async () => {
  if (!(await has('md-link'))) await runFromChat('git log markdown-demo');
  await openPanel();
  const opens = systemCalls.filter((c) => c.what === 'open').length;
  const popup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await page.getByTestId('md-link').filter({ hasText: 'the docs' }).last().click();
  const p = await popup;
  await p?.waitForLoadState().catch(() => {});
  await page.waitForTimeout(600);
  expect(!!p && p.url().startsWith('https://docs.example.invalid/prong'), 'a tab with the link: ' + p?.url());
  expect(page.url().startsWith(base), 'Prong’s window stays: ' + page.url());
  expect(await panelOpen(), 'the chat is still there');
  expect(systemCalls.filter((c) => c.what === 'open').length === opens, 'not opened a second time by the engine: ' + JSON.stringify(systemCalls.slice(-2)));
  await p?.close();
  // the bare address too
  const popup2 = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await page.getByTestId('md-link').filter({ hasText: 'https://example.invalid/raw' }).last().click();
  const p2 = await popup2;
  await p2?.waitForLoadState().catch(() => {});
  expect(!!p2 && p2.url() === 'https://example.invalid/raw', 'the bare URL opens: ' + p2?.url());
  await p2?.close();
  expect(page.url().startsWith(base), 'still in Prong');
});

await step('chat: a suggestion fills the composer; the target switch shows the suggestions of that target', async () => {
  await openPanel();
  await pickTarget('repo');
  const repoChips = await page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-suggestion"]')].map((e) => e.innerText));
  expect(repoChips.length > 0 && repoChips.includes('создай ветку feature/agent-panel') && !repoChips.includes('скрой колонку автора'), 'repo suggestions: ' + repoChips.join(' | '));
  await pickTarget('app');
  const appChips = await page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-suggestion"]')].map((e) => e.innerText));
  expect(appChips.includes('скрой колонку автора') && !appChips.includes('создай ветку feature/agent-panel'), 'app suggestions: ' + appChips.join(' | '));
  expect((await composer().getAttribute('placeholder')) === 'что изменить в интерфейсе', 'the composer says what it is for');
  await tid('agent-suggestion').filter({ hasText: 'скрой колонку автора' }).click();
  expect((await composer().inputValue()) === 'скрой колонку автора', 'the composer has it');
  await composer().fill('');
  await pickTarget('auto');
  expect((await page.evaluate(() => document.querySelectorAll('[data-testid="agent-suggestion"]').length)) === repoChips.length + appChips.length, 'auto shows all');
});

await step('chat: Clear chat leaves the introduction and starts a new conversation; it waits while the agent works', async () => {
  clearLog();
  await runFromChat('git log before clearing');
  await openPanel();
  await composer().fill('git gc slow task');
  await composer().press('Enter');
  await tid('agent-working').waitFor({ timeout: 5000 });
  await tid('agent-clear').click({ force: true });
  await page.waitForTimeout(200);
  expect((await userMsgs()).some((m) => m.includes('git gc slow task')), 'nothing cleared while it works');
  await tid('agent-stop').click();
  await waitIdle();
  await tid('agent-clear').click();
  await page.waitForTimeout(200);
  expect((await userMsgs()).length === 0 && (await agentMsgs()).length === 0, 'only the introduction is left');
  expect((await page.evaluate(() => document.querySelector('[data-testid="agent-panel"]').innerText)).includes('Prong поставляется'), 'the introduction stays');
  await runFromChat('git log after clearing');
  const all = entries();
  expect(all[all.length - 1].resume === '', 'a new conversation: ' + all[all.length - 1].resume);
});

// ---------- where a request runs ----------

await step('modes: in auto, git words run in the repository and words about the interface in Prong’s sources', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await openPanel();
  await tid('agent-clear').click();
  await pickTarget('auto');
  await runFromChat('покажи последние коммиты');
  await runFromChat('сделай тулбар компактнее');
  const [a, b] = await waitEntries(2);
  expect(sameDir(a.cwd, WORK), 'git words: in the repository: ' + a.cwd);
  expect(sameDir(b.cwd, appSources) && b.resume === '', 'interface words: in the app sources, a conversation of its own: ' + b.cwd);
  const msgs = await userMsgs();
  expect(/·\s*repo/i.test(msgs[0]) && /·\s*app/i.test(msgs[1]), 'each request says where it ran: ' + msgs.join(' | '));
  expect((await lastAgent()).includes('no source changes'), 'an app run that changed nothing says so');
});

await step('modes: a pinned target wins over the words', async () => {
  clearLog();
  await openPanel();
  await pickTarget('app');
  await runFromChat('покажи git log');
  await pickTarget('repo');
  await runFromChat('сделай тулбар компактнее');
  const [a, b] = await waitEntries(2);
  expect(sameDir(a.cwd, appSources), 'app pinned: in the sources: ' + a.cwd);
  expect(sameDir(b.cwd, WORK), 'repo pinned: in the repository: ' + b.cwd);
  await pickTarget('auto');
});

await step('modes: a reply without target words goes on in the same repository and conversation, even from another tab', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await openPanel();
  await tid('agent-clear').click();
  await runFromChat('какие ветки есть в репозитории');
  await openRepoTab('agent-other');
  await runFromChat('да, сделай');
  const [, b] = await waitEntries(2);
  expect(sameDir(b.cwd, WORK) && b.resume === 'fake-session', 'the reply ran in agent-work, resumed: ' + JSON.stringify({ cwd: b.cwd, resume: b.resume }));
  // a new git request from this tab runs here, as a new conversation
  await runFromChat('покажи коммиты этой ветки');
  const c = (await waitEntries(3))[2];
  expect(sameDir(c.cwd, OTHER) && c.resume === '', 'a new request runs in the repository on screen: ' + JSON.stringify({ cwd: c.cwd, resume: c.resume }));
});

await step('modes: an auto request the repository’s agent says is about the interface is re-run in Prong’s sources; with repo pinned it says to switch', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await openPanel();
  await tid('agent-clear').click();
  await pickTarget('auto');
  await runFromChat('retarget-app please');
  const [a, b] = await waitEntries(2);
  expect(sameDir(a.cwd, WORK) && sameDir(b.cwd, appSources), 'first in the repository, then in the sources: ' + a.cwd + ' → ' + b.cwd);
  const msgs = await agentMsgs();
  expect(msgs.some((m) => m.includes('Это задача про интерфейс Prong, запускаю в исходниках приложения')), 'the chat says why: ' + msgs.join(' || '));
  expect(!msgs.some((m) => m.includes('PRONG_TARGET')), 'the marker is not shown');
  clearLog();
  await pickTarget('repo');
  await runFromChat('retarget-app again');
  await page.waitForTimeout(300);
  expect(entries().length === 1, 'not re-run against the pinned target');
  expect((await lastAgent()).includes('Агент считает, что это задача для цели «app». Переключите цель и повторите.'), 'it says to switch: ' + (await lastAgent()));
  await pickTarget('auto');
});

// ---------- settings ----------

await step('settings: the fields show what the engine uses: an empty model is Claude Code’s default, the binary, the sources folder', async () => {
  const s = await settings();
  await openPanel();
  await tab('settings');
  await shot('settings');
  expect(s.agent.model === '', 'the engine has no model of its own: ' + s.agent.model);
  expect((await tid('agent-set-model').inputValue()) === '', 'the model field is empty (Claude Code’s default): ' + (await tid('agent-set-model').inputValue()));
  expect((await tid('agent-set-cli').inputValue()) === FAKE, 'the binary: ' + (await tid('agent-set-cli').inputValue()));
  expect(sameDir(await tid('agent-set-sources').inputValue(), appSources), 'the sources folder');
  const label = await tid('agent-auto-rollback').innerText();
  expect(/roll back an interface change whose build fails/i.test(label), 'the box says what it does: ' + label);
});

await step('settings: the model reaches Claude Code and Plan only keeps it from editing; ticking a box does not pin a model', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await openPanel();
  await tab('settings');
  await tid('agent-plan-only').click();
  await until(async () => (await settings()).agent.askBeforeApply === true, 'Plan only saved');
  await tid('agent-plan-only').click();
  await until(async () => (await settings()).agent.askBeforeApply === false, 'Plan only off again');
  expect((await settings()).agent.model === '', 'no model pinned by the boxes: ' + (await settings()).agent.model);
  // typed key by key, as a user does: what is saved is what the field shows
  await tid('agent-set-model').pressSequentially('claude-sonnet-x');
  await page.waitForTimeout(800);
  expect((await settings()).agent.model === 'claude-sonnet-x', 'the whole name saved: ' + (await settings()).agent.model);
  await tid('agent-set-model').fill('opus');
  await until(async () => (await settings()).agent.model === 'opus', 'the model saved');
  await tid('agent-plan-only').click();
  await until(async () => (await settings()).agent.askBeforeApply === true, 'Plan only saved');
  await runFromChat('git log with opus');
  await tab('settings');
  await tid('agent-plan-only').click();
  await tid('agent-set-model').fill('');
  await until(async () => (await settings()).agent.model === '' && (await settings()).agent.askBeforeApply === false, 'back to the default model, edits allowed');
  await runFromChat('git log with the default');
  const [a, b] = await waitEntries(2);
  expect(a.model === 'opus' && a.apply === 'no', 'the model and plan-only reached Claude Code: ' + JSON.stringify({ model: a.model, apply: a.apply }));
  expect(b.model === '' && b.apply === 'yes', 'no --model, edits accepted: ' + JSON.stringify({ model: b.model, apply: b.apply }));
});

await step('settings: a wrong binary: check says Claude Code is not found, the header says not connected, a request says so instead of running a demo agent; fixed and checked, requests go to Claude Code again', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await openPanel();
  await tab('settings');
  try {
    await tid('agent-set-cli').fill('/nonexistent/claude');
    await tid('agent-check').click();
    // a failed check is an error: its window says what to do
    await tid('error-dialog').waitFor({ timeout: 5000 });
    expect((await tid('error-title').innerText()) === 'Claude Code not found' && /npm i -g @anthropic-ai\/claude-code/.test(await tid('error-dialog').innerText()), 'the error window: ' + (await tid('error-dialog').innerText()));
    await tid('error-close').click();
    await waitGone('error-dialog');
    expect((await tid('agent-connection').innerText()).includes('not connected'), 'the header: ' + (await tid('agent-connection').innerText()));
    const branches = git(WORK, 'branch', '--list');
    await runFromChat('создай ветку from-a-demo');
    await page.waitForTimeout(800);
    expect(git(WORK, 'branch', '--list') === branches, 'no branch made in the repository: ' + git(WORK, 'branch', '--list'));
    expect((await lastAgent()).includes('Claude Code не найден'), 'the chat says why: ' + (await lastAgent()));
    expect(!(await page.evaluate(() => document.body.innerText)).includes('offline demo agent'), 'no demo agent');
    expect(entries().length === 0, 'nothing ran');
  } finally {
    await tab('settings');
    await tid('agent-set-cli').fill(FAKE);
    await tid('agent-check').click();
  }
  await until(async () => (await tid('agent-connection').innerText()).includes('claude code 9.9.9'), 'connected again');
  await runFromChat('покажи git log');
  await waitEntries(1);
  expect((await lastAgent()).includes('Done: checked'), 'Claude Code answered: ' + (await lastAgent()));
});

await step('settings: a provider that does not work yet answers so, instead of running a demo agent', async () => {
  clearLog();
  await openPanel();
  await tab('settings');
  await tid('agent-panel').getByText('Anthropic API key', { exact: true }).click();
  try {
    await until(async () => (await settings()).agent.provider === 'anthropic-api', 'the provider saved');
    expect(!(await has('agent-set-cli')), 'no Claude Code binary for this provider');
    const branches = git(WORK, 'branch', '--list');
    await runFromChat('создай ветку from-another-provider');
    await page.waitForTimeout(800);
    expect(git(WORK, 'branch', '--list') === branches, 'no branch made');
    expect((await lastAgent()).includes('Этот провайдер пока не работает'), 'says so: ' + (await lastAgent()));
  } finally {
    await tab('settings');
    await tid('agent-panel').getByText('Anthropic · local Claude Code', { exact: true }).click();
  }
  await until(async () => (await settings()).agent.provider === 'anthropic-claude-code', 'back on Claude Code');
});

await step('settings: the sources folder: Reveal and Open in editor ask the system for it; without a folder an interface request says to set one', async () => {
  await openPanel();
  await tab('settings');
  const n = systemCalls.length;
  await tid('agent-sources-reveal').click();
  await tid('agent-sources-editor').click();
  await until(async () => systemCalls.length >= n + 2, 'two system calls');
  const [reveal, open] = systemCalls.slice(n);
  expect(reveal.what === 'reveal' && sameDir(reveal.body.path, appSources), 'reveal the folder: ' + JSON.stringify(reveal));
  expect(open.what === 'open' && sameDir(open.body.path, appSources), 'open it in the editor: ' + JSON.stringify(open));
  clearLog();
  try {
    await tid('agent-set-sources').fill('');
    await until(async () => (await settings()).agent.sourcesPath === '', 'the folder cleared');
    expect((await tid('agent-sources-reveal').getAttribute('aria-disabled')) === 'true', 'nothing to reveal');
    await tab('chat');
    await pickTarget('app');
    await runFromChat('сделай тулбар компактнее');
    expect((await lastAgent()).includes('Укажите папку исходников приложения'), 'says to set the folder: ' + (await lastAgent()));
    expect(entries().length === 0, 'nothing ran');
  } finally {
    await tab('settings');
    await tid('agent-set-sources').fill(appSources);
    await until(async () => sameDir((await settings()).agent.sourcesPath, appSources), 'the folder back');
    await tab('chat');
    await pickTarget('auto');
  }
});

// ---------- versions of the interface ----------

await step('versions: an interface change from the command line: a card “Interface updated” that survives the reload; later cards stay apart from it', async () => {
  clearLog();
  // a fresh page: the cards it makes are counted from one
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await openRepoTab('agent-work');
  await runFromBar('git log first');
  await closeNotices();
  await runFromBar('убери кнопку темы edit-ui', { reload: true });
  await tid('agent-notice-card').first().waitFor({ timeout: 15000 });
  const [card] = await cards();
  expect(/interface updated/i.test(card) && card.includes('1 file edited') && !/more step/.test(card), 'the card: ' + card);
  expect(toolbarSrc().includes('edited by fake agent: убери кнопку темы edit-ui'), 'the sources changed');
  const v = await versionsNow();
  expect(v.length === 1 && v[0].status === 'applied', 'v1 recorded: ' + JSON.stringify(v));
  const errors = pageErrors.length;
  await runFromBar('git log second');
  await runFromBar('git log third');
  const now = await cards();
  expect(now.length === 3 && now.filter((c) => /interface updated/i.test(c)).length === 1, 'three cards: ' + now.length);
  // closing the card of the reload closes it alone
  const i = now.findIndex((c) => /interface updated/i.test(c));
  await tid('agent-notice-close').nth(i).click();
  await page.waitForTimeout(200);
  expect((await cards()).length === 2, 'the other two stay: ' + (await cards()).length);
  // and each of them closes (two cards shared an id with the one from before the reload and would not close)
  for (let k = 0; k < 4 && (await has('agent-notice-close')); k++) {
    await tid('agent-notice-close').first().click();
    await page.waitForTimeout(150);
  }
  expect((await cards()).length === 0, 'every card closed with its ×: ' + (await cards()).join(' | '));
  expect(!pageErrors.slice(errors).some((e) => /same key/.test(e)), 'no duplicate cards: ' + pageErrors.slice(errors).join(' | '));
});

await step('versions: the chat shows the change’s chip (v1 · applied, Revert, Log); Log opens Changes: v1 current over the factory build', async () => {
  await openPanel();
  await tab('chat');
  const chip = tid('agent-version-chip').last();
  await chip.waitFor({ timeout: 5000 });
  expect(/v1 · applied/i.test(await chip.innerText()), 'the chip: ' + (await chip.innerText()));
  expect(/version v1 · src\/Toolbar\.tsx/.test(await lastAgent()) || (await agentMsgs()).some((m) => /version v1 · src\/Toolbar\.tsx/.test(m)), 'the outcome line names the version');
  expect(/changes 1/i.test(await tid('agent-tab-changes').innerText()), 'the tab counts it: ' + (await tid('agent-tab-changes').innerText()));
  await chip.getByTestId('agent-chip-log').click();
  expect((await activeTab()) === 'changes', 'on Changes');
  expect(/current: v1 · 1 of 1 applied/i.test(await tid('agent-versions-head').innerText()), 'the head: ' + (await tid('agent-versions-head').innerText()));
  expect(/factory build/i.test(await tid('agent-version-0').innerText()) && /base/i.test(await tid('agent-version-0').innerText()), 'v0: ' + (await tid('agent-version-0').innerText()));
  expect(/убери кнопку темы edit-ui/.test(await tid('agent-version-1').innerText()) && /current/i.test(await tid('agent-version-1').innerText()) && /1 file/.test(await tid('agent-version-1').innerText()), 'v1: ' + (await tid('agent-version-1').innerText()));
  await shot('versions');
});

await step('versions: the chip in the chat reverts the change and re-applies it', async () => {
  await openPanel();
  await tab('chat');
  let mark = await buildMark();
  await tid('agent-version-chip').last().getByTestId('agent-chip-toggle').click();
  await waitNewBuild(mark);
  expect((await versionsNow())[0].status === 'reverted' && toolbarSrc() === BASELINE, 'reverted');
  await openPanel();
  const chip = tid('agent-version-chip').last();
  expect(/v1 · reverted/i.test(await chip.innerText()) && /re-apply/i.test(await chip.innerText()), 'the chip says so: ' + (await chip.innerText()));
  mark = await buildMark();
  await chip.getByTestId('agent-chip-toggle').click();
  await waitNewBuild(mark);
  expect((await versionsNow())[0].status === 'applied' && toolbarSrc().includes('убери кнопку темы'), 'applied again');
});

await step('versions: a version’s details show its prompt, files and diff; a file and Open in editor open it in the editor; Copy diff copies the patch', async () => {
  await openPanel();
  await tab('changes');
  await tid('agent-version-1').click();
  const d = tid('agent-version-details');
  await d.waitFor({ timeout: 3000 });
  await page.waitForFunction(() => /diff --git/.test(document.querySelector('[data-testid="agent-version-diff"]')?.innerText ?? ''), null, { timeout: 5000 });
  const text = await d.innerText();
  await shot('version-details');
  expect(text.includes('«убери кнопку темы edit-ui»') && text.includes('src/Toolbar.tsx'), 'prompt and files: ' + text);
  expect(text.includes('+// edited by fake agent: убери кнопку темы edit-ui') && text.includes('diff --git a/src/Toolbar.tsx'), 'the real diff: ' + text);
  const n = systemCalls.length;
  await d.getByTestId('agent-version-file').first().click();
  await d.getByTestId('agent-version-editor').click();
  await until(async () => systemCalls.length >= n + 2, 'the editor was asked twice');
  for (const c of systemCalls.slice(n)) expect(c.what === 'open' && sameDir(c.body.path, path.join(appSources, 'src/Toolbar.tsx')), 'opens the file: ' + JSON.stringify(c));
  await page.evaluate(() => navigator.clipboard.writeText('-'));
  await d.getByTestId('agent-version-copy').click();
  await until(async () => /^diff --git a\/src\/Toolbar\.tsx[\s\S]*\+\/\/ edited by fake agent/.test(await page.evaluate(() => navigator.clipboard.readText())), 'the patch is on the clipboard');
  await tid('agent-version-1').click();
  await waitGone('agent-version-details', 3000);
});

await step('versions: hover buttons stay under the pointer: Revert an older version, Re-apply it, Roll back here; the panel comes back on Changes after each reload', async () => {
  await runFromChat('сделай сайдбар уже edit-sidebar', { reload: true });
  let v = await versionsNow();
  expect(v.length === 2 && v.every((x) => x.status === 'applied') && sidebarSrc().includes('сделай сайдбар уже'), 'v2 recorded: ' + JSON.stringify(v.map((x) => x.status)));
  await openPanel();
  await tab('changes');
  await away();
  expect(/current/i.test(await tid('agent-version-2').innerText()) && /applied/i.test(await tid('agent-version-1').innerText()), 'v2 current, v1 applied');
  // Revert v1: the button appears on hover and stays while the pointer goes onto it
  let mark = await buildMark();
  await tid('agent-version-1').hover();
  await tid('agent-version-toggle-1').hover();
  await page.waitForTimeout(150);
  expect(await tid('agent-version-toggle-1').isVisible(), 'Revert stays under the pointer');
  await tid('agent-version-toggle-1').click();
  await waitNewBuild(mark);
  v = await versionsNow();
  expect(v[0].status === 'reverted' && v[1].status === 'applied', 'v1 reverted: ' + JSON.stringify(v.map((x) => x.status)));
  expect(toolbarSrc() === BASELINE && sidebarSrc().includes('сделай сайдбар уже'), 'only v1 is gone from the sources');
  await tid('agent-panel').waitFor({ timeout: 5000 });
  expect((await activeTab()) === 'changes', 'the panel is back on Changes: ' + (await activeTab()));
  await away();
  expect(/reverted/i.test(await tid('agent-version-1').innerText()), 'v1 shows reverted: ' + (await tid('agent-version-1').innerText()));
  // Re-apply it
  mark = await buildMark();
  await tid('agent-version-1').hover();
  await tid('agent-version-toggle-1').hover();
  expect(/re-apply/i.test(await tid('agent-version-toggle-1').innerText()), 'its button re-applies');
  await tid('agent-version-toggle-1').click();
  await waitNewBuild(mark);
  v = await versionsNow();
  expect(v.every((x) => x.status === 'applied') && toolbarSrc().includes('убери кнопку темы'), 'both applied again: ' + JSON.stringify(v.map((x) => x.status)));
  // Roll back to v1: v2 goes
  mark = await buildMark();
  await tid('agent-version-1').hover();
  await tid('agent-version-rollback-1').hover();
  expect(await tid('agent-version-rollback-1').isVisible(), 'Roll back here stays under the pointer');
  await tid('agent-version-rollback-1').click();
  await waitNewBuild(mark);
  v = await versionsNow();
  expect(v[0].status === 'applied' && v[1].status === 'reverted' && !existsSync(sidebarFile), 'rolled back to v1: ' + JSON.stringify(v.map((x) => x.status)));
  await away();
  expect(/current: v1 · 1 of 2 applied/i.test(await tid('agent-versions-head').innerText()), 'the head: ' + (await tid('agent-versions-head').innerText()));
});

await step('versions: the current version reverts from its own row', async () => {
  await openPanel();
  await tab('changes');
  const mark = await buildMark();
  await tid('agent-version-1').hover();
  await tid('agent-version-toggle-1').waitFor({ state: 'visible', timeout: 3000 });
  expect(/revert/i.test(await tid('agent-version-toggle-1').innerText()), 'Revert on the current version');
  await tid('agent-version-toggle-1').click();
  await waitNewBuild(mark);
  const v = await versionsNow();
  expect(v.every((x) => x.status === 'reverted'), 'nothing applied: ' + JSON.stringify(v.map((x) => x.status)));
  expect(toolbarSrc() === BASELINE, 'the sources are as they were');
  await away();
  expect(/current: factory · 0 of 2 applied/i.test(await tid('agent-versions-head').innerText()), 'the head: ' + (await tid('agent-versions-head').innerText()));
  expect((await tid('agent-reset-factory').getAttribute('aria-disabled')) === 'true', 'nothing to reset');
});

await step('versions: Reset to factory asks first, then reverts every applied version', async () => {
  await openPanel();
  await tab('changes');
  // re-apply both so that there is something to reset
  for (const n of [1, 2]) {
    const mark = await buildMark();
    await tid(`agent-version-${n}`).hover();
    await tid(`agent-version-toggle-${n}`).click();
    await waitNewBuild(mark);
    await tid('agent-panel').waitFor({ timeout: 5000 });
  }
  expect((await versionsNow()).every((x) => x.status === 'applied'), 'both applied');
  await tid('agent-reset-factory').click();
  await tid('modal').waitFor({ timeout: 3000 });
  expect(/reset to factory build\?/i.test(await tid('modal').innerText()), 'it asks: ' + (await tid('modal').innerText()));
  await page.keyboard.press('Escape');
  await waitGone('modal');
  expect((await versionsNow()).every((x) => x.status === 'applied'), 'Escape changed nothing');
  const mark = await buildMark();
  await tid('agent-reset-factory').click();
  await tid('modal').waitFor({ timeout: 3000 });
  await tid('modal').getByText('Reset', { exact: true }).click();
  await waitNewBuild(mark);
  const v = await versionsNow();
  expect(v.every((x) => x.status === 'reverted'), 'all reverted: ' + JSON.stringify(v.map((x) => x.status)));
  expect(toolbarSrc() === BASELINE && !existsSync(sidebarFile), 'the factory sources');
});

await step('versions: a version whose lines a later one changed cannot be reverted alone: the error says why, nothing changes', async () => {
  await openPanel();
  await tab('changes');
  let mark = await buildMark();
  await tid('agent-version-1').hover();
  await tid('agent-version-toggle-1').click();
  await waitNewBuild(mark);
  // a later change right under v1's line
  await runFromChat('добавь кнопку Terminal edit-ui', { reload: true });
  let v = await versionsNow();
  expect(v.length === 3 && v[0].status === 'applied' && v[2].status === 'applied', 'v1 and v3 applied: ' + JSON.stringify(v.map((x) => x.status)));
  const src = toolbarSrc();
  await openPanel();
  await tab('changes');
  expectedErrors.push(/status of 500/);
  await tid('agent-version-1').hover();
  await tid('agent-version-toggle-1').click();
  await tid('error-dialog').waitFor({ timeout: 10000 });
  const said = await tid('error-dialog').innerText();
  expect(/A later version changed the same lines of src\/Toolbar\.tsx/.test(said) && /Nothing was changed/.test(said) && !/hint:/.test(said), 'the error says why: ' + said);
  await tid('error-close').click();
  await waitGone('error-dialog');
  v = await versionsNow();
  expect(v[0].status === 'applied' && v[2].status === 'applied' && toolbarSrc() === src, 'nothing changed: ' + JSON.stringify(v.map((x) => x.status)));
  // what does work: back to the factory build (the later one is reverted first)
  mark = await buildMark();
  await tid('agent-reset-factory').click();
  await tid('modal').getByText('Reset', { exact: true }).click();
  await waitNewBuild(mark);
  expect((await versionsNow()).every((x) => x.status === 'reverted') && toolbarSrc() === BASELINE, 'reset worked');
});

await step('versions: with the rollback box off, a change that does not build stays recorded and can be reverted by hand', async () => {
  await openPanel();
  await tab('settings');
  await tid('agent-auto-rollback').click();
  await until(async () => (await settings()).agent.autoRollbackOnBuildError === false, 'the box saved');
  const count = (await versionsNow()).length;
  try {
    const mark = await buildMark();
    await runFromChat('сделай тулбар компактнее edit-ui BREAK');
    await page.waitForFunction(() => /Interface build failed/.test([...document.querySelectorAll('[data-testid="agent-msg-agent"]')].pop()?.innerText ?? ''), null, { timeout: 15000 });
    expect((await buildMark()) === mark, 'no reload into a broken build');
    let v = await versionsNow();
    expect(v.length === count + 1 && v[count].status === 'applied' && toolbarSrc().includes('BREAK'), 'the change stays: ' + JSON.stringify(v.map((x) => x.status)));
    expect(!(await lastAgent()).includes('rolled back'), 'not rolled back: ' + (await lastAgent()));
    // reverted by hand from its row: the build works again
    await tab('changes');
    await tid(`agent-version-${count + 1}`).hover();
    await tid(`agent-version-toggle-${count + 1}`).click();
    await waitNewBuild(mark);
    v = await versionsNow();
    expect(v[count].status === 'reverted' && toolbarSrc() === BASELINE, 'reverted by hand: ' + JSON.stringify(v.map((x) => x.status)));
  } finally {
    await openPanel();
    await tab('settings');
    await tid('agent-auto-rollback').click();
    await until(async () => (await settings()).agent.autoRollbackOnBuildError === true, 'the box back on');
  }
});

// ---------- Ask AI ----------

await step('Ask AI: an unexpected error of Prong goes to the agent in Prong’s sources, with the error and its stack; the chat opens on it', async () => {
  clearLog();
  await openRepoTab('agent-work');
  // the panel was left on Settings: Ask AI still shows the chat
  await openPanel();
  await tab('settings');
  await tid('agent-close').click();
  await page.evaluate(() => setTimeout(() => {
    throw new Error('e2e agent: a synthetic crash in a handler');
  }, 0));
  await tid('error-dialog').waitFor({ timeout: 5000 });
  await tid('error-ask-ai').click();
  await waitGone('error-dialog');
  await tid('agent-panel').waitFor({ timeout: 3000 });
  expect((await activeTab()) === 'chat', 'the chat: ' + (await activeTab()));
  const q = (await userMsgs()).pop();
  expect(q.includes('Prong сломался — найди причину в исходниках и исправь.') && q.includes('Unexpected error') && q.includes('e2e agent: a synthetic crash in a handler') && !q.includes('**'), 'the question: ' + q);
  const [e] = await waitEntries(1);
  await waitIdle();
  expect(sameDir(e.cwd, appSources) && e.resume === '', 'in Prong’s sources, a new conversation: ' + e.cwd);
  expect(e.prompt.includes('e2e agent: a synthetic crash in a handler') && e.prompt.includes('npx tsc --noEmit') && /### Причина/.test(e.prompt), 'the error, the rule and the answer format: ' + e.prompt.slice(0, 400));
});

await step('Ask AI: a failed connection test goes to the agent in that repository with the remote, the connection and git’s words', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await page.getByText('More', { exact: true }).first().click();
  await page.getByText('Connection (SSH key / account)…', { exact: true }).click();
  await tid('connection-dialog').waitFor({ timeout: 5000 });
  await tid('conn-test').click();
  await tid('conn-test-result').waitFor({ timeout: 20000 });
  expect((await tid('conn-test-result').innerText()).includes('Could not connect to origin'), 'the test failed: ' + (await tid('conn-test-result').innerText()));
  await tid('conn-ask-ai').click();
  await waitGone('connection-dialog');
  await tid('agent-panel').waitFor({ timeout: 3000 });
  const q = (await userMsgs()).pop();
  expect(q.includes('Разберись с ошибкой и исправь, если это безопасно.') && q.includes('Could not connect to origin') && /agent-work · ветка main/.test(q), 'the question: ' + q);
  const [e] = await waitEntries(1);
  await waitIdle();
  expect(sameDir(e.cwd, WORK), 'in the repository: ' + e.cwd);
  expect(e.prompt.includes('git ls-remote origin HEAD') && e.prompt.includes('agent-missing.git') && /does not appear to be a git repository|No such file|not found/i.test(e.prompt), 'the remote, the connection and git’s words: ' + e.prompt.slice(0, 600));
});

await step('Ask AI: a panel that keeps crashing offers Ask AI; it goes to the agent in Prong’s sources with the panel and the error', async () => {
  clearLog();
  await openRepoTab('agent-other');
  // the engine's answer makes the repository view throw on every render
  await page.route('**/api/repo/snapshotCached', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
  await page.route('**/api/repo/snapshot', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.commits?.[0]) body.commits[0].subject = { e2e: 'not a string' };
    await route.fulfill({ response: res, json: body });
  });
  try {
    await page.reload({ waitUntil: 'load' });
    await page.getByTestId('crash-ask-ai').waitFor({ timeout: 20000 });
    await shot('crash');
    await tid('crash-ask-ai').click();
    await tid('agent-panel').waitFor({ timeout: 3000 });
    const q = (await userMsgs()).pop() ?? '';
    expect(q.includes('Prong сломался') && /Repository crashed/.test(q), 'the question: ' + q);
    const [e] = await waitEntries(1);
    await waitIdle();
    expect(sameDir(e.cwd, appSources), 'in Prong’s sources: ' + e.cwd);
    expect(/Objects are not valid as a React child|not a string|e2e/i.test(e.prompt), 'the error itself: ' + e.prompt.slice(0, 500));
  } finally {
    await page.unroute('**/api/repo/snapshot');
    await page.unroute('**/api/repo/snapshotCached');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1500);
  }
});

await step('Ask AI: while the agent works it says it is busy and shows the chat; without Claude Code it says it is not available', async () => {
  clearLog();
  await openRepoTab('agent-work');
  await openBar();
  await tid('agent-input').fill('git gc slow task');
  await tid('agent-input').press('Enter');
  await tid('agent-status').waitFor({ timeout: 5000 });
  await page.evaluate(() => setTimeout(() => {
    throw new Error('e2e agent: while busy');
  }, 0));
  await tid('error-dialog').waitFor({ timeout: 5000 });
  await tid('error-ask-ai').click();
  await tid('agent-panel').waitFor({ timeout: 3000 });
  // the status panel shows the run, so the chat says it
  await page.waitForFunction(() => /Агент занят другим запросом/.test(document.querySelector('[data-testid="agent-panel"]')?.innerText ?? ''), null, { timeout: 3000 });
  expect(!(await userMsgs()).some((m) => m.includes('while busy')), 'not asked twice at once');
  await tid('agent-stop').click();
  await waitIdle();
  expect(entries().length === 1, 'only the running request');
  // Claude Code gone: the error window's Ask AI says so
  await tab('settings');
  await tid('agent-set-cli').fill('/nonexistent/claude');
  await tid('agent-check').click();
  await tid('error-dialog').waitFor({ timeout: 5000 });
  await tid('error-close').click();
  await waitGone('error-dialog');
  try {
    await page.evaluate(() => setTimeout(() => {
      throw new Error('e2e agent: no claude');
    }, 0));
    await tid('error-dialog').waitFor({ timeout: 5000 });
    await tid('error-ask-ai').click();
    await statusHas(/Claude Code is not available/);
    expect(entries().length === 1, 'nothing ran');
  } finally {
    await openPanel();
    await tab('settings');
    await tid('agent-set-cli').fill(FAKE);
    await tid('agent-check').click();
    await until(async () => (await tid('agent-connection').innerText()).includes('claude code 9.9.9'), 'connected again');
  }
});

// ---------- layout ----------

await step('layout: in a narrow window the command line and the panel fit, nothing sticks out', async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  try {
    await openRepoTab('agent-work');
    await openBar();
    const bar = await tid('agent-bar').boundingBox();
    const input = await tid('agent-input').boundingBox();
    expect(bar.x >= 0 && bar.x + bar.width <= 1000 && input.width >= 100, 'the line fits: ' + JSON.stringify({ bar, input: input.width }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
    await shot('narrow-bar');
    await tid('agent-expand').click();
    await tid('agent-panel').waitFor({ timeout: 3000 });
    if ((await activeTab()) !== 'chat') await tab('chat');
    const panel = await tid('agent-panel').boundingBox();
    expect(panel.x + panel.width <= 1001 && panel.x >= 500, 'the panel sits on the right: ' + JSON.stringify(panel));
    const send = await tid('agent-chat-send').boundingBox();
    expect(send && send.x + send.width <= 1000 && send.y + send.height <= 700, 'Send is on screen: ' + JSON.stringify(send));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll with the panel');
    await shot('narrow-panel');
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

await check('agent: no page errors besides the crash the suite made on purpose', async () => {
  const left = pageErrors.filter((e) => !expectedErrors.some((re) => re.test(e)));
  expect(left.length === 0, 'page errors: ' + left.join(' | '));
});

await finish('agent');
