import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { MediaSide } from '../../state/live';
import { FONT, useTheme } from '../../theme';
import { Checkbox, Spinner, Txt } from '../../ui/primitives';
import { SideBanner } from './common';
import { fmtBytes, fmtDuration, peaks, sideState, WAVE_MAX_BYTES } from './mediaMath';

/**
 * Audio and video changes (web: native <audio>/<video>, which the engine feeds with byte ranges).
 * Each side shows its duration (and resolution for video); audio gets a waveform you can click to seek.
 * With both sides present playback can be linked: play, pause and seeking follow each other.
 * A format the browser cannot decode says so instead of failing, with "Open" in the default app.
 */

interface Meta {
  duration?: number;
  w?: number;
  h?: number;
  error?: boolean;
}

function useWaveform(side?: MediaSide, enabled = true) {
  const url = side?.url;
  const tooLarge = !!side && side.bytes > WAVE_MAX_BYTES;
  const [state, setState] = useState<{ url?: string; peaks?: [number, number][]; error?: string }>({});
  useEffect(() => {
    if (!url || !enabled || tooLarge) return;
    let alive = true;
    (async () => {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) throw new Error('no Web Audio');
      const buf = await (await fetch(url)).arrayBuffer();
      const ctx = new AC();
      try {
        const audio: AudioBuffer = await new Promise((res, rej) => {
          const p = ctx.decodeAudioData(buf, res, rej);
          if (p && typeof p.then === 'function') p.then(res, rej);
        });
        const chans = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
        if (alive) setState({ url, peaks: peaks(chans) });
      } finally {
        void ctx.close?.();
      }
    })().catch((e) => alive && setState({ url, error: String(e?.message ?? e) }));
    return () => {
      alive = false;
    };
  }, [url, enabled, tooLarge]);
  if (!url || !enabled) return {};
  if (tooLarge) return { error: 'too large for a waveform' };
  return state.url === url ? state : { loading: true };
}

export function AVCompare({ kind, before, after, loading, error }: { kind: 'audio' | 'video'; before?: MediaSide; after?: MediaSide; loading: boolean; error?: string | null }) {
  const t = useTheme();
  const st = sideState(before, after);
  // metadata per media URL: a different file starts with none, nothing to reset
  const [metaByUrl, setMetaByUrl] = useState<Record<string, Meta>>({});
  const meta = { before: (before && metaByUrl[before.url]) || {}, after: (after && metaByUrl[after.url]) || {} };
  const beforeRef = useRef<HTMLMediaElement | null>(null);
  const afterRef = useRef<HTMLMediaElement | null>(null);
  const refs = { before: beforeRef, after: afterRef };
  const [linked, setLinked] = useState(true);
  const syncing = useRef(false);
  const both = !!before && !!after && st === 'modified';

  // linked playback: the other side follows play, pause and seeks
  const follow = (from: 'before' | 'after', what: 'play' | 'pause' | 'seek') => {
    if (!linked || !both || syncing.current) return;
    const src = refs[from].current;
    const dst = refs[from === 'before' ? 'after' : 'before'].current;
    if (!src || !dst) return;
    syncing.current = true;
    try {
      if (what === 'seek' || Math.abs(dst.currentTime - src.currentTime) > 0.25) dst.currentTime = Math.min(src.currentTime, dst.duration || src.currentTime);
      if (what === 'play') void dst.play().catch(() => {});
      if (what === 'pause') dst.pause();
    } finally {
      setTimeout(() => (syncing.current = false), 50);
    }
  };

  if (loading) return <Box><Spinner /></Box>;
  if (error) return <Box><Txt color={t.del} size={FONT.sm}>{error}</Txt></Box>;
  const info = (m: Meta) => [fmtDuration(m.duration), m.w && m.h ? `${m.w}×${m.h}` : ''].filter(Boolean).join(' · ') || undefined;
  const delta = () => {
    const a = meta.before;
    const b = meta.after;
    const parts: string[] = [];
    if (a.duration !== undefined && b.duration !== undefined) {
      const d = b.duration - a.duration;
      parts.push(Math.abs(d) < 0.005 ? 'same duration' : `duration ${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} s`);
    }
    if (a.w && b.w && (a.w !== b.w || a.h !== b.h)) parts.push(`resolution ${a.w}×${a.h} → ${b.w}×${b.h}`);
    return parts.join(' · ');
  };
  const sides = ([['before', before], ['after', after]] as const).filter(([, s]) => !!s) as ['before' | 'after', MediaSide][];
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <SideBanner state={st} kind={kind} before={before} after={after} beforeInfo={info(meta.before)} afterInfo={info(meta.after)} />
      {both && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 8 }}>
          <Checkbox checked={linked} onChange={setLinked} label="Link playback" />
          <Txt size={FONT.xs} faint style={{ marginLeft: 12 }}>
            {delta()}
          </Txt>
        </View>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexWrap: 'wrap', gap: 12, padding: 12, alignContent: 'flex-start' }}>
        {sides.map(([which, side]) => (
          <SidePlayer
            key={which + side.url}
            kind={kind}
            which={which}
            side={side}
            deleted={st === 'deleted'}
            mediaRef={refs[which]}
            onMeta={(m) => setMetaByUrl((x) => ({ ...x, [side.url]: { ...x[side.url], ...m } }))}
            meta={meta[which]}
            onEvent={(what) => follow(which, what)}
            single={sides.length === 1}
          />
        ))}
      </div>
    </View>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120 }}>{children}</div>;
}

function SidePlayer({ kind, which, side, deleted, mediaRef, onMeta, meta, onEvent, single }: { kind: 'audio' | 'video'; which: 'before' | 'after'; side: MediaSide; deleted: boolean; mediaRef: React.MutableRefObject<HTMLMediaElement | null>; onMeta: (m: Meta) => void; meta: Meta; onEvent: (w: 'play' | 'pause' | 'seek') => void; single: boolean }) {
  const t = useTheme();
  const color = which === 'before' ? t.del : t.add;
  const [time, setTime] = useState(0);
  const wave = useWaveform(side, kind === 'audio' && !meta.error);
  const label = which === 'before' ? (deleted ? 'BEFORE · deleted' : 'BEFORE') : single ? 'AFTER · new file' : 'AFTER';
  const common = {
    ref: (el: HTMLMediaElement | null) => (mediaRef.current = el),
    src: side.url,
    controls: true,
    preload: 'metadata',
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget as HTMLVideoElement;
      onMeta({ duration: el.duration, w: (el as any).videoWidth || undefined, h: (el as any).videoHeight || undefined });
    },
    onError: () => onMeta({ error: true }),
    onPlay: () => onEvent('play'),
    onPause: () => onEvent('pause'),
    onSeeked: () => onEvent('seek'),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => setTime(e.currentTarget.currentTime),
  };
  return (
    <div data-side={which} style={{ flex: single ? '1 1 100%' : '1 1 360px', minWidth: 0, maxWidth: single ? 900 : undefined, border: `1px solid ${t.border}`, background: t.panelAlt, padding: 10, boxSizing: 'border-box', opacity: deleted ? 0.9 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ width: 6, height: 6, background: color, display: 'inline-block' }} />
        <span style={{ color, font: `600 10px ${t.fontFor('600')}`, letterSpacing: 0.6 }}>{label}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: t.textFaint, font: `400 11px ${t.fontFor('400')}` }}>{[fmtDuration(meta.duration), meta.w && meta.h ? `${meta.w}×${meta.h}` : '', fmtBytes(side.bytes)].filter(Boolean).join(' · ')}</span>
      </div>
      {meta.error ? (
        <div style={{ padding: '18px 0', color: t.textMuted, font: `400 12px ${t.fontFor('400')}` }}>{"This format can't be played here. Use “Open” to play it in the default app."}</div>
      ) : kind === 'video' ? (
        <video {...(common as any)} playsInline style={{ width: '100%', maxHeight: 420, background: '#000', display: 'block' }} />
      ) : (
        <>
          <Waveform state={wave} time={time} duration={meta.duration} color={color} onSeek={(sec) => mediaRef.current && (mediaRef.current.currentTime = sec)} />
          <audio {...(common as any)} style={{ width: '100%', display: 'block', marginTop: 6 }} />
        </>
      )}
    </div>
  );
}

function Waveform({ state, time, duration, color, onSeek }: { state: { peaks?: [number, number][]; error?: string; loading?: boolean }; time: number; duration?: number; color: string; onSeek: (sec: number) => void }) {
  const t = useTheme();
  const H = 64;
  if (!state.peaks)
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.textFaint, font: `400 11px ${t.fontFor('400')}`, border: `1px solid ${t.border}` }}>
        {state.loading ? 'reading waveform…' : state.error ? `no waveform (${state.error})` : ''}
      </div>
    );
  const n = state.peaks.length;
  const head = duration ? (time / duration) * n : -1;
  return (
    <svg
      data-waveform="1"
      viewBox={`0 0 ${n} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: H, display: 'block', cursor: duration ? 'pointer' : 'default', background: t.bg, border: `1px solid ${t.border}` }}
      onClick={(e) => {
        if (!duration) return;
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onSeek(((e.clientX - r.left) / r.width) * duration);
      }}
    >
      {state.peaks.map(([lo, hi], i) => (
        <rect key={i} x={i} y={H / 2 - hi * (H / 2)} width={0.8} height={Math.max(0.6, (hi - lo) * (H / 2))} fill={i <= head ? color : t.textFaint} />
      ))}
      {head >= 0 && <rect x={head} y={0} width={1} height={H} fill={t.accent} />}
    </svg>
  );
}
