"use client";

import { Button, Card, Input, message } from "antd";
import { useState } from "react";

export default function DumpBox() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");

  async function submit() {
    setLoading(true);
    try {
      const res = await fetch("/api/dump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
      message.success("Dumped — Sanctum remembers.");
      window.dispatchEvent(new Event("sanctum:dirty")); // wake the graph view
    } catch {
      message.error("Dump failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="📥 Dump" className="w-full">
      <Input.TextArea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Dump anything… e.g. Emran said we need to fix the sign-in API query params by this Friday"
      />
      <Button type="primary" className="mt-3" loading={loading} onClick={submit} disabled={!text.trim()}>
        Remember this
      </Button>
      {result && (
        <pre className="mt-3 max-h-64 overflow-auto rounded bg-slate-100 p-3 text-xs">{result}</pre>
      )}
    </Card>
  );
}
