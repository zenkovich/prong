import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

/** the files a drop or a paste carries (a pasted screenshot is one file with no name) */
export function filesOf(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files?.length) for (const f of Array.from(dt.files)) out.push(f);
  else
    for (const it of Array.from(dt.items ?? [])) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  return out;
}

const carriesFiles = (dt: DataTransfer | null | undefined) => !!dt && Array.from(dt.types ?? []).includes('Files');

/**
 * A box that takes files: dropped on it (the window's own drop, which opens a dropped folder as a repository, does
 * not see them) or pasted into a field inside it (a pasted text stays typing). `over`: files are being dragged
 * over it, to show where they go. `box` goes on the box's View as its ref (react-native-web: its DOM node).
 */
export function useFileTarget(onFiles: (files: File[]) => void, enabled = true) {
  // the box's node, set by `box` (a callback ref): the listeners go on it once it is there
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [over, setOver] = useState(false);
  const take = useRef(onFiles);
  useEffect(() => {
    take.current = onFiles;
  });
  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled || !node?.addEventListener) return;
    // enter/leave fire for every child the pointer crosses: counted, so the mark does not flicker
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const overIt = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      const files = filesOf(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      take.current(files);
    };
    const paste = (e: ClipboardEvent) => {
      const files = filesOf(e.clipboardData);
      if (!files.length) return;
      // cells or a styled text copied from an app carry a picture of themselves too: the text is what was meant;
      // files copied in Finder carry their names as the text, and the files are
      const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
      if (text && !files.some((f) => f.name && text.includes(f.name))) return;
      e.preventDefault();
      take.current(files);
    };
    node.addEventListener('dragenter', enter);
    node.addEventListener('dragover', overIt);
    node.addEventListener('dragleave', leave);
    node.addEventListener('drop', drop);
    node.addEventListener('paste', paste);
    return () => {
      node.removeEventListener('dragenter', enter);
      node.removeEventListener('dragover', overIt);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
      node.removeEventListener('paste', paste);
    };
  }, [enabled, node]);
  return { box: setNode as (n: any) => void, over };
}
