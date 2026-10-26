import { describe, expect, it } from 'vitest';
import { plan } from './mockAgent';

describe('mock agent command parser', () => {
  it('maps repository commands in Russian and English', () => {
    expect(plan('создай ветку feature/x', 'auto')).toMatchObject({ kind: 'repo', actions: [{ run: 'createBranch', arg: 'feature/x' }] });
    expect(plan('create branch hotfix', 'auto')).toMatchObject({ kind: 'repo', actions: [{ run: 'createBranch', arg: 'hotfix' }] });
    expect(plan('закоммить: fix graph', 'auto')).toMatchObject({ kind: 'repo', actions: [{ run: 'stageAll' }, { run: 'commit', arg: 'fix graph' }] });
    expect(plan('запушь', 'auto')).toMatchObject({ kind: 'repo', actions: [{ run: 'push' }] });
    expect(plan('ребейз на origin/main', 'auto')).toMatchObject({ kind: 'repo', actions: [{ run: 'rebase', arg: 'origin/main' }] });
    expect(plan('переключись на main', 'auto')).toMatchObject({ kind: 'repo', actions: [{ run: 'checkout', arg: 'main' }] });
    expect(plan('сверни мержи', 'auto')).toMatchObject({ kind: 'repo', actions: [{ run: 'collapseAll' }] });
  });
  it('maps interface commands to AppMods patches with files', () => {
    const p = plan('скрой колонку автора', 'auto');
    expect(p).toMatchObject({ kind: 'app', patch: { hideAuthor: true } });
    expect((p as any).files).toContain('src/components/CommitList.tsx');
    expect(plan('компактный тулбар', 'auto')).toMatchObject({ kind: 'app', patch: { compactToolbar: true } });
    expect(plan('убери кнопку Merge', 'auto')).toMatchObject({ kind: 'app', patch: { hiddenToolbarButtons: ['merge'] } });
    expect(plan('добавь кнопку Terminal', 'auto')).toMatchObject({ kind: 'app', patch: { extraToolbarButtons: ['terminal'] } });
    expect(plan('схема на Ice', 'auto')).toMatchObject({ kind: 'app', patch: { scheme: 'ice' } });
  });
  it('respects the explicit target and explains unknown requests', () => {
    expect(plan('компактный тулбар', 'repo').kind).toBe('help');
    expect(plan('запушь', 'app').kind).toBe('help');
    expect(plan('напиши стихотворение', 'auto')).toMatchObject({ kind: 'help' });
  });
});
