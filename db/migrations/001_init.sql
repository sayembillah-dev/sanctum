-- 001_init — Sanctum memory graph (auto-applied by scripts/migrate.mjs)
create extension if not exists vector;

create table if not exists dumps (
  id uuid primary key default gen_random_uuid(),
  raw_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists nodes (
  id uuid primary key default gen_random_uuid(),
  type text not null,                 -- soft-typed: agent mints new types (see brain/types.md)
  name text not null,
  attrs jsonb not null default '{}',
  embedding vector(1536),             -- text-embedding-3-large @ 1536 dims
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists edges (
  id uuid primary key default gen_random_uuid(),
  src_id uuid not null references nodes(id) on delete cascade,
  dst_id uuid not null references nodes(id) on delete cascade,
  type text not null,                 -- said / owns / works_on / part_of / due_by / mentions / related_to
  attrs jsonb not null default '{}',
  said_on date,                       -- temporality: when was this stated
  valid_from date,                    -- temporality: fact became true
  valid_to date,                      -- temporality: fact stopped being true (null = current)
  source_dump_id uuid references dumps(id),  -- provenance: cite your sources
  created_at timestamptz not null default now()
);

create index if not exists nodes_name_idx on nodes (lower(name));
create index if not exists nodes_type_idx on nodes (type);
create index if not exists edges_src_idx on edges (src_id);
create index if not exists edges_dst_idx on edges (dst_id);

-- After real data exists, add semantic search:
-- create index nodes_embedding_hnsw on nodes using hnsw (embedding vector_cosine_ops);
