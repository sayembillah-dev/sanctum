import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/agent";

export async function POST(req: Request) {
  const { question } = await req.json();
  if (!question?.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  const result = await answerQuestion(question);
  return NextResponse.json(result);
}
