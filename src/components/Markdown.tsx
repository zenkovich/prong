import React, { useMemo } from 'react';
import { ScrollView, Text, TextStyle, View } from 'react-native';
import * as live from '../state/live';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { PressScale, Txt } from '../ui/primitives';
import { Block, Inline, parseMarkdown, plain } from './markdownSyntax';

/**
 * The agent's Markdown in the chat (and its notices): headings, lists, code blocks with a copy button, tables that
 * scroll sideways in the narrow panel, links that open in the browser. Text stays selectable.
 */
export function Markdown({ text, size = FONT.md, testID }: { text: string; size?: number; testID?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View testID={testID}>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} size={size} first={i === 0} />
      ))}
    </View>
  );
}

function BlockView({ b, size, first }: { b: Block; size: number; first: boolean }) {
  const t = useTheme();
  const gap = first ? 0 : 6;
  const line = Math.round(size * 1.45);
  switch (b.t) {
    case 'p':
      return (
        <Txt size={size} selectable style={{ marginTop: gap, lineHeight: line }}>
          <Spans c={b.c} />
        </Txt>
      );
    case 'h':
      return (
        <Txt size={b.level <= 2 ? size + 2 : size} weight="700" selectable style={{ marginTop: first ? 0 : 10, lineHeight: line + 2 }}>
          <Spans c={b.c} />
        </Txt>
      );
    case 'code':
      return <CodeBlock lang={b.lang} code={b.s} gap={gap} />;
    case 'list':
      return (
        <View style={{ marginTop: gap }}>
          {b.items.map((item, k) => (
            <View key={k} style={{ flexDirection: 'row', marginTop: k ? 3 : 0 }}>
              <Txt size={size} color={b.ordered ? t.textMuted : t.accent} style={{ width: b.ordered ? 22 : 14, lineHeight: line }}>
                {b.ordered ? `${b.start + k}.` : '•'}
              </Txt>
              <View style={{ flex: 1, minWidth: 0 }}>
                {item.map((x, j) => (
                  <BlockView key={j} b={x} size={size} first={j === 0} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={{ marginTop: gap, borderLeftWidth: 2, borderLeftColor: t.borderStrong, paddingLeft: 8 }}>
          {b.c.map((x, j) => (
            <BlockView key={j} b={x} size={size} first={j === 0} />
          ))}
        </View>
      );
    case 'hr':
      return <View style={{ height: 1, backgroundColor: t.border, marginVertical: 8 }} />;
    case 'table':
      return <Table head={b.head} rows={b.rows} size={size} gap={gap} />;
  }
}

/** inline content as nested Text: bold and italics, `code` on a tinted ground, links */
function Spans({ c }: { c: Inline[] }) {
  const t = useTheme();
  return (
    <>
      {c.map((x, i) => {
        switch (x.t) {
          case 'text':
            return x.s;
          case 'br':
            return '\n';
          case 'code':
            return (
              // padding rather than spaces around it: copied text stays as written
              <Text key={i} style={{ color: t.accent, backgroundColor: t.bg, fontFamily: t.fontFor('500'), paddingHorizontal: 3 } as TextStyle}>
                {x.s}
              </Text>
            );
          case 'b':
            return (
              <Text key={i} style={{ fontFamily: t.fontFor('700') }}>
                <Spans c={x.c} />
              </Text>
            );
          case 'i':
            return (
              <Text key={i} style={{ fontStyle: 'italic' } as TextStyle}>
                <Spans c={x.c} />
              </Text>
            );
          case 's':
            return (
              <Text key={i} style={{ textDecorationLine: 'line-through', color: t.textMuted }}>
                <Spans c={x.c} />
              </Text>
            );
          case 'a':
            return (
              <Text key={i} style={{ color: t.info, textDecorationLine: 'underline' }} onPress={() => void live.openUrl(x.href)} {...({ href: x.href } as any)}>
                <Spans c={x.c} />
              </Text>
            );
        }
      })}
    </>
  );
}

function CodeBlock({ lang, code, gap }: { lang: string; code: string; gap: number }) {
  const t = useTheme();
  return (
    <View style={{ marginTop: gap, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg }} testID="md-code">
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 4 }}>
        <Txt label size={9} faint style={{ flex: 1 }}>
          {lang || 'code'}
        </Txt>
        <PressScale onPress={() => live.copyText(code)} scaleTo={0.9} style={{ padding: 3 }} hoverStyle={{ backgroundColor: t.hover }} label="Copy" testID="md-code-copy">
          <Icon name="copy" size={11} />
        </PressScale>
      </View>
      {/* wrapped, not scrolled sideways: git's long lines stay readable in the narrow panel; Copy gives them as written */}
      <View style={{ paddingHorizontal: 8, paddingBottom: 7, paddingTop: 2 }}>
        <Txt size={FONT.sm} selectable style={{ lineHeight: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as any}>
          {code}
        </Txt>
      </View>
    </View>
  );
}

/** columns as wide as their longest cell (within limits); the table scrolls sideways when the panel is narrow */
function Table({ head, rows, size, gap }: { head: Inline[][]; rows: Inline[][][]; size: number; gap: number }) {
  const t = useTheme();
  const n = Math.max(head.length, ...rows.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, k) => {
    const longest = Math.max(plain(head[k] ?? []).length, ...rows.map((r) => plain(r[k] ?? []).length));
    return Math.min(260, Math.max(48, longest * size * 0.62 + 14));
  });
  const row = (cells: Inline[][], header: boolean, key: number) => (
    <View key={key} style={{ flexDirection: 'row', backgroundColor: header ? t.panelAlt : 'transparent' }}>
      {widths.map((w, k) => (
        <View key={k} style={{ width: w, paddingHorizontal: 6, paddingVertical: 3, borderColor: t.border, borderRightWidth: k < n - 1 ? 1 : 0, borderTopWidth: key ? 1 : 0 }}>
          <Txt size={size - 0.5} weight={header ? '700' : undefined} selectable>
            <Spans c={cells[k] ?? []} />
          </Txt>
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal style={{ marginTop: gap }} contentContainerStyle={{ borderWidth: 1, borderColor: t.border }}>
      <View>
        {row(head, true, 0)}
        {rows.map((r, k) => row(r, false, k + 1))}
      </View>
    </ScrollView>
  );
}
