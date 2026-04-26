"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { compile, parse } from "mathjs";
import katex from "katex";
import type { GraphEl } from "../lib/canvas-types";

// ── Expression normalizer (strip LaTeX fragments → math.js syntax) ───────

function normalize(expr: string): string {
  let s = expr.trim();
  // Strip \left / \right
  s = s.replace(/\\left/g, "").replace(/\\right/g, "");
  // |expr| → abs(expr)
  s = s.replace(/\|([^|]+)\|/g, "abs($1)");
  // \frac{a}{b} → ((a)/(b))
  for (let i = 0; i < 10; i++) {
    s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "(($1)/($2))");
  }
  // \sqrt{...} → sqrt(...)
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, "sqrt($1)");
  // \abs{...} → abs(...)
  s = s.replace(/\\abs\{([^{}]+)\}/g, "abs($1)");
  // Backslash-prefixed functions → plain names (e.g. \sin → sin)
  s = s.replace(/\\(a?(?:sin|cos|tan)h?|sqrt|abs|ln|log|exp)\b/g, "$1");
  // \pi → pi, \e → e
  s = s.replace(/\\pi\b/g, "pi");
  s = s.replace(/\\e\b/g, "e");
  // x^{expr} → x^(expr)
  s = s.replace(/\^{([^{}]+)}/g, "^($1)");
  // Strip stray backslashes
  s = s.replace(/\\/g, "");
  return s;
}

// ── Expression parser using math.js ──────────────────────────────────────

type PlotFn =
  | { kind: "explicit"; fn: (x: number) => number }       // y = f(x)
  | { kind: "explicit_x"; fn: (y: number) => number }     // x = f(y)
  | { kind: "implicit"; fn: (x: number, y: number) => number }; // f(x,y) = 0

function parseExpression(raw: string): PlotFn | null {
  try {
    const trimmed = raw.trim();

    // y = f(x)
    const yMatch = trimmed.match(/^y\s*=\s*(.+)$/);
    if (yMatch) {
      const code = compile(normalize(yMatch[1]));
      const fn = (x: number) => code.evaluate({ x }) as number;
      fn(0); // test
      return { kind: "explicit", fn };
    }

    // x = f(y)
    const xMatch = trimmed.match(/^x\s*=\s*(.+)$/);
    if (xMatch && !xMatch[1].includes("x")) {
      const code = compile(normalize(xMatch[1]));
      const fn = (y: number) => code.evaluate({ y }) as number;
      fn(0);
      return { kind: "explicit_x", fn };
    }

    // Implicit: anything with = sign → f(x,y) = 0
    if (trimmed.includes("=")) {
      const [lhs, rhs] = trimmed.split("=").map(s => s.trim());
      const codeLhs = compile(normalize(lhs));
      const codeRhs = compile(normalize(rhs));
      const fn = (x: number, y: number) =>
        (codeLhs.evaluate({ x, y }) as number) - (codeRhs.evaluate({ x, y }) as number);
      fn(0, 0);
      return { kind: "implicit", fn };
    }

    // No = sign: treat as y = expr
    const code = compile(normalize(trimmed));
    const fn = (x: number) => code.evaluate({ x }) as number;
    fn(0);
    return { kind: "explicit", fn };
  } catch {
    return null;
  }
}

// ── Graph colors for multiple expressions ─────────────────────────────────

const CURVE_COLORS = [
  "#2d70b3", // blue
  "#c74440", // red
  "#388c46", // green
  "#6042a6", // purple
  "#fa7e19", // orange
  "#000000", // black
  "#e91e63", // pink
  "#009688", // teal
  "#795548", // brown
  "#607d8b", // blue-grey
  "#ff5722", // deep orange
  "#3f51b5", // indigo
  "#8bc34a", // light green
  "#ffc107", // amber
  "#00bcd4", // cyan
  "#9c27b0", // deep purple
  "#cddc39", // lime
  "#f44336", // bright red
  "#1b5e20", // dark green
  "#4a148c", // dark purple
];

// ── Canvas renderer ───────────────────────────────────────────────────────

function drawGraph(
  canvas: HTMLCanvasElement,
  expressions: string[],
  xBounds: [number, number],
  yBounds: [number, number],
  preParsed?: (PlotFn | null)[],
  expressionColors?: string[],
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const [xMin, xMax] = xBounds;
  const [yMin, yMax] = yBounds;
  const xRange = xMax - xMin;
  const yRange = yMax - yMin;

  // Coordinate transforms
  const toPixelX = (x: number) => ((x - xMin) / xRange) * w;
  const toPixelY = (y: number) => ((yMax - y) / yRange) * h;

  // ── Background ──
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  // ── Grid ──
  const gridStep = (range: number) => {
    const raw = range / 8;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    if (norm < 1.5) return mag;
    if (norm < 3.5) return 2 * mag;
    if (norm < 7.5) return 5 * mag;
    return 10 * mag;
  };

  const xStep = gridStep(xRange);
  const yStep = gridStep(yRange);

  ctx.strokeStyle = "#e8e8e8";
  ctx.lineWidth = 1;

  // Vertical grid lines
  let xStart = Math.ceil(xMin / xStep) * xStep;
  for (let x = xStart; x <= xMax; x += xStep) {
    const px = toPixelX(x);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }

  // Horizontal grid lines
  let yStart = Math.ceil(yMin / yStep) * yStep;
  for (let y = yStart; y <= yMax; y += yStep) {
    const py = toPixelY(y);
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
    ctx.stroke();
  }

  // ── Axes ──
  ctx.strokeStyle = "#b0b0b0";
  ctx.lineWidth = 1.5;

  // X-axis
  if (yMin <= 0 && yMax >= 0) {
    const py = toPixelY(0);
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
    ctx.stroke();
  }

  // Y-axis
  if (xMin <= 0 && xMax >= 0) {
    const px = toPixelX(0);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }

  // ── Tick labels ──
  const fontSize = Math.max(11, Math.min(16, Math.min(w, h) * 0.04));
  ctx.fillStyle = "#666";
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const axisY = (yMin <= 0 && yMax >= 0) ? toPixelY(0) : h;
  for (let x = xStart; x <= xMax; x += xStep) {
    if (Math.abs(x) < xStep * 0.01) continue;
    const px = toPixelX(x);
    const label = Number(x.toPrecision(4)).toString();
    ctx.fillText(label, px, Math.min(axisY + 4, h - 14));
  }

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const axisX = (xMin <= 0 && xMax >= 0) ? toPixelX(0) : 0;
  for (let y = yStart; y <= yMax; y += yStep) {
    if (Math.abs(y) < yStep * 0.01) continue;
    const py = toPixelY(y);
    const label = Number(y.toPrecision(4)).toString();
    ctx.fillText(label, Math.max(axisX - 4, 40), py);
  }

  // ── Plot expressions ──
  const parsed = preParsed ?? expressions.map(parseExpression);

  for (let i = 0; i < parsed.length; i++) {
    const plot = parsed[i];
    if (!plot) continue;
    const color = expressionColors?.[i] ?? CURVE_COLORS[i % CURVE_COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";

    if (plot.kind === "explicit") {
      const samples = w * 2;
      ctx.beginPath();
      let penDown = false;
      for (let s = 0; s <= samples; s++) {
        const x = xMin + (s / samples) * xRange;
        try {
          const y = plot.fn(x);
          if (!isFinite(y)) { penDown = false; continue; }
          const px = toPixelX(x);
          const py = toPixelY(y);
          if (!penDown) { ctx.moveTo(px, py); penDown = true; }
          else {
            // Break line if there's a huge jump (likely discontinuity)
            const prevX = xMin + ((s - 1) / samples) * xRange;
            const prevY = plot.fn(prevX);
            if (isFinite(prevY) && Math.abs(py - toPixelY(prevY)) > h * 2) {
              ctx.moveTo(px, py);
            } else {
              ctx.lineTo(px, py);
            }
          }
        } catch { penDown = false; }
      }
      ctx.stroke();
    } else if (plot.kind === "explicit_x") {
      const samples = h * 2;
      ctx.beginPath();
      let penDown = false;
      for (let s = 0; s <= samples; s++) {
        const y = yMin + (s / samples) * yRange;
        try {
          const x = plot.fn(y);
          if (!isFinite(x)) { penDown = false; continue; }
          const px = toPixelX(x);
          const py = toPixelY(y);
          if (!penDown) { ctx.moveTo(px, py); penDown = true; }
          else ctx.lineTo(px, py);
        } catch { penDown = false; }
      }
      ctx.stroke();
    } else if (plot.kind === "implicit") {
      // Marching squares for implicit curves
      const resolution = 1.5; // pixels per cell
      const cols = Math.ceil(w / resolution);
      const rows = Math.ceil(h / resolution);
      const vals: number[] = new Array((cols + 1) * (rows + 1));

      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          const x = xMin + (c / cols) * xRange;
          const y = yMax - (r / rows) * yRange;
          try {
            vals[r * (cols + 1) + c] = plot.fn(x, y);
          } catch {
            vals[r * (cols + 1) + c] = NaN;
          }
        }
      }

      ctx.beginPath();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const tl = vals[r * (cols + 1) + c];
          const tr = vals[r * (cols + 1) + c + 1];
          const bl = vals[(r + 1) * (cols + 1) + c];
          const br = vals[(r + 1) * (cols + 1) + c + 1];
          if (isNaN(tl) || isNaN(tr) || isNaN(bl) || isNaN(br)) continue;
          // Check if zero crossing exists in this cell
          const signs = [tl > 0, tr > 0, bl > 0, br > 0];
          if (signs[0] === signs[1] && signs[1] === signs[2] && signs[2] === signs[3]) continue;
          // Draw a small segment at the interpolated crossing
          const cx = (c + 0.5) * resolution;
          const cy = (r + 0.5) * resolution;
          ctx.moveTo(cx - resolution * 0.6, cy);
          ctx.lineTo(cx + resolution * 0.6, cy);
        }
      }
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

// ── Graph subcommand validation + flash ───────────────────────────────────

export type RescaleResult = {
  xBounds?: [number, number];
  yBounds?: [number, number];
  graphNum?: number;
};

export type RmResult = { graphNum: number; index: number };

export type SedResult = { graphNum: number; index: number; expression: string };

/** Parse "/graph <id> scale ..." args. Format: /graph <id> scale x x0 x1 [y y0 y1] */
export function validateGraphScale(args: string): RescaleResult | null {
  // Expect: "<id> scale <rest>"
  const m = args.match(/^(\d+)\s+scale\s+(.+)$/i);
  if (!m) return null;
  const graphNum = parseInt(m[1]);
  let rest = m[2];

  // Shorthand: just two numbers → square bounds (both axes same range)
  const sqMatch = rest.match(/^(-?[\d.]+)\s+(-?[\d.]+)$/);
  if (sqMatch) {
    const v0 = parseFloat(sqMatch[1]), v1 = parseFloat(sqMatch[2]);
    if (v0 >= v1) return null;
    return { xBounds: [v0, v1], yBounds: [v0, v1], graphNum };
  }

  // Parse axis specs: "x <v0> <v1>" and/or "y <v0> <v1>"
  let xBounds: [number, number] | undefined;
  let yBounds: [number, number] | undefined;

  const xMatch = rest.match(/x\s+(-?[\d.]+)\s+(-?[\d.]+)/i);
  if (xMatch) {
    const v0 = parseFloat(xMatch[1]), v1 = parseFloat(xMatch[2]);
    if (v0 >= v1) return null;
    xBounds = [v0, v1];
  }

  const yMatch = rest.match(/y\s+(-?[\d.]+)\s+(-?[\d.]+)/i);
  if (yMatch) {
    const v0 = parseFloat(yMatch[1]), v1 = parseFloat(yMatch[2]);
    if (v0 >= v1) return null;
    yBounds = [v0, v1];
  }

  // Must have at least one axis
  if (!xBounds && !yBounds) return null;

  return { xBounds, yBounds, graphNum };
}

/** Parse "/graph <id> delete <index>" args. */
export function validateGraphDelete(args: string): RmResult | null {
  const m = args.match(/^(\d+)\s+delete\s+(\d+)$/i);
  if (!m) return null;
  return { graphNum: parseInt(m[1]), index: parseInt(m[2]) };
}

/** Parse "/graph <id> place <index> <expression>" args. */
export function validateGraphPlace(args: string): SedResult | null {
  const m = args.match(/^(\d+)\s+place\s+(\d+)\s+(.+)$/i);
  if (!m) return null;
  return { graphNum: parseInt(m[1]), index: parseInt(m[2]), expression: m[3].trim() };
}

/** Hook that manages flash-red state for text elements with invalid graph commands. */
export function useGraphFlash() {
  const idsRef = useRef(new Set<string>());
  const [, tick] = useState(0);
  const flash = useCallback((id: string) => {
    idsRef.current.add(id);
    tick(n => n + 1);
    setTimeout(() => { idsRef.current.delete(id); tick(n => n + 1); }, 200);
  }, []);
  const has = useCallback((id: string) => idsRef.current.has(id), []);
  return { flash, has };
}

// ── Constants ──────────────────────────────────────────────────────────────

const HANDLE_SIZE = 8;
const MIN_W = 200;
const MIN_H = 150;
const LABEL_GAP = 12;

// ── Props ──────────────────────────────────────────────────────────────────

export interface GraphContainerProps {
  graphEl: GraphEl;
  canvasScale: number;
  onResize: (id: string, changes: { w?: number; h?: number; x?: number; y?: number; xBounds?: [number, number]; yBounds?: [number, number]; expressions?: string[]; expressionColors?: string[] }) => void;
  locked?: boolean;
}

// ── Metadata label ─────────────────────────────────────────────────────────

function exprToTex(raw: string): string {
  try {
    const trimmed = raw.trim();
    // Handle "y = ..." or "x = ..." by converting only the RHS
    const eqMatch = trimmed.match(/^([xy])\s*=\s*(.+)$/);
    if (eqMatch) {
      return `${eqMatch[1]} = ${parse(normalize(eqMatch[2])).toTex()}`;
    }
    // Implicit equation: convert both sides
    if (trimmed.includes("=")) {
      const [lhs, rhs] = trimmed.split("=").map(s => s.trim());
      return `${parse(normalize(lhs)).toTex()} = ${parse(normalize(rhs)).toTex()}`;
    }
    return `y = ${parse(normalize(trimmed)).toTex()}`;
  } catch {
    return raw;
  }
}

function GraphLabel({ graphEl, onExpressionChange, onColorChange, onExpressionAdd, onExpressionDelete, onBoundsChange, locked }: {
  graphEl: GraphEl;
  onExpressionChange?: (index: number, value: string) => void;
  onColorChange?: (index: number, color: string) => void;
  onExpressionAdd?: (value: string, color?: string) => void;
  onExpressionDelete?: (index: number) => void;
  onBoundsChange?: (changes: Partial<GraphEl>) => void;
  locked?: boolean;
}) {
  const xb = graphEl.xBounds ?? [-10, 10];
  const yb = graphEl.yBounds ?? [-10, 10];
  const exprs = graphEl.expressions ?? [];
  const colors = graphEl.expressionColors ?? [];
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingBound, setEditingBound] = useState<"x" | "y" | null>(null);
  const [placeholderColor, setPlaceholderColor] = useState<string | null>(null);
  const inputRefs = useRef<Map<number, HTMLInputElement>>(new Map());

  const getColor = (i: number) => {
    if (i >= exprs.length) return placeholderColor ?? CURVE_COLORS[i % CURVE_COLORS.length];
    return colors[i] ?? CURVE_COLORS[i % CURVE_COLORS.length];
  };

  const cycleColor = (i: number) => {
    const current = getColor(i);
    const idx = CURVE_COLORS.indexOf(current);
    const next = CURVE_COLORS[(idx + 1) % CURVE_COLORS.length];
    if (i >= exprs.length) {
      setPlaceholderColor(next);
    } else {
      onColorChange?.(i, next);
    }
  };

  const commitEdit = (i: number, val: string, original?: string) => {
    val = val.trim();
    if (!val) return;
    if (i < exprs.length) {
      if (val !== original && onExpressionChange) onExpressionChange(i, val);
    } else {
      onExpressionAdd?.(val, placeholderColor ?? undefined);
      setPlaceholderColor(null);
    }
    setEditingIndex(null);
  };

  const renderRow = (i: number, expr: string | undefined, isPlaceholder: boolean) => (
    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, whiteSpace: "nowrap" }}
      onMouseDown={(ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        if (locked) return;
        if (editingIndex !== i) setEditingIndex(i);
      }}
    >
      <span
        style={{
          width: 16, height: 16, borderRadius: 3, flexShrink: 0,
          background: getColor(i),
          opacity: isPlaceholder && !placeholderColor ? 0.2 : 1,
          cursor: locked ? "default" : "pointer",
        }}
        onMouseDown={(ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (locked) return;
          cycleColor(i);
        }}
        title={locked ? undefined : "Click to change color"}
      />
      {editingIndex === i ? (
        <input
          ref={(node) => {
            if (node) { inputRefs.current.set(i, node); node.focus(); }
            else inputRefs.current.delete(i);
          }}
          defaultValue={expr ?? ""}
          placeholder={isPlaceholder ? "y = ..." : undefined}
          className="bg-transparent text-[var(--th-text)] border-b border-[var(--th-border-30)] outline-none font-lexend"
          style={{ fontSize: 22, width: 250 }}
          onMouseDown={(ev) => ev.stopPropagation()}
          onKeyDown={(ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") {
              ev.preventDefault();
              commitEdit(i, ev.currentTarget.value, expr);
            }
            if (ev.key === "Escape") setEditingIndex(null);
            if (ev.key === "Backspace" && ev.currentTarget.value === "") {
              ev.preventDefault();
              if (isPlaceholder) {
                // On placeholder, just move to row above if exists
                if (i > 0) setEditingIndex(i - 1);
                else setEditingIndex(null);
              } else {
                // Delete this expression row
                onExpressionDelete?.(i);
                // Focus the row above (or clear editing if first row)
                if (i > 0) setEditingIndex(i - 1);
                else setEditingIndex(null);
              }
            }
          }}
          onBlur={(ev) => {
            const val = ev.currentTarget.value.trim();
            if (val) commitEdit(i, val, expr);
            else {
              if (isPlaceholder) setPlaceholderColor(null);
              setEditingIndex(null);
            }
          }}
        />
      ) : (
        isPlaceholder ? (
          <span style={{ color: "var(--th-text)", opacity: 0.35, cursor: "text", fontSize: 22, fontFamily: "var(--font-lexend), sans-serif" }}>
            y = ...
          </span>
        ) : (
          <span
            style={{ color: "var(--th-text)", opacity: 0.85, cursor: "text", fontSize: 22 }}
            dangerouslySetInnerHTML={{ __html: katex.renderToString(exprToTex(expr!), { throwOnError: false, displayMode: false }) }}
          />
        )
      )}
    </div>
  );

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: graphEl.w + LABEL_GAP,
        pointerEvents: "auto",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
      onMouseDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => ev.stopPropagation()}
      onDoubleClick={(ev) => ev.stopPropagation()}
    >
      <div style={{ fontFamily: "var(--font-lexend), monospace", fontSize: 16, lineHeight: 1.5, color: "var(--th-text)", opacity: 0.7, margin: 0, whiteSpace: "pre" }}>
        <div>{`Graph ${graphEl.graphNum}`}</div>
        {(["x", "y"] as const).map((axis) => {
          const bounds = axis === "x" ? xb : yb;
          const isEditing = editingBound === axis;
          return (
            <div key={axis} style={{ display: "flex", alignItems: "center" }}>
              <span>{axis}:[</span>
              {isEditing ? (
                <input
                  autoFocus
                  defaultValue={`${bounds[0]},${bounds[1]}`}
                  className="bg-transparent text-[var(--th-text)] border-b border-[var(--th-border-30)] outline-none font-lexend"
                  style={{ fontSize: 16, width: 100, opacity: 1 }}
                  onMouseDown={(ev) => ev.stopPropagation()}
                  onKeyDown={(ev) => {
                    ev.stopPropagation();
                    if (ev.key === "Enter") {
                      ev.preventDefault();
                      const parts = ev.currentTarget.value.split(",").map(s => parseFloat(s.trim()));
                      if (parts.length === 2 && parts.every(n => isFinite(n)) && parts[0] < parts[1]) {
                        onBoundsChange?.(axis === "x" ? { xBounds: [parts[0], parts[1]] } : { yBounds: [parts[0], parts[1]] });
                      }
                      setEditingBound(null);
                    }
                    if (ev.key === "Escape") setEditingBound(null);
                    if (ev.key === "Tab") {
                      ev.preventDefault();
                      const parts = ev.currentTarget.value.split(",").map(s => parseFloat(s.trim()));
                      if (parts.length === 2 && parts.every(n => isFinite(n)) && parts[0] < parts[1]) {
                        onBoundsChange?.(axis === "x" ? { xBounds: [parts[0], parts[1]] } : { yBounds: [parts[0], parts[1]] });
                      }
                      setEditingBound(axis === "x" ? "y" : "x");
                    }
                  }}
                  onBlur={(ev) => {
                    const parts = ev.currentTarget.value.split(",").map(s => parseFloat(s.trim()));
                    if (parts.length === 2 && parts.every(n => isFinite(n)) && parts[0] < parts[1]) {
                      onBoundsChange?.(axis === "x" ? { xBounds: [parts[0], parts[1]] } : { yBounds: [parts[0], parts[1]] });
                    }
                    setEditingBound(null);
                  }}
                />
              ) : (
                <span
                  style={{ cursor: locked ? "default" : "text" }}
                  onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault(); if (locked) return; setEditingBound(axis); }}
                >{`${bounds[0]},${bounds[1]}`}</span>
              )}
              <span>]</span>
            </div>
          );
        })}
      </div>
      {exprs.map((e, i) => renderRow(i, e, false))}
      {!locked && renderRow(exprs.length, undefined, true)}
    </div>
  );
}

// ── Edge/corner types ─────────────────────────────────────────────────────

type Edge = "right" | "left" | "bottom" | "top" | "br" | "bl" | "tr" | "tl";

const EDGE_HAS_RIGHT  = new Set<Edge>(["right", "br", "tr"]);
const EDGE_HAS_LEFT   = new Set<Edge>(["left", "bl", "tl"]);
const EDGE_HAS_BOTTOM = new Set<Edge>(["bottom", "br", "bl"]);
const EDGE_HAS_TOP    = new Set<Edge>(["top", "tr", "tl"]);

// ── Component ──────────────────────────────────────────────────────────────

function GraphContainer({ graphEl, canvasScale, onResize, locked }: GraphContainerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const resizeDragRef = useRef<{
    edge: Edge;
    startScreenX: number;
    startScreenY: number;
    startW: number;
    startH: number;
    startX: number;
    startY: number;
    startXBounds: [number, number];
    startYBounds: [number, number];
    last?: { w: number; h: number; x: number; y: number; xBounds: [number, number]; yBounds: [number, number] };
  } | null>(null);

  // ── Drawing ─────────────────────────────────────────────────────────────
  // Cache parsed plot functions so we don't re-parse during resize drags
  const expressions = graphEl.expressions ?? [];
  const expressionsKey = expressions.join("\x00");
  const parsedRef = useRef<(PlotFn | null)[]>([]);
  const prevExpKeyRef = useRef("");
  if (expressionsKey !== prevExpKeyRef.current) {
    parsedRef.current = expressions.map(parseExpression);
    prevExpKeyRef.current = expressionsKey;
  }

  const x0 = graphEl.xBounds?.[0] ?? -10;
  const x1 = graphEl.xBounds?.[1] ?? 10;
  const y0 = graphEl.yBounds?.[0] ?? -10;
  const y1 = graphEl.yBounds?.[1] ?? 10;

  const rafRef = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (!canvasRef.current) return;
      drawGraph(canvasRef.current, expressions, [x0, x1], [y0, y1], parsedRef.current, graphEl.expressionColors);
    });
    return () => cancelAnimationFrame(rafRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expressionsKey, x0, x1, y0, y1, graphEl.w, graphEl.h, (graphEl.expressionColors ?? []).join(",")]);

  // ── Resize handlers ─────────────────────────────────────────────────────

  const handleResizePointerDown = useCallback((e: React.PointerEvent, edge: Edge) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeDragRef.current = {
      edge,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startW: graphEl.w,
      startH: graphEl.h,
      startX: graphEl.x,
      startY: graphEl.y,
      startXBounds: graphEl.xBounds ?? [-10, 10],
      startYBounds: graphEl.yBounds ?? [-10, 10],
    };
  }, [graphEl.w, graphEl.h, graphEl.x, graphEl.y, graphEl.xBounds, graphEl.yBounds]);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - drag.startScreenX) / canvasScale;
    const dy = (e.clientY - drag.startScreenY) / canvasScale;
    const { edge } = drag;

    let newW = drag.startW;
    let newH = drag.startH;
    let newX = drag.startX;
    let newY = drag.startY;

    if (EDGE_HAS_RIGHT.has(edge))  newW = Math.max(MIN_W, drag.startW + dx);
    if (EDGE_HAS_LEFT.has(edge))   { newW = Math.max(MIN_W, drag.startW - dx); newX = drag.startX + (drag.startW - newW); }
    if (EDGE_HAS_BOTTOM.has(edge)) newH = Math.max(MIN_H, drag.startH + dy);
    if (EDGE_HAS_TOP.has(edge))    { newH = Math.max(MIN_H, drag.startH - dy); newY = drag.startY + (drag.startH - newH); }

    // Compute new bounds at same units-per-pixel scale
    const xb = drag.startXBounds;
    const yb = drag.startYBounds;
    const uppX = (xb[1] - xb[0]) / drag.startW;
    const uppY = (yb[1] - yb[0]) / drag.startH;

    const newXMin = EDGE_HAS_LEFT.has(edge)   ? xb[1] - uppX * newW : xb[0];
    const newXMax = EDGE_HAS_RIGHT.has(edge)  ? xb[0] + uppX * newW : xb[1];
    const newYMax = EDGE_HAS_TOP.has(edge)    ? yb[0] + uppY * newH : yb[1];
    const newYMin = EDGE_HAS_BOTTOM.has(edge) ? yb[1] - uppY * newH : yb[0];

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const newXBounds: [number, number] = [r2(newXMin), r2(newXMax)];
    const newYBounds: [number, number] = [r2(newYMin), r2(newYMax)];

    // DOM-only update — no React state
    const node = containerRef.current;
    if (node) {
      node.style.left = `${newX}px`;
      node.style.top = `${newY}px`;
      node.style.width = `${newW}px`;
      node.style.height = `${newH}px`;
    }

    // Redraw canvas directly
    if (canvasRef.current) {
      drawGraph(canvasRef.current, expressions, newXBounds, newYBounds, parsedRef.current, graphEl.expressionColors);
    }

    drag.last = { w: newW, h: newH, x: newX, y: newY, xBounds: newXBounds, yBounds: newYBounds };
  }, [canvasScale, expressions]);

  const handleResizePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    // Commit final size to state — React's next render will overwrite inline styles
    if (drag.last) {
      onResize(graphEl.id, drag.last);
    }
    resizeDragRef.current = null;
  }, [graphEl.id, onResize]);

  const showHandles = !locked && (isHovered || resizeDragRef.current != null);

  const resizePointerProps = {
    onPointerMove: handleResizePointerMove,
    onPointerUp: handleResizePointerUp,
  };

  // ── Edge handle helper ──────────────────────────────────────────────────

  const edgeHandle = (edge: Edge, style: React.CSSProperties, cursor: string, pip: React.CSSProperties) => (
    <div
      onPointerDown={(e) => handleResizePointerDown(e, edge)}
      {...resizePointerProps}
      style={{
        position: "absolute",
        cursor,
        opacity: showHandles ? 1 : 0,
        transition: "opacity 0.15s",
        pointerEvents: showHandles ? "auto" : "none",
        ...style,
      }}
    >
      <div style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        borderRadius: 3,
        background: "var(--th-text)",
        opacity: 0.55,
        ...pip,
      }} />
    </div>
  );

  const cornerHandle = (edge: Edge, style: React.CSSProperties, cursor: string) => (
    <div
      onPointerDown={(e) => handleResizePointerDown(e, edge)}
      {...resizePointerProps}
      style={{
        position: "absolute",
        width: HANDLE_SIZE * 2,
        height: HANDLE_SIZE * 2,
        cursor,
        opacity: showHandles ? 1 : 0,
        transition: "opacity 0.15s",
        pointerEvents: showHandles ? "auto" : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--th-text)", opacity: 0.55 }} />
    </div>
  );

  return (
    <div
      ref={containerRef}
      data-el
      data-el-id={graphEl.id}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { if (!resizeDragRef.current) setIsHovered(false); }}
      style={{
        position: "absolute",
        left: graphEl.x,
        top: graphEl.y,
        width: graphEl.w,
        height: graphEl.h,
        overflow: "visible",
      }}
    >
      {/* Canvas graph */}
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid var(--th-chart-border)",
          background: "#fff",
          pointerEvents: "none",
          display: "block",
        }}
      />

      {/* Metadata label (to the right) */}
      <GraphLabel
        graphEl={graphEl}
        locked={locked}
        onBoundsChange={(changes) => onResize(graphEl.id, changes)}
        onExpressionChange={(index, value) => {
          const exprs = [...(graphEl.expressions ?? [])];
          exprs[index] = value;
          onResize(graphEl.id, { expressions: exprs });
        }}
        onColorChange={(index, color) => {
          const colors = [...(graphEl.expressionColors ?? [])];
          while (colors.length <= index) colors.push(CURVE_COLORS[colors.length % CURVE_COLORS.length]);
          colors[index] = color;
          onResize(graphEl.id, { expressionColors: colors });
        }}
        onExpressionAdd={(value, color) => {
          const exprs = [...(graphEl.expressions ?? []), value];
          const changes: Parameters<typeof onResize>[1] = { expressions: exprs };
          if (color) {
            const cols = [...(graphEl.expressionColors ?? [])];
            while (cols.length < exprs.length - 1) cols.push(CURVE_COLORS[cols.length % CURVE_COLORS.length]);
            cols.push(color);
            changes.expressionColors = cols;
          }
          onResize(graphEl.id, changes);
        }}
        onExpressionDelete={(index) => {
          const exprs = [...(graphEl.expressions ?? [])];
          exprs.splice(index, 1);
          const cols = [...(graphEl.expressionColors ?? [])];
          if (cols.length > index) cols.splice(index, 1);
          onResize(graphEl.id, { expressions: exprs, expressionColors: cols });
        }}
      />

      {/* ── Edge handles ───────────────────────────────────────────────── */}
      {edgeHandle("right",  { top: 0, right: -HANDLE_SIZE / 2, width: HANDLE_SIZE, height: "100%" }, "ew-resize", { width: 5, height: 32 })}
      {edgeHandle("left",   { top: 0, left: -HANDLE_SIZE / 2, width: HANDLE_SIZE, height: "100%" }, "ew-resize", { width: 5, height: 32 })}
      {edgeHandle("bottom", { bottom: -HANDLE_SIZE / 2, left: 0, width: "100%", height: HANDLE_SIZE }, "ns-resize", { width: 32, height: 5 })}
      {edgeHandle("top",    { top: -HANDLE_SIZE / 2, left: 0, width: "100%", height: HANDLE_SIZE }, "ns-resize", { width: 32, height: 5 })}

      {/* ── Corner handles ─────────────────────────────────────────────── */}
      {cornerHandle("br", { bottom: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2 }, "nwse-resize")}
      {cornerHandle("tl", { top: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2 }, "nwse-resize")}
      {cornerHandle("tr", { top: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2 }, "nesw-resize")}
      {cornerHandle("bl", { bottom: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2 }, "nesw-resize")}
    </div>
  );
}

export default memo(GraphContainer);
