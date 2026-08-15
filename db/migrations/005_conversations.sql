-- 005_conversations — server-side conversation persistence
-- Chat history lived only in React state: refresh lost the thread, and the
-- digest cadence counted whatever array the client happened to send (fragile,
-- double-fires on retry). Now messages persist per session; cadence is a
-- deterministic DB count, and the client rehydrates on load.

-- key-value app state (single-user prototype): holds the current session id
create table if not exists app_state (
  key text primary key,
  value jsonb not null
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  role text not null,               -- 'user' | 'assistant'
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_idx on chat_messages (session_id, created_at);
