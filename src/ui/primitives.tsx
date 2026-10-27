import React, { useCallback, useEffect, useRef, useState, useLayoutEffect } from 'react';
import { Animated, Easing, Image, Platform, Pressable, StyleProp, StyleSheet, Text, TextInput, TextStyle, View, ViewStyle, useWindowDimensions } from 'react-native';
import { getState, useStore } from '../state/store';
import { FONT, ROW, SelectedContext, TRACK, isDark, useSelected, useTheme } from '../theme';
import { Icon, IconName } from './Icon';

export const webCursor = (cursor: string) => (Platform.OS === 'web' ? ({ cursor } as any) : {});

/** Screen px → layout px inside the zoomed root (web applies `uiScale` with CSS zoom). */
export const toLayout = (px: number) => (Platform.OS === 'web' ? px / getState().uiScale : px);
/** Window size in layout px: what the zoomed root can actually show. */
export function useViewport() {
  const { width, height } = useWindowDimensions();
  const scale = useStore((s) => s.uiScale);
  const k = Platform.OS === 'web' ? scale : 1;
  return { width: width / k, height: height / k, scale: k };
}
export const noSelect = Platform.OS === 'web' ? ({ userSelect: 'none' } as any) : {};
const native = Platform.OS !== 'web';

// ---------- text ----------

export function Txt({ children, style, muted, faint, mono, size, weight, color, numberOfLines, label, selectable, testID }: {
  children?: React.ReactNode;
  style?: StyleProp<TextStyle>;
  muted?: boolean;
  faint?: boolean;
  mono?: boolean;
  size?: number;
  weight?: TextStyle['fontWeight'];
  color?: string;
  numberOfLines?: number;
  /** uppercase label with tracking */
  label?: boolean;
  selectable?: boolean;
  testID?: string;
}) {
  const t = useTheme();
  const inverted = useSelected();
  let c = color;
  if (!c) {
    if (inverted) c = t.selectionText;
    else c = faint ? t.textFaint : muted ? t.textMuted : t.text;
  }
  const w = label && !weight ? '700' : weight;
  return (
    <Text
      testID={testID}
      numberOfLines={numberOfLines}
      selectable={selectable}
      {...(selectable && Platform.OS === 'web' ? ({ dataSet: { selectable: '1' } } as any) : {})}
      style={[
        selectable && Platform.OS === 'web' ? ({ cursor: 'text' } as any) : null,
        {
          color: c,
          fontFamily: t.fontFor(w),
          fontSize: size ?? (label ? FONT.xs : FONT.md),
          fontWeight: 'normal',
          opacity: inverted && (muted || faint) ? (faint ? 0.6 : 0.78) : 1,
        },
        label && { textTransform: 'uppercase', letterSpacing: TRACK },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// ---------- press with scale ----------

export interface Anchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the last press anywhere: which element (its ref) and when */
const lastPress: { owner: object | null; at: number } = { owner: null, at: 0 };
/** modifier keys and position of the last mouse press (⌘/Ctrl, Shift for multi-selection; where for menus) */
const pressMods = { meta: false, shift: false };
const pressAt = { x: 0, y: 0 };
/**
 * The system's click count of the last mouse press (2 on the second click of a double click; 0: not a mouse).
 * The system counts by the time between the clicks themselves, so a first click whose work keeps the page busy for
 * a second (selecting a branch in a large repository) still makes a double click.
 */
const pressClicks = { n: 0 };
if (Platform.OS === 'web' && typeof window !== 'undefined')
  window.addEventListener(
    'mousedown',
    (e) => {
      pressMods.meta = e.metaKey || e.ctrlKey;
      pressMods.shift = e.shiftKey;
      pressAt.x = e.clientX;
      pressAt.y = e.clientY;
      pressClicks.n = e.detail;
    },
    true,
  );
/** without a click count (touch, keyboard): two presses of one element within this many ms are a double click */
export const DOUBLE_CLICK_MS = 450;

/** set by HoverReveal: the pressables inside it say when they are hovered */
const RevealHover = React.createContext<((hovered: boolean) => void) | null>(null);
/**
 * Set by every PressScale for the pressables inside it. RN-web ends a pressable's hover when the pointer moves onto
 * one inside it (its "contain" lock): a row lost its highlight and its hover buttons under its own arrow or button,
 * and where they took space the layout moved under the pointer and flickered (merge2core's → in Changes). Inner
 * ones say when they are hovered, and the outer one stays hovered while one of them is.
 */
const HoverParent = React.createContext<((hovered: boolean) => void) | null>(null);

/**
 * What a row shows while it is hovered (its buttons), in place of what it shows otherwise (`rest`: counts, a
 * status). Both stay mounted: a button that exists only while its row is hovered vanishes the moment the pointer
 * moves onto it (a pressable inside a pressable ends the outer one's hover), so the buttons stay while the row or
 * one of them is hovered.
 */
export function HoverReveal({ rowHovered, rest, children, idleOpacity }: {
  rowHovered: boolean;
  rest?: React.ReactNode;
  children: React.ReactNode;
  /** the buttons stay shown at this opacity while nothing is hovered (instead of hidden) */
  idleOpacity?: number;
}) {
  const [over, setOver] = useState(false);
  const on = rowHovered || over;
  return (
    <>
      {rest != null && rest !== false ? <View style={on ? { display: 'none' } : undefined}>{rest}</View> : null}
      <View style={[{ flexDirection: 'row', alignItems: 'center' }, !on && (idleOpacity != null ? { opacity: idleOpacity } : { display: 'none' })]}>
        <RevealHover.Provider value={setOver}>{children}</RevealHover.Provider>
      </View>
    </>
  );
}

export function PressScale({ children, onPress, onLongPress, style, disabled, scaleTo = 0.97, hoverStyle, onHover, onContextMenu, onDoublePress, testID, label, onPressAt, outerStyle, onPressMods }: {
  /** a press with ⌘/Ctrl or Shift held: return true when handled (the plain onPress is then skipped) */
  onPressMods?: (m: { meta: boolean; shift: boolean }) => boolean | void;
  /** the pressable's own box (`style` goes to the inner view): e.g. letting it shrink in a crowded row */
  outerStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode | ((s: { hovered: boolean; pressed: boolean }) => React.ReactNode);
  onPress?: () => void;
  /** like onPress, but receives the pressed element's window rect in layout px (menu anchoring) */
  onPressAt?: (a: Anchor) => void;
  onLongPress?: () => void;
  /** a double click; `at` is where (layout px), e.g. for a menu of choices */
  onDoublePress?: (at: { x: number; y: number }) => void;
  style?: StyleProp<ViewStyle>;
  hoverStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  scaleTo?: number;
  onHover?: (h: boolean) => void;
  onContextMenu?: (x: number, y: number) => void;
  testID?: string;
  label?: string;
}) {
  const t = useTheme();
  const scale = useState(() => new Animated.Value(1))[0];
  const [hovered, setHovered] = useState(false);
  const reveal = React.useContext(RevealHover);
  const parent = React.useContext(HoverParent);
  // hovered: the pointer is on it, or on a pressable inside it. The lock that ends this one's hover and the inner
  // one's start come in one pointer event, so React draws only the outcome (no frame without the hover)
  const own = useRef(false);
  const inner = useRef(0);
  const sent = useRef(false);
  const ups = useRef({ parent, reveal, onHover });
  useLayoutEffect(() => {
    ups.current = { parent, reveal, onHover };
  });
  const sync = useCallback(() => {
    const h = own.current || inner.current > 0;
    if (h === sent.current) return;
    sent.current = h;
    setHovered(h);
    ups.current.onHover?.(h);
    ups.current.parent?.(h);
    ups.current.reveal?.(h);
  }, []);
  const fromInner = useCallback(
    (h: boolean) => {
      inner.current = Math.max(0, inner.current + (h ? 1 : -1));
      sync();
    },
    [sync],
  );
  // gone while hovered (a button that hides on click): its parent is not left hovered for good
  useEffect(
    () => () => {
      if (!sent.current) return;
      ups.current.parent?.(false);
      ups.current.reveal?.(false);
    },
    [],
  );
  /** this element's identity for double-click detection */
  const me = useRef(0);
  const box = useRef<any>(null);
  const animate = (to: number) => Animated.timing(scale, { toValue: to, duration: 70 * t.motion, easing: Easing.out(Easing.quad), useNativeDriver: native }).start();
  return (
    <Pressable
      testID={testID}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        const now = Date.now();
        if ((pressMods.meta || pressMods.shift) && onPressMods?.({ ...pressMods })) {
          lastPress.owner = null;
          return;
        }
        // a double click is two clicks on this element with no other click in between
        const double = pressClicks.n > 0 ? pressClicks.n === 2 : now - lastPress.at < DOUBLE_CLICK_MS;
        if (onDoublePress && lastPress.owner === me && double) {
          lastPress.owner = null;
          onDoublePress({ x: toLayout(pressAt.x), y: toLayout(pressAt.y) });
          return;
        }
        lastPress.owner = me;
        lastPress.at = now;
        onPress?.();
        if (onPressAt) {
          const node = box.current as any;
          if (node?.measureInWindow) node.measureInWindow((x: number, y: number, w: number, h: number) => onPressAt({ x: toLayout(x), y: toLayout(y), w: toLayout(w), h: toLayout(h) }));
          else onPressAt({ x: 0, y: 0, w: 0, h: 0 });
        }
      }}
      onLongPress={onLongPress}
      onPressIn={() => scaleTo !== 1 && animate(scaleTo)}
      onPressOut={() => scaleTo !== 1 && animate(1)}
      onHoverIn={() => {
        own.current = true;
        sync();
      }}
      onHoverOut={() => {
        own.current = false;
        sync();
      }}
      onPointerDown={(e: any) => {
        if (onContextMenu && e?.nativeEvent?.button === 2) {
          e.preventDefault?.();
          onContextMenu(toLayout(e.nativeEvent.pageX), toLayout(e.nativeEvent.pageY));
        }
      }}
      style={[webCursor(disabled ? 'default' : 'pointer'), noSelect, outerStyle]}
    >
      {({ pressed }) => (
        <Animated.View ref={box} style={[style, hovered && hoverStyle, { transform: [{ scale }] }, disabled && { opacity: 0.4 }]}>
          <HoverParent.Provider value={fromInner}>{typeof children === 'function' ? children({ hovered, pressed }) : children}</HoverParent.Provider>
        </Animated.View>
      )}
    </Pressable>
  );
}

// ---------- buttons ----------

export function Button({ label, icon, onPress, primary, danger, small, disabled, style, iconRight, active, testID }: {
  testID?: string;
  label?: string;
  icon?: IconName;
  iconRight?: IconName;
  onPress?: () => void;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  active?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = primary ? t.accent : danger ? t.del : active ? t.accentSoft : t.raised;
  const fg = primary ? t.accentText : danger ? '#1a0b0a' : active ? t.accent : t.text;
  // a button that opens a menu (▾) has no outline, only its fill (the border stays, transparent: same size)
  const menu = iconRight === 'chevronDown';
  return (
    <PressScale
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, small && styles.buttonSmall, { backgroundColor: bg, borderColor: menu ? 'transparent' : primary ? t.accent : danger ? t.del : active ? t.accent : t.borderStrong }, style]}
      hoverStyle={{ opacity: 0.88 }}
    >
      {icon && <Icon name={icon} size={small ? 12 : 13} color={fg} />}
      {label ? (
        <Txt label size={small ? 10 : FONT.xs} color={fg} style={icon ? { marginLeft: 6 } : undefined}>
          {label}
        </Txt>
      ) : null}
      {iconRight && (
        <View style={{ marginLeft: 4 }}>
          <Icon name={iconRight} size={11} color={fg} />
        </View>
      )}
    </PressScale>
  );
}

export function IconButton({ icon, onPress, size = 15, color, title, active, disabled, style, onPressAt, testID }: {
  testID?: string;
  icon: IconName;
  onPress?: () => void;
  onPressAt?: (a: Anchor) => void;
  size?: number;
  color?: string;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <PressScale label={title} onPress={onPress} onPressAt={onPressAt} disabled={disabled} scaleTo={0.9} style={[styles.iconButton, active && { backgroundColor: t.accentSoft }, style]} hoverStyle={{ backgroundColor: t.hover }} testID={testID}>
      <Icon name={icon} size={size} color={active ? t.accent : color} />
    </PressScale>
  );
}

// ---------- toolbar button: icon + uppercase label in one row (terminal density) ----------

export function ToolButton({ icon, label, onPress, badge, badgeColor, disabled, menu, onPressAt, compact, testID }: {
  icon: IconName;
  label: string;
  /** the button's; its arrow gets `<testID>-menu` */
  testID?: string;
  compact?: boolean;
  onPress?: () => void;
  onPressAt?: (a: Anchor) => void;
  badge?: string | number;
  badgeColor?: string;
  disabled?: boolean;
  /** the arrow next to it: gets the arrow's window rect, e.g. for a menu of quick actions */
  menu?: (a: Anchor) => void;
}) {
  const t = useTheme();
  const hasBadge = badge !== undefined && badge !== 0 && badge !== '';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
      <PressScale label={compact ? label : undefined} onPress={onPress} onPressAt={onPressAt} disabled={disabled} scaleTo={0.96} style={[styles.toolButton, compact && { paddingHorizontal: 7 }]} hoverStyle={{ backgroundColor: t.hover }} testID={testID}>
        {({ hovered }) => (
          <>
            <Icon name={icon} size={compact ? 15 : 13} color={hovered ? t.text : t.textMuted} />
            {!compact && (
              <Txt label size={10.5} color={hovered ? t.text : t.textMuted} style={{ marginLeft: 6 }}>
                {label}
              </Txt>
            )}
            {hasBadge ? (
              <View style={[styles.badge, { backgroundColor: badgeColor ?? t.accent, marginLeft: 5 }]}>
                <Txt size={10} color={badgeColor && badgeColor !== t.accent ? '#fff' : t.accentText} weight="700">
                  {String(badge)}
                </Txt>
              </View>
            ) : null}
          </>
        )}
      </PressScale>
      {menu && (
        <PressScale onPressAt={menu} disabled={disabled} style={styles.toolMenu} hoverStyle={{ backgroundColor: t.hover }} label={`${label}: quick actions`} testID={testID ? `${testID}-menu` : undefined}>
          <Icon name="chevronDown" size={10} />
        </PressScale>
      )}
    </View>
  );
}

// ---------- badge / pill ----------

export function Badge({ children, color, bg, mono, style }: { children: React.ReactNode; color?: string; bg?: string; mono?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: bg ?? t.raised }, style]}>
      <Txt size={10} color={color ?? t.textMuted} weight="600" mono={mono}>
        {children}
      </Txt>
    </View>
  );
}

// ---------- row ----------

export function Row({ children, selected, onPress, onDoublePress, onContextMenu, style, height = ROW, indent = 0, selectMode = 'invert', testID, onPressMods }: {
  testID?: string;
  onPressMods?: (m: { meta: boolean; shift: boolean }) => boolean | void;
  children: React.ReactNode | ((s: { hovered: boolean }) => React.ReactNode);
  selected?: boolean;
  onPress?: () => void;
  onDoublePress?: (at: { x: number; y: number }) => void;
  onContextMenu?: (x: number, y: number) => void;
  style?: StyleProp<ViewStyle>;
  height?: number;
  indent?: number;
  /** invert: amber block with dark text (cursor). soft: raised background, normal text. */
  selectMode?: 'invert' | 'soft';
}) {
  const t = useTheme();
  const inverted = !!selected && selectMode === 'invert';
  return (
    <SelectedContext.Provider value={inverted}>
      <PressScale
        onPress={onPress}
        onDoublePress={onDoublePress}
        onContextMenu={onContextMenu}
        onPressMods={onPressMods}
        scaleTo={1}
        style={[styles.row, { height, paddingLeft: 8 + indent }, selected && { backgroundColor: inverted ? t.selection : t.softSelection }, style]}
        hoverStyle={!selected ? { backgroundColor: t.hover } : undefined}
        testID={testID}
      >
        {children}
      </PressScale>
    </SelectedContext.Provider>
  );
}

// ---------- inputs ----------

export function Input({ value, onChange, placeholder, mono, multiline, style, autoFocus, onSubmit, icon, small, secure, slash, fill, testID, enterSends }: {
  /** a multiline field that takes the whole height of its box */
  fill?: boolean;
  /**
   * a chat composer: several lines, Enter runs `onSubmit` and the cursor stays in the field, Shift+Enter breaks the
   * line (a one-line field drops the line breaks of pasted text and loses the cursor after Enter)
   */
  enterSends?: boolean;
  testID?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
  style?: StyleProp<ViewStyle>;
  autoFocus?: boolean;
  onSubmit?: () => void;
  icon?: IconName;
  small?: boolean;
  secure?: boolean;
  /** terminal-style "/" prompt instead of an icon */
  slash?: boolean;
}) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.input, { backgroundColor: t.bg, borderColor: focused ? t.accent : t.border }, small && { minHeight: 24, paddingVertical: 0 }, (multiline || enterSends) && { alignItems: 'flex-start' }, style]}>
      {slash ? (
        <Txt color={t.accent} weight="700" size={FONT.md} style={{ marginRight: 6 }}>
          /
        </Txt>
      ) : icon ? (
        <View style={{ marginRight: 6 }}>
          <Icon name={icon} size={12} />
        </View>
      ) : null}
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={t.textFaint}
        multiline={multiline || enterSends}
        autoFocus={autoFocus}
        secureTextEntry={secure}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={enterSends ? undefined : onSubmit}
        onKeyPress={
          enterSends
            ? (e: any) => {
                const k = e.nativeEvent ?? {};
                if (k.key !== 'Enter' || k.shiftKey || k.isComposing) return;
                e.preventDefault?.();
                onSubmit?.();
              }
            : undefined
        }
        // names, paths, commands: what is typed stays as typed (WebKit capitalized "tmp/x" into "Tmp/x");
        // spelling is only marked in longer text
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={!!multiline && !mono}
        autoComplete="off"
        testID={testID}
        style={[
          // minWidth 0: an <input> is ~150px wide by itself and would stick out of a narrow box (the sidebar's filter)
          { flex: 1, minWidth: 0, color: t.text, fontFamily: t.fontFor('400'), fontSize: small ? FONT.sm : FONT.md, paddingVertical: multiline || enterSends ? 4 : 0, minHeight: enterSends ? 40 : multiline ? (fill ? 24 : 64) : undefined },
          fill && { alignSelf: 'stretch' },
          Platform.OS === 'web' && ({ outlineStyle: 'none' } as any),
        ]}
      />
    </View>
  );
}

export function Checkbox({ checked, onChange, label, disabled, testID }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; testID?: string }) {
  const t = useTheme();
  return (
    <PressScale onPress={() => onChange(!checked)} disabled={disabled} scaleTo={0.96} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 3 }} testID={testID}>
      <View style={[styles.checkbox, { borderColor: checked ? t.accent : t.borderStrong, backgroundColor: checked ? t.accent : 'transparent' }]}>
        {checked && <Icon name="check" size={10} color={t.accentText} strokeWidth={3} />}
      </View>
      {label ? <Txt style={{ marginLeft: 7 }}>{label}</Txt> : null}
    </PressScale>
  );
}

/** `testID`: the chosen one's ends in "-on" */
export function Radio({ checked, onPress, label, hint, testID }: { checked: boolean; onPress: () => void; label: string; hint?: string; testID?: string }) {
  const t = useTheme();
  return (
    <PressScale onPress={onPress} scaleTo={0.98} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 4 }} testID={testID ? `${testID}${checked ? '-on' : ''}` : undefined}>
      <View style={[styles.radio, { borderColor: checked ? t.accent : t.borderStrong }]}>{checked && <View style={{ width: 7, height: 7, backgroundColor: t.accent }} />}</View>
      <View style={{ marginLeft: 8, flex: 1 }}>
        <Txt>{label}</Txt>
        {hint ? (
          <Txt muted size={FONT.sm}>
            {hint}
          </Txt>
        ) : null}
      </View>
    </PressScale>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label?: string; icon?: IconName }[]; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: t.bg, borderColor: t.borderStrong }]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <PressScale key={o.value} onPress={() => onChange(o.value)} scaleTo={0.96} style={[styles.segment, active && { backgroundColor: t.accent }]} label={o.label ?? o.value}>
            {o.icon && <Icon name={o.icon} size={12} color={active ? t.accentText : t.textMuted} />}
            {o.label ? (
              <Txt label size={10} color={active ? t.accentText : t.textMuted} style={o.icon ? { marginLeft: 4 } : undefined}>
                {o.label}
              </Txt>
            ) : null}
          </PressScale>
        );
      })}
    </View>
  );
}

export function Kbd({ children }: { children: string }) {
  const t = useTheme();
  return (
    <View style={{ paddingHorizontal: 4, paddingVertical: 1, borderWidth: 1, borderColor: t.borderStrong, backgroundColor: t.raised, marginLeft: 6 }}>
      <Txt size={10} muted>
        {children}
      </Txt>
    </View>
  );
}

export function Divider({ vertical }: { vertical?: boolean }) {
  const t = useTheme();
  return <View style={vertical ? { width: 1, alignSelf: 'stretch', backgroundColor: t.border } : { height: 1, backgroundColor: t.border }} />;
}

export function SectionHeader({ title, right, count }: { title: string; right?: React.ReactNode; count?: number }) {
  const t = useTheme();
  return (
    <View style={[styles.sectionHeader, { backgroundColor: t.panelAlt, borderColor: t.border }]}>
      <Txt label faint size={10}>
        ──
      </Txt>
      <Txt label muted style={{ marginLeft: 6 }}>
        {title}
      </Txt>
      {count !== undefined && <Badge style={{ marginLeft: 6 }}>{count}</Badge>}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

// ---------- frosted glass surface for every popup ----------

export function Glass({ children, style, pointerEvents, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; pointerEvents?: 'auto' | 'none' | 'box-none'; testID?: string }) {
  const t = useTheme();
  return (
    <View
      pointerEvents={pointerEvents}
      testID={testID}
      {...({ dataSet: { glass: '1' } } as any)}
      style={[
        { backgroundColor: t.glass },
        Platform.OS === 'web' && ({ boxShadow: `0 24px 60px ${t.shadow}, 0 2px 8px rgba(0,0,0,0.25)` } as any),
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Scrolls `node` the least that brings the element marked `data-<mark>` inside it into view (as scrollIntoView
 * "nearest", but only this scroller). Rects are measured in window px and the scroll is in the node's own px,
 * which differ under the interface scale (CSS zoom).
 */
export function revealIn(node: HTMLElement | null, mark: string, axis: 'x' | 'y', pad = 8) {
  const el = node?.querySelector(`[data-${mark}]`) as HTMLElement | null;
  if (!node || !el) return;
  const a = el.getBoundingClientRect();
  const b = node.getBoundingClientRect();
  const k = axis === 'x' ? (b.width ? node.clientWidth / b.width : 1) : b.height ? node.clientHeight / b.height : 1;
  const [lo, hi, blo, bhi] = axis === 'x' ? [a.left, a.right, b.left, b.right] : [a.top, a.bottom, b.top, b.bottom];
  const d = lo < blo ? lo - blo - pad : hi > bhi ? hi - bhi + pad : 0;
  if (!d) return;
  if (axis === 'x') node.scrollLeft += d * k;
  else node.scrollTop += d * k;
}

// ---------- splitter ----------

export function Splitter({ orientation, onDelta, onEnd, testID }: { orientation: 'vertical' | 'horizontal'; onDelta: (d: number) => void; onEnd?: () => void; testID?: string }) {
  const t = useTheme();
  const [active, setActive] = useState(false);
  const last = useRef(0);
  const vertical = orientation === 'vertical';
  return (
    <View
      testID={testID}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        last.current = toLayout(vertical ? e.nativeEvent.pageX : e.nativeEvent.pageY);
        setActive(true);
      }}
      onResponderMove={(e) => {
        const v = toLayout(vertical ? e.nativeEvent.pageX : e.nativeEvent.pageY);
        onDelta(v - last.current);
        last.current = v;
      }}
      onResponderRelease={() => {
        setActive(false);
        onEnd?.();
      }}
      style={[
        vertical ? { width: 5, marginHorizontal: -2, alignSelf: 'stretch' } : { height: 5, marginVertical: -2 },
        { zIndex: 5, justifyContent: 'center', alignItems: 'center' },
        webCursor(vertical ? 'col-resize' : 'row-resize'),
      ]}
    >
      <View style={[vertical ? { width: 1, flex: 1 } : { height: 1, alignSelf: 'stretch' }, { backgroundColor: active ? t.accent : t.border }]} />
    </View>
  );
}

// ---------- resize / drag for popups ----------

/** Bottom-right corner grip. Deltas are in layout px. */
export function ResizeGrip({ onDelta, onEnd, size = 16 }: { onDelta: (dx: number, dy: number) => void; onEnd?: () => void; size?: number }) {
  const t = useTheme();
  const last = useRef({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  return (
    <View
      testID="resize-grip"
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        last.current = { x: toLayout(e.nativeEvent.pageX), y: toLayout(e.nativeEvent.pageY) };
        setActive(true);
      }}
      onResponderMove={(e) => {
        const x = toLayout(e.nativeEvent.pageX);
        const y = toLayout(e.nativeEvent.pageY);
        onDelta(x - last.current.x, y - last.current.y);
        last.current = { x, y };
      }}
      onResponderRelease={() => {
        setActive(false);
        onEnd?.();
      }}
      style={[{ position: 'absolute', right: 0, bottom: 0, width: size, height: size, alignItems: 'flex-end', justifyContent: 'flex-end', padding: 3, zIndex: 5 }, webCursor('nwse-resize')]}
    >
      <View style={{ width: 9, height: 9, borderRightWidth: 2, borderBottomWidth: 2, borderColor: active ? t.accent : t.textFaint }} />
    </View>
  );
}

/** Wraps a header to make its popup draggable; reports position deltas in layout px. */
export function DragHandle({ children, onDelta, style }: { children: React.ReactNode; onDelta: (dx: number, dy: number) => void; style?: StyleProp<ViewStyle> }) {
  const last = useRef({ x: 0, y: 0 });
  return (
    <View
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        last.current = { x: toLayout(e.nativeEvent.pageX), y: toLayout(e.nativeEvent.pageY) };
      }}
      onResponderMove={(e) => {
        const x = toLayout(e.nativeEvent.pageX);
        const y = toLayout(e.nativeEvent.pageY);
        onDelta(x - last.current.x, y - last.current.y);
        last.current = { x, y };
      }}
      style={[style, webCursor('grab')]}
    >
      {children}
    </View>
  );
}

// ---------- animations (near-instant in the terminal system) ----------

export function FadeIn({ children, delay = 0, duration = 160, slide = 0, style, keyProp }: { children: React.ReactNode; delay?: number; duration?: number; slide?: number; style?: StyleProp<ViewStyle>; keyProp?: string | number }) {
  const t = useTheme();
  const v = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration: duration * t.motion, delay: delay * t.motion, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
  }, [keyProp, v, duration, delay, t.motion]);
  return <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [slide, 0] }) }] }]}>{children}</Animated.View>;
}

export function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  const t = useTheme();
  const v = useState(() => new Animated.Value(open ? 1 : 0))[0];
  // mounted while open and while the close animation runs
  const [render, setRender] = useState(open);
  if (open && !render) setRender(true);
  useEffect(() => {
    Animated.timing(v, { toValue: open ? 1 : 0, duration: 120 * t.motion, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start(({ finished }) => {
      if (finished && !open) setRender(false);
    });
  }, [open, v, t.motion]);
  if (!render) return null;
  return <Animated.View style={{ opacity: v }}>{children}</Animated.View>;
}

/** Disclosure chevron for collapsible rows: points right when closed, rotates down when open. */
export function Chevron({ open, size = 11, color }: { open: boolean; size?: number; color?: string }) {
  const t = useTheme();
  const v = useState(() => new Animated.Value(open ? 1 : 0))[0];
  useEffect(() => {
    Animated.timing(v, { toValue: open ? 1 : 0, duration: 140 * t.motion, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
  }, [open, v, t.motion]);
  return (
    <Animated.View style={{ width: size + 3, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] }) }] }}>
      <Icon name="chevronRight" size={size} color={color ?? t.textFaint} strokeWidth={2.2} />
    </Animated.View>
  );
}

export function Spinner({ size = 13, color }: { size?: number; color?: string }) {
  const t = useTheme();
  const v = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: native }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View style={{ transform: [{ rotate: v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}>
      <Icon name="spinner" size={size} color={color ?? t.accent} strokeWidth={2.4} />
    </Animated.View>
  );
}

/** Blinking block cursor, the one animation the terminal system allows. */
export function Cursor({ color }: { color?: string }) {
  const t = useTheme();
  const v = useState(() => new Animated.Value(1))[0];
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([Animated.delay(520), Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: native }), Animated.delay(520), Animated.timing(v, { toValue: 1, duration: 0, useNativeDriver: native })]));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={{ width: 7, height: 13, backgroundColor: color ?? t.accent, opacity: v, marginLeft: 2 }} />;
}

export function usePulse(trigger: unknown) {
  const v = useState(() => new Animated.Value(1))[0];
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    Animated.sequence([
      Animated.timing(v, { toValue: 1.2, duration: 60, useNativeDriver: native }),
      Animated.timing(v, { toValue: 1, duration: 100, easing: Easing.out(Easing.quad), useNativeDriver: native }),
    ]).start();
  }, [trigger, v]);
  return v;
}

/**
 * Window key handler, in the capture phase: react-native-web text inputs stop keydown from bubbling, so a
 * bubbling listener never hears keys typed into a field (⌘K from the commit message, Esc or ↑↓⏎ in the command
 * palette). Handlers therefore see keys while the user types and must leave plain keys alone when they only
 * make sense outside a text field (check `target`).
 */
/**
 * Window-wide keys (capture phase: RN-web text inputs stop keydown propagation). While the error dialog is open
 * only handlers registered with `errorLayer` run, so Enter or Escape there does not also act on what is beneath.
 */
/** key presses a layer already handled (an open menu's Escape): the dialog underneath leaves them alone */
const consumedKeys = new WeakSet<KeyboardEvent>();
export interface KeyPress {
  key: string;
  meta: boolean;
  shift: boolean;
  ctrl: boolean;
  /** ⌥ (Option): with it held macOS changes `key` (⌥T is "†"), so such shortcuts read `code` */
  alt: boolean;
  /** the physical key ("KeyT"), whatever the layout and modifiers make of it */
  code: string;
  preventDefault: () => void;
  target: any;
  /** handled here: the handlers that run after this one see `consumed` */
  consume: () => void;
  readonly consumed: boolean;
}
export function useKeyboard(handler: (e: KeyPress) => void, opts: { errorLayer?: boolean } = {}) {
  const ref = useRef(handler);
  const errorLayer = !!opts.errorLayer;
  useLayoutEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (!errorLayer && getState().errorOpen != null) return;
      ref.current({
        key: e.key,
        meta: e.metaKey || e.ctrlKey,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        code: e.code,
        preventDefault: () => e.preventDefault(),
        target: e.target,
        consume: () => consumedKeys.add(e),
        get consumed() {
          return consumedKeys.has(e);
        },
      });
      // an Enter a window handler took (a dialog's default button, a list's pick) does not also press the focused
      // button underneath: RN-web presses a focused pressable on Enter, so the toolbar button that opened the dialog
      // (still focused) opened it again right after Enter had run it
      if (e.key === 'Enter' && e.defaultPrevented) e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [errorLayer]);
}

/** addresses the engine answered 404 for (or that failed to load) — no second request this session */
const avatarMisses = new Set<string>();
/**
 * Author avatar: the engine fetches and caches GitHub / Gravatar images by e-mail; initials in a lane
 * colour until it answers and whenever there is no image.
 */
export function Avatar({ name, email, color, size = 16 }: { name: string; email?: string; color?: string; size?: number }) {
  const t = useTheme();
  const enabled = useStore((s) => s.engine.online && (s.serverSettings?.avatars ?? true));
  const key = email?.trim().toLowerCase() ?? '';
  const [failed, setFailed] = useState(() => avatarMisses.has(key));
  const initials = name
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const bg = color ?? t.lanes[name.length % t.lanes.length];
  const showImage = enabled && !!key && key.includes('@') && !failed;
  return (
    <View style={{ width: size, height: size, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <Txt size={size * 0.45} color={isDark(t.name) ? '#15120a' : '#fffaf0'} weight="700">
        {initials}
      </Txt>
      {showImage && (
        <Image
          source={{ uri: avatarUrlFor(key) }}
          style={{ position: 'absolute', left: 0, top: 0, width: size, height: size }}
          onError={() => {
            avatarMisses.add(key);
            setFailed(true);
          }}
        />
      )}
    </View>
  );
}
/** engine base URL without importing the live module (primitives must stay dependency-free) */
let avatarBase = '';
export function setAvatarBase(url: string) {
  avatarBase = url;
}
const avatarUrlFor = (email: string) => `${avatarBase}/api/avatar?email=${encodeURIComponent(email)}`;

export const useLatest = <T,>(v: T) => {
  const r = useRef(v);
  useLayoutEffect(() => {
    r.current = v;
  });
  return r;
};

export function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export const useStable = <T extends (...a: any[]) => any>(fn: T) => {
  const r = useLatest(fn);
  return useCallback((...a: Parameters<T>) => r.current(...a), [r]);
};

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, height: 26, borderWidth: 1 },
  buttonSmall: { height: 22, paddingHorizontal: 7 },
  iconButton: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  toolButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9, height: 26 },
  // as tall as its button: the arrow sits at the middle of the label, not at the top
  toolMenu: { justifyContent: 'center', paddingHorizontal: 3, marginLeft: -3, height: 26 },
  badge: { paddingHorizontal: 4, minWidth: 16, height: 15, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  input: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingHorizontal: 8, minHeight: 26 },
  checkbox: { width: 13, height: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 13, height: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  segmented: { flexDirection: 'row', borderWidth: 1, padding: 1 },
  segment: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 7, height: 18 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', height: 24, paddingHorizontal: 8, borderBottomWidth: 1 },
});
