import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MediaSide } from '../../state/live';
import { FONT, Theme, useTheme } from '../../theme';
import { Button, Segmented, Spinner, Txt } from '../../ui/primitives';
import { View } from 'react-native';
import { SideBanner } from './common';
import { availableModes, clamp, Dims, fitView, Mode, sideState, View2D, zoomAt } from './mediaMath';

/**
 * Image change viewer (web: plain DOM, so wheel, pinch and pointer capture work directly).
 *
 * - Added / deleted / unchanged files show one image with a banner saying so; comparison modes appear only
 *   when both versions exist and differ, and "Difference" only when both have the same pixel size.
 * - Zoom and pan are shared by every pane (side by side stays aligned): drag to pan, two-finger scroll to pan,
 *   pinch (trackpad: ctrl+wheel in Chromium, gesture events in WebKit) or ⌘/ctrl+wheel to zoom around the
 *   cursor, double-click to toggle fit ↔ 1:1. Above 2× pixels are drawn crisp.
 * - Swipe: the divider follows the cursor; BEFORE is left of it, AFTER right.
 */


function useImageDims(url?: string) {
  const [state, setState] = useState<{ dims?: Dims; error?: boolean; url?: string }>({});
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const img = new window.Image();
    img.onload = () => alive && setState({ url, dims: { w: img.naturalWidth || 1, h: img.naturalHeight || 1 } });
    img.onerror = () => alive && setState({ url, error: true });
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return state.url === url ? state : {};
}

const checker = (t: Theme, s: number): React.CSSProperties => ({
  backgroundColor: t.panelAlt,
  backgroundImage: `linear-gradient(45deg, ${t.border} 25%, transparent 25%), linear-gradient(-45deg, ${t.border} 25%, transparent 25%), linear-gradient(45deg, transparent 75%, ${t.border} 75%), linear-gradient(-45deg, transparent 75%, ${t.border} 75%)`,
  backgroundSize: `${16 / s}px ${16 / s}px`,
  backgroundPosition: `0 0, 0 ${8 / s}px, ${8 / s}px -${8 / s}px, -${8 / s}px 0`,
});

export function ImageCompare({ before, after, loading, error }: { before?: MediaSide; after?: MediaSide; loading: boolean; error?: string | null }) {
  const t = useTheme();
  const b = useImageDims(before?.url);
  const a = useImageDims(after?.url);
  const identical = !!before && !!after && !!before.oid && before.oid === after.oid;
  const modes = availableModes(!!before, !!after, identical, b.dims, a.dims);
  const [mode, setMode] = useState<Mode>('side');
  const active: Mode | null = modes.length ? (modes.includes(mode) ? mode : 'side') : null;
  // the frame both images are centred in: the larger of the two
  const frame: Dims | null = useMemo(() => {
    const ds = [b.dims, a.dims].filter(Boolean) as Dims[];
    if (!ds.length) return null;
    return { w: Math.max(...ds.map((d) => d.w)), h: Math.max(...ds.map((d) => d.h)) };
  }, [b.dims, a.dims]);

  // panes and their shared view
  // measured through a callback ref: the container appears only once the sides are known
  const [box, setBox] = useState<Dims>({ w: 0, h: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const outer = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    // padding is part of the container; panes share what is left
    const measure = () => setBox({ w: Math.max(0, el.clientWidth - 24), h: Math.max(0, el.clientHeight - 6) });
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
    measure();
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  const twoPanes = active === 'side';
  const stacked = twoPanes && box.w < 640;
  const gap = 12;
  const pane: Dims = twoPanes ? (stacked ? { w: box.w, h: Math.max(80, (box.h - gap) / 2) } : { w: Math.max(80, (box.w - gap) / 2), h: box.h }) : box;
  const [view, setView] = useState<View2D>({ s: 1, x: 0, y: 0, fitted: true });
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  });
  // a different file or mode starts fitted; a resize keeps the fit unless the user zoomed or panned
  // (adjusted while rendering, so the first paint is already fitted)
  const fitKey = `${frame?.w}x${frame?.h}|${Math.round(pane.w)}x${Math.round(pane.h)}`;
  const resetKey = `${before?.url}|${after?.url}|${active}`;
  const [keys, setKeys] = useState({ fit: '', reset: '' });
  if (frame && pane.w > 10 && pane.h > 10 && (keys.fit !== fitKey || keys.reset !== resetKey)) {
    const reset = keys.reset !== resetKey;
    setKeys({ fit: fitKey, reset: resetKey });
    setView((v) => (reset || v.fitted ? fitView(pane, frame) : v));
  }

  const fit = () => frame && setView(fitView(pane, frame));
  const actual = (cx = pane.w / 2, cy = pane.h / 2) => setView((v) => zoomAt(v, 1 / v.s, cx, cy));
  const step = (k: number) => setView((v) => zoomAt(v, k, pane.w / 2, pane.h / 2));

  const [divider, setDivider] = useState(0.5);
  const [blend, setBlend] = useState(0.5);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const st = sideState(before, after, identical);
  const shown = after ?? before;
  const shownDims = after ? a.dims : b.dims;
  const failed = (before && b.error) || (after && a.error);

  if (loading && !shown) return <Centered><Spinner /></Centered>;
  if (error) return <Centered><Txt color={t.del} size={FONT.sm}>{error}</Txt></Centered>;

  const paneProps = { view, setView, viewRef, frame, pane, onDouble: (cx: number, cy: number) => (viewRef.current.fitted || Math.abs(viewRef.current.s - 1) > 0.01 ? actual(cx, cy) : fit()) };
  const pixel = (d?: Dims) => {
    if (!cursor || !frame || !d) return null;
    const ix = Math.floor((cursor.x - view.x) / view.s - (frame.w - d.w) / 2);
    const iy = Math.floor((cursor.y - view.y) / view.s - (frame.h - d.h) / 2);
    return ix >= 0 && iy >= 0 && ix < d.w && iy < d.h ? `${ix}, ${iy}` : null;
  };
  const px = pixel(shownDims ?? undefined);

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <SideBanner state={st} kind="image" before={before} after={after} beforeInfo={dimsText(b.dims)} afterInfo={dimsText(a.dims)} />
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, flexWrap: 'wrap', gap: 8 } as any}>
        {modes.length > 0 && <Segmented value={active!} onChange={(v) => setMode(v)} options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />}
        {active === 'onion' && (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Txt size={FONT.xs} faint style={{ marginRight: 6 }}>
              before
            </Txt>
            <input aria-label="blend" type="range" min={0} max={100} value={Math.round(blend * 100)} onChange={(e) => setBlend(parseInt(e.currentTarget.value, 10) / 100)} style={{ width: 140, accentColor: t.accent }} />
            <Txt size={FONT.xs} faint style={{ marginLeft: 6 }}>
              after
            </Txt>
          </View>
        )}
        <View style={{ flex: 1 }} />
        {px && (
          <Txt size={FONT.xs} faint mono>
            {px} px
          </Txt>
        )}
        <Button small icon="minus" onPress={() => step(1 / 1.25)} />
        <Txt size={FONT.xs} mono muted style={{ width: 46, textAlign: 'center' }}>
          {Math.round(view.s * 100)}%
        </Txt>
        <Button small icon="plus" onPress={() => step(1.25)} />
        <Button small label="Fit" active={view.fitted} onPress={fit} />
        <Button small label="1:1" active={!view.fitted && Math.abs(view.s - 1) < 0.001} onPress={() => actual()} />
      </View>
      <div ref={outer} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: stacked ? 'column' : 'row', gap, padding: '0 12px 6px', boxSizing: 'border-box' }}>
        {failed ? (
          <Centered>
            <Txt muted size={FONT.sm}>{"This image format can't be shown here."}</Txt>
          </Centered>
        ) : !frame ? (
          <Centered>
            <Spinner />
          </Centered>
        ) : active === 'side' ? (
          <>
            <Pane {...paneProps} label="BEFORE" labelColor={t.del} onCursor={setCursor}>
              <Layer url={before!.url} dims={b.dims} frame={frame} view={view} t={t} />
            </Pane>
            <Pane {...paneProps} label="AFTER" labelColor={t.add} onCursor={setCursor}>
              <Layer url={after!.url} dims={a.dims} frame={frame} view={view} t={t} />
            </Pane>
          </>
        ) : active === 'swipe' ? (
          <Pane {...paneProps} label="BEFORE" labelColor={t.del} rightLabel="AFTER" rightColor={t.add} onCursor={(c) => (setCursor(c), c && setDivider(clamp(c.x / pane.w, 0, 1)))}>
            <Layer url={before!.url} dims={b.dims} frame={frame} view={view} t={t} />
            <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 0 0 ${divider * pane.w}px)` }}>
              <Layer url={after!.url} dims={a.dims} frame={frame} view={view} t={t} />
            </div>
            <div data-divider="1" style={{ position: 'absolute', top: 0, bottom: 0, left: divider * pane.w - 1, width: 2, background: t.accent, pointerEvents: 'none', boxShadow: '0 0 0 1px rgba(0,0,0,.35)' }} />
          </Pane>
        ) : active === 'onion' ? (
          <Pane {...paneProps} label="BEFORE" labelColor={t.del} rightLabel={`AFTER ${Math.round(blend * 100)}%`} rightColor={t.add} onCursor={setCursor}>
            <Layer url={before!.url} dims={b.dims} frame={frame} view={view} t={t} />
            <div style={{ position: 'absolute', inset: 0, opacity: blend }}>
              <Layer url={after!.url} dims={a.dims} frame={frame} view={view} t={t} noChecker />
            </div>
          </Pane>
        ) : active === 'diff' ? (
          <Pane {...paneProps} label="DIFFERENCE" labelColor={t.warn} rightLabel="black = identical" rightColor={t.textFaint} onCursor={setCursor} dark>
            <Layer url={before!.url} dims={b.dims} frame={frame} view={view} t={t} noChecker />
            <div style={{ position: 'absolute', inset: 0, mixBlendMode: 'difference' }}>
              <Layer url={after!.url} dims={a.dims} frame={frame} view={view} t={t} noChecker />
            </div>
          </Pane>
        ) : (
          <Pane {...paneProps} label={st === 'deleted' ? 'BEFORE · deleted' : st === 'added' ? 'AFTER · new file' : 'IMAGE'} labelColor={st === 'deleted' ? t.del : t.add} onCursor={setCursor}>
            <Layer url={shown!.url} dims={shownDims} frame={frame} view={view} t={t} dim={st === 'deleted'} />
          </Pane>
        )}
      </div>
      <Txt size={FONT.xs} faint style={{ textAlign: 'center', paddingBottom: 6 }}>
        drag or scroll to pan · pinch or ⌘ scroll to zoom · double-click toggles 1:1
      </Txt>
    </View>
  );
}

const MODE_LABEL: Record<Mode, string> = { side: 'Side by side', swipe: 'Swipe', onion: 'Onion skin', diff: 'Difference' };
const dimsText = (d?: Dims) => (d ? `${d.w}×${d.h} px` : undefined);

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120 }}>{children}</div>;
}

/** one image placed in the shared frame under the shared transform */
function Layer({ url, dims, frame, view, t, noChecker, dim }: { url: string; dims?: Dims; frame: Dims; view: View2D; t: Theme; noChecker?: boolean; dim?: boolean }) {
  if (!dims) return null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: frame.w, height: frame.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: '0 0', pointerEvents: 'none' }}>
      <img
        src={url}
        alt=""
        draggable={false}
        style={{
          position: 'absolute',
          left: (frame.w - dims.w) / 2,
          top: (frame.h - dims.h) / 2,
          width: dims.w,
          height: dims.h,
          imageRendering: view.s >= 2 ? 'pixelated' : 'auto',
          opacity: dim ? 0.85 : 1,
          ...(noChecker ? {} : checker(t, view.s)),
        }}
      />
    </div>
  );
}

interface PaneProps {
  children: React.ReactNode;
  label: string;
  labelColor: string;
  rightLabel?: string;
  rightColor?: string;
  dark?: boolean;
  view: View2D;
  setView: React.Dispatch<React.SetStateAction<View2D>>;
  viewRef: React.MutableRefObject<View2D>;
  frame: Dims | null;
  pane: Dims;
  onDouble: (cx: number, cy: number) => void;
  onCursor: (c: { x: number; y: number } | null) => void;
}

/** a viewport with wheel / pinch / drag handling; all panes share one view */
function Pane({ children, label, labelColor, rightLabel, rightColor, dark, setView, viewRef, onDouble, onCursor }: PaneProps) {
  const t = useTheme();
  const el = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const local = useCallback((e: { clientX: number; clientY: number }) => {
    const r = el.current!.getBoundingClientRect();
    // the app root is CSS-zoomed (interface scale): convert screen px into layout px
    const z = r.width ? el.current!.offsetWidth / r.width : 1;
    return { x: (e.clientX - r.left) * z, y: (e.clientY - r.top) * z };
  }, []);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      if (e.ctrlKey || e.metaKey) {
        // pinch on a trackpad arrives as ctrl+wheel with small deltas; a mouse wheel with ⌘ has large ones
        const d = clamp(e.deltaY, -60, 60);
        setView((v) => zoomAt(v, Math.exp(-d * 0.01), p.x, p.y));
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        setView((v) => ({ ...v, x: v.x - e.deltaX * k, y: v.y - e.deltaY * k, fitted: false }));
      }
    };
    // WebKit (Safari, Prong.app) reports trackpad pinches as gesture events instead of ctrl+wheel
    let start = 1;
    const onGestureStart = (e: any) => {
      e.preventDefault();
      start = viewRef.current.s;
    };
    const onGestureChange = (e: any) => {
      e.preventDefault();
      const p = local(e);
      setView((v) => zoomAt(v, (start * e.scale) / v.s, p.x, p.y));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('gesturestart', onGestureStart as any, { passive: false } as any);
    node.addEventListener('gesturechange', onGestureChange as any, { passive: false } as any);
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('gesturestart', onGestureStart as any);
      node.removeEventListener('gesturechange', onGestureChange as any);
    };
  }, [local, setView, viewRef]);
  return (
    <div
      ref={el}
      data-pane={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, id: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
        setGrabbing(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) {
          const r = el.current!.getBoundingClientRect();
          const z = r.width ? el.current!.offsetWidth / r.width : 1;
          setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x) * z, y: d.vy + (e.clientY - d.y) * z, fitted: false }));
        } else onCursor(local(e));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        setGrabbing(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }}
      onPointerLeave={() => !drag.current && onCursor(null)}
      onDoubleClick={(e) => {
        const p = local(e);
        onDouble(p.x, p.y);
      }}
      style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: dark ? '#000' : t.bg, border: `1px solid ${t.border}`, cursor: grabbing ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
    >
      {children}
      <span style={{ position: 'absolute', left: 6, top: 5, padding: '1px 6px', background: t.panel, color: labelColor, font: `600 10px ${t.fontFor('600')}`, letterSpacing: 0.6, pointerEvents: 'none' }}>{label}</span>
      {rightLabel && <span style={{ position: 'absolute', right: 6, top: 5, padding: '1px 6px', background: t.panel, color: rightColor, font: `600 10px ${t.fontFor('600')}`, letterSpacing: 0.6, pointerEvents: 'none' }}>{rightLabel}</span>}
    </div>
  );
}

