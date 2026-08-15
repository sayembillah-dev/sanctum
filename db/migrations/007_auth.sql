-- 007_auth.sql — better-auth core tables + isAdmin flag (Phase 1: gate the app).
-- User/session data lives in OUR Postgres (Neon), next to the brain — no
-- external auth provider. DDL stays SQL-owned; prisma/schema.prisma mirrors it.
-- better-auth generates row ids itself (text PKs, no uuid default here).

create table if not exists "user" (
  id              text primary key,
  name            text not null,
  email           text not null unique,
  "emailVerified" boolean not null default false,
  image           text,
  "isAdmin"       boolean not null default false,  -- first account ever = admin (set by hook, not by client)
  "createdAt"     timestamptz not null default now(),
  "updatedAt"     timestamptz not null default now()
);

create table if not exists session (
  id          text primary key,
  "expiresAt" timestamptz not null,
  token       text not null unique,
  "ipAddress" text,
  "userAgent" text,
  "userId"    text not null references "user"(id) on delete cascade,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists session_user_idx on session ("userId");

create table if not exists account (
  id                      text primary key,
  "accountId"             text not null,
  "providerId"            text not null,
  "userId"                text not null references "user"(id) on delete cascade,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope                   text,
  password                text,  -- hashed credential (better-auth owns hashing)
  "createdAt"             timestamptz not null default now(),
  "updatedAt"             timestamptz not null default now()
);
create index if not exists account_user_idx on account ("userId");

create table if not exists verification (
  id          text primary key,
  identifier  text not null,
  value       text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
