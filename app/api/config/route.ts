import { NextRequest, NextResponse } from "next/server";
import {
  readConfig,
  writeConfig,
  redactConfig,
  validateConfig,
  mergeKeepingExistingKeys,
} from "@/lib/providers/config";

export async function GET() {
  try {
    const cfg = await readConfig();
    return NextResponse.json({ status: "ok", config: redactConfig(cfg) });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: "error", message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("config" in body)) {
    return NextResponse.json(
      { status: "error", message: "Body must be { config: ... }" },
      { status: 400 },
    );
  }
  try {
    const incoming = validateConfig((body as { config: unknown }).config);
    const existing = await readConfig();
    const merged = mergeKeepingExistingKeys(incoming, existing);
    await writeConfig(merged);
    return NextResponse.json({ status: "ok", config: redactConfig(merged) });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: "error", message }, { status: 400 });
  }
}
