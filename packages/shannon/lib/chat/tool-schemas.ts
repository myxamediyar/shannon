import Anthropic from "@anthropic-ai/sdk";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web for up-to-date information. Use this when the user asks about current events, recent data, or anything you're unsure about and would benefit from a web lookup.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query to look up on the web",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_shape",
    description:
      "Draw a shape on the whiteboard canvas. Supported shapes: rectangle, square, circle, triangle.",
    input_schema: {
      type: "object" as const,
      properties: {
        shape: {
          type: "string",
          enum: ["rectangle", "square", "circle", "triangle"],
          description: "The type of shape to create",
        },
        width: {
          type: "number",
          description: "Width in canvas pixels (optional, default ~200)",
        },
        height: {
          type: "number",
          description: "Height in canvas pixels (optional, default ~200). For square, only width is used.",
        },
        x: { type: "number", description: "X position in canvas coordinates (optional — auto-placed if omitted)" },
        y: { type: "number", description: "Y position in canvas coordinates (optional — auto-placed if omitted)" },
      },
      required: ["shape"],
    },
  },
  {
    name: "create_table",
    description:
      "Create a table on the whiteboard canvas with the given number of rows and columns, optionally pre-filled with data.",
    input_schema: {
      type: "object" as const,
      properties: {
        rows: { type: "number", description: "Number of rows (including header)" },
        cols: { type: "number", description: "Number of columns" },
        data: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "Optional 2D array of cell values. First row is headers.",
        },
        x: { type: "number", description: "X position in canvas coordinates (optional — auto-placed if omitted)" },
        y: { type: "number", description: "Y position in canvas coordinates (optional — auto-placed if omitted)" },
      },
      required: ["rows", "cols"],
    },
  },
  {
    name: "create_chart",
    description:
      "Place a chart on the whiteboard. You provide the data directly — labels (x-axis categories) and one or more datasets (each a series of numeric values aligned to the labels). Pick the chart_type that best fits the data: bar/line for trends and comparisons, pie/doughnut for parts of a whole, scatter for correlations, etc. For smooth curves (distributions, continuous functions) use ≥20 evenly-spaced points.",
    input_schema: {
      type: "object" as const,
      properties: {
        chart_type: {
          type: "string",
          enum: ["bar", "line", "pie", "doughnut", "radar", "polarArea", "histogram", "scatter"],
          description: "Chart type. For scatter, labels should be x-coordinates as string numbers.",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "X-axis categories (or x-coordinates as strings for scatter). Each dataset's values must align to this length.",
        },
        datasets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Series name shown in the legend" },
              values: { type: "array", items: { type: "number" }, description: "Numeric values, one per label" },
            },
            required: ["label", "values"],
          },
          description: "One or more series. Use multiple datasets to compare groups on the same axes.",
        },
        description: {
          type: "string",
          description: "Optional 1-3 sentence plain-text caption shown under the chart.",
        },
        formula: {
          type: "string",
          description: "Optional LaTeX formula behind the data (e.g. 'y = mx + b'). Empty if none applies.",
        },
        x: { type: "number", description: "X position in canvas coordinates (optional — auto-placed if omitted)" },
        y: { type: "number", description: "Y position in canvas coordinates (optional — auto-placed if omitted)" },
      },
      required: ["chart_type", "labels", "datasets"],
    },
  },
  {
    name: "create_graph",
    description:
      "Create a new mathematical function graph on the whiteboard. Expressions use math.js syntax: x^2, sin(x), sqrt(x), ln(x), log(x), exp(x), abs(x), pi, e, implicit multiplication (2x = 2*x), etc. Do NOT use LaTeX — use plain math notation like 'x^2 + 3x - 1', 'sin(2x)', '(x+1)/(x-1)'. Multiple expressions are overlaid on the same axes. Returns the graph number which can be used with edit_graph.",
    input_schema: {
      type: "object" as const,
      properties: {
        expressions: {
          type: "array",
          items: { type: "string" },
          description: "Array of math.js expressions to plot, e.g. [\"x^2\", \"sin(x)\", \"2x + 1\", \"(x+1)/(x-1)\"]. Use plain math, not LaTeX.",
        },
        x: { type: "number", description: "X position in canvas coordinates (optional — auto-placed if omitted)" },
        y: { type: "number", description: "Y position in canvas coordinates (optional — auto-placed if omitted)" },
      },
      required: ["expressions"],
    },
  },
  {
    name: "edit_graph",
    description:
      "Edit an existing graph on the whiteboard. You can add expressions, remove them by index, replace them by index, or rescale the axes. Use the graph_num from the canvas context (shown as [graph N ...]) to target a specific graph.",
    input_schema: {
      type: "object" as const,
      properties: {
        graph_num: { type: "number", description: "The graph number to edit (shown in canvas context as [graph N ...])" },
        action: {
          type: "string",
          enum: ["add", "remove", "replace", "rescale"],
          description: "The edit action: 'add' appends an expression, 'remove' removes by index, 'replace' replaces by index, 'rescale' changes axis bounds",
        },
        expression: {
          type: "string",
          description: "The math.js expression (for 'add' or 'replace' actions). Use plain math, not LaTeX — e.g. 'x^2', 'sin(x)', '2x + 1'.",
        },
        index: { type: "number", description: "The expression index to remove or replace (0-based, for 'remove' or 'replace' actions)" },
        x_bounds: { type: "array", items: { type: "number" }, description: "New x-axis range [min, max] (for 'rescale' action)" },
        y_bounds: { type: "array", items: { type: "number" }, description: "New y-axis range [min, max] (for 'rescale' action)" },
      },
      required: ["graph_num", "action"],
    },
  },
  {
    name: "create_math",
    description:
      "Render a LaTeX math expression on the whiteboard using KaTeX. Use this for equations, formulas, mathematical notation.",
    input_schema: {
      type: "object" as const,
      properties: {
        latex: {
          type: "string",
          description: "The LaTeX expression to render, e.g. \"\\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}\"",
        },
        x: { type: "number", description: "X position in canvas coordinates (optional — auto-placed if omitted)" },
        y: { type: "number", description: "Y position in canvas coordinates (optional — auto-placed if omitted)" },
      },
      required: ["latex"],
    },
  },
  {
    name: "create_arrow",
    description: "Draw an arrow on the whiteboard. Can specify length and direction.",
    input_schema: {
      type: "object" as const,
      properties: {
        length: { type: "number", description: "Length of the arrow in canvas pixels (optional, default ~200)" },
        direction: {
          type: "string",
          enum: ["right", "left", "up", "down"],
          description: "Direction the arrow points (optional, default right)",
        },
        x: { type: "number", description: "X position of arrow start in canvas coordinates (optional — auto-placed if omitted)" },
        y: { type: "number", description: "Y position of arrow start in canvas coordinates (optional — auto-placed if omitted)" },
      },
    },
  },
  {
    name: "create_text",
    description:
      "Spawn a text element on the whiteboard. Use this for notes, labels, definitions, or any plain text. Supports multi-line content with \\n. For math notation, prefer create_math instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "The text content. Can include \\n for multiple lines." },
        font_scale: { type: "number", description: "Optional font scale (1–4, default 2). Larger values produce bigger text." },
        x: { type: "number", description: "X position in canvas coordinates (optional — auto-placed if omitted)" },
        y: { type: "number", description: "Y position in canvas coordinates (optional — auto-placed if omitted)" },
      },
      required: ["text"],
    },
  },
  {
    name: "create_logo",
    description:
      "Spawn the Shannon logo as an image on the whiteboard. No arguments needed — the logo is auto-placed next to your chat. Use this when the user explicitly asks for the Shannon logo.",
    input_schema: {
      type: "object" as const,
      properties: {
        size: { type: "number", description: "Size in canvas pixels (optional, default 200). The logo is square." },
        x: { type: "number", description: "X position in canvas coordinates (optional — auto-placed if omitted)" },
        y: { type: "number", description: "Y position in canvas coordinates (optional — auto-placed if omitted)" },
      },
    },
  },
  {
    name: "rasterize_shapes",
    description:
      "Rasterize all shape diagrams on the visible canvas into images. Shapes (rectangles, circles, triangles) and arrows that overlap or touch are automatically grouped into diagrams and rendered as composite images. Call this when you want to visually see how shapes and arrows are arranged — e.g. a flowchart, a diagram, connected shapes. No arguments needed; all visible shape groups are returned.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "read_pdf_pages",
    description:
      "Render a range of pages from a PDF document on the canvas and return them as images. Use this when the user asks about PDF content. The canvas context tells you which PDFs are available and their page counts. IMPORTANT: Before calling this tool, always confirm which pages the user wants you to read. For example, ask 'Which pages would you like me to read?' or 'Should I read pages 1-5?'. Never read more than 50 pages at once.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename of the PDF on the canvas (from the context)" },
        start_page: { type: "number", description: "First page to read (1-based, inclusive)" },
        end_page: { type: "number", description: "Last page to read (1-based, inclusive). Max 50 pages per call." },
      },
      required: ["filename", "start_page", "end_page"],
    },
  },
  {
    name: "find_note",
    description:
      "Search the user's sidebar notes by name (case-insensitive substring match). Returns matching note id(s), or reports not-found. If not found, use list_notes to browse the full list in pages.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name or keyword to search for (case-insensitive substring match against note titles)" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_notes",
    description:
      "List the user's sidebar notes in a range (up to 50 per call). Use this when find_note returns no match to iteratively browse and find the closest title. Returns { total, offset, notes[] } so you can paginate by calling again with the next offset.",
    input_schema: {
      type: "object" as const,
      properties: {
        offset: { type: "number", description: "Starting index into the note list (0-based). Defaults to 0." },
      },
      required: [],
    },
  },
  {
    name: "read_note",
    description:
      "Read the full content of a note from the user's sidebar. Use find_note first to get a note's id.",
    input_schema: {
      type: "object" as const,
      properties: {
        note_id: { type: "string", description: "The id of the note to read (obtained from find_note)" },
      },
      required: ["note_id"],
    },
  },
  {
    name: "read_current_note",
    description:
      "Read the full content of the *current* note — the one this chat lives in. Returns every text/table/other element in layout order, plus the note's title. No arguments required. Prefer this over read_note when the user refers to 'this note', 'the canvas', 'here', or their current context.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "read_embed",
    description:
      "Read the text content of an embedded Google Doc, Sheet, or Slides on the canvas. The canvas context tells you which embeds are available. Use this when the user asks about the content of an embedded document.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the embed on the canvas (from the context)" },
        embed_url: { type: "string", description: "The embed URL (from the context)" },
      },
      required: ["title", "embed_url"],
    },
  },
  {
    name: "read_chat",
    description:
      "Read messages from another chat on the canvas (up to 10 per call). The canvas context lists each chat's number and total message count (e.g. [chat #5 @ (x,y)]: 12 messages). Use this when the user references another chat or when prior conversation context would help. Returns the selected range plus the total count so you can paginate by adjusting offset.",
    input_schema: {
      type: "object" as const,
      properties: {
        chat_number: { type: "integer", description: "The chat number from the canvas context (e.g., the 5 in [chat #5])." },
        offset: { type: "integer", description: "0-indexed start of the range (default 0 = oldest message first). To get the most recent messages, pass offset = max(0, total - 10) using the total shown in the canvas context." },
        count: { type: "integer", description: "How many messages to return, 1–10. Default 10." },
      },
      required: ["chat_number"],
    },
    cache_control: { type: "ephemeral" },
  },
];

export function toolInvocationLabel(name: string): string {
  const map: Record<string, string> = {
    web_search: "Searching the web",
    create_shape: "Creating shape",
    create_table: "Creating table",
    create_chart: "Creating chart",
    create_graph: "Creating graph",
    edit_graph: "Editing graph",
    create_math: "Creating math",
    create_arrow: "Creating arrow",
    create_text: "Creating text",
    create_logo: "Spawning logo",
    rasterize_shapes: "Rasterizing shapes",
    read_pdf_pages: "Reading PDF",
    read_embed: "Reading document",
    find_note: "Finding note",
    list_notes: "Listing notes",
    read_note: "Reading note",
    read_current_note: "Reading current note",
    read_chat: "Reading chat",
  };
  return map[name] ?? name.replace(/_/g, " ");
}

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export function toOpenAITools(tools: Anthropic.Tool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}
