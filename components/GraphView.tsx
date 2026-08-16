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

// ── C11: prerendered halo sprites ─────────────────────────────────────────
// The old halo ran ctx.createRadialGradient per node per frame (alloc + GPU
// upload × nodes × 60fps). Now each type color gets ONE offscreen canvas with
// the fade-out gradient baked in; the frame loop blits it with drawImage and
// modulates alpha via globalAlpha (boost/dim/birth factors still apply whole).
const SPRITE_PX = 128;
const haloSprites = new Map<string, HTMLCanvasElement>();
function haloSprite(color: string): HTMLCanvasElement | null {
  const hit = haloSprites.get(color);
  if (hit) return hit;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = SPRITE_PX;
  const sctx = c.getContext("2d");
  if (!sctx) return null;
  const [r, g, b] = rgbOf(color);
  const grad = sctx.createRadialGradient(SPRITE_PX / 2, SPRITE_PX / 2, SPRITE_PX * 0.05, SPRITE_PX / 2, SPRITE_PX / 2, SPRITE_PX / 2);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  haloSprites.set(color, c);
  return c;
}
// The screen-space vignette is static per canvas size — cache the gradient
// instead of rebuilding it every frame.
let vigCache: { w: number; h: number; g: CanvasGradient } | null = null;

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
  const ver = useRef<string | null>(null); // B6: last-seen graph version (304 probe)
  const fitted = useRef(false);
  const prevCount = useRef(0);
  const dirtyUntil = useRef(0);
  const pulses = useRef<Map<string, number>>(new Map());
  const births = useRef<Map<string, number>>(new Map()); // node id → first-seen ts (bloom-in)
  const pops = useRef(new Map<string, { ax: number; ay: number; ang: number; t0: number; tx?: number; ty?: number }>()); // pop-out tweens (tx/ty = settled destination when known)

  // ── 🕰️ timelapse — serial-based, not time-based ──────────────────────
  // The cosmos replays in the order neurons were born (the snapshot arrives
  // ordered by created_at). cut = how many of the first N nodes to show;
  // null → live full graph. Pure client-side slicing: no fetches, no clocks.
  const [cut, setCut] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<number | null>(null); // rAF handle
  const prevVisible = useRef<Set<string>>(new Set());
  const prevLinkKeys = useRef<Set<string>>(new Set()); // visible synapses last frame (grow-in tracking)
  const linkBirths = useRef<Map<string, number>>(new Map()); // "a|b" → first-visible ts
  const linkPulses = useRef<Map<string, number>>(new Map()); // "a|b" → recall-pulse ts (AI used this synapse)
  const dataRef = useRef<GData>({ nodes: [], links: [] }); // latest snapshot for once-registered handlers

  // ── C10: idle sleep ─────────────────────────────────────────────────────
  // cooldownTime=Infinity keeps the engine repainting at 60fps forever (the
  // starfield). When NOTHING is animating and the sim has physically settled,
  // pauseAnimation() drops the canvas to 0fps — zero CPU/GPU while idle.
  // wake() on any interaction/event; the 500ms watcher below both puts it to
  // sleep and revives it (self-healing if a wake() was somehow missed).
  const asleep = useRef(false);
  const lastActivity = useRef(Date.now()); // boot grace: never sleeps instantly
  const lastPos = useRef<Float64Array | null>(null); // node x/y sampler (settle detection)
  const hoverRef = useRef<string | null>(null); // hover state readable from the watcher

  const wake = () => {
    lastActivity.current = Date.now();
    if (asleep.current) {
      asleep.current = false;
      fgRef.current?.resumeAnimation?.();
    }
  };
  /** Anything animating right now? (self-cleaning maps can only drain while painting) */
  const anyAnimating = () =>
    pulses.current.size > 0 ||
    births.current.size > 0 ||
    pops.current.size > 0 ||
    linkBirths.current.size > 0 ||
    linkPulses.current.size > 0 ||
    dimMap.current.size > 0 ||
    linkFx.current.size > 0 ||
    hoverRef.current !== null ||
    playRef.current !== null;
  /** Has the cosmos physically moved since the last sample? (sim settle detection) */
  const moved = () => {
    const ns = dataRef.current.nodes;
    let lp = lastPos.current;
    if (!lp || lp.length !== ns.length * 2) {
      lp = new Float64Array(ns.length * 2);
      lastPos.current = lp;
      for (let i = 0; i < ns.length; i++) {
        lp[i * 2] = ns[i].x ?? 0;
        lp[i * 2 + 1] = ns[i].y ?? 0;
      }
      return true; // layout changed shape — treat as movement
    }
    let sum = 0;
    for (let i = 0; i < ns.length; i++) {
      const x = ns[i].x ?? 0;
      const y = ns[i].y ?? 0;
      sum += Math.abs(x - lp[i * 2]) + Math.abs(y - lp[i * 2 + 1]);
      lp[i * 2] = x;
      lp[i * 2 + 1] = y;
    }
    return sum > 0.75; // total drift (px) across the whole cosmos per 500ms
  };

  const stopPlay = () => {
    if (playRef.current !== null) cancelAnimationFrame(playRef.current);
    playRef.current = null;
    setPlaying(false);
  };

  // Continuous reveal: rAF advances a fractional cut so neurons enter ONE at a
  // time (~130ms each) instead of N/60 bursts — that's what makes it read as
  // growth rather than chunks. setCut only re-renders when the integer changes.
  const play = () => {
    wake();
    if (playing) return stopPlay();
    const total = data.nodes.length;
    if (total < 2) return;
    setPlaying(true);
    const t0 = performance.now();
    const dur = Math.min(Math.max(total * 280, 3500), 30000);
    const tick = () => {
      const p = (performance.now() - t0) / dur;
      if (p >= 1) {
        stopPlay();
        setCut(null); // land back on the live graph
        return;
      }
      setCut(1 + Math.floor(p * (total - 1)));
      playRef.current = requestAnimationFrame(tick);
    };
    playRef.current = requestAnimationFrame(tick);
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
    const now = performance.now();
    // The timelapse OWNS its entrances: every newly revealed neuron kicks in
    // from a visible parent — even though it already holds a settled position
    // from the live layout (that spot becomes the tween's destination, so the
    // pop reads as growth, not a teleport). Live-path entries are load()'s job.
    if (cut !== null) {
      for (const n of nodes) {
        if (prevVisible.current.has(n.id)) continue;
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
        if (anchor && Number.isFinite(anchor.x)) {
          // 🎆 spawn pinned AT the parent; the per-frame tween eases it to its
          // settled spot with an easeOutBack overshoot, then releases to physics
          const settled =
            Number.isFinite(n.x) && Number.isFinite(n.y) ? { tx: n.x as number, ty: n.y as number } : {};
          n.x = anchor.x as number;
          n.y = anchor.y ?? 0;
          n.fx = n.x;
          n.fy = n.y;
          pops.current.set(n.id, { ax: n.x, ay: n.y, ang: Math.random() * Math.PI * 2, t0: now, ...settled });
        }
        // no visible parent (first neuron / island): births above blooms it in place
      }
      // synapses grow in alongside their neuron — track first visibility per link
      for (const l of data.links) {
        const a = idOf(l.source);
        const b = idOf(l.target);
        if (!visible.has(a) || !visible.has(b)) continue;
        const k = `${a}|${b}`;
        if (!prevLinkKeys.current.has(k)) linkBirths.current.set(k, now);
      }
      // no reheat here — reheating on every entry pins the sim at full boil;
      // the running sim settles released nodes gently on its own
    }
    prevVisible.current = visible;
    const links = data.links.filter((l) => visible.has(idOf(l.source)) && visible.has(idOf(l.target)));
    prevLinkKeys.current = new Set(links.map((l) => `${idOf(l.source)}|${idOf(l.target)}`));
    return { nodes, links };
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
      // B6: send the last-seen version — 304 means the graph is unchanged,
      // keep the cosmos exactly as-is (skip parse + signature + merge).
      const q = ver.current ? `?v=${encodeURIComponent(ver.current)}` : "";
      const r = await fetch(`/api/graph${q}`, { cache: "no-store" });
      if (r.status === 304) return;
      const d = (await r.json()) as GData;
      ver.current = r.headers.get("X-Graph-Version") ?? ver.current;
      const nextSig =
        d.nodes
          .map((n) => `${n.id}:${n.name}:${n.type}:${n.pinned ? 1 : 0}:${n.mention_count ?? 0}`)
          .sort()
          .join("|") +
        "##" +
        d.links.map((l) => `${idOf(l.source)}>${idOf(l.target)}:${l.type}`).sort().join("|");
      if (nextSig === sig.current) return;
      sig.current = nextSig;
      wake(); // data actually changed — births/pops/physics are coming
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
      wake();
      dirtyUntil.current = Date.now() + 8000;
      load();
    };
    const onRecalled = (e: Event) => {
      wake(); // pulses/linkPulses below must be able to animate
      // Chat.tsx dispatches detail = the id ARRAY itself (not { ids }) — the
      // old detail?.ids read silently yielded [] and pulses never fired at all
      const d = (e as CustomEvent).detail;
      const ids: string[] = Array.isArray(d) ? d : (d?.ids ?? []);
      const now = performance.now();
      const s = new Set(ids);
      // the pinned profile is ALWAYS in the system prompt though excluded from
      // the recall list (buildContext) — it earns a pulse on every reply, so
      // profile-sourced answers (family.father etc.) still light the sun
      for (const n of dataRef.current.nodes) if (n.pinned) s.add(n.id);
      s.forEach((id) => pulses.current.set(id, now));
      // light the synapses BETWEEN lit neurons — both endpoints recalled means
      // the model connected them to build this reply
      for (const l of dataRef.current.links) {
        const a = idOf(l.source);
        const b = idOf(l.target);
        if (s.has(a) && s.has(b)) linkPulses.current.set(`${a}|${b}`, now);
      }
    };
    // reply-grounded glow: any neuron the reply TEXT names lights up, recall
    // or not — honest grounding for answers sourced from profile attrs
    const onReply = (e: Event) => {
      wake();
      const text = String((e as CustomEvent).detail ?? "").toLowerCase();
      if (!text) return;
      const now = performance.now();
      const s = new Set<string>();
      for (const n of dataRef.current.nodes) {
        if (n.pinned || (n.name.length >= 3 && text.includes(n.name.toLowerCase()))) s.add(n.id);
      }
      s.forEach((id) => pulses.current.set(id, now));
      for (const l of dataRef.current.links) {
        const a = idOf(l.source);
        const b = idOf(l.target);
        if (s.has(a) && s.has(b)) linkPulses.current.set(`${a}|${b}`, now);
      }
    };
    window.addEventListener("sanctum:dirty", onDirty);
    window.addEventListener("sanctum:recalled", onRecalled);
    window.addEventListener("sanctum:reply", onReply);
    const t = setInterval(() => {
      if (Date.now() < dirtyUntil.current) load();
    }, 2000);
    return () => {
      window.removeEventListener("sanctum:dirty", onDirty);
      window.removeEventListener("sanctum:recalled", onRecalled);
      window.removeEventListener("sanctum:reply", onReply);
      clearInterval(t);
      if (playRef.current !== null) cancelAnimationFrame(playRef.current);
    };
  }, []);

  // C10 watcher: sleep when settled + idle; revive if anything wakes up.
  useEffect(() => {
    const t = setInterval(() => {
      const fg = fgRef.current;
      if (!fg) return;
      const busyView = Date.now() - lastActivity.current < 800 || anyAnimating() || moved();
      if (!busyView && !asleep.current) {
        asleep.current = true;
        fg.pauseAnimation?.();
      } else if (busyView && asleep.current) {
        asleep.current = false;
        fg.resumeAnimation?.();
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fit on first load; gently reheat + refit when the brain grows
  useEffect(() => {
    dataRef.current = data;
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
        cooldownTime={Infinity}
        // ^ never let the render engine cool off. With the default cooldown the
        // canvas simply STOPS painting between state changes — that's what made
        // the timelapse (and the starfield) jump instead of animate smoothly.
        enableNodeDrag
        onNodeDrag={() => wake()}
        onZoom={() => wake()}
        onNodeDragEnd={(n: any) => {
          wake();
          delete n.fx; // release → the live sim bounces it back into the disc
          delete n.fy;
          fgRef.current?.d3ReheatSimulation?.();
        }}
        onNodeClick={(n: any) => {
          wake();
          inspect(n as GNode);
        }}
        onBackgroundClick={() => {
          wake();
          setSelected(null);
        }}
        // ── cosmic backdrop: twinkling stars + vignette (screen space) ──
        onRenderFramePre={(ctx: CanvasRenderingContext2D) => {
          const w = ctx.canvas.width;
          const h = ctx.canvas.height;
          // C10: twinkle stepped at ~30Hz — imperceptible vs 60, halves phase churn
          const now = Math.floor(performance.now() / 33.4) * 0.0334;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          for (const s of STARS) {
            const a = 0.12 + 0.14 * (0.5 + 0.5 * Math.sin(now * s.s + s.p));
            ctx.fillStyle = `rgba(200,210,255,${a.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
            ctx.fill();
          }
          if (!vigCache || vigCache.w !== w || vigCache.h !== h) {
            const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.75);
            vg.addColorStop(0, "rgba(5,5,15,0)");
            vg.addColorStop(1, "rgba(0,0,5,0.55)");
            vigCache = { w, h, g: vg };
          }
          ctx.fillStyle = vigCache.g;
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
            const p = Math.min(1, (performance.now() - pop.t0) / 1150);
            const e = 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2); // easeOutBack (overshoot)
            // known destination (timelapse): lerp parent → settled spot;
            // fresh live entry: legacy 90px ray in a random direction
            const tx = pop.tx ?? pop.ax + Math.cos(pop.ang) * 90;
            const ty = pop.ty ?? pop.ay + Math.sin(pop.ang) * 90;
            n.x = n.fx = pop.ax + (tx - pop.ax) * e;
            n.y = n.fy = pop.ay + (ty - pop.ay) * e;
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
          const birthF = tB === undefined ? 1 : Math.min(1, (performance.now() - tB) / 1300);
          if (birthF >= 1 && tB !== undefined) births.current.delete(n.id);
          const eB = 1 - Math.pow(1 - birthF, 3);
          // pop kick: easeOutBack overshoot on the RADIUS (alpha stays easeOutCubic)
          const eK = 1 + 2.70158 * Math.pow(birthF - 1, 3) + 1.70158 * Math.pow(birthF - 1, 2);

          // halo — C11: prerendered per-color sprite, alpha-modulated blit
          // (replaces a per-node per-frame createRadialGradient alloc)
          const haloR = r * (2.1 + 2.6 * boost) * eK;
          const sprite = haloSprite(color);
          if (sprite) {
            ctx.globalAlpha = mix(boost > 0 ? 0.55 : 0.1, 0.028, dimF) * eB;
            ctx.drawImage(sprite, n.x - haloR, n.y - haloR, haloR * 2, haloR * 2);
            ctx.globalAlpha = 1;
          }

          // core
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * (1 + 0.5 * boost) * eK, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${(mix(1, 0.14, dimF) * eB).toFixed(3)})`;
          ctx.fill();
          // white-hot heart while the pulse is strong — the "glow" read
          if (boost > 0.05) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, r * 0.55 * eK, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${(0.55 * boost).toFixed(3)})`;
            ctx.fill();
          }

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
        onNodeHover={(n: any) => {
          const id = n ? (n as GNode).id : null;
          hoverRef.current = id;
          setHover(id);
          wake(); // hover drives dim/linkFx lerps — must be painting
        }}
        linkColor={(l: any) => {
          const a = idOf(l.source);
          const b = idOf(l.target);
          const target = hover === null ? 0 : a === hover || b === hover ? 1 : -1;
          const v = lerpTo(linkFx.current, `${a}|${b}`, target, 0.16);
          // grow-in: synapses revealed by the timelapse fade/widen over ~0.6s
          const kb = linkBirths.current.get(`${a}|${b}`);
          const kf = kb === undefined ? 1 : Math.min(1, (performance.now() - kb) / 950);
          if (kb !== undefined && kf >= 1) linkBirths.current.delete(`${a}|${b}`);
          // 🧠 recall pulse: the AI just used this synapse — bright glow, eased PULSE_MS fade
          const pt = linkPulses.current.get(`${a}|${b}`);
          const praw = pt !== undefined ? Math.max(0, 1 - (performance.now() - pt) / PULSE_MS) : 0;
          const pb = praw * praw;
          if (pt !== undefined && praw <= 0) linkPulses.current.delete(`${a}|${b}`);
          const lit = Math.max(v, pb); // pulse overrides hover-dim
          return v >= 0 || pb > 0.02
            ? // ease slate → lit indigo
              `rgba(${Math.round(mix(148, 196, lit))},${Math.round(mix(163, 181, lit))},${Math.round(
                mix(184, 255, lit)
              )},${(Math.min(0.95, mix(0.22, 0.6, lit) + pb * 0.3) * kf).toFixed(3)})`
            : // ease toward background
              `rgba(148,163,184,${(mix(0.22, 0.05, -v) * kf).toFixed(3)})`;
        }}
        linkWidth={(l: any) => {
          const k = `${idOf(l.source)}|${idOf(l.target)}`;
          const v = linkFx.current.get(k) ?? 0;
          const kb = linkBirths.current.get(k);
          const kf = kb === undefined ? 1 : 0.3 + 0.7 * Math.min(1, (performance.now() - kb) / 950);
          const pt = linkPulses.current.get(k);
          const praw = pt !== undefined ? Math.max(0, 1 - (performance.now() - pt) / PULSE_MS) : 0;
          return (v > 0 ? 1 + v * 0.5 : 1) * kf * (1 + praw * praw * 0.9); // pulses thicken hard
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
              wake();
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
              onClick={() => {
                wake();
                setCut(null);
              }}
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
