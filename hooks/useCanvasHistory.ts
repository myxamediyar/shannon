import { useCallback, useRef } from "react";
import {
  type UndoStack,
  type Snapshot,
  emptyStack,
  pushSnapshot,
  isExceptedChange,
  undo as undoStack,
  redo as redoStack,
} from "../lib/canvas-history";

/** Time window (ms) during which repeated edits to the same element coalesce into one history entry. */
const COALESCE_WINDOW_MS = 300;

/**
 * Per-note undo/redo stacks with rapid-edit coalescing.
 *
 * The hook owns the stack map + coalesce tracker. Consumers:
 *   - call `record(aid, prev, current, changedId?)` on every mutation
 *   - call `undo(aid, current)` / `redo(aid, current)` for cmd+z / cmd+shift+z
 * Undo/redo return the target snapshot (or null if the stack is empty); applying it to
 * canvas refs stays in the shell because history doesn't own element state.
 */
export function useCanvasHistory() {
  const historyRef = useRef<Map<string, UndoStack>>(new Map());
  const coalesceRef = useRef<{ time: number; changedId: string | null }>({ time: 0, changedId: null });

  const getStack = useCallback((noteId: string): UndoStack => {
    return historyRef.current.get(noteId) ?? emptyStack();
  }, []);

  const record = useCallback((aid: string, prev: Snapshot, current: Snapshot, changedId?: string) => {
    if (isExceptedChange(prev, current)) return;
    const now = Date.now();
    const c = coalesceRef.current;
    if (changedId && c.changedId === changedId && now - c.time < COALESCE_WINDOW_MS) {
      coalesceRef.current = { time: now, changedId };
    } else {
      historyRef.current.set(aid, pushSnapshot(getStack(aid), prev));
      coalesceRef.current = { time: now, changedId: changedId ?? null };
    }
  }, [getStack]);

  const undo = useCallback((aid: string, current: Snapshot): Snapshot | null => {
    coalesceRef.current = { time: 0, changedId: null };
    const result = undoStack(getStack(aid), current);
    if (!result) return null;
    historyRef.current.set(aid, result.stack);
    return result.snapshot;
  }, [getStack]);

  const redo = useCallback((aid: string, current: Snapshot): Snapshot | null => {
    coalesceRef.current = { time: 0, changedId: null };
    const result = redoStack(getStack(aid), current);
    if (!result) return null;
    historyRef.current.set(aid, result.stack);
    return result.snapshot;
  }, [getStack]);

  return { record, undo, redo };
}
