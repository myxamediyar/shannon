import { NextRequest, NextResponse } from "next/server";
import { runWebSearch } from "@/lib/websearch";

export async function POST(request: NextRequest) {
  const data = await request.json().catch(() => null);
  if (!data || typeof data.query !== "string" || !data.query.trim()) {
    return NextResponse.json(
      { status: "error", message: "query is required" },
      { status: 400 },
    );
  }

  try {
    const { answer, citations } = await runWebSearch(data.query);
    return NextResponse.json({ status: "ok", answer, citations });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: "error", message }, { status: 500 });
  }
}
