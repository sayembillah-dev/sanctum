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

// ── smooth hover-highlight helpers ──────────────────────────────────────────
// Per-entity factors lerp toward their target every paint frame (the canvas
// already repaints continuously for the starfield, so easing is free).
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const rgbCache = new Map<string, [number, number, number]>();
const rgbOf = (hex: string): [number, number, number] => {
  let v = rgbCache.get(hex);
  if (!v) {
    v = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    rgbCache.set(hex, v);
  }
  return v;
};
/** Lerp a map-held value toward target at `rate`/frame; settled 0s are dropped. */
const lerpTo = (map: Map<string, number>, key: string, target: number, rate = 0.2): number => {
  const cur = map.get(key) ?? 0;
  if (Math.abs(target - cur) < 0.01) {
    if (target === 0) map.delete(key);
    else map.set(key, target);
    return target;
  }
  const next = cur + (target - cur) * rate;
  map.set(key, next);
  return next;
};

type GNode = {
  id: string;
  type: string;
  name: string;
  pinned?: boolean;
  mention_count?: number;
  created?: string; // created_at ISO — feeds the timelapse slider range
  x?: number;
  y?: number;
  vx?: number; // velocity — d3-force integrates these
  vy?: number;
  fx?: number; // fixed position pin (used during the pop-out tween; delete to release)
  fy?: number;
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
  const births = useRef<Map<string, number>>(new Map()); // node id → first-seen ts (bloom-in)
  const pops = useRef(new Map<string, { ax: number; ay: number; ang: number; t0: number }>()); // pop-out tweens

  // ── 🕰️ timelapse — serial-based, not time-based ──────────────────────
  // The cosmos replays in the order neurons were born (the snapshot arrives
  // ordered by created_at). cut = how many of the first N nodes to show;
  // null → live full graph. Pure client-side slicing: no fetches, no clocks.
  const [cut, setCut] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevVisible = useRef<Set<string>>(new Set());

  const stopPlay = () => {
    if (playRef.current) clearInterval(playRef.current);
    playRef.current = null;
    setPlaying(false);
  };

  const play = () => {
    if (playing) return stopPlay();
    const total = data.nodes.length;
    if (total < 2) return;
    const step = Math.max(1, Math.ceil(total / 60)); // ≤ ~60 frames
    let cur = 1;
    setPlaying(true);
    setCut(1);
    playRef.current = setInterval(() => {
      cur += step;
      if (cur >= total) {
        stopPlay();
        setCut(null); // land back on the live graph
        return;
      }
      setCut(cur);
    }, 350);
  };

  // ── node inspector ─────────────────────────────────────────────────────
  type NodeDetail = {
    node: GNode & {
      attrs: Record<string, unknown>;
      recall_used_count: number;
      last_recalled_at: string | null;
      created_at: string;
    };
    edges: { src: string; dst: string; type: string; said_on: string | null }[];
  };
  const [hover, setHover] = useState<string | null>(null); // 🖱️ hovered node id (Obsidian-style highlight)
  const dimMap = useRef(new Map<string, number>()); // node id → 0 lit … 1 dimmed (lerped)
  const linkFx = useRef(new Map<string, number>()); // "a|b" → -1 dimmed … 0 … +1 lit (lerped)
  const [selected, setSelected] = useState<{ id: string; name: string; type: string; pinned?: boolean } | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);

  const inspect = (n: GNode) => {
    setSelected({ id: n.id, name: n.name, type: n.type, pinned: n.pinned });
    setConfirmForget(false);
    setDetail(null);
    fetch(`/api/graph/node?id=${encodeURIComponent(n.id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setDetail(d))
      .catch(() => {});
  };

  // Explicit user-initiated forget from the UI — same soft-close path as
  // chat-based forgetting; the node drops out of the cosmos on the next merge.
  const forgetSelected = async () => {
    if (!selected) return;
    if (!confirmForget) return setConfirmForget(true);
    try {
      const r = await fetch("/api/graph/node", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, action: "forget" }),
      });
      if (r.ok) {
        setSelected(null);
        setDetail(null);
        window.dispatchEvent(new Event("sanctum:dirty"));
      }
    } catch {
      /* non-critical */
    } finally {
      setConfirmForget(false);
    }
  };

  // degree map → node sizing + collision
  const degrees = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of data.links) {
      m.set(idOf(l.source), (m.get(idOf(l.source)) ?? 0) + 1);
      m.set(idOf(l.target), (m.get(idOf(l.target)) ?? 0) + 1);
    }
    return m;
  }, [data]);

  // 🖱️ 1-hop adjacency for hover highlight: hovered node + its direct synapses
  // stay lit; everything else dims. (Decision: direct neighbors only — 2-hop on
  // a hub-connected graph would light up nearly everything.)
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data.links) {
      const a = idOf(l.source);
      const b = idOf(l.target);
      (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
      (m.get(b) ?? m.set(b, new Set()).get(b)!).add(a);
    }
    return m;
  }, [data]);

  // Visible slice for the timelapse: first `cut` nodes (+ links between them).
  // Nodes entering the window mid-scrub bloom in beside a visible neighbor.
  const view = useMemo<GData>(() => {
    const nodes = cut === null ? data.nodes : data.nodes.slice(0, cut);
    const visible = new Set(nodes.map((n) => n.id));
    if (prevVisible.current.size > 0) {
      const now = performance.now();
      let kicked = false;
      for (const n of nodes) {
        if (prevVisible.current.has(n.id) || n.x !== undefined) continue;
        births.current.set(n.id, now);
        pulses.current.set(n.id, now);
        const nb = data.links.find((l) => {
          const a = idOf(l.source);
          const b = idOf(l.target);
          return (a === n.id && visible.has(b)) || (b === n.id && visible.has(a));
        });
        const anchor = nb
          ? nodes.find((m) => m.id === (idOf(nb.source) === n.id ? idOf(nb.target) : idOf(nb.source)))
          : undefined;
        if (anchor?.x !== undefined) {
          // 🎆 pop out FROM the parent (Obsidian timelapse feel): spawn pinned at
          // its exact position, then a per-frame tween eases it outward (d3's
          // velocity decay eats plain kicks in ~5 ticks — too fast to read as motion)
          n.x = anchor.x;
          n.y = anchor.y ?? 0;
          n.fx = n.x;
          n.fy = n.y;
          pops.current.set(n.id, { ax: n.x, ay: n.y, ang: Math.random() * Math.PI * 2, t0: now });
          kicked = true;
        }
      }
      // wake the sim so nodes settle naturally once the tween releases them
      if (kicked) queueMicrotask(() => fgRef.current?.d3ReheatSimulation?.());
    }
    prevVisible.current = visible;
    return {
      nodes,
      links: data.links.filter((l) => visible.has(idOf(l.source)) && visible.has(idOf(l.target))),
    };
  }, [data, cut]);

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
        const alive = new Set(d.nodes.map((n) => n.id));
        return {
          // The merge maps over the NEW node list — forgotten/merged nodes drop
          // out of the cosmos live (no ghost neurons lingering until refresh).
          nodes: d.nodes.map((n) => {
            const o = old.get(n.id);
            if (o) return Object.assign(o, n); // keep positions across refreshes
            // New neuron entering the cosmos → bloom-in + welcome flash.
            // Skipped on first load (everything would bloom at once).
            if (prev.nodes.length > 0) {
              const now = performance.now();
              births.current.set(n.id, now);
              pulses.current.set(n.id, now);
              // pop out FROM the neighbor it belongs to (pinned + outward tween)
              const nb = d.links.find((l) => idOf(l.source) === n.id || idOf(l.target) === n.id);
              const anchor = nb
                ? old.get(idOf(nb.source) === n.id ? idOf(nb.target) : idOf(nb.source))
                : undefined;
              if (anchor && anchor.x !== undefined) {
                n.x = anchor.x;
                n.y = anchor.y ?? 0;
                n.fx = n.x;
                n.fy = n.y;
                pops.current.set(n.id, {
                  ax: n.x,
                  ay: n.y,
                  ang: Math.random() * Math.PI * 2,
                  t0: performance.now(),
                });
              }
            }
            return n;
          }),
          // defensive: never keep a link whose endpoint left the graph
          links: d.links.filter((l) => alive.has(idOf(l.source)) && alive.has(idOf(l.target))),
        };
      });
      // close the inspector if its node just left the graph (forgotten/merged)
      setSelected((sel) => (sel && !d.nodes.some((n) => n.id === sel.id) ? null : sel));
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
      if (playRef.current) clearInterval(playRef.current);
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
        graphData={view}
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
        onNodeClick={(n: any) => inspect(n as GNode)}
        onBackgroundClick={() => setSelected(null)}
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
          // position not assigned yet (fresh timelapse slice entry) — skip this frame
          if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;

          // 🎆 pop-out tween: pinned node eases ~90px outward from its parent
          // with a slight overshoot (easeOutBack), then releases to physics
          const pop = pops.current.get(n.id);
          if (pop) {
            const p = Math.min(1, (performance.now() - pop.t0) / 700);
            const e = 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
            const dist = 90 * e;
            n.x = n.fx = pop.ax + Math.cos(pop.ang) * dist;
            n.y = n.fy = pop.ay + Math.sin(pop.ang) * dist;
            if (p >= 1) {
              delete n.fx; // release → force layout takes over
              delete n.fy;
              pops.current.delete(n.id);
            }
          }
          const isSun = !!n.pinned;
          const color = isSun ? SUN : colorFor(n.type);
          const r = radiusOf(n);
          // 🖱️ smooth hover dim: the factor eases toward its target each frame
          const dimTarget = hover !== null && n.id !== hover && !neighbors.get(hover)?.has(n.id) ? 1 : 0;
          const dimF = lerpTo(dimMap.current, n.id, dimTarget);
          const [cr, cg, cb] = rgbOf(color);

          // eased recall pulse
          const t0 = pulses.current.get(n.id);
          const raw = t0 !== undefined ? Math.max(0, 1 - (performance.now() - t0) / PULSE_MS) : 0;
          const boost = raw * raw;
          if (t0 !== undefined && raw <= 0) pulses.current.delete(n.id);

          // bloom-in (timelapse / freshly extracted neurons): easeOutCubic over ~0.9s
          const tB = births.current.get(n.id);
          const birthF = tB === undefined ? 1 : Math.min(1, (performance.now() - tB) / 900);
          if (birthF >= 1 && tB !== undefined) births.current.delete(n.id);
          const eB = 1 - Math.pow(1 - birthF, 3);

          // halo — radial gradient, fades to nothing (no hard edge)
          const haloR = r * (2.1 + 1.2 * boost) * eB;
          const g = ctx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, haloR);
          g.addColorStop(0, `rgba(${cr},${cg},${cb},${(mix(boost > 0 ? 0.19 : 0.1, 0.028, dimF) * eB).toFixed(3)})`);
          g.addColorStop(1, color + "00");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(n.x, n.y, haloR, 0, Math.PI * 2);
          ctx.fill();

          // core
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * (1 + 0.25 * boost) * eB, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${(mix(1, 0.14, dimF) * eB).toFixed(3)})`;
          ctx.fill();

          // label — constant screen size, hidden when far zoomed out
          if (scale > 0.45) {
            const fs = Math.min(Math.max(11 / scale, 3), 15);
            ctx.font = `${isSun ? 700 : 500} ${fs}px Inter, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = `rgba(226,232,255,${(mix(0.82, 0.08, dimF) * eB).toFixed(3)})`;
            ctx.fillText(n.name, n.x, n.y + r + fs * 0.55);
          }
        }}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const n = node as GNode & { x: number; y: number };
          if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return; // unpositioned yet
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x, n.y, radiusOf(n) + 6, 0, Math.PI * 2);
          ctx.fill();
        }}
        onNodeHover={(n: any) => setHover(n ? (n as GNode).id : null)}
        linkColor={(l: any) => {
          const a = idOf(l.source);
          const b = idOf(l.target);
          const target = hover === null ? 0 : a === hover || b === hover ? 1 : -1;
          const v = lerpTo(linkFx.current, `${a}|${b}`, target, 0.16);
          return v >= 0
            ? // ease slate → lit indigo
              `rgba(${Math.round(mix(148, 165, v))},${Math.round(mix(163, 180, v))},${Math.round(
                mix(184, 252, v)
              )},${mix(0.22, 0.6, v).toFixed(3)})`
            : // ease toward background
              `rgba(148,163,184,${mix(0.22, 0.05, -v).toFixed(3)})`;
        }}
        linkWidth={(l: any) => {
          const v = linkFx.current.get(`${idOf(l.source)}|${idOf(l.target)}`) ?? 0;
          return v > 0 ? 1 + v * 0.5 : 1; // lit synapses thicken slightly
        }}
      />

      {/* counters */}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] tracking-wide text-slate-300/80 backdrop-blur">
        {data.nodes.length} neurons · {data.links.length} synapses
      </div>

      {/* 🕰️ timelapse — replay the cosmos in birth order (node #1 → #N) */}
      {data.nodes.length > 1 && (
        <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 backdrop-blur">
          <button
            onClick={play}
            title={playing ? "Stop timelapse" : "▶ Timelapse — watch your brain grow"}
            className={`grid h-5 w-5 place-items-center rounded-full border text-[9px] transition active:scale-90 ${
              playing
                ? "border-amber-300/50 bg-amber-400/15 text-amber-300"
                : "border-white/15 text-slate-400 hover:border-indigo-300/50 hover:text-indigo-300"
            }`}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <span className="text-[11px]" title="Replay in the order neurons were born">
            🕰️
          </span>
          <input
            type="range"
            aria-label="Show the first N neurons"
            className="h-1 w-40 cursor-pointer accent-indigo-400"
            min={1}
            max={data.nodes.length}
            value={cut ?? data.nodes.length}
            onChange={(e) => {
              stopPlay(); // manual scrub wins over playback
              const v = Number(e.target.value);
              setCut(v >= data.nodes.length ? null : v);
            }}
          />
          <span
            className={`min-w-[4.5rem] text-center text-[11px] tabular-nums ${
              cut !== null ? "text-amber-300" : "text-slate-400"
            }`}
            title={cut !== null ? data.nodes[cut - 1]?.created : undefined}
          >
            {cut === null ? "now" : `#${cut} / ${data.nodes.length}`}
          </span>
          {cut !== null && (
            <button
              onClick={() => setCut(null)}
              className="rounded-full border border-amber-300/30 px-2 py-0.5 text-[10px] text-amber-300 transition hover:bg-amber-400/10"
            >
              back to now
            </button>
          )}
        </div>
      )}

      {/* ── node inspector — click a neuron ── */}
      {selected && (
        <div className="absolute right-3 top-3 z-10 flex max-h-[85%] w-72 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a18]/90 shadow-2xl backdrop-blur-md">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
            <span
              className="h-2.5 w-2.5 flex-none rounded-full"
              style={{ backgroundColor: selected.pinned ? SUN : colorFor(selected.type) }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{selected.name}</p>
              <p className="text-[10px] text-slate-500">
                {selected.type}
                {selected.pinned ? " · pinned ☀️" : ""}
              </p>
            </div>
            <button
              onClick={() => setSelected(null)}
              aria-label="Close"
              className="rounded-md px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-300"
            >
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {!detail ? (
              <p className="py-4 text-center text-[11px] text-slate-500">reading memory…</p>
            ) : (
              <>
                <p className="text-[10px] text-slate-600">
                  ×{detail.node.mention_count} mentions · cited {detail.node.recall_used_count}×
                  {detail.node.last_recalled_at &&
                    ` · last recalled ${detail.node.last_recalled_at.slice(0, 10)}`}
                </p>

                {Object.keys(detail.node.attrs ?? {}).length > 0 && (
                  <>
                    <p className="mt-3 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                      Attributes
                    </p>
                    <dl className="mt-1 space-y-1">
                      {Object.entries(detail.node.attrs).map(([k, v]) => (
                        <div key={k} className="flex gap-2 text-[11px]">
                          <dt className="flex-none text-slate-500">{k}</dt>
                          <dd className="min-w-0 flex-1 break-words text-slate-300">
                            {typeof v === "string" ? v : JSON.stringify(v)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </>
                )}

                {detail.edges.length > 0 && (
                  <>
                    <p className="mt-3 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                      Synapses
                    </p>
                    <ul className="mt-1 space-y-1 text-[11px] text-slate-300">
                      {detail.edges.map((e, i) => (
                        <li key={i} className="truncate">
                          {e.src === detail.node.name ? (
                            <>
                              —<span className="text-indigo-300">{e.type}</span>→ {e.dst}
                            </>
                          ) : (
                            <>
                              {e.src} —<span className="text-indigo-300">{e.type}</span>→
                            </>
                          )}
                          {e.said_on && <span className="text-slate-600"> · {e.said_on}</span>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>

          {!selected.pinned && (
            <div className="border-t border-white/[0.06] px-4 py-3">
              <button
                onClick={forgetSelected}
                className={`w-full rounded-xl border px-3 py-1.5 text-[11px] transition ${
                  confirmForget
                    ? "border-rose-400/40 bg-rose-500/15 text-rose-300"
                    : "border-white/10 text-slate-400 hover:border-rose-400/40 hover:text-rose-300"
                }`}
              >
                {confirmForget ? "Sure? This soft-deletes the node" : "Forget this memory"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
