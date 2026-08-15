-- 003_grows_with_you — adaptive memory ("the more you chat, the better it gets")
-- Salience: memories strengthen with use, fade without. Pinning: the user's profile
-- node never decays and is always in context. Feedback: reply ratings feed consolidation.
alter table nodes add column if not exists mention_count int not null default 1;
alter table nodes add column if not exists last_recalled_at timestamptz;
alter table nodes add column if not exists recall_used_count int not null default 0;
alter table nodes add column if not exists pinned boolean not null default false;

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  rating smallint not null,            -- +1 = good reply, -1 = bad reply
  user_msg text not null,              -- the prompt that produced it
  assistant_msg text not null,         -- the reply being rated
  created_at timestamptz not null default now()
);

create index if not exists nodes_pinned_idx on nodes (pinned) where pinned;
create index if not exists feedback_created_idx on feedback (created_at desc);
