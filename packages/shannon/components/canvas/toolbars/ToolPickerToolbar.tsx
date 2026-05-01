"use client";

import { TOOLS, type ToolId } from "../../../lib/canvas-types";
import { ToolTip } from "./ToolTip";
import { useSettings } from "../../../lib/use-settings";

export type ShapeSubTool = "rect" | "circle" | "triangle" | "arrow";

type Props = {
  activeTool: ToolId | null;
  isCanvasTyping: boolean;
  shapeSubTool: ShapeSubTool;
  selectTool: (id: ToolId) => void;
  setShapeSubTool: (id: ShapeSubTool) => void;
  setActiveTool: (id: ToolId) => void;
};

const TIP: Record<string, { label: string; shortcut: string }> = {
  mover:       { label: "Cursor",      shortcut: "V" },
  text:        { label: "Text",        shortcut: "T" },
  eraser:      { label: "Eraser",      shortcut: "E" },
  draw:        { label: "Draw",        shortcut: "D" },
  shape:       { label: "Shape",       shortcut: "S" },
  image:       { label: "Image",       shortcut: "I" },
  pdf:         { label: "PDF",         shortcut: "" },
  noteRef:     { label: "Note Link",   shortcut: "L" },
  graph:       { label: "Graph",       shortcut: "G" },
  print:       { label: "Print Region", shortcut: "P" },
  chat:        { label: "Chat",        shortcut: "C" },
  table:       { label: "Table",       shortcut: "" },
  checklist:   { label: "Checklist",   shortcut: "" },
};

const SHAPE_SUB_TOOLS: { id: ShapeSubTool; icon: string; label: string }[] = [
  { id: "rect",     icon: "rectangle",       label: "Rectangle" },
  { id: "circle",   icon: "circle",          label: "Circle" },
  { id: "triangle", icon: "change_history",  label: "Triangle" },
  { id: "arrow",    icon: "arrow_right_alt",  label: "Arrow" },
];

export function ToolPickerToolbar({
  activeTool, isCanvasTyping, shapeSubTool, selectTool, setShapeSubTool, setActiveTool,
}: Props) {
  const { settings } = useSettings();
  const expanded = settings.expandedToolbar;
  const activeShapeIcon = SHAPE_SUB_TOOLS.find(s => s.id === shapeSubTool)?.icon ?? "category";
  return (
    <div className="absolute top-8 left-1/2 -translate-x-1/2 p-1.5 rounded-2xl flex items-center gap-1 z-20"
      style={{ background: "var(--th-surface-overlay)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: "0.5px solid var(--th-border-subtle)", boxShadow: "0 8px 32px var(--th-shadow-heavy)" }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>

      {(() => { const t = TOOLS.find(t => t.id === "mover")!; return (
        <ToolTip label={TIP.mover.label} shortcut={TIP.mover.shortcut}>
          <button onClick={() => selectTool("mover")}
            className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors ${activeTool === "mover" ? "bg-[var(--th-accent)] text-[var(--th-accent-on)]" : "hover:bg-[var(--th-surface-hover)] text-[var(--th-text-muted)] hover:text-[var(--th-text-secondary)]"}`}>
            <span className="material-symbols-outlined">{t.icon}</span>
          </button>
        </ToolTip>
      ); })()}

      <div className="w-[1px] h-6 bg-[var(--th-divider)] mx-1" />

      {(["text", "draw", "eraser"] as ToolId[]).map((id) => {
        const t = TOOLS.find(t => t.id === id)!;
        const toolLit = activeTool === id || (id === "text" && isCanvasTyping && !activeTool);
        return (
          <ToolTip key={id} label={TIP[id]?.label ?? t.label} shortcut={TIP[id]?.shortcut ?? ""}>
            <button onClick={() => selectTool(id)}
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors ${toolLit ? "bg-[var(--th-accent)] text-[var(--th-accent-on)]" : "hover:bg-[var(--th-surface-hover)] text-[var(--th-text-muted)] hover:text-[var(--th-text-secondary)]"}`}>
              <span className="material-symbols-outlined">{t.icon}</span>
            </button>
          </ToolTip>
        );
      })}

      {expanded && <div className="w-[1px] h-6 bg-[var(--th-divider)] mx-1" />}

      {expanded && (() => {
        const shapeLit = activeTool === "shape";
        return (
          <div className="relative group">
            <ToolTip label={TIP.shape.label} shortcut={TIP.shape.shortcut}>
              <button onClick={() => selectTool("shape")}
                className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors ${shapeLit ? "bg-[var(--th-accent)] text-[var(--th-accent-on)]" : "hover:bg-[var(--th-surface-hover)] text-[var(--th-text-muted)] hover:text-[var(--th-text-secondary)]"}`}>
                <span className="material-symbols-outlined">{activeShapeIcon}</span>
              </button>
            </ToolTip>
            <div className="absolute top-full left-1/2 -translate-x-1/2 pt-2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
              <div className="rounded-xl p-1 flex flex-col gap-0.5"
                style={{ background: "var(--th-surface-raised)", border: "0.5px solid var(--th-border-subtle)", boxShadow: "0 8px 32px var(--th-shadow-heavy)" }}>
                {SHAPE_SUB_TOOLS.map((sub) => (
                  <button key={sub.id}
                    onClick={() => { setShapeSubTool(sub.id); setActiveTool("shape"); }}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-left whitespace-nowrap transition-colors ${shapeSubTool === sub.id && shapeLit ? "bg-[var(--th-accent)] text-[var(--th-accent-on)]" : shapeSubTool === sub.id ? "bg-[var(--th-surface-hover)] text-[var(--th-text)]" : "text-[var(--th-text-muted)] hover:bg-[var(--th-surface-hover)] hover:text-[var(--th-text-secondary)]"}`}>
                    <span className="material-symbols-outlined text-lg">{sub.icon}</span>
                    <span className="text-[11px] font-lexend font-medium">{sub.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {expanded && (["image", "pdf", "noteRef", "graph", "table", "checklist", "print", "chat"] as ToolId[]).map((id) => {
        const t = TOOLS.find(t => t.id === id)!;
        return (
          <ToolTip key={id} label={TIP[id]?.label ?? t.label} shortcut={TIP[id]?.shortcut ?? ""}>
            <button onClick={() => selectTool(id)}
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors ${activeTool === id ? "bg-[var(--th-accent)] text-[var(--th-accent-on)]" : "hover:bg-[var(--th-surface-hover)] text-[var(--th-text-muted)] hover:text-[var(--th-text-secondary)]"}`}>
              <span className="material-symbols-outlined">{t.icon}</span>
            </button>
          </ToolTip>
        );
      })}

    </div>
  );
}
