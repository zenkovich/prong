/**
 * A folder dropped on the window: the browser would otherwise open the dropped file in place of Prong. A drop that
 * names a path (a file:// address, a typed path) opens it as a repository; a folder from Finder gives a web page no
 * path, so that says how to open it instead.
 */
export function droppedPath(dt: { getData: (type: string) => string } | null): string | null {
  if (!dt) return null;
  const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l.startsWith('file://'));
  if (uri) {
    try {
      return decodeURIComponent(new URL(uri).pathname).replace(/\/+$/, '') || null;
    } catch {
      return null;
    }
  }
  const text = (dt.getData('text/plain') || '').trim();
  return /^(\/|~\/)[^\n]*$/.test(text) ? text.replace(/\/+$/, '') || null : null;
}
