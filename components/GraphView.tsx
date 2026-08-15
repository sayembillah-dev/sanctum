"use client";

// ── Sanctum memory cosmos — rebuilt for an Obsidian-like feel ──────────────
// Physics: forceX/forceY pull everything into a soft round disc; forceManyBody
// + forceCollide keep nodes evenly separated; links are uniform-length. The sim
// settles, then stays alive enough that dragging a node and releasing it
// bounces it back into place. No pinning, no freezing.

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
// @ts-ignore — d3-force-3d ships no types
import { forceCollide, forceManyBody, forceX, forceY } from "d3-force-3d";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// ── palette ────────────────────────────────────────────────────────────────
const BASE_BG = "#05050f";
const TYPE_COLORS: Record<string, string> = {
  Person: "#f472b6",
  Project: "#60a5fa",
  Org: "#34d399",
  Place: "#a78bfa",
  Task: "#fbbf24",
  Note: "#c084fc",
};
const colorFor = (t: string) => TYPE_COLORS[t] ?? "#94a3b8";
const SUN = "#fcd34d";

type GNode = {
  id: string;
  type: string;
  name: string;
  pinned?: boolean;
  mention_count?: number;
  x?: number;
  y?: number;
};
type GLink = { source: string | GNode; target: string | GNode; type: string };
type GData = { nodes: GNode[]; links: GLink[] };

const idOf = (v: string | GNode) => (typeof v === "string" ? v : v.id);
const PULSE_MS = 3500;

// stars for the backdrop (normalized coords, twinkle phase)
const STARS = Array.from({ length: 160 }, () => ({
  x: Math.random(),
  y: Math.random(),
  r: Math.random() * 1.1 + 0.3,
  p: Math.random() * Math.PI * 2,
  s: 0.4 + Math.random() * 0.8,
}));

export default function GraphView() {
  const fgRef = useRef<any>(null);
  const [data, setData] = useState<GData>({ nodes: [], links: [] });
  const sig = useRef("");
  const fitted = useRef(false);
  const prevCount = useRef(0);
  const dirtyUntil = useRef(0);
  const pulses = useRef<Map<string, number>>(new Map());

  // degree map → node sizing + collision
  const degrees = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of data.links) {
      m.set(idOf(l.source), (m.get(idOf(l.source)) ?? 0) + 1);
      m.set(idOf(l.target), (m.get(idOf(l.target)) ?? 0) + 1);
    }
    return m;
  }, [data]);

  const radiusOf = (n: GNode) => {
    const base = n.pinned ? 7 : 4.5;
    const deg = Math.min((degrees.get(n.id) ?? 0) * 0.7, 5);
    const use = Math.min(Math.log1p(n.mention_count ?? 1) * 0.4, 2);
    return base + deg + use;
  };

  // ── physics: Obsidian balance ────────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("center", null); // replaced by soft x/y containment → round disc
    fg.d3Force("x", forceX(0).strength(0.055));
    fg.d3Force("y", forceY(0).strength(0.055));
    fg.d3Force("charge", forceManyBody().strength(-320).distanceMax(520));
    fg.d3Force("link")?.distance?.(130)?.strength?.(0.85);
    fg.d3Force(
      "collide",
      forceCollide((n: any) => radiusOf(n as GNode) + 14).iterations(2)
    );
  }, [degrees]);

  // ── data loading (dirty-window polling after activity) ───────────────────
  const load = async () => {
    try {
      const r = await fetch("/api/graph", { cache: "no-store" });
      const d = (await r.json()) as GData;
      const nextSig =
        d.nodes
          .map((n) => `${n.id}:${n.name}:${n.type}:${n.pinned ? 1 : 0}:${n.mention_count ?? 0}`)
          .sort()
          .join("|") +
        "##" +
        d.links.map((l) => `${idOf(l.source)}>${idOf(l.target)}:${l.type}`).sort().join("|");
      if (nextSig === sig.current) return;
      sig.current = nextSig;
      setData((prev) => {
        const old = new Map(prev.nodes.map((n) => [n.id, n]));
        return {
          nodes: d.nodes.map((n) => {
            const o = old.get(n.id);
            return o ? Object.assign(o, n) : n; // keep positions across refreshes
          }),
          links: d.links,
        };
      });
    } catch {
      /* offline tolerance */
    }
  };

  useEffect(() => {
    load();
    const onDirty = () => {
      dirtyUntil.current = Date.now() + 8000;
      load();
    };
    const onRecalled = (e: Event) => {
      const ids: string[] = (e as CustomEvent).detail?.ids ?? [];
      const now = performance.now();
      ids.forEach((id) => pulses.current.set(id, now));
    };
    window.addEventListener("sanctum:dirty", onDirty);
    window.addEventListener("sanctum:recalled", onRecalled);
    const t = setInterval(() => {
      if (Date.now() < dirtyUntil.current) load();
    }, 2000);
    return () => {
      window.removeEventListener("sanctum:dirty", onDirty);
      window.removeEventListener("sanctum:recalled", onRecalled);
      clearInterval(t);
    };
  }, []);

  // fit on first load; gently reheat + refit when the brain grows
  useEffect(() => {
    if (!data.nodes.length) return;
    const grew = data.nodes.length > prevCount.current;
    prevCount.current = data.nodes.length;
    if (!fitted.current) {
      fitted.current = true;
      setTimeout(() => fgRef.current?.zoomToFit(700, 70), 500);
    } else if (grew) {
      fgRef.current?.d3ReheatSimulation?.();
      setTimeout(() => fgRef.current?.zoomToFit(800, 80), 900);
    }
  }, [data]);

  return (
    <div className="relative h-full w-full">
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        backgroundColor={BASE_BG}
        warmupTicks={120}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.28}
        enableNodeDrag
        onNodeDragEnd={(n: any) => {
          delete n.fx; // release → the live sim bounces it back into the disc
          delete n.fy;
          fgRef.current?.d3ReheatSimulation?.();
        }}
        // ── cosmic backdrop: twinkling stars + vignette (screen space) ──
        onRenderFramePre={(ctx: CanvasRenderingContext2D) => {
          const w = ctx.canvas.width;
          const h = ctx.canvas.height;
          const now = performance.now() / 1000;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          for (const s of STARS) {
            const a = 0.12 + 0.14 * (0.5 + 0.5 * Math.sin(now * s.s + s.p));
            ctx.fillStyle = `rgba(200,210,255,${a.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
            ctx.fill();
          }
          const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.75);
          vg.addColorStop(0, "rgba(5,5,15,0)");
          vg.addColorStop(1, "rgba(0,0,5,0.55)");
          ctx.fillStyle = vg;
          ctx.fillRect(0, 0, w, h);
          ctx.restore();
        }}
        // ── nodes: clean dot + gradient-faded halo + label ──
        nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
          const n = node as GNode & { x: number; y: number };
          const isSun = !!n.pinned;
          const color = isSun ? SUN : colorFor(n.type);
          const r = radiusOf(n);

          // eased recall pulse
          const t0 = pulses.current.get(n.id);
          const raw = t0 !== undefined ? Math.max(0, 1 - (performance.now() - t0) / PULSE_MS) : 0;
          const boost = raw * raw;
          if (t0 !== undefined && raw <= 0) pulses.current.delete(n.id);

          // halo — radial gradient, fades to nothing (no hard edge)
          const haloR = r * (2.1 + 1.2 * boost);
          const g = ctx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, haloR);
          g.addColorStop(0, color + (boost > 0 ? "30" : "1a"));
          g.addColorStop(1, color + "00");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(n.x, n.y, haloR, 0, Math.PI * 2);
          ctx.fill();

          // core
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * (1 + 0.25 * boost), 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();

          // label — constant screen size, hidden when far zoomed out
          if (scale > 0.45) {
            const fs = Math.min(Math.max(11 / scale, 3), 15);
            ctx.font = `${isSun ? 700 : 500} ${fs}px Inter, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = "rgba(226,232,255,0.82)";
            ctx.fillText(n.name, n.x, n.y + r + fs * 0.55);
          }
        }}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const n = node as GNode & { x: number; y: number };
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x, n.y, radiusOf(n) + 6, 0, Math.PI * 2);
          ctx.fill();
        }}
        linkColor={() => "rgba(148,163,184,0.22)"}
        linkWidth={1}
      />

      {/* counters */}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] tracking-wide text-slate-300/80 backdrop-blur">
        {data.nodes.length} neurons · {data.links.length} synapses
      </div>
    </div>
  );
}
