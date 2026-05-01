import { NextRequest, NextResponse } from "next/server";
import { resolveCallback } from "@/lib/tool-callbacks";

export async function POST(request: NextRequest) {
  const data = await request.json().catch(() => null);
  if (!data || !data.callbackId) {
    return NextResponse.json({ error: "callbackId required" }, { status: 400 });
  }
  const resolved = resolveCallback(data.callbackId, data.payload ?? "");
  return NextResponse.json({ ok: resolved });
}
