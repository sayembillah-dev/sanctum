"use client";

import { Button, Card, Input, message } from "antd";
import { useState } from "react";

export default function AskBox() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState("");

  async function submit() {
    setLoading(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      setAnswer(data.answer ?? JSON.stringify(data, null, 2));
    } catch {
      message.error("Ask failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="💬 Ask" className="w-full">
      <div className="flex gap-2">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onPressEnter={submit}
          placeholder="What did Emran ask me to fix?"
        />
        <Button type="primary" loading={loading} onClick={submit} disabled={!question.trim()}>
          Ask
        </Button>
      </div>
      {answer && <p className="mt-3 whitespace-pre-wrap rounded bg-slate-100 p-3 text-sm">{answer}</p>}
    </Card>
  );
}
