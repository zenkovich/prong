import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crashLog, ErrorBoundary, onCrash, reportCrash } from './ErrorBoundary';

// the boundary's recovery policy is what matters here; the visual pieces are stubbed out so the test
// does not pull react-native-svg (a CommonJS package that requires the flow-typed react-native).
// vi.mock is hoisted above the imports by vitest.
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('./primitives', () => ({ Txt: () => null, Button: () => null }));

/** Drives the boundary's lifecycle methods directly: no DOM is needed to check the recovery policy. */
function boundary(onRecover: () => void) {
  const b = new ErrorBoundary({ name: 'Panel', children: null, onRecover });
  b.setState = (p: any) => Object.assign(b.state, typeof p === 'function' ? p(b.state) : p);
  return b;
}

describe('ErrorBoundary', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records crashes and notifies listeners', () => {
    const seen: string[] = [];
    const off = onCrash((c) => seen.push(`${c.panel}: ${c.message}`));
    reportCrash('Diff', new Error('boom'));
    reportCrash('window', 'plain string');
    off();
    reportCrash('ignored', new Error('x'));
    expect(seen).toEqual(['Diff: boom', 'window: plain string']);
    expect(crashLog().slice(-3).map((c) => c.panel)).toEqual(['Diff', 'window', 'ignored']);
  });

  it('derives the failed state from the error', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('render failed'))).toEqual({ failed: true, message: 'render failed' });
  });

  it('auto-recovers up to three times in ten seconds, then stays down until Retry', () => {
    const recover = vi.fn();
    const b = boundary(recover);
    for (let i = 0; i < 3; i++) {
      Object.assign(b.state, ErrorBoundary.getDerivedStateFromError(new Error(`crash ${i}`)));
      b.componentDidCatch(new Error(`crash ${i}`), { componentStack: '' } as any);
      expect(b.state.failed).toBe(true);
      vi.advanceTimersByTime(100);
      expect(b.state.failed).toBe(false); // came back on its own
    }
    expect(recover).toHaveBeenCalledTimes(3);
    Object.assign(b.state, ErrorBoundary.getDerivedStateFromError(new Error('crash 3')));
    b.componentDidCatch(new Error('crash 3'), { componentStack: '' } as any);
    vi.advanceTimersByTime(100);
    expect(b.state.failed).toBe(true); // fourth crash in the window: no auto-recovery
    expect(recover).toHaveBeenCalledTimes(3);
    b.retry();
    expect(b.state.failed).toBe(false);
    expect(recover).toHaveBeenCalledTimes(4);
    expect(b.state.crashes).toEqual([]);
  });

  it('forgets crashes older than the window', () => {
    const recover = vi.fn();
    const b = boundary(recover);
    for (let i = 0; i < 3; i++) {
      b.componentDidCatch(new Error('old'), { componentStack: '' } as any);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(11_000);
    b.componentDidCatch(new Error('new'), { componentStack: '' } as any);
    vi.advanceTimersByTime(100);
    expect(b.state.failed).toBe(false);
    expect(recover).toHaveBeenCalledTimes(4);
  });

  it('a throwing recovery callback does not break the boundary', () => {
    const b = boundary(() => {
      throw new Error('recovery failed');
    });
    expect(() => b.componentDidCatch(new Error('x'), { componentStack: '' } as any)).not.toThrow();
    expect(() => b.retry()).not.toThrow();
  });
});
