/**
 * 🪞 lib/mirror.ts — the "file over app" durability layer.
 *
 * Postgres is a rebuildable INDEX; dumps are the source of truth. This module
 * makes that truth survive the app itself:
 *
 *   mirrorDump() — write-through: every dump lands in mirror/dumps/YYYY-MM-DD.md
 *                  (local-time day files) the moment it persists. Idempotent via
 *                  an HTML-comment marker carrying the dump id.
 *   buildVault() — full regeneration from the DB: dumps + every node as an
 *                  Obsidian-ready note (frontmatter + [[wiki links]] for edges),
 *                  forgotten nodes in graveyard/, and a 00 - Sanctum.md map of
 *                  content. Opens straight in Obsidian; also heals stale files.
 *   zipVault()   — the mirror folder as one downloadable archive.
 *
 * Root: SANCTUM_MIRROR_DIR env, default <cwd>/mirror (gitignored).
 * NOTE: durable on the self-hosted/local run — serverless disks are ephemeral,
 * so on Vercel only the zip download survives.
 *
 * (The turbopackIgnore comments keep dynamic fs paths out of the serverless
 * output trace — otherwise the whole project gets bundled into the routes.)
 */
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { prisma } from "./db";

export const MIRROR_ROOT =
  process.env.SANCTUM_MIRROR_DIR?.trim() || path.join(process.cwd(), "mirror");

// Serialize ALL mirror work (appends + full rebuilds) through one in-process
// queue: a dump landing mid-export can never be wiped by it, and two same-day
// appends can't interleave. buildVault enqueues its DB reads too, so any dump
// committed before the build starts is guaranteed to be included in it.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`; // local
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null); // @db.Date cols

/** Filesystem- and Obsidian-safe note title (filename stem + [[link]] target).
 *  Strips what Windows forbids AND what breaks wiki links (# ^ [ ]). */
export function slug(name: string): string {
  const s = name
    .replace(/[<>:"/\\|?*#^[\]\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, "") // Windows: no trailing dots/spaces
    .trim();
  if (!s) return "untitled";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s) ? `~${s}` : s; // Windows reserved names
}

let enabledCache: { v: boolean; at: number } | null = null;

/** Opt-in write-through switch (app_state key "mirror_enabled"); default OFF.
 *  Cached 5s so a stretch inserting many dumps doesn't re-read the row each
 *  time. buildVault/zipVault are NOT gated -- an explicit export always works. */
async function mirrorEnabled(): Promise<boolean> {
  if (enabledCache && Date.now() - enabledCache.at < 5000) return enabledCache.v;
  let v = false;
  try {
    const row = await prisma.appState.findUnique({ where: { key: "mirror_enabled" } });
    v = row?.value === true;
  } catch {
    v = false; // DB hiccup = off; the dump itself is never affected
  }
  enabledCache = { v, at: Date.now() };
  return v;
}

/**
 * Append one dump to its day file. Idempotent — the dump-id marker is checked
 * before writing, so re-extractions and retries never double up. Callers
 * fire-and-forget with .catch: a mirror hiccup must never fail a memory write.
 */
export async function mirrorDump(d: { id: string; raw_text: string; created_at: Date | string }) {
  return enqueue(async () => {
    if (!(await mirrorEnabled())) return; // opt-in: off unless the user turns it on
    const file = path.join(/*turbopackIgnore: true*/ MIRROR_ROOT, "dumps", `${dayOf(new Date(d.created_at))}.md`);
    const marker = `<!-- sanctum:dump:${d.id} -->`;
    const existing = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8").catch(() => null);
    if (existing?.includes(marker)) return;
    const block =
      (existing === null ? `# ${dayOf(new Date(d.created_at))}\n\n` : "") +
      `## ${timeOf(new Date(d.created_at))}\n${marker}\n\n${d.raw_text.trim()}\n\n---\n\n`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(/*turbopackIgnore: true*/ file, block, "utf8");
  });
}

type DumpRow = { id: string; raw_text: string; created_at: Date };
type EdgeRow = {
  src_id: string;
  dst_id: string;
  type: string;
  said_on: Date | null;
  valid_from: Date | null;
  valid_to: Date | null;
};

export type VaultStats = {
  dir: string;
  dumps: number;
  days: number;
  nodes: number;
  forgotten: number;
  edges: number;
  removed: number;
};

/**
 * Regenerate the whole mirror from the DB:
 *   dumps/YYYY-MM-DD.md — every raw dump, chronological (THE source of truth)
 *   nodes/<Type>/<Name>.md — live nodes, edges rendered as [[wiki links]]
 *   graveyard/<Name>.md — forgotten nodes (soft-deleted history)
 *   00 - Sanctum.md — map of content: stats, type index, dump days
 * Files from earlier runs that this build didn't write are removed (renames,
 * forgets, emptied days) — after a build, disk == DB.
 */
export async function buildVault(): Promise<VaultStats> {
  return enqueue(async () => {
    const [dumps, nodes, edges] = await Promise.all([
      prisma.dump.findMany({
        orderBy: { created_at: "asc" },
        select: { id: true, raw_text: true, created_at: true },
      }),
      prisma.node.findMany({
        orderBy: { created_at: "asc" },
        select: {
          id: true,
          type: true,
          name: true,
          attrs: true,
          pinned: true,
          mention_count: true,
          created_at: true,
          updated_at: true,
          valid_to: true,
        },
      }),
      prisma.edge.findMany({
        orderBy: { created_at: "asc" },
        select: {
          src_id: true,
          dst_id: true,
          type: true,
          said_on: true,
          valid_from: true,
          valid_to: true,
        },
      }),
    ]);

    const written = new Set<string>(); // rel paths (forward slashes) written this build
    const writeRel = async (rel: string, content: string) => {
      const p = path.join(/*turbopackIgnore: true*/ MIRROR_ROOT, rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(/*turbopackIgnore: true*/ p, content, "utf8");
      written.add(rel);
    };

    // Wiki links resolve by basename in Obsidian — one unique stem per node.
    const stemById = new Map<string, string>();
    const taken = new Map<string, string>(); // lower(stem) → node id
    for (const n of nodes) {
      let stem = slug(n.name);
      const clash = taken.get(stem.toLowerCase());
      if (clash && clash !== n.id) stem = `${slug(n.name)}-${n.id.slice(0, 6)}`;
      taken.set(stem.toLowerCase(), n.id);
      stemById.set(n.id, stem);
    }
    const link = (id: string) => `[[${stemById.get(id) ?? "missing"}]]`;

    // ── dumps/ — the source of truth, chronological day files ──
    const byDay = new Map<string, DumpRow[]>();
    for (const d of dumps) {
      const day = dayOf(d.created_at);
      const arr = byDay.get(day) ?? [];
      arr.push(d);
      byDay.set(day, arr);
    }
    for (const [day, list] of byDay) {
      const body = list
        .map((d) => `## ${timeOf(d.created_at)}\n<!-- sanctum:dump:${d.id} -->\n\n${d.raw_text.trim()}`)
        .join("\n\n---\n\n");
      await writeRel(`dumps/${day}.md`, `# ${day}\n\n${body}\n`);
    }

    // ── nodes/ + graveyard/ — the graph as linked notes ──
    const outBy = new Map<string, EdgeRow[]>();
    const inBy = new Map<string, EdgeRow[]>();
    for (const e of edges) {
      outBy.set(e.src_id, [...(outBy.get(e.src_id) ?? []), e]);
      inBy.set(e.dst_id, [...(inBy.get(e.dst_id) ?? []), e]);
    }

    for (const n of nodes) {
      const stem = stemById.get(n.id)!;
      const self = `**${n.name.replace(/\*\*/g, "")}**`; // bold, never a link (this note)
      const triple = (e: EdgeRow, outgoing: boolean, live: boolean) => {
        const other = link(outgoing ? e.dst_id : e.src_id);
        const core = outgoing ? `${self} —${e.type}→ ${other}` : `${other} —${e.type}→ ${self}`;
        const said = e.said_on ? ` _(said ${dateOnly(e.said_on)})_` : "";
        const until = !live && e.valid_to ? ` _(until ${dateOnly(e.valid_to)})_` : "";
        return `- ${live ? core : `~~${core}~~`}${said}${until}`;
      };
      const out = outBy.get(n.id) ?? [];
      const inc = inBy.get(n.id) ?? [];
      const liveLines = [
        ...out.filter((e) => !e.valid_to).map((e) => triple(e, true, true)),
        ...inc.filter((e) => !e.valid_to).map((e) => triple(e, false, true)),
      ];
      const histLines = [
        ...out.filter((e) => e.valid_to).map((e) => triple(e, true, false)),
        ...inc.filter((e) => e.valid_to).map((e) => triple(e, false, false)),
      ];

      const attrs = (n.attrs ?? {}) as Record<string, unknown>;
      const body = [
        [
          "---",
          `name: ${JSON.stringify(n.name)}`,
          `type: ${JSON.stringify(n.type)}`,
          `created: ${n.created_at.toISOString()}`,
          `updated: ${n.updated_at.toISOString()}`,
          `mentions: ${n.mention_count}`,
          ...(n.pinned ? ["pinned: true"] : []),
          ...(n.valid_to ? [`forgotten: ${dateOnly(n.valid_to)}`] : []),
          "---",
        ].join("\n"),
        "",
        `# ${n.name}`,
        "",
        ...(Object.keys(attrs).length
          ? ["## Attrs", "", "```json", JSON.stringify(attrs, null, 2), "```", ""]
          : []),
        ...(liveLines.length ? ["## Synapses", "", ...liveLines, ""] : []),
        ...(histLines.length ? ["## History", "", ...histLines, ""] : []),
      ].join("\n");

      const folder = n.valid_to ? "graveyard" : `nodes/${slug(n.type)}`;
      await writeRel(`${folder}/${stem}.md`, body + "\n");
    }

    // ── 00 - Sanctum.md — the map of content ──
    const liveNodes = nodes.filter((n) => !n.valid_to);
    const byType = new Map<string, string[]>();
    for (const n of liveNodes) {
      const arr = byType.get(n.type) ?? [];
      arr.push(stemById.get(n.id)!);
      byType.set(n.type, arr);
    }
    const typeSections = [...byType.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(
        ([t, stems]) =>
          `- **${t}** (${stems.length}): ${stems
            .slice(0, 40)
            .map((s) => `[[${s}]]`)
            .join(" · ")}${stems.length > 40 ? ` · …and ${stems.length - 40} more` : ""}`
      );
    const dayLinks = [...byDay.entries()].map(
      ([day, list]) => `- [[${day}]] — ${list.length} dump${list.length === 1 ? "" : "s"}`
    );
    const moc = `# 00 - Sanctum

> **This vault is a mirror of your Sanctum brain** — regenerated ${new Date().toISOString()}.
> Open it in Obsidian (or any markdown reader); nothing here needs Sanctum to run.
>
> - \`dumps/\` — every raw dump, chronological. **The source of truth.** If the app dies, the whole graph can be rebuilt from these files alone.
> - \`nodes/\` — the live memory graph, one note per node, edges as [[wiki links]].
> - \`graveyard/\` — forgotten nodes (soft-deleted history).
>
> Regenerate: \`GET /api/admin/export?format=vault\` (admin) — also downloads a zip.
> Full JSON backup (adds feedback + chat messages): \`GET /api/admin/export\`.

## Stats
- **${dumps.length}** dumps across **${byDay.size}** day${byDay.size === 1 ? "" : "s"}
- **${liveNodes.length}** live nodes · **${nodes.length - liveNodes.length}** forgotten
- **${edges.filter((e) => !e.valid_to).length}** active synapses · **${
      edges.filter((e) => e.valid_to).length
    }** historical

## Node types
${typeSections.join("\n") || "(none yet)"}

## Dump days
${dayLinks.join("\n") || "(none yet)"}
`;
    await writeRel("00 - Sanctum.md", moc);

    // Remove files from earlier runs that this build didn't write (renamed or
    // forgotten nodes, emptied day files), then prune emptied folders.
    let removed = 0;
    const sweep = async (rel: string): Promise<void> => {
      const abs = path.join(/*turbopackIgnore: true*/ MIRROR_ROOT, rel);
      const entries = await fs
        .readdir(/*turbopackIgnore: true*/ abs, { withFileTypes: true })
        .catch(() => null);
      if (!entries) return;
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await sweep(r);
        } else if (!written.has(r)) {
          await fs.rm(path.join(/*turbopackIgnore: true*/ MIRROR_ROOT, r), { force: true });
          removed++;
        }
      }
      if (rel) {
        const rest = await fs.readdir(/*turbopackIgnore: true*/ abs).catch(() => null);
        if (rest && rest.length === 0) await fs.rmdir(/*turbopackIgnore: true*/ abs);
      }
    };
    await sweep("");

    return {
      dir: MIRROR_ROOT,
      dumps: dumps.length,
      days: byDay.size,
      nodes: liveNodes.length,
      forgotten: nodes.length - liveNodes.length,
      edges: edges.length,
      removed,
    };
  });
}

/** The mirror folder as a single zip archive — the portable "my brain" file. */
export async function zipVault(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(/*turbopackIgnore: true*/ MIRROR_ROOT, rel);
    const entries = await fs
      .readdir(/*turbopackIgnore: true*/ abs, { withFileTypes: true })
      .catch(() => null);
    if (!entries) return;
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else zip.file(r, await fs.readFile(/*turbopackIgnore: true*/ path.join(abs, e.name)));
    }
  };
  await walk("");
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}
