"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };
type Task = {
  id: string;
  name: string;
  due: string | null;
  status: string;
  overdue: boolean;
  mention_count: number;
};
type Recap = {
  newNodes: number;
  newEdges: number;
  byType: Record<string, number>;
  newest: { name: string; type: string }[];
  topMentioned: { name: string; type: string; mention_count: number }[];
  feedback: { up: number; down: number };
  openLoops: { name: string; due: string | null; overdue: boolean }[];
  latestDigest: { name: string; summary: string; date: string } | null;
};

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fb, setFb] = useState<Record<number, 1 | -1>>({}); // msg index → rating given
  const [recap, setRecap] = useState<Recap | "loading" | null>(null);
  const [title, setTitle] = useState<string | null>(null); // 🏷️ X5 session title
  const [tasks, setTasks] = useState<Task[] | "loading" | null>(null); // ✅ tasks overlay
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Conversation persistence: rehydrate the current session's thread on load —
  // a refresh no longer wipes the chat.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    fetch("/api/chat/history", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.messages) && d.messages.length) setMessages(d.messages);
        if (typeof d.title === "string" && d.title) setTitle(d.title);
      })
      .catch(() => {});
  }, []);

  // auto-growing composer
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  // error toast auto-dismiss
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // clear-chat confirm auto-resets after 3s
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  function clearChat() {
    if (!confirmClear) return setConfirmClear(true);
    // 🌙 session ended — the server crystallizes its transcript into a digest
    // node and rotates to a fresh session (fire-and-forget)
    fetch("/api/conversations/digest", { method: "POST", keepalive: true })
      .then(() => window.dispatchEvent(new Event("sanctum:dirty")))
      .catch(() => {});
    setMessages([]);
    setFb({});
    setError(null);
    setTitle(null); // fresh session — its first message will name it
    setConfirmClear(false);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const history: Msg[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    // memory write starts server-side now → wake the graph view
    window.dispatchEvent(new Event("sanctum:dirty"));
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The server holds the thread in the DB — send only the new message.
        body: JSON.stringify({ message: text }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const recalled = res.headers.get("X-Recalled-Nodes");
      if (recalled) {
        window.dispatchEvent(new CustomEvent("sanctum:recalled", { detail: JSON.parse(recalled) }));
      }
      const st = res.headers.get("X-Session-Title");
      if (st) setTitle(decodeURIComponent(st));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const snapshot = acc;
        setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", content: snapshot }]);
      }
      // reply complete — let the graph light every neuron the reply NAMES
      // (recall misses nodes whose facts ride on profile attrs, e.g. father)
      if (acc.trim()) window.dispatchEvent(new CustomEvent("sanctum:reply", { detail: acc }));
    } catch {
      if (abort.signal.aborted) {
        // user hit stop — keep whatever reply streamed in
      } else {
        setError("Connection hiccup — that message didn't land. Try again.");
        setMessages(history);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      // extraction may still be landing after the stream ends — keep the graph watching
      window.dispatchEvent(new Event("sanctum:dirty"));
    }
  }

  function stop() {
    abortRef.current?.abort(); // the partial reply stays on screen
  }

  // 👍/👎 — teaches Sanctum what good looks like (read by the consolidation cycle)
  async function sendFeedback(i: number, rating: 1 | -1) {
    if (fb[i]) return;
    setFb((p) => ({ ...p, [i]: rating }));
    const userMsg = messages[i - 1]?.role === "user" ? messages[i - 1].content : "";
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, userMsg, assistantMsg: messages[i].content }),
      });
    } catch {
      /* non-critical — feedback is a gift, not a guarantee */
    }
  }

  async function loadRecap() {
    setRecap("loading");
    try {
      const r = await fetch("/api/recap", { cache: "no-store" });
      setRecap(await r.json());
    } catch {
      setRecap(null);
    }
  }

  // ✅ tasks view — the memory graph's Task nodes, toggled from the UI.
  // Toggling writes attrs.status through the same path the extractor uses,
  // so open loops, recall and the cosmos all stay in sync.
  async function loadTasks() {
    setTasks("loading");
    try {
      const r = await fetch("/api/tasks", { cache: "no-store" });
      const d = await r.json();
      setTasks(Array.isArray(d.tasks) ? d.tasks : []);
    } catch {
      setTasks(null);
    }
  }

  async function toggleTask(t: Task) {
    const done = t.status === "open";
    // optimistic flip
    setTasks((prev) =>
      Array.isArray(prev)
        ? prev.map((x) => (x.id === t.id ? { ...x, status: done ? "done" : "open", overdue: false } : x))
        : prev
    );
    try {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id, done }),
      });
      window.dispatchEvent(new Event("sanctum:dirty"));
    } catch {
      /* revert on failure */
      setTasks((prev) =>
        Array.isArray(prev) ? prev.map((x) => (x.id === t.id ? t : x)) : prev
      );
    }
  }

  const waiting =
    busy && messages.at(-1)?.role === "assistant" && !messages.at(-1)?.content;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* messages */}
      <div className="relative min-h-0 flex-1">
        <button
          onClick={loadRecap}
          title="What Sanctum learned this week"
          className="absolute left-3 top-3 z-10 rounded-full border border-white/10 bg-[#0a0a18]/80 px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur-md transition hover:border-amber-300/40 hover:text-amber-300"
        >
          ✨ Week
        </button>
        <button
          onClick={loadTasks}
          title="Tasks Sanctum is tracking for you"
          className="absolute left-[5.75rem] top-3 z-10 rounded-full border border-white/10 bg-[#0a0a18]/80 px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur-md transition hover:border-emerald-300/40 hover:text-emerald-300"
        >
          ✅ Tasks
        </button>
        {/* 🏷️ session title — instant slice first, LLM-upgraded as the conversation grows */}
        {title && (
          <p
            title={title}
            className="pointer-events-none absolute left-1/2 top-[15px] z-10 max-w-[34%] -translate-x-1/2 truncate text-[11px] italic text-slate-500"
          >
            {title}
          </p>
        )}
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            disabled={busy}
            title="End this session — it's saved as a memory digest"
            className={`absolute right-3 top-3 z-10 rounded-full border px-3 py-1.5 text-[11px] backdrop-blur-md transition disabled:opacity-40 ${
              confirmClear
                ? "border-rose-400/40 bg-rose-500/15 text-rose-300"
                : "border-white/10 bg-[#0a0a18]/80 text-slate-400 hover:border-rose-400/40 hover:text-rose-300"
            }`}
          >
            {confirmClear ? "Sure?" : "✕ Clear"}
          </button>
        )}

        {/* ✨ weekly recap overlay — growth made visible */}
        {recap !== null && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-[#05050f]/70 p-4 backdrop-blur-sm"
            onClick={() => setRecap(null)}
          >
            <div
              className="msg-in max-h-full w-full max-w-[330px] overflow-y-auto rounded-2xl border border-white/10 bg-[#0a0a18]/95 p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {recap === "loading" ? (
                <p className="py-6 text-center text-xs text-slate-500">gathering stardust…</p>
              ) : (
                <>
                  <h3 className="font-display text-sm font-semibold text-white">
                    ✨ This week I learned
                  </h3>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {recap.newNodes} new neurons · {recap.newEdges} new synapses
                    {recap.feedback.up + recap.feedback.down > 0 &&
                      ` · ${recap.feedback.up}👍 ${recap.feedback.down}👎`}
                  </p>
                  {Object.keys(recap.byType).length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {Object.entries(recap.byType).map(([t, c]) => (
                        <span
                          key={t}
                          className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-300"
                        >
                          {t} ×{c}
                        </span>
                      ))}
                    </div>
                  )}
                  {recap.newest.length > 0 && (
                    <>
                      <p className="mt-3 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        Newest
                      </p>
                      <ul className="mt-1 space-y-1 text-[11px] text-slate-300">
                        {recap.newest.map((n) => (
                          <li key={n.name} className="truncate">
                            <span className="text-slate-500">{n.type} ·</span> {n.name}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {recap.topMentioned.length > 0 && (
                    <>
                      <p className="mt-3 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        On your mind
                      </p>
                      <ul className="mt-1 space-y-1 text-[11px] text-slate-300">
                        {recap.topMentioned.map((n) => (
                          <li key={n.name} className="truncate">
                            {n.name} <span className="text-slate-600">×{n.mention_count}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {(recap.openLoops?.length ?? 0) > 0 && (
                    <>
                      <p className="mt-3 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        Open loops
                      </p>
                      <ul className="mt-1 space-y-1 text-[11px] text-slate-300">
                        {recap.openLoops.map((l) => (
                          <li key={l.name} className="truncate">
                            {l.name}{" "}
                            <span className={l.overdue ? "text-rose-400" : "text-slate-600"}>
                              {l.due ? (l.overdue ? `overdue ${l.due}` : `due ${l.due}`) : "no deadline"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {recap.latestDigest && (
                    <>
                      <p className="mt-3 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        Last session
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                        {recap.latestDigest.summary.slice(0, 220)}
                        <span className="text-slate-600"> · {recap.latestDigest.date}</span>
                      </p>
                    </>
                  )}
                  <p className="mt-4 text-center text-[10px] text-slate-600">tap outside to close</p>
                </>
              )}
            </div>
          </div>
        )}

        {/* ✅ tasks overlay — the graph's Task nodes as a checklist */}
        {tasks !== null && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-[#05050f]/70 p-4 backdrop-blur-sm"
            onClick={() => setTasks(null)}
          >
            <div
              className="msg-in max-h-full w-full max-w-[330px] overflow-y-auto rounded-2xl border border-white/10 bg-[#0a0a18]/95 p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {tasks === "loading" ? (
                <p className="py-6 text-center text-xs text-slate-500">gathering loops…</p>
              ) : (
                <>
                  <h3 className="font-display text-sm font-semibold text-white">✅ Tasks</h3>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {tasks.filter((t) => t.status === "open").length} open ·{" "}
                    {tasks.filter((t) => t.overdue).length} overdue
                  </p>
                  {tasks.length === 0 ? (
                    <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
                      No tasks yet — mention one in chat
                      <br />
                      <span className="text-slate-600">
                        (“remind me to fix the sign-in API by Friday”)
                      </span>
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-1.5">
                      {tasks.map((t) => {
                        const open = t.status === "open";
                        return (
                          <li key={t.id} className="flex items-start gap-2.5">
                            <button
                              onClick={() => toggleTask(t)}
                              aria-label={open ? "Mark done" : "Reopen"}
                              className={`mt-0.5 grid h-4 w-4 flex-none place-items-center rounded-md border transition active:scale-90 ${
                                open
                                  ? "border-white/25 hover:border-emerald-300/60"
                                  : "border-emerald-400/50 bg-emerald-500/20 text-emerald-300"
                              }`}
                            >
                              {!open && (
                                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M20 6 9 17l-5-5" />
                                </svg>
                              )}
                            </button>
                            <div className="min-w-0 flex-1">
                              <p
                                className={`text-[12px] leading-snug ${
                                  open ? "text-slate-200" : "text-slate-500 line-through"
                                }`}
                              >
                                {t.name}
                              </p>
                              {t.due && (
                                <p className={`text-[10px] ${t.overdue ? "text-rose-400" : "text-slate-600"}`}>
                                  {t.overdue ? `overdue ${t.due}` : open ? `due ${t.due}` : `was due ${t.due}`}
                                </p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <p className="mt-4 text-center text-[10px] text-slate-600">tap outside to close</p>
                </>
              )}
            </div>
          </div>
        )}

        <div className="msg-scroll h-full overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <div className="orb" />
            <div>
              <h2 className="font-display text-lg font-semibold text-white">
                What&apos;s on your mind?
              </h2>
              <p className="mx-auto mt-2 max-w-[270px] text-xs leading-relaxed text-slate-400">
                Talk to me — I&apos;ll remember everything, silently. The more we
                chat, the better I know you. ✨
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3 pt-8">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`msg-in group flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div className="max-w-[85%]">
                  <div
                    className={
                      m.role === "user"
                        ? "whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-indigo-500 to-violet-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-[0_6px_24px_-6px_rgba(99,102,241,0.5)]"
                        : "whitespace-pre-wrap rounded-2xl rounded-bl-md border border-white/[0.08] bg-white/[0.05] px-4 py-2.5 text-sm leading-relaxed text-slate-200"
                    }
                  >
                    {m.content ||
                      (waiting && i === messages.length - 1 ? (
                        <span className="flex items-center gap-1.5 py-1">
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                        </span>
                      ) : null)}
                  </div>
                  {m.role === "assistant" && m.content && !(busy && i === messages.length - 1) && (
                    <div className="mt-1 flex gap-1 opacity-0 transition group-hover:opacity-100">
                      {([1, -1] as const).map((r) => (
                        <button
                          key={r}
                          onClick={() => sendFeedback(i, r)}
                          title={r === 1 ? "Good reply" : "Not great — Sanctum will adjust"}
                          className={`rounded-md px-1.5 py-0.5 text-[11px] transition ${
                            fb[i] === r
                              ? r === 1
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "bg-rose-500/15 text-rose-300"
                              : "text-slate-600 hover:bg-white/[0.06] hover:text-slate-300"
                          }`}
                        >
                          {r === 1 ? "👍" : "👎"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
        </div>
      </div>

      {/* error toast */}
      {error && (
        <div className="msg-in mx-4 mb-2 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* composer */}
      <div className="px-4 pb-4">
        <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.05] p-2 transition focus-within:border-indigo-400/50 focus-within:shadow-[0_0_0_1px_rgba(99,102,241,0.25),0_8px_32px_-8px_rgba(99,102,241,0.35)]">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Say anything…"
            disabled={busy}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-slate-100 outline-none placeholder:text-slate-500 disabled:opacity-50"
          />
          {busy ? (
            <button
              onClick={stop}
              aria-label="Stop generating"
              title="Stop — keeps what streamed so far"
              className="grid h-9 w-9 flex-none place-items-center rounded-xl border border-rose-400/40 bg-rose-500/15 text-rose-300 transition hover:bg-rose-500/25 active:scale-95"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              aria-label="Send"
              className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30 transition hover:brightness-110 active:scale-95 disabled:opacity-30 disabled:shadow-none"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-[10px] tracking-wide text-slate-600">
          Enter to send · Shift + Enter for a new line
        </p>
      </div>
    </div>
  );
}
