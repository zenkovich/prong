import { describe, expect, it } from 'vitest';
import { classifyAgentTarget, RETARGET_MARKER } from './classify';

describe('classifyAgentTarget', () => {
  it('routes UI requests to the app sources even when they mention git nouns', () => {
    for (const s of [
      'сделай чтобы теги, remotes и стеши в левой панели были по умолчанию свернуты',
      'скрой колонку автора в списке коммитов',
      'сделай тулбар компактнее',
      'make the sidebar wider',
      'collapse the tags section by default',
      'добавь кнопку Terminal',
      'поменяй цвет выделения на синий',
      'граф толще',
    ]) expect(classifyAgentTarget(s), s).toBe('app');
  });
  it('routes git work to the repository', () => {
    for (const s of ['создай ветку feature/x', 'закоммить: wire agent panel', 'ребейз на origin/main', 'push the current branch', 'удали ветку tmp/old', 'покажи diff последнего коммита', 'переключись на master', 'сделай stash']) expect(classifyAgentTarget(s), s).toBe('repo');
  });
  it('recognises the retarget marker', () => {
    expect(RETARGET_MARKER.exec('I cannot do this here.\nPRONG_TARGET: app')?.[1]).toBe('app');
    expect(RETARGET_MARKER.test('Done, created the branch.')).toBe(false);
  });
});
