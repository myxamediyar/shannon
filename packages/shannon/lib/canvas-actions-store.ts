// Cross-component action requests for the notes canvas. Replaces the
// legacy `notes:export-html` window event: the sidebar (or anywhere) calls
// `requestExportHtml(noteId)`, the canvas subscribes via useSyncExternalStore
// and runs the export when its active note id matches the request.

let pendingExportNoteId: string | null = null;
const subs = new Set<() => void>();

function notify() {
  for (const l of subs) l();
}

export function subscribePendingExport(listener: () => void): () => void {
  subs.add(listener);
  return () => { subs.delete(listener); };
}

export function getPendingExportSnapshot(): string | null {
  return pendingExportNoteId;
}

export function requestExportHtml(noteId: string): void {
  pendingExportNoteId = noteId;
  notify();
}

/** Clear the request if (and only if) it targets `noteId`. Returns whether
 *  there was a matching request — so the caller can decide whether to fire
 *  the export. */
export function consumePendingExport(noteId: string): boolean {
  if (pendingExportNoteId !== noteId) return false;
  pendingExportNoteId = null;
  notify();
  return true;
}
