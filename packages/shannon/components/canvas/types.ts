import type {
  CanvasEl,
  PlacementOp,
  PlacementResponse,
  ToolId,
} from "../../lib/canvas-types";

/** Options accepted alongside a placement op — passed through to `execPlace`. */
export type DispatchOptions = PlacementResponse & {
  immediate?: boolean;
  skipHistory?: boolean;
  changedId?: string;
};

/** Parent-provided handle: children ask the canvas to mutate the element graph. */
export type Dispatch = (op: PlacementOp, opts?: DispatchOptions) => void;

/**
 * The uniform contract every canvas child container implements.
 *
 * The canvas knows only `{id, type, bbox}`; containers own their own rendering
 * and dispatch back via `dispatch(op)` — this is the "child asks, parent resolves"
 * pattern made concrete. Selection chrome is drawn by the shell, not containers.
 */
export interface CanvasChildProps<E extends CanvasEl> {
  el: E;
  canvasScale: number;
  activeTool: ToolId | null;
  locked: boolean;
  selected: boolean;
  dispatch: Dispatch;
  /** Optional: containers whose content measures itself (Math, Text) report size back. */
  onMeasure?: (id: string, w: number, h: number) => void;
}
