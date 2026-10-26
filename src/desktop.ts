/**
 * Bridge to the macOS shell (macos/Sources/main.swift). Present only when the UI runs inside the
 * desktop app: `window.__PRONG_DESKTOP__` is injected before the page loads, and
 * `window.webkit.messageHandlers.prong` carries requests; replies come back via `__prongReply`.
 */

declare const window: any;

export interface DesktopInfo {
  version: string;
  platform: 'macos';
}

export function desktop(): DesktopInfo | null {
  try {
    return typeof window !== 'undefined' && window.__PRONG_DESKTOP__ ? (window.__PRONG_DESKTOP__ as DesktopInfo) : null;
  } catch {
    return null;
  }
}

let seq = 0;
const pending = new Map<number, (v: unknown) => void>();

function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> {
  const bridge = typeof window !== 'undefined' ? window.webkit?.messageHandlers?.prong : null;
  if (!bridge) return Promise.resolve(null);
  if (!window.__prongReply) {
    window.__prongReply = (id: number, result: unknown) => {
      const cb = pending.get(id);
      pending.delete(id);
      cb?.(result);
    };
  }
  const id = ++seq;
  return new Promise<T | null>((resolve) => {
    pending.set(id, (v) => resolve((v as T) ?? null));
    bridge.postMessage({ id, cmd, ...args });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve(null);
      }
    }, 120000);
  });
}

export const pickFolder = (message: string, prompt = 'Choose') => call<string>('pickFolder', { message, prompt });
export const revealInFinder = (path: string) => call<boolean>('reveal', { path });
export const openInTerminal = (path: string) => call<boolean>('openTerminal', { path });
export const openExternal = (url: string) => call<boolean>('openExternal', { url });
export const setWindowTitle = (title: string) => call<boolean>('setTitle', { title });
