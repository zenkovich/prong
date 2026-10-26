import React, { useEffect, useLayoutEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { FONT, useTheme } from '../theme';
import { closeDialog, dismissToast, getState, hideContextMenu, hidePicker, PickerState, useStore } from '../state/store';
import { Icon } from './Icon';
import { Button, DragHandle, Glass, Input, Kbd, PressScale, ResizeGrip, Txt, noSelect, useKeyboard, useViewport } from './primitives';

const native = Platform.OS !== 'web';

/** Generic dialog shell: dimmed backdrop (content stays visible through the glass) + frosted card. */
export function Modal({ title, children, width = 520, footer, onClose, icon, layer }: {
  /** 'error': the error dialog, above every other dialog; Escape closes it alone */
  layer?: 'error';
  title: string;
  children: React.ReactNode;
  width?: number;
  footer?: React.ReactNode;
  onClose?: () => void;
  icon?: React.ReactNode;
}) {
  const t = useTheme();
  const vp = useViewport();
  const v = useState(() => new Animated.Value(0))[0];
  // user-adjusted geometry: width always, height only after a resize, offset after a drag
  const [w, setW] = useState(width);
  const [h, setH] = useState<number | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 120 * t.motion, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
  }, [v, t.motion]);
  const close = onClose ?? closeDialog;
  // while the error dialog is open, keys belong to it, not to the dialog underneath (see useKeyboard)
  useKeyboard(
    (e) => {
      // an open menu or dropdown above the dialog takes the Escape
      if (e.key === 'Escape' && !e.consumed) close();
    },
    { errorLayer: layer === 'error' },
  );
  const maxW = Math.max(280, vp.width - 24);
  const maxH = Math.max(200, vp.height - 24);
  const cw = Math.min(w, maxW);
  const ch = h === null ? null : Math.min(h, maxH);
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: layer === 'error' ? 120 : 100 }]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.shadow, opacity: v }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="box-none">
        <Animated.View style={{ width: cw, height: ch ?? undefined, maxHeight: maxH, opacity: v, transform: [{ translateX: pos.x }, { translateY: pos.y }, { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) }] }}>
          <Glass style={{ flex: ch ? 1 : undefined, maxHeight: maxH }}>
            <DragHandle onDelta={(dx, dy) => setPos((p) => ({ x: p.x + dx, y: p.y + dy }))}>
              <View style={[styles.cardHeader, { borderColor: t.glassBorder }]}>
                <Txt color={t.accent} weight="700" size={FONT.md} style={{ marginRight: 8 }}>
                  ▸
                </Txt>
                {icon}
                <Txt label size={FONT.sm} style={{ flex: 1, marginLeft: icon ? 8 : 0 }}>
                  {title}
                </Txt>
                <PressScale onPress={close} scaleTo={0.9} style={{ padding: 4 }} hoverStyle={{ backgroundColor: t.hover }}>
                  <Icon name="x" size={13} />
                </PressScale>
              </View>
            </DragHandle>
            <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: 14 }}>
              {children}
            </ScrollView>
            {footer && <View style={[styles.cardFooter, { borderColor: t.glassBorder }]}>{footer}</View>}
            <ResizeGrip
              onDelta={(dx, dy) => {
                setW((x) => Math.max(280, Math.min(maxW, x + dx)));
                setH((y) => Math.max(200, Math.min(maxH, (y ?? Math.min(maxH, 420)) + dy)));
              }}
            />
          </Glass>
        </Animated.View>
      </View>
    </View>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm }: { title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }) {
  const t = useTheme();
  return (
    <Modal
      title={title}
      width={420}
      icon={<Icon name={danger ? 'warning' : 'info'} size={16} color={danger ? t.warn : t.info} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button
            label={confirmLabel ?? 'OK'}
            primary={!danger}
            danger={danger}
            style={{ marginLeft: 8 }}
            onPress={() => {
              closeDialog();
              onConfirm();
            }}
          />
        </>
      }
    >
      <Txt muted>{message}</Txt>
    </Modal>
  );
}

export function ContextMenuHost() {
  const t = useTheme();
  const menu = useStore((s) => s.contextMenu);
  const { width, height } = useViewport();
  const v = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    if (menu) {
      v.setValue(0);
      Animated.timing(v, { toValue: 1, duration: 80 * t.motion, easing: Easing.out(Easing.quad), useNativeDriver: native }).start();
    }
  }, [menu, v, t.motion]);
  useKeyboard((e) => {
    if (e.key === 'Escape' && getState().contextMenu) {
      hideContextMenu();
      e.consume();
    }
  });
  if (!menu) return null;
  const menuW = 290;
  const itemH = 24;
  const menuH = menu.items.reduce((h, i) => h + (i.separator ? 9 : itemH), 8);
  const x = Math.min(menu.x, width - menuW - 8);
  const y = Math.min(menu.y, height - menuH - 8);
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 110 }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={hideContextMenu} onPointerDown={(e: any) => e?.nativeEvent?.button === 2 && hideContextMenu()} />
      <Animated.View style={[styles.menu, { left: x, top: y, width: menuW, opacity: v }]}>
        <Glass style={{ paddingVertical: 4 }}>
          {menu.items.map((it, i) =>
            it.separator ? (
              <View key={i} style={{ height: 1, backgroundColor: t.glassBorder, marginVertical: 4 }} />
            ) : (
              <PressScale
                key={i}
                disabled={it.disabled}
                scaleTo={1}
                onPress={() => {
                  hideContextMenu();
                  it.onPress?.();
                }}
                style={[styles.menuItem, { height: itemH }]}
                hoverStyle={{ backgroundColor: it.danger ? t.del : t.accent }}
              >
                {({ hovered }) => (
                  <>
                    <Txt size={FONT.sm} numberOfLines={1} color={hovered ? (it.danger ? '#1a0b0a' : t.accentText) : it.danger ? t.del : t.text} style={{ flex: 1 }}>
                      {it.label}
                    </Txt>
                    {it.shortcut ? (
                      <Txt size={FONT.xs} color={hovered ? t.accentText : t.textFaint}>
                        {it.shortcut}
                      </Txt>
                    ) : null}
                  </>
                )}
              </PressScale>
            ),
          )}
        </Glass>
      </Animated.View>
    </View>
  );
}

/** at most this many rows of a dropdown are drawn: a filter narrows the rest (2 400 remote branches) */
const PICK_ROWS = 200;

/**
 * A dialog field's dropdown, drawn above the dialog: the choices under the field (or above it near the bottom of
 * the window), the current one ticked, a filter on top for long lists; arrows and Enter pick, Escape closes it alone.
 */
/** the open list's arrows and Enter (set while a list is open) */
let pickerKeys: ((key: string) => void) | null = null;

export function PickerHost() {
  const picker = useStore((s) => s.picker);
  // here, not in the list: this host is mounted before any dialog, so its keys come first and the dialog under
  // the list sees them as taken (Escape closes the list alone, Enter picks instead of running the dialog)
  useKeyboard((e) => {
    if (!getState().picker) return;
    if (e.key === 'Escape') {
      hidePicker();
      e.consume();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault();
      e.consume();
      pickerKeys?.(e.key);
    }
  });
  return picker ? <PickerList key={picker.id} picker={picker} /> : null;
}

function PickerList({ picker }: { picker: PickerState }) {
  const t = useTheme();
  const { width, height } = useViewport();
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(() => Math.max(0, picker.options.findIndex((o) => o.value === picker.value)));
  const needle = q.trim().toLowerCase();
  const matches = needle ? picker.options.filter((o) => o.label.toLowerCase().includes(needle) || o.hint?.toLowerCase().includes(needle)) : picker.options;
  const shown = matches.slice(0, PICK_ROWS);
  const pick = (v: string) => {
    const p = getState().picker;
    hidePicker();
    p?.onPick(v);
  };
  useLayoutEffect(() => {
    pickerKeys = (key) => {
      if (key === 'Enter') {
        if (shown[cursor]) pick(shown[cursor].value);
      } else setCursor((c) => Math.max(0, Math.min(shown.length - 1, c + (key === 'ArrowDown' ? 1 : -1))));
    };
    return () => {
      pickerKeys = null;
    };
  });
  const rowH = 24;
  const filterH = picker.filter ? 34 : 0;
  const listH = Math.min(320, Math.max(rowH, shown.length * rowH + (matches.length > shown.length ? rowH : 0)));
  const boxH = listH + filterH + 8;
  const w = Math.max(picker.anchor.w, 260);
  const x = Math.max(8, Math.min(picker.anchor.x, width - w - 8));
  const below = picker.anchor.y + picker.anchor.h + 2;
  const y = below + boxH <= height - 8 ? below : Math.max(8, picker.anchor.y - boxH - 2);
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 115 }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={hidePicker} />
      <View style={[styles.menu, { left: x, top: y, width: w }]} testID={picker.testID ?? 'picker'}>
        <Glass style={{ paddingVertical: 4 }}>
          {picker.filter && (
            <View style={{ paddingHorizontal: 6, paddingBottom: 4 }}>
              <Input value={q} onChange={(v) => { setQ(v); setCursor(0); }} placeholder={`filter ${picker.options.length}`} mono small autoFocus testID="picker-filter" />
            </View>
          )}
          <ScrollView style={{ maxHeight: listH }}>
            {shown.map((o, i) => {
              const on = o.value === picker.value;
              return (
                <PressScale key={o.value} scaleTo={1} onPress={() => pick(o.value)} onHover={(h) => h && setCursor(i)} style={[styles.menuItem, { height: rowH }, i === cursor && { backgroundColor: t.accent }]} testID={`pick-${o.value}`}>
                  <Txt size={FONT.sm} color={i === cursor ? t.accentText : t.accent} style={{ width: 14 }}>
                    {on ? '✓' : ''}
                  </Txt>
                  <Txt size={FONT.sm} numberOfLines={1} color={i === cursor ? t.accentText : t.text} weight={on ? '600' : undefined} style={{ flex: 1 }}>
                    {o.label}
                  </Txt>
                  {o.hint ? (
                    <Txt size={FONT.xs} numberOfLines={1} color={i === cursor ? t.accentText : t.textFaint} style={{ marginLeft: 8, maxWidth: '45%' }}>
                      {o.hint}
                    </Txt>
                  ) : null}
                </PressScale>
              );
            })}
            {matches.length > shown.length && (
              <Txt size={FONT.xs} faint style={{ paddingHorizontal: 10, height: rowH, lineHeight: rowH }}>
                {matches.length - shown.length} more — type to narrow
              </Txt>
            )}
            {!matches.length && (
              <Txt size={FONT.xs} faint style={{ paddingHorizontal: 10, height: rowH, lineHeight: rowH }}>
                nothing matches
              </Txt>
            )}
          </ScrollView>
        </Glass>
      </View>
    </View>
  );
}

export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  const agent = useStore((s) => s.agent);
  return (
    <View style={[styles.toastHost, agent.open && { right: agent.width + 14 }]} pointerEvents="box-none">
      {toasts.map((tt) => (
        <ToastCard key={tt.id} id={tt.id} text={tt.text} kind={tt.kind} detail={tt.detail} />
      ))}
    </View>
  );
}

function ToastCard({ id, text, kind, detail }: { id: number; text: string; kind: 'info' | 'success' | 'error'; detail?: string }) {
  const t = useTheme();
  const v = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 100 * t.motion, useNativeDriver: native }).start();
  }, [v, t.motion]);
  const color = kind === 'success' ? t.add : kind === 'error' ? t.del : t.info;
  const tag = kind === 'success' ? 'OK' : kind === 'error' ? 'ERR' : 'INFO';
  return (
    <Animated.View style={{ opacity: v, marginTop: 6 }}>
      <Glass style={styles.toast}>
        <View style={{ width: 3, alignSelf: 'stretch', backgroundColor: color, marginRight: 10 }} />
        <Txt label size={10} color={color} style={{ marginRight: 8, width: 32 }}>
          {tag}
        </Txt>
        <View style={{ flex: 1 }}>
          <Txt>{text}</Txt>
          {detail ? (
            <Txt muted size={FONT.sm}>
              {detail}
            </Txt>
          ) : null}
        </View>
        <PressScale onPress={() => dismissToast(id)} style={{ padding: 4 }} scaleTo={0.9}>
          <Icon name="x" size={11} />
        </PressScale>
      </Glass>
    </Animated.View>
  );
}

export function ShortcutsDialog() {
  const items: [string, string][] = [
    ['⌘ T', 'New tab / open repository'],
    ['⌘ W', 'Close tab'],
    ['⌘ 1', 'Local changes'],
    ['⌘ 2', 'All commits'],
    ['⌘ ⏎', 'Commit'],
    ['⌘ ⇧ F', 'Fetch'],
    ['⌘ ⇧ L', 'Pull'],
    ['⌘ ⇧ P', 'Push'],
    ['⌘ F', 'Search commits'],
    ['⌘ K', 'Command palette'],
    ['⌘ ,', 'Preferences'],
    ['⌘ B', 'Toggle sidebar'],
    ['⌘ J', 'Ask the agent (command line)'],
    ['⌘ ⇧ J', 'Agent chat window'],
    ['← / →', 'Collapse / expand merge'],
    ['Space', 'Stage / unstage selected file'],
    ['F7 / F8', 'Next / previous hunk'],
    ['Esc', 'Close dialog'],
  ];
  return (
    <Modal title="Keyboard shortcuts" width={440}>
      {items.map(([k, d]) => (
        <View key={k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 3 }}>
          <Txt style={{ flex: 1 }}>{d}</Txt>
          <Kbd>{k}</Kbd>
        </View>
      ))}
    </Modal>
  );
}

const styles = StyleSheet.create({
  cardHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 38, borderBottomWidth: 1 },
  cardFooter: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 14, height: 46, borderTopWidth: 1 },
  menu: { position: 'absolute', ...noSelect },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginHorizontal: 4 },
  toastHost: { position: 'absolute', right: 14, bottom: 32, width: 360, zIndex: 120 },
  toast: { flexDirection: 'row', alignItems: 'center', padding: 9 },
});
