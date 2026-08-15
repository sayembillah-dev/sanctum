"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });
// @ts-ignore — d3-force-3d ships no types; forceCollide interface matches d3-force
import { forceCollide } from "d3-force-3d";

const TYPE_COLORS: Record<string, string> = {
  Person: "#f472b6",
  Project: "#60a5fa",
  Task: "#fbbf24",
  Org: "#34d399",
  Place: "#a78bfa",
  Note: "#94a3b8",
};
const colorFor = (t: string) => TYPE_COLORS[t] ?? "#e879f9";
const idOf = (x: any) => (typeof x === "string" ? x : x?.id);
const jitter = (r: number) => (Math.random() - 0.5) * r;

const PULSE_MS = 3500; // how long a recalled neuron glows
const BASE_BG = "#05050f"; // deep space — matches page bg

type GNode = { id: string; type: string; name: string; pinned?: boolean; mention_count?: number; x?: number; y?: number };
type GLink = { source: any; target: any; type: string };
type GData = { nodes: GNode[]; links: GLink[] };

function signature(d: GData) {
  return (
    d.nodes.map((n) => `${n.id}:${n.name}:${n.type}:${n.pinned ? 1 : 0}:${n.mention_count ?? 0}`).sort().join("|") +
    "#" +
    d.links.map((l) => `${idOf(l.source)}>${idOf(l.target)}:${l.type}`).sort().join("|")
  );
}

/** Merge a fresh snapshot into the live graph: keep positions, seed new nodes beside a neighbor. */
function mergeGraph(prev: GData, next: GData): GData {
  if (signature(prev) === signature(next)) return prev; // unchanged → same reference → zero churn
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]));
  const nodes = next.nodes.map((n) => {
    const old = prevById.get(n.id);
    if (old) return Object.assign(old, n); // preserve x/y/vx/vy → simulation stays stable
    const newborn: GNode = { ...n };
    // Seed on a ring around the centroid of ALL its already-placed neighbors (~one
    // link-distance out) — the relax pass then finds its true organic spot.
    const neighborIds = next.links
      .filter((l) => idOf(l.source) === n.id || idOf(l.target) === n.id)
      .map((l) => (idOf(l.source) === n.id ? idOf(l.target) : idOf(l.source)));
    const placed = neighborIds
      .map((id) => prevById.get(id as string))
      .filter((p): p is GNode => !!p && p.x !== undefined);
    const angle = Math.random() * 2 * Math.PI;
    if (placed.length) {
      const cx = placed.reduce((a, p) => a + (p.x ?? 0), 0) / placed.length;
      const cy = placed.reduce((a, p) => a + (p.y ?? 0), 0) / placed.length;
      newborn.x = cx + Math.cos(angle) * 110 + jitter(24);
      newborn.y = cy + Math.sin(angle) * 110 + jitter(24);
    } else {
      // orphan: ring around the graph's center of mass
      const cx = prev.nodes.reduce((a, p) => a + (p.x ?? 0), 0) / Math.max(prev.nodes.length, 1);
      const cy = prev.nodes.reduce((a, p) => a + (p.y ?? 0), 0) / Math.max(prev.nodes.length, 1);
      newborn.x = cx + Math.cos(angle) * 190 + jitter(24);
      newborn.y = cy + Math.sin(angle) * 190 + jitter(24);
    }
    return newborn;
  });
  return { nodes, links: next.links.map((l) => ({ ...l })) };
}

export default function GraphView() {
  const [data, setData] = useState<GData>({ nodes: [], links: [] });
  const fgRef = useRef<any>(null);
  const fitted = useRef(false);
  const prevCount = useRef(0);
  const dragging = useRef(false);
  const pulses = useRef(new Map<string, number>()); // nodeId → when the pulse started

  // Static starfield — generated once, painted into the canvas every frame
  const stars = useMemo(
    () =>
      Array.from({ length: 240 }, () => ({
        x: Math.random(),
        y: Math.random(),
        r: Math.random() * 1.1 + 0.3,
        a: Math.random() * 0.45 + 0.15,
        p: Math.random() * Math.PI * 2, // twinkle phase
      })),
    []
  );

  // No idle polling — the graph only changes on memory writes. Fetch on mount and
  // tab refocus, plus a short "active" window after `sanctum:dirty` so nodes pop in
  // while server-side extraction lands. Merge keeps the simulation alive on updates.
  useEffect(() => {
    let stop = false;
    let activeTimer: ReturnType<typeof setInterval> | null = null;
    let activeUntil = 0;

    async function load() {
      try {
        const r = await fetch("/api/graph", { cache: "no-store" });
        const d = await r.json();
        if (!stop) setData((prev) => mergeGraph(prev, d));
      } catch {
        /* transient — next trigger retries */
      }
    }

    // Poll every 2s, but only until `activeUntil`; each dirty event extends the window
    function kick(activeMs = 30_000) {
      activeUntil = Date.now() + activeMs;
      if (activeTimer) return;
      activeTimer = setInterval(() => {
        if (Date.now() > activeUntil) {
          clearInterval(activeTimer!);
          activeTimer = null;
          return;
        }
        load();
      }, 2000);
    }

    function onDirty() {
      load(); // immediate — catches anything already committed
      kick(); // then keep watching while extraction lands
    }
    function onVisible() {
      if (!document.hidden) load();
    }

    load();
    window.addEventListener("sanctum:dirty", onDirty);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      if (activeTimer) clearInterval(activeTimer);
      window.removeEventListener("sanctum:dirty", onDirty);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Neurons that the AI just recalled light up
  useEffect(() => {
    function onRecall(e: Event) {
      const now = performance.now();
      for (const id of (e as CustomEvent<string[]>).detail) pulses.current.set(id, now);
      // wake the engine so frames flow during the glow fade — nodes are pinned, so nothing moves
      fgRef.current?.d3ReheatSimulation?.();
      setTimeout(() => fgRef.current?.refresh?.(), PULSE_MS); // final paint of the cooled state
    }
    window.addEventListener("sanctum:recalled", onRecall);
    return () => window.removeEventListener("sanctum:recalled", onRecall);
  }, []);

  const degrees = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of data.links) {
      const s = idOf(l.source);
      const t = idOf(l.target);
      m.set(s, (m.get(s) ?? 0) + 1);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [data.links]);

  // Obsidian-ish physics: strong repulsion + wide links + collision radius so
  // clusters declump and labels stop colliding; weak center keeps domains apart
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // Obsidian-like balance: mild center pull forms a round constellation,
    // bounded repulsion + uniform link length keep nodes clean and separate
    fg.d3Force?.("charge")?.strength?.(-420);
    fg.d3Force?.("link")?.distance?.(150);
    fg.d3Force?.("center")?.strength?.(0.1);
    fg.d3Force?.("charge")?.distanceMax?.(700);
    const collide = forceCollide((n: any) => 30 + (degrees.get(n.id) ?? 0) * 1.8);
    collide.strength?.(0.5); // gentle overlap resolution — no violent push-back
    fg.d3Force?.("collide", collide);
  }, [degrees]);

  // New memories: unpin the whole cosmos and let it relax organically (Obsidian-style
  // re-settle), then re-frame. Pinning resumes on engine stop — drags stay rock solid.
  useEffect(() => {
    const grew = data.nodes.length > prevCount.current;
    prevCount.current = data.nodes.length;
    if (grew) {
      fitted.current = true;
      for (const n of data.nodes) {
        delete (n as any).fx;
        delete (n as any).fy;
      }
      fgRef.current?.d3ReheatSimulation?.();
      setTimeout(() => fgRef.current?.zoomToFit(800, 80), 900);
    } else if (!fitted.current && data.nodes.length > 0) {
      fitted.current = true;
      setTimeout(() => fgRef.current?.zoomToFit(600, 100), 600);
    }
  }, [data]);

  return (
    <div className="relative h-full w-full">
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        warmupTicks={80}
        d3AlphaDecay={0.03}
        d3VelocityDecay={0.3}
        onEngineStop={() => {
          // pin everything once the layout settles — dragging one neuron
          // no longer shakes unrelated clusters, and the cosmos stays where you left it
          // no pinning — nodes stay under live forces so drags bounce back (Obsidian-style)
        }}
        onNodeDrag={(dragged: any) => {
          if (dragging.current) return;
          dragging.current = true;
          // free ONLY the dragged node's 1-hop neighbors — local organic flex;
          // distant domains stay pinned. Everything re-pins on engine stop.
          const near = new Set<string>();
          for (const l of data.links) {
            const s = idOf(l.source);
            const t = idOf(l.target);
            if (s === dragged.id) near.add(t);
            else if (t === dragged.id) near.add(s);
          }
          for (const n of data.nodes) {
            if (near.has(n.id)) {
              delete (n as any).fx;
              delete (n as any).fy;
            }
          }
        }}
        onNodeDragEnd={(n: any) => {
          dragging.current = false;
          delete n.fx; // release → springs back into the disc
          delete n.fy;
          fgRef.current?.d3ReheatSimulation?.();
        }}
        backgroundColor={BASE_BG}
        onRenderFramePre={(ctx: CanvasRenderingContext2D) => {
          // Screen-space cosmic backdrop: nebulae + twinkling stars + vignette
          const w = ctx.canvas.width;
          const h = ctx.canvas.height;
          const dpr = w / (ctx.canvas.clientWidth || w);
          const now = performance.now();
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);

          const nebula = (x: number, y: number, r: number, c: string) => {
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, c);
            g.addColorStop(1, "rgba(5,5,15,0)");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
          };
          nebula(w * 0.72, h * 0.22, w * 0.38, "rgba(99,102,241,0.10)"); // indigo
          nebula(w * 0.5, h * 0.85, w * 0.32, "rgba(168,85,247,0.07)"); // violet
          nebula(w * 0.92, h * 0.65, w * 0.26, "rgba(236,72,153,0.045)"); // pink

          for (const s of stars) {
            const tw = 0.65 + 0.35 * Math.sin(now / 900 + s.p);
            ctx.globalAlpha = s.a * tw;
            ctx.beginPath();
            ctx.arc(s.x * w, s.y * h, s.r * dpr, 0, 2 * Math.PI);
            ctx.fillStyle = "#e2e8f0";
            ctx.fill();
          }
          ctx.globalAlpha = 1;

          const vg = ctx.createRadialGradient(
            w / 2,
            h / 2,
            Math.min(w, h) * 0.4,
            w / 2,
            h / 2,
            Math.max(w, h) * 0.75
          );
          vg.addColorStop(0, "rgba(0,0,0,0)");
          vg.addColorStop(1, "rgba(0,0,0,0.5)");
          ctx.fillStyle = vg;
          ctx.fillRect(0, 0, w, h);

          ctx.restore();
        }}
        linkColor={() => "rgba(148,163,184,0.22)"}
        linkWidth={1}
        onNodeHover={(n: any) => {
          document.body.style.cursor = n ? "pointer" : "";
        }}
        nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
          // ☀️ the pinned profile node is the sun of the cosmos — warm, bigger, brighter
          const isSun = !!node.pinned;
          const isDigest = node.type === "Conversation"; // session digests: quiet dust, not stars
          const color = isSun ? "#fcd34d" : isDigest ? "#475569" : colorFor(node.type);
          const r =
            (isSun ? 6.5 : isDigest ? 2 : 4) +
            (degrees.get(node.id) ?? 0) * 1.6 +
            Math.min(Math.log1p(node.mention_count ?? 1) * 0.5, 2.5); // grows with use

          // 🔥 recall pulse — fading white ring + brightened halo for ~3.5s
          // recall glow: neuron burns brighter & bigger while in use, then cools
          const t0 = pulses.current.get(node.id);
          const raw =
            t0 !== undefined
              ? Math.max(0, 1 - (performance.now() - t0) / PULSE_MS)
              : 0;
          const boost = raw * raw; // eased fade — soft onset, long silky tail
          if (t0 !== undefined && performance.now() - t0 >= PULSE_MS) {
            pulses.current.delete(node.id);
          }
          const rr = r * (1 + 0.3 * boost);

          // soft outer halo — swells while glowing; the sun radiates wider & warmer
          ctx.beginPath();
          ctx.arc(node.x, node.y, rr * ((isSun ? 2.4 : 1.9) + 0.9 * boost), 0, 2 * Math.PI);
          ctx.fillStyle = color + (boost > 0 ? "1c" : isSun ? "12" : "0b");
          ctx.fill();

          // neuron body — hot core cooling to type color, with neon glow
          ctx.save();
          ctx.shadowColor = color;
          ctx.shadowBlur = (isSun ? 10 : 6) + 12 * boost;
          const g = ctx.createRadialGradient(
            node.x - rr * 0.35,
            node.y - rr * 0.35,
            rr * 0.1,
            node.x,
            node.y,
            rr
          );
          g.addColorStop(0, "rgba(255,255,255,0.95)");
          g.addColorStop(0.35, color);
          g.addColorStop(1, color);
          ctx.beginPath();
          ctx.arc(node.x, node.y, rr, 0, 2 * Math.PI);
          ctx.fillStyle = g;
          ctx.fill();
          ctx.restore();

          // label with subtle dark glow for readability over stars
          const fs = Math.max(11 / scale, 2.5);
          ctx.save();
          ctx.font = `${isSun ? 700 : 500} ${fs}px Inter, system-ui, sans-serif`;
          ctx.shadowColor = "rgba(0,0,0,0.9)";
          ctx.shadowBlur = 6;
          ctx.fillStyle = "rgba(226,232,240,0.92)";
          ctx.fillText(node.name, node.x + r + 4, node.y + fs / 2);
          ctx.restore();
        }}
      />

      {/* status overlay */}
      <div className="rise-in pointer-events-none absolute right-6 top-5 z-10 flex flex-col items-end gap-2">
        <span className="glass-chip">
          <span className="live-dot" />
          Memory Graph · live
        </span>
        <span className="pr-1 text-[11px] tracking-wide text-slate-500">
          {data.nodes.length} neurons · {data.links.length} synapses
        </span>
      </div>

      {/* contextual hints */}
      {data.nodes.length === 0 ? (
        <div className="pointer-events-none absolute bottom-8 right-6 z-10 max-w-[240px] text-right text-[11px] leading-relaxed text-slate-600">
          your memories will ignite here as you chat ✨
        </div>
      ) : (
        <div className="pointer-events-none absolute bottom-5 right-6 z-10 text-[10px] tracking-wide text-slate-600">
          drag to explore · scroll to zoom
        </div>
      )}
    </div>
  );
}
