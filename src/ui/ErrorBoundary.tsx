import React from 'react';
import { View } from 'react-native';
import { FONT, THEMES, ThemeContext, type Theme } from '../theme';
import { Button, Txt } from './primitives';

/**
 * Crash containment. A render error inside a panel used to unmount the whole React tree (a black
 * window). Each panel sits in its own boundary: the error is logged, the panel's state is reset
 * through `onRecover` and the panel re-renders on its own. After 3 crashes within 10 s the panel
 * stays down with a Retry button so a persistent bug does not loop; the root boundary offers a reload.
 */

export interface CrashRecord {
  panel: string;
  message: string;
  stack?: string;
  time: number;
}

const listeners = new Set<(c: CrashRecord) => void>();
const history: CrashRecord[] = [];
export const crashLog = () => history.slice();
export function onCrash(fn: (c: CrashRecord) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function reportCrash(panel: string, err: unknown, stack?: string) {
  const rec: CrashRecord = { panel, message: err instanceof Error ? err.message : String(err), stack: stack ?? (err instanceof Error ? err.stack : undefined), time: Date.now() };
  history.push(rec);
  if (history.length > 50) history.shift();
  for (const l of listeners) l(rec);
  try {
    console.error(`[prong] ${panel} crashed: ${rec.message}`);
  } catch {
    /* ignore */
  }
}

/** who a crash can be handed to ("Ask AI"); set by the app, so this module does not depend on the state layer */
let assistant: ((title: string, detail: string) => void) | null = null;
export function setCrashAssistant(fn: ((title: string, detail: string) => void) | null) {
  assistant = fn;
}

const AUTO_LIMIT = 3;
const AUTO_WINDOW = 10_000;

interface Props {
  name: string;
  children: React.ReactNode;
  /** resets the state that made the panel crash (e.g. deselects the file) */
  onRecover?: () => void;
  /** root boundary: a full-window fallback with reload */
  root?: boolean;
  /** show the error in place right away (no auto-recovery): for previews, where retrying the same file fails again */
  inline?: boolean;
}
interface State {
  failed: boolean;
  message: string;
  crashes: number[];
}

export class ErrorBoundary extends React.Component<Props, State> {
  static contextType = ThemeContext;
  state: State = { failed: false, message: '', crashes: [] };
  private timer: number | null = null;

  static getDerivedStateFromError(e: unknown): Partial<State> {
    return { failed: true, message: e instanceof Error ? e.message : String(e) };
  }

  componentDidCatch(e: unknown, info: React.ErrorInfo) {
    reportCrash(this.props.name, e, info.componentStack ?? undefined);
    const now = Date.now();
    const crashes = [...this.state.crashes.filter((t) => now - t < AUTO_WINDOW), now];
    this.setState({ crashes });
    if (!this.props.inline && crashes.length <= AUTO_LIMIT) {
      try {
        this.props.onRecover?.();
      } catch {
        /* the recovery itself must never throw */
      }
      this.timer = setTimeout(() => this.setState({ failed: false }), 60) as unknown as number;
    }
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  retry = () => {
    try {
      this.props.onRecover?.();
    } catch {
      /* ignore */
    }
    this.setState({ failed: false, crashes: [] });
  };

  /** the crash, with where it happened in the component tree, to the agent */
  askAi = () => {
    const title = this.props.root ? 'Prong hit an error' : this.props.inline ? `${this.props.name} failed` : `${this.props.name} crashed`;
    const rec = [...history].reverse().find((c) => c.panel === this.props.name);
    assistant?.(title, [this.state.message, rec?.stack].filter(Boolean).join('\n\n'));
  };

  render() {
    if (!this.state.failed) return this.props.children;
    const t = (this.context as Theme | undefined) ?? THEMES.amber;
    const looping = this.state.crashes.length > AUTO_LIMIT;
    if (!looping && !this.props.root && !this.props.inline) return null; // recovering: the panel comes back on the next tick
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: t.panel }}>
        <Txt weight="600">{this.props.root ? 'Prong hit an error' : this.props.inline ? `${this.props.name} failed` : `${this.props.name} crashed`}</Txt>
        <Txt muted size={FONT.sm} style={{ marginTop: 6, textAlign: 'center', maxWidth: 520 }} selectable>
          {this.state.message}
        </Txt>
        <View style={{ flexDirection: 'row', marginTop: 14 }}>
          <Button label="Retry" primary onPress={this.retry} />
          {this.props.root && typeof location !== 'undefined' && <Button label="Reload" style={{ marginLeft: 8 }} onPress={() => location.reload()} />}
          {assistant && <Button label="Ask AI" icon="agent" style={{ marginLeft: 8 }} onPress={this.askAi} testID="crash-ask-ai" />}
        </View>
      </View>
    );
  }
}
