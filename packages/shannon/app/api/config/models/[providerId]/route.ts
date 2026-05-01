import { NextRequest, NextResponse } from "next/server";
import { listProviderModels } from "@/lib/providers/list-models";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const { providerId } = await params;
  try {
    const models = await listProviderModels(decodeURIComponent(providerId));
    return NextResponse.json({ status: "ok", models });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: "error", message }, { status: 200 });
  }
}
