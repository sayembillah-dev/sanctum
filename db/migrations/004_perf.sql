-- 004_perf — retrieval speed + integrity (auto-applied by scripts/migrate.mjs)

-- 1) HNSW index for cosine semantic search.
--    Commented out since 001 → every searchNodes/findNode/dupeCandidates did a
--    full sequential scan over nodes. (pgvector >= 0.5; 1536 dims < 2000 HNSW cap)
create index if not exists nodes_embedding_hnsw
  on nodes using hnsw (embedding vector_cosine_ops);

-- 2) Close redundant duplicate active edges (keep the oldest) so uniqueness can be enforced.
with ranked as (
  select id,
         row_number() over (partition by src_id, dst_id, type order by created_at asc) as rn
  from edges
  where valid_to is null
)
update edges e
set valid_to = current_date
from ranked r
where e.id = r.id and r.rn > 1;

-- 3) One active edge per (src, dst, type) — dedupe enforced by the DB itself.
--    Concurrent extractions (chat silent-write + dump) can no longer double-insert;
--    lib/graph.ts createEdge uses INSERT … ON CONFLICT DO NOTHING against this index.
create unique index if not exists edges_unique_active
  on edges (src_id, dst_id, type)
  where valid_to is null;

-- 4) Normalized-name lookup: matches the regexp_replace expression in findNode/resolveNode
--    (regexp_replace is IMMUTABLE → expression index allowed; partial predicate matches
--    the queries' "and valid_to is null").
create index if not exists nodes_name_norm_idx
  on nodes (regexp_replace(lower(name), '[^a-z0-9]+', '', 'g'))
  where valid_to is null;

-- 5) Active-edge adjacency — 1-hop neighborhood reads, closeEdges, forgetNode.
create index if not exists edges_src_active_idx on edges (src_id) where valid_to is null;
create index if not exists edges_dst_active_idx on edges (dst_id) where valid_to is null;
