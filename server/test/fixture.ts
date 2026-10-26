import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Repo } from '../src/git/repo.js';
import { runGit } from '../src/git/run.js';

/** Builds a small history: main with 3 commits, feature branch with 2 commits merged, a tag, a bare "origin". */
export async function makeFixtureRepo(root: string) {
  const dir = path.join(root, 'work');
  const repo = await Repo.init(dir);
  await repo.setConfig('user.name', 'Test User');
  await repo.setConfig('user.email', 'test@example.com');
  await repo.setConfig('commit.gpgsign', 'false');
  const write = (f: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), content);
  };
  write('README.md', '# Fixture\n');
  write('src/a.ts', 'const a = 1;\nconst b = 2;\nexport default a + b;\n');
  await repo.stageAll();
  await repo.commit('Initial commit');
  write('src/a.ts', 'const a = 1;\nconst b = 3;\nexport default a + b;\n');
  await repo.stageAll();
  await repo.commit('Change b');
  await repo.createBranch('feature/x', 'HEAD', true);
  write('src/feature.ts', 'export const f = 1;\n');
  await repo.stageAll();
  await repo.commit('Add feature');
  write('src/feature.ts', 'export const f = 2;\n');
  await repo.stageAll();
  await repo.commit('Tweak feature');
  await repo.checkout('main');
  write('docs/guide.md', 'guide\n');
  await repo.stageAll();
  await repo.commit('Add guide');
  await repo.merge('feature/x', { noFf: true });
  await repo.createTag('v1.0.0', 'HEAD', 'Release 1.0');
  // bare remote
  const bare = path.join(root, 'origin.git');
  await runGit(['init', '--bare', bare], { cwd: root });
  await repo.git(['remote', 'add', 'origin', bare]);
  await repo.push({ remote: 'origin', branch: 'main', setUpstream: true });
  return { repo, dir, bare, write };
}

