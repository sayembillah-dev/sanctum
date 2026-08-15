import Chat from "@/components/Chat";
import GraphView from "@/components/GraphView";

export default function Home() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#05050f]">
      {/* memory cosmos — full-bleed canvas behind everything */}
      <div className="absolute inset-0">
        <GraphView />
      </div>

      {/* floating glass chat panel */}
      <aside className="rise-in absolute bottom-5 left-5 top-5 z-20 flex w-[400px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0a0a18]/70 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
        <header className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="grid h-10 w-10 flex-none place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg shadow-[0_0_24px_rgba(99,102,241,0.5)]">
            🧠
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-lg font-semibold tracking-tight text-white">
              Sanctum
            </h1>
            <p className="truncate text-[11px] text-slate-400">
              every chat becomes memory — watch it grow
            </p>
          </div>
          <span className="glass-chip ml-auto">
            <span className="live-dot" />
            LIVE
          </span>
        </header>
        <Chat />
      </aside>
    </main>
  );
}
