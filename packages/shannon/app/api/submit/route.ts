import { NextRequest, NextResponse } from "next/server";
import { pingAnthropic } from "@/lib/anthropic";

export async function POST(request: NextRequest) {
  const data = await request.json().catch(() => null);
  if (!data) {
    return NextResponse.json({ status: "error", message: "No JSON provided" }, { status: 400 });
  }

  const text = data.text;
  if (typeof text !== "string") {
    return NextResponse.json({ status: "error", message: "Invalid payload" }, { status: 400 });
  }

  const res = await pingAnthropic(text);
  return NextResponse.json({ status: "ok", message: res, received: { text } });
}
