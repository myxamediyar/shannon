// Tool-callback registry. When a chat tool needs the browser to do client-side
// work (rasterize shapes, render a PDF page, read a note, etc.) the chat
// handler registers a Promise keyed by callbackId. The browser POSTs the
// result to /api/chat/tool-callback which calls resolveCallback to unblock the
// pending Promise. Shared module scope so both ends see the same Map.
const callbacks = new Map<string, (data: string) => void>();

export function registerCallback(id: string): Promise<string> {
  return new Promise((resolve) => {
    callbacks.set(id, resolve);
  });
}

export function resolveCallback(id: string, data: string): boolean {
  const cb = callbacks.get(id);
  if (cb) {
    cb(data);
    callbacks.delete(id);
    return true;
  }
  return false;
}
