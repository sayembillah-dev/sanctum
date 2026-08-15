-- 008_session_sweeps — fact-sweep bookkeeping per session.
-- swept_count = how many persisted messages extraction has already covered.
-- Lets a NEW session heal the previous session's unswept tail (sessions that
-- ended below the 12-msg digest cadence without a clear-chat sweep used to
-- strand every fact the remember tool skipped).

alter table chat_sessions add column if not exists swept_count int not null default 0;
