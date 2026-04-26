import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "ok", message: "Shannon API is running." });
}
