-- 009_perf2 — round-2 index batch (additive only; auto-applied by scripts/migrate.mjs)

-- recentNodes / graphSnapshot / weeklyRecap order by created_at over live nodes
create index if not exists nodes_created_live_idx
  on nodes (created_at desc) where valid_to is null;

-- openLoops + listTasks filter lower(type) = 'task' on EVERY chat message — was a seq scan
create index if not exists nodes_type_lower_live_idx
  on nodes (lower(type)) where valid_to is null;

-- weeklyRecap's edge count window
create index if not exists edges_created_idx on edges (created_at desc);

-- previousSession (session-start healing) orders sessions by created_at
create index if not exists chat_sessions_created_idx on chat_sessions (created_at desc);
