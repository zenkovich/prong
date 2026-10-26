import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, plain } from './markdownSyntax';

describe('markdown for the agent chat', () => {
  it('reads an agent answer: bold outcome, headings, bullets with code, a shell block', () => {
    const md = [
      '**Fetch works again**',
      '',
      '### Причина',
      '- ветка `hs/tmp/fix` удалена на сервере',
      '- в `remote.origin.fetch` осталась её строка',
      '',
      '### Что сделать вам',
      '```sh',
      'git config --unset remote.origin.fetch "+refs/heads/hs/tmp/fix:"',
      'git fetch',
      '```',
    ].join('\n');
    const b = parseMarkdown(md);
    expect(b.map((x) => x.t)).toEqual(['p', 'h', 'list', 'h', 'code']);
    expect(b[0]).toEqual({ t: 'p', c: [{ t: 'b', c: [{ t: 'text', s: 'Fetch works again' }] }] });
    expect(b[1]).toMatchObject({ t: 'h', level: 3 });
    const list = b[2] as Extract<(typeof b)[number], { t: 'list' }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[0][0]).toEqual({ t: 'p', c: [{ t: 'text', s: 'ветка ' }, { t: 'code', s: 'hs/tmp/fix' }, { t: 'text', s: ' удалена на сервере' }] });
    expect(b[4]).toEqual({ t: 'code', lang: 'sh', s: 'git config --unset remote.origin.fetch "+refs/heads/hs/tmp/fix:"\ngit fetch' });
  });

  it('keeps line breaks inside a paragraph, as a chat does', () => {
    expect(parseMarkdown('one\ntwo')).toEqual([{ t: 'p', c: [{ t: 'text', s: 'one' }, { t: 'br' }, { t: 'text', s: 'two' }] }]);
  });

  it('numbered and nested lists, a code block inside an item', () => {
    const b = parseMarkdown('1. first\n   - inner\n2. second\n\n   ```\n   git status\n   ```\n3. third');
    const list = b[0] as any;
    expect(list).toMatchObject({ t: 'list', ordered: true, start: 1 });
    expect(list.items).toHaveLength(3);
    expect(list.items[0][1]).toMatchObject({ t: 'list', ordered: false });
    expect(list.items[1][1]).toEqual({ t: 'code', lang: '', s: 'git status' });
  });

  it('tables, quotes, rules', () => {
    const b = parseMarkdown('| file | state |\n|---|:--:|\n| `a.ts` | M |\n| b\\|c | A |\n\n> note\n> more\n\n---');
    expect(b[0]).toMatchObject({ t: 'table' });
    const table = b[0] as any;
    expect(plain(table.head[0])).toBe('file');
    expect(table.rows.map((r: any) => r.map(plain))).toEqual([['a.ts', 'M'], ['b|c', 'A']]);
    expect(b[1]).toMatchObject({ t: 'quote', c: [{ t: 'p' }] });
    expect(b[2]).toEqual({ t: 'hr' });
  });

  it('inline: italic, bold inside italic, strikethrough, links, bare URLs; snake_case and lone stars stay text', () => {
    expect(parseInline('*a **b** c*')).toEqual([{ t: 'i', c: [{ t: 'text', s: 'a ' }, { t: 'b', c: [{ t: 'text', s: 'b' }] }, { t: 'text', s: ' c' }] }]);
    expect(parseInline('~~old~~ [docs](https://git-scm.com/docs) and https://github.com/x.')).toEqual([
      { t: 's', c: [{ t: 'text', s: 'old' }] },
      { t: 'text', s: ' ' },
      { t: 'a', href: 'https://git-scm.com/docs', c: [{ t: 'text', s: 'docs' }] },
      { t: 'text', s: ' and ' },
      { t: 'a', href: 'https://github.com/x', c: [{ t: 'text', s: 'https://github.com/x' }] },
      { t: 'text', s: '.' },
    ]);
    expect(parseInline('fetch_head and 2 * 3 * 4')).toEqual([{ t: 'text', s: 'fetch_head and 2 * 3 * 4' }]);
    expect(parseInline('a `**not bold**` b')).toEqual([{ t: 'text', s: 'a ' }, { t: 'code', s: '**not bold**' }, { t: 'text', s: ' b' }]);
    expect(parseInline('\\*literal\\*')).toEqual([{ t: 'text', s: '*literal*' }]);
  });

  it('an unclosed fence takes the rest as code; plain text stays as it is', () => {
    expect(parseMarkdown('```\nhalf')).toEqual([{ t: 'code', lang: '', s: 'half' }]);
    expect(parseMarkdown('Проверил ветки, всё на месте.')).toEqual([{ t: 'p', c: [{ t: 'text', s: 'Проверил ветки, всё на месте.' }] }]);
  });
});
