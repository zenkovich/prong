/**
 * The harness itself: a suite runs in a process of its own, a repository of its own shows up and opens.
 */
import { check, freshRepo, openRepo, page, finish, waitText } from '../harness.mjs';

await check('smoke: a suite gets the start screen, its own repository is listed and opens on its Changes', async () => {
  await freshRepo('smoke-repo', { 'README.md': '# smoke\n', 'src/a.txt': 'a\n' });
  await page.getByText('smoke-repo', { exact: true }).first().waitFor({ timeout: 10000 });
  await openRepo('smoke-repo');
  await waitText('Initial commit');
});

await finish('smoke');
