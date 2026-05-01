"use client";

import { useEffect, useState } from "react";
import NotesCanvas from "../components/NotesCanvas";
import type { NoteItem } from "../lib/canvas-types";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

const HEADER = 2.5;
const SUB = 1.05;

// Layout constants — column spacing relative to the leftmost column.
const COL_GAP = 580;
const HEADING_DX = 400; // greeting offset from COL_A
const INTRO_DX = 80;    // intro paragraph offset from COL_A

// Sidebar (~220px + 12px margin) sits over the canvas in screen px. The canvas
// renders at DEFAULT_SCALE (0.70), so canvasX = screenPx / 0.70. Center a
// ~1500-wide content block within the visible canvas region — wider screens
// push everything further right naturally.
const SIDEBAR_PX = 232;
const CANVAS_SCALE = 0.70;
const BLOCK_WIDTH = 1500;

function computeColA(innerWidth: number): number {
  const visibleLeft = SIDEBAR_PX / CANVAS_SCALE;
  const visibleRight = innerWidth / CANVAS_SCALE;
  const center = (visibleLeft + visibleRight) / 2;
  return Math.max(360, Math.round(center - BLOCK_WIDTH / 2));
}

export default function HomePage() {
  const [note, setNote] = useState<NoteItem | null>(null);

  useEffect(() => {
    const build = () => {
      const COL_A = computeColA(window.innerWidth);
      const COL_B = COL_A + COL_GAP;
      const COL_C = COL_A + COL_GAP * 2;

      let i = 0;
      const nid = () => `g${++i}`;
      const text = (x: number, y: number, t: string, f = 1) =>
        ({ id: nid(), type: "text" as const, x, y, text: t, fontScale: f });
      const shape = (
        x: number, y: number, w: number, h: number,
        kind: "rect" | "circle" | "triangle",
      ) => ({ id: nid(), type: "shape" as const, x, y, w, h, shape: kind });
      const arrow = (x1: number, y1: number, x2: number, y2: number) =>
        ({ id: nid(), type: "arrow" as const, x1, y1, x2, y2 });
      // Hand-drawn-looking squiggle: layered sines at different frequencies plus
      // a small x-axis wobble, so it doesn't read as a clean sine wave.
      const squiggle = (
        x0: number, y0: number, len: number, amp: number, freq: number,
      ) => {
        const pts: string[] = [];
        const N = Math.round(len / 3);
        for (let k = 0; k <= N; k++) {
          const t = k / N;
          const x = x0 + t * len + Math.sin(k * freq * 1.3 + 0.6) * 0.9;
          const y = y0
            + Math.sin(k * freq) * amp
            + Math.sin(k * freq * 2.7 + 1.3) * (amp * 0.45)
            + Math.sin(k * freq * 5.1 + 2.7) * (amp * 0.25);
          pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        return { id: nid(), type: "draw" as const, pts: pts.join(" ") };
      };

      const elements = [
      // ── Header ─────────────────────────────────────────
      text(COL_A + HEADING_DX, 160, `${greeting()}, user!`, 3),
      text(COL_A + INTRO_DX, 240, "Welcome to Shannon — your notes and AI, all on-device with your own keys."),
      text(COL_A + INTRO_DX, 262, "Here's how to use it."),

      // ── Column A · Toolbar ─────────────────────────────
      text(COL_A, 340, "Toolbar", HEADER),
      text(COL_A, 395, "Top of canvas. Enable extras in Settings → Expanded toolbar.", SUB),
      text(COL_A, 440, "V — Cursor / select"),
      text(COL_A, 462, "T — Text"),
      text(COL_A, 484, "D — Draw"),
      text(COL_A, 506, "E — Eraser"),
      text(COL_A, 528, "S — Shape (rect, circle, triangle, arrow)"),
      text(COL_A, 550, "I — Image"),
      text(COL_A, 572, "L — Note Link"),
      text(COL_A, 594, "G — Graph"),
      text(COL_A, 616, "P — Print Region"),
      text(COL_A, 638, "C — Chat"),
      text(COL_A, 660, "Table & Checklist (no shortcut)"),

      // ── Column A · Controls ────────────────────────────
      text(COL_A, 740, "Controls", HEADER),
      text(COL_A, 795, "⌘ on Mac, Ctrl on Windows / Linux.", SUB),
      text(COL_A, 840, "⌘Z  /  ⌘⇧Z — Undo / Redo"),
      text(COL_A, 862, "⌘C  /  ⌘X  /  ⌘V — Copy / Cut / Paste"),
      text(COL_A, 884, "⌘A — Select all"),
      text(COL_A, 906, "Delete — Remove selection"),
      text(COL_A, 928, "Esc — Deselect / cancel / stop streaming"),
      text(COL_A, 950, "Shift + drag — Pan canvas"),
      text(COL_A, 972, "Scroll / pinch — Zoom"),
      text(COL_A, 994, "Arrow keys — Move between elements"),
      text(COL_A, 1016, "⌘← / ⌘→ — Jump word or element"),
      text(COL_A, 1038, "Drop image / PDF on canvas to insert"),

      // ── Column A · Pointer ─────────────────────────────
      text(COL_A, 1140, "Pointers", HEADER),
      text(COL_A, 1195, "Mouse, gestures, double-click.", SUB),
      text(COL_A, 1240, "Right-click element — Select; ⇧ toggles in multi-select"),
      text(COL_A, 1262, "Right-click empty canvas — Spawn / paste menu"),
      text(COL_A, 1284, "Shift + click element — Center & zoom on it"),
      text(COL_A, 1306, "Shift + drag (text tool) — Move like the mover (V) tool"),
      text(COL_A, 1328, "Double-click empty space — Drop a text fragment"),
      text(COL_A, 1350, "Double-click text — Edit at the click point"),

      // ── Column B · Commands ────────────────────────────
      text(COL_B, 340, "Commands", HEADER),
      text(COL_B, 395, "<required>  [optional] — type, then press Enter.", SUB),

      text(COL_B, 440, "Chat", 1.25),
      text(COL_B, 472, "/chat <question> — Spawn an AI chat on the canvas"),
      text(COL_B, 494, "/chat — Spawn a blank chat (no auto-submit)"),
      text(COL_B, 516, "/chat fork <n> — New chat with chat <n>'s history visible"),
      text(COL_B, 538, "/chat clear <n> — Wipe chat <n>'s messages"),
      text(COL_B, 560, "/chat @<n> — Center the viewport on chat <n>"),
      text(COL_B, 582, "/chat compact <n> — Fold chat <n>'s older history into a summary"),
      text(COL_B, 604, "/compact — Same, typed inside a chat's own input"),
      text(COL_B, 626, "/q <question> — One-shot ephemeral question"),
      text(COL_B, 648, "/sideq <id> <prompt> — Quick ask using chat <id>'s context"),
      text(COL_B, 670, "/sidechat <id> <prompt> — Fork chat <id> into a new chat"),

      text(COL_B, 712, "Shapes & arrows", 1.25),
      text(COL_B, 744, "/rectangle [w] [h]"),
      text(COL_B, 766, "/square [size]"),
      text(COL_B, 788, "/circle [size]"),
      text(COL_B, 810, "/triangle [w] [h]"),
      text(COL_B, 832, "/arrow [length] [up|down|left|right]"),

      text(COL_B, 874, "Math & graphs", 1.25),
      text(COL_B, 906, "/math <latex> — Render a LaTeX formula"),
      text(COL_B, 928, "/graph <expr>, ... — Create a 2D plot"),
      text(COL_B, 950, "/graph <id> <expr> — Append expression to plot"),
      text(COL_B, 972, "/graph <id> delete <i> — Remove expression by index"),
      text(COL_B, 994, "/graph <id> place <i> <expr> — Replace expression"),
      text(COL_B, 1016, "/graph <id> scale <v0> <v1> — Square rescale"),
      text(COL_B, 1038, "/graph <id> scale x <a> <b> [y <c> <d>] — Axis rescale"),

      text(COL_B, 1080, "Tables, lists & more", 1.25),
      text(COL_B, 1112, "/table [rows] [cols] — Default 3×3, max 50×20"),
      text(COL_B, 1134, "/checklist [n] — n empty checkbox rows"),
      text(COL_B, 1156, "/image — Pick an image file to insert"),
      text(COL_B, 1178, "/pdf — Pick a PDF to insert"),
      text(COL_B, 1200, "/embed <url> — Google Doc / Sheet / Slides or YouTube"),
      text(COL_B, 1222, "/link — Insert a link to another note"),
      text(COL_B, 1244, "/print [letter|a4|legal] — Add a printable page region"),

      // ── Column C · Model ───────────────────────────────
      text(COL_C, 340, "Model", HEADER),
      text(COL_C, 395, "Configure providers under Model in the sidebar.", SUB),
      text(COL_C, 440, "Two roles to assign:"),
      text(COL_C, 462, "  • Chat — main tutor model"),
      text(COL_C, 484, "  • Web Search — for live results"),
      text(COL_C, 528, "Supported provider templates:"),
      text(COL_C, 550, "  Anthropic (Claude)"),
      text(COL_C, 572, "  OpenAI (GPT-4o, o-series)"),
      text(COL_C, 594, "  OpenRouter, Groq, Together"),
      text(COL_C, 616, "  Perplexity, Tavily, Brave Search"),
      text(COL_C, 638, "  Custom OpenAI-compatible base URL"),
      text(COL_C, 682, "API keys are stored locally."),

      // ── Column C · Settings ────────────────────────────
      text(COL_C, 740, "Settings", HEADER),
      text(COL_C, 795, "Saved in your browser.", SUB),
      text(COL_C, 840, "Light / dark theme"),
      text(COL_C, 862, "Expanded toolbar — show shape, image, graph, …"),
      text(COL_C, 884, "Drag-to-draw vs press-to-draw"),
      text(COL_C, 906, "Background image, blur, grayscale, opacity"),
      text(COL_C, 928, "Upload your own canvas backgrounds"),

      // ── Column C · Notes & files ───────────────────────
      text(COL_C, 995, "Notes & files", HEADER),
      text(COL_C, 1060, "Manage everything from the sidebar.", SUB),
      text(COL_C, 1100, "New Note · New Folder · Import"),
      text(COL_C, 1122, "Drag notes between folders to reorder"),
      text(COL_C, 1144, "Row menu → Rename / Export / Delete"),
      text(COL_C, 1166, "Export as .shannon (full fidelity) or HTML"),

      // ── Showcase ──────────────────────────────────────
      // Layout: doodle → house (left) + chart (right) → graph → logo, each with
      // its own caption and a generous vertical gap between them.
      text(COL_A, 1430, "Make stuff", HEADER),
      text(COL_A, 1485, "Everything below can be placed by typing, dragging, or using commands!", SUB),

      // ── Doodle (above) ───────────────────────────────
      text(COL_A + 60, 1530, "Doodle with the drawing tool", 1),
      squiggle(COL_A + 60, 1580, 360, 7, 0.45),

      // ── House (left) ─────────────────────────────────
      text(COL_A, 1730, "Draw diagrams with shapes", 1),
      // Roof
      shape(COL_A - 10, 1770, 220, 90, "triangle"),
      // Body
      shape(COL_A, 1860, 200, 150, "rect"),
      // Windows
      shape(COL_A + 22, 1890, 40, 35, "rect"),
      shape(COL_A + 138, 1890, 40, 35, "rect"),
      // Door
      shape(COL_A + 80, 1930, 40, 80, "rect"),
      // Callout arrow + label
      arrow(COL_A + 340, 1820 + 70, COL_A + 260, 1790 + 70),
      text(COL_A + 350, 1808 + 80, "a house!", 1.1),

      // ── Chart (right, parallel to house) ─────────────
      text(COL_A + 660, 1730, "Ask chat to make a chart for you!", 1),
      {
        id: nid(), type: "chart" as const,
        x: COL_A + 660, y: 1770, w: 440, h: 230,
        chartType: "bar" as const,
        labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        datasets: [{ label: "aha moments", values: [3, 7, 4, 9, 6, 2, 5] }],
      },

      // ── Graph (below) ────────────────────────────────
      text(COL_A + 220, 2130, "Draw a cool graph", 1),
      {
        id: nid(), type: "graph" as const,
        x: COL_A + 220, y: 2170, w: 560, h: 260, graphNum: 1,
        expressions: ["sin(x) * cos(2x)"],
        xBounds: [-6, 6] as [number, number],
        yBounds: [-1.2, 1.2] as [number, number],
      },

      // ── Logo ─────────────────────────────────────────
      text(COL_A + 300, 2530, "Paste an image anywhere!", 1),
      {
        id: nid(), type: "image" as const,
        x: COL_A + 300, y: 2570, w: 200, h: 200,
        src: "/shannon-logo.png",
      },

      // ── Chat demo (right of "Make stuff" showcase) ───
      text(COL_A + 1320, 1490, "Chat with your LLM and search the web!", 1),
      {
        id: nid(), type: "chat" as const,
        x: COL_A + 1320, y: 1530,
        chatId: "dashboard-demo-chat",
        chatNumber: 1,
        messages: [
          { role: "user" as const, content: "Who came up with information entropy, and what does it measure?" },
          {
            role: "assistant" as const,
            content:
              "Information entropy was introduced by **Claude Shannon** in his 1948 paper *A Mathematical Theory of Communication*. For a discrete random variable X with outcomes xᵢ and probabilities p(xᵢ), entropy is defined by the formula drawn to the right — measured in bits.\n\nIntuitively, it's the average number of yes/no questions needed to pin down an outcome — so a fair coin has H = 1 bit, while a coin that always lands heads has H = 0.",
            citations: [
              "https://en.wikipedia.org/wiki/Entropy_(information_theory)",
              "https://people.math.harvard.edu/~ctm/home/text/others/shannon/entropy/entropy.pdf",
              "https://www.britannica.com/science/information-theory",
            ],
          },
          { role: "user" as const, content: "Cool — and what's it actually used for?" },
          {
            role: "assistant" as const,
            content:
              "A few big ones:\n- **Data compression** — entropy is the lower bound on average bits per symbol (Shannon's source coding theorem). Algorithms like Huffman and arithmetic coding chase that bound.\n- **Communication** — channel capacity, the max reliable bit rate over a noisy channel, is defined in entropy terms.\n- **Machine learning** — cross-entropy loss, KL divergence, and decision-tree splits all reduce to entropy comparisons.",
            citations: [
              "https://en.wikipedia.org/wiki/Shannon%27s_source_coding_theorem",
              "https://en.wikipedia.org/wiki/Channel_capacity",
              "https://en.wikipedia.org/wiki/Cross-entropy",
            ],
          },
        ],
        inputText: "",
      },
      {
        id: nid(), type: "math" as const,
        x: COL_A + 1500, y: 2310,
        latex: "H(X) = -\\sum_i p(x_i)\\,\\log_2 p(x_i)",
      },
    ];

      setNote({
        id: "dashboard",
        title: "Dashboard",
        updatedAt: Date.now(),
        elements,
      });
    };

    build();
    window.addEventListener("resize", build);
    return () => window.removeEventListener("resize", build);
  }, []);

  return <NotesCanvas note={note} locked />;
}
