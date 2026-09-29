create extension if not exists pgcrypto;

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  given_name text not null,
  surname text,
  aliases text[] not null default '{}',
  sex text check (sex in ('M','F','U')) default 'U',
  birth_year integer,
  death_year integer,
  notes text,
  source text,
  source_ref text,
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists relationships (
  id uuid primary key default gen_random_uuid(),
  from_person_id uuid not null references people(id) on delete cascade,
  to_person_id uuid not null references people(id) on delete cascade,
  relationship_type text not null check (relationship_type in ('parent','spouse')),
  status text not null default 'approved' check (status in ('pending','approved','rejected')),
  source text,
  evidence text,
  proposed_by text,
  reviewed_by text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create unique index if not exists uq_relationship on relationships(from_person_id,to_person_id,relationship_type);

create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('add_person','edit_person','delete_person','add_relationship','delete_relationship')),
  payload jsonb not null,
  token_label text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text
);

create table if not exists token_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists idx_token_attempts_ip_time on token_attempts(ip, attempted_at);

create table if not exists access_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text unique not null,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  body text not null,
  source_note text,
  updated_at timestamptz not null default now()
);

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete cascade,
  author_name text not null,
  body text not null,
  token_label text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb,
  actor text,
  created_at timestamptz not null default now()
);

create index if not exists idx_people_names on people(lower(given_name), lower(surname));
create index if not exists idx_rel_from on relationships(from_person_id);
create index if not exists idx_rel_to on relationships(to_person_id);
create index if not exists idx_proposals_status on proposals(status, submitted_at desc);
create index if not exists idx_comments_article_status on comments(article_id,status,created_at);
