-- Esquema del portal en Supabase (Postgres). Ejecutar UNA vez en: SQL Editor > New query > Run.
-- Usar un proyecto SOLO para el portal (no el de las skills de ISO).

create table if not exists tokens (
  id bigint generated always as identity primary key,
  name text not null,
  role text not null default 'user' check (role in ('user','admin')),
  token_hash text not null unique,
  token_hint text not null,
  daily_limit integer not null default 50,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists sessions (
  id_hash text primary key,
  token_id bigint not null references tokens(id) on delete cascade,
  created_at bigint not null,
  last_seen bigint not null
);

-- Registro de ejecuciones: NUNCA guarda el token ni el contenido de entradas/respuestas.
create table if not exists runs (
  id bigint generated always as identity primary key,
  token_id bigint references tokens(id) on delete set null,
  user_name text not null,
  task text not null,
  status text not null,
  error_code text,
  input_chars integer not null default 0,
  output_chars integer not null default 0,
  duration_ms integer not null default 0,
  cost_usd double precision,
  created_at timestamptz not null default now()
);
create index if not exists idx_runs_token_day on runs(token_id, created_at);

-- Catálogo de skills sincronizado desde Git. Una skill nueva nace DESACTIVADA.
create table if not exists skills (
  name text primary key,
  description text not null default '',
  enabled integer not null default 0,
  allow_scripts integer not null default 0,  -- 0 bloqueados, 1 aislados (sandbox), 2 restringidos
  has_scripts integer not null default 0,
  present integer not null default 1,
  commit_sha text,
  first_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Archivos generados por skills; solo los puede descargar quien ejecutó la tarea.
create table if not exists run_files (
  id bigint generated always as identity primary key,
  run_id text not null,
  token_id bigint references tokens(id) on delete cascade,
  name text not null,
  size bigint not null,
  created_at bigint not null
);
create index if not exists idx_run_files_run on run_files(run_id);

create table if not exists kv (key text primary key, value text not null);

-- SEGURIDAD: activar RLS sin políticas = nadie puede leer/escribir con la clave pública (anon).
-- Solo el servidor, con la clave de servicio (service_role), accede a estas tablas.
alter table tokens enable row level security;
alter table sessions enable row level security;
alter table runs enable row level security;
alter table skills enable row level security;
alter table run_files enable row level security;
alter table kv enable row level security;
revoke all on tokens, sessions, runs, skills, run_files, kv from anon, authenticated;

-- Bucket privado para adjuntos y resultados (se crea desde SQL; también se puede crear en Storage > New bucket, sin marcar "Public").
insert into storage.buckets (id, name, public) values ('portal-files', 'portal-files', false)
on conflict (id) do nothing;
