-- 006_chat_sessions — conversation titles (Hermes X5: two-stage generation)
-- Stage 1: an instant deterministic slice of the first user message lands BEFORE
-- any model call — even a failed first reply leaves a named session.
-- Stage 2: once the conversation has substance, a small LLM call upgrades it.
-- Provenance ranks protect titles: derived < llm < user (a manual rename would
-- never be overwritten by either generator).

create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  title text,
  title_source text not null default 'derived',  -- derived | llm | user
  created_at timestamptz not null default now()
);

-- backfill the current session (stored in app_state as a jsonb string) so it
-- can receive a title too
insert into chat_sessions (id)
select (value #>> '{}')::uuid
from app_state
where key = 'current_session' and jsonb_typeof(value) = 'string'
on conflict do nothing;
