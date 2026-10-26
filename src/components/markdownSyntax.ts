/**
 * The Markdown the agent writes (Claude Code answers in it), parsed for the chat: headings, paragraphs with line
 * breaks kept (as chat apps do), lists (nested, numbered), code blocks, quotes, rules, tables; inline code, bold,
 * italic, strikethrough, links and bare URLs. Anything it does not know stays text — nothing is lost.
 */

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'code'; s: string }
  | { t: 'b' | 'i' | 's'; c: Inline[] }
  | { t: 'a'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; s: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (l: string) => /^\s*/.exec(l)![0].replace(/\t/g, '    ').length;
const isTableRow = (l: string) => l.includes('|');
function startsBlock(lines: string[], i: number) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || LIST.test(l) || QUOTE.test(l) || (isTableRow(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]));
}
function cells(l: string): string[] {
  const row = l.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (row[i] === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += row[i];
  }
  out.push(cur.trim());
  return out;
}

export function parseMarkdown(src: string): Block[] {
  return blocks(src.replace(/\r\n?/g, '\n').split('\n'));
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(l);
    if (fence) {
      const [, ind, mark, lang] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && lines[i].trim().replace(new RegExp(`^\\${mark[0]}+`), '').trim() === '')) {
        // the block's own indentation (a fence inside a list item) is not part of the code
        const line = lines[i];
        body.push(line.startsWith(ind) ? line.slice(ind.length) : line.trimStart());
        i++;
      }
      i++; // the closing fence (or the end)
      out.push({ t: 'code', lang: lang.toLowerCase(), s: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(l);
    if (h) {
      out.push({ t: 'h', level: h[1].length, c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (RULE.test(l)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (isTableRow(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(l).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i])) {
        rows.push(cells(lines[i]).map(parseInline));
        i++;
      }
      out.push({ t: 'table', head, rows });
      continue;
    }
    if (QUOTE.test(l)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const q = QUOTE.exec(lines[i]);
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push({ t: 'quote', c: blocks(body) });
      continue;
    }
    const li = LIST.exec(l);
    if (li) {
      const base = indentOf(l);
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
        const content = indentOf(lines[i]) + m[2].length + 1;
        const body = [m[3]];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            // a blank line ends the item unless what follows is indented under it
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && indentOf(lines[j]) > base) {
              body.push('');
              i++;
              continue;
            }
            break;
          }
          const ind = indentOf(next);
          if (ind > base) {
            body.push(next.replace(/\t/g, '    ').slice(Math.min(ind, content)));
            i++;
            continue;
          }
          // a line that is not indented: a new item or block ends this one, plain text continues it
          if (startsBlock(lines, i)) break;
          body.push(next.trim());
          i++;
        }
        items.push(blocks(body));
      }
      out.push({ t: 'list', ordered, start, items });
      continue;
    }
    // a paragraph: up to a blank line or the start of another block; its line breaks are kept
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) {
      para.push(lines[i].trim());
      i++;
    }
    out.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return out;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|>]/;
const URL_AT = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"»)]/;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', s: text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        const code = s.slice(i + run.length, end);
        out.push({ t: 'code', s: /^ .* $/.test(code) ? code.slice(1, -1) : code });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === '*' || ch === '_') {
      const dbl = s[i + 1] === ch;
      const mark = dbl ? ch + ch : ch;
      const next = s[i + mark.length];
      // an opening mark is followed by text; `snake_case` is not emphasis
      if (next && !/\s/.test(next) && !(ch === '_' && /[\p{L}\p{N}]/u.test(prev))) {
        const close = closing(s, i + mark.length, mark);
        if (close > 0) {
          flush();
          out.push({ t: dbl ? 'b' : 'i', c: parseInline(s.slice(i + mark.length, close)) });
          i = close + mark.length;
          continue;
        }
      }
      text += mark;
      i += mark.length;
      continue;
    }
    if (ch === '~' && s[i + 1] === '~') {
      const close = s.indexOf('~~', i + 2);
      if (close > i + 2) {
        flush();
        out.push({ t: 's', c: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: 'a', href: m[2], c: parseInline(m[1] || m[2]) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '<') {
      const m = /^<(https?:\/\/[^>\s]+)>/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: 'a', href: m[1], c: [{ t: 'text', s: m[1] }] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === 'h' && !/[\p{L}\p{N}/]/u.test(prev)) {
      const m = URL_AT.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: 'a', href: m[0], c: [{ t: 'text', s: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** where an emphasis that opens at `from` closes: after text, not inside code, not mid-word for `_` */
function closing(s: string, from: number, mark: string): number {
  const ch = mark[0];
  let j = from;
  while (j < s.length) {
    if (s[j] === '`') {
      const run = /^`+/.exec(s.slice(j))![0];
      const end = s.indexOf(run, j + run.length);
      if (end < 0) return -1;
      j = end + run.length;
      continue;
    }
    if (s[j] === '\n' && s[j + 1] === '\n') return -1;
    // a single mark looking for its end steps over a double one (bold inside italics)
    if (mark.length === 1 && s[j] === ch && s[j + 1] === ch) {
      j += 2;
      continue;
    }
    if (s.startsWith(mark, j) && j > from && !/\s/.test(s[j - 1])) {
      if (ch === '_' && /[\p{L}\p{N}]/u.test(s[j + mark.length] ?? '')) {
        j++;
        continue;
      }
      return j;
    }
    j++;
  }
  return -1;
}

/** the plain text of inline content (for widths and copying) */
export function plain(c: Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.s : x.t === 'br' ? '\n' : plain(x.c))).join('');
}
