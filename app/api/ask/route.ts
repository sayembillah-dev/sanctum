import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/agent";
import { requireUser } from "@/lib/auth";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { question } = await req.json();
  if (!question?.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  const result = await answerQuestion(question);
  return NextResponse.json(result);
}
