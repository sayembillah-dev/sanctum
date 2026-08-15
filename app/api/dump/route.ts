import { NextResponse } from "next/server";
import { runExtraction } from "@/lib/agent";
import { requireUser } from "@/lib/auth";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { text } = await req.json();
  if (!text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  const result = await runExtraction(text);
  return NextResponse.json(result);
}
