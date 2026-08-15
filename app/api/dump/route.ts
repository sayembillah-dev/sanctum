import { NextResponse } from "next/server";
import { runExtraction } from "@/lib/agent";

export async function POST(req: Request) {
  const { text } = await req.json();
  if (!text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  const result = await runExtraction(text);
  return NextResponse.json(result);
}
