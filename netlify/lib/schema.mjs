// Additive, idempotent migrations. Nothing here deletes or rewrites people or relationships.
export const BASE_SQL = `
create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
`;

export const MIGRATIONS = [
  {
    version: '002_heritage_platform',
    sql: `
alter table people add column if not exists birth_date date;
alter table people add column if not exists death_date date;
alter table people add column if not exists birth_place text;
alter table people add column if not exists occupation text;
alter table people add column if not exists location text;
alter table people add column if not exists living_status text;
alter table people add column if not exists updated_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'people_living_status_check') then
    alter table people add constraint people_living_status_check
      check (living_status is null or living_status in ('living','deceased','unknown'));
  end if;
  if exists (select 1 from pg_constraint where conname = 'people_sex_check'
             and pg_get_constraintdef(oid) not like '%''O''%') then
    alter table people drop constraint people_sex_check;
    alter table people add constraint people_sex_check check (sex in ('M','F','O','U'));
  end if;
end $$;

create table if not exists images (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('person','story')),
  ref_id uuid,
  content_type text not null,
  size_bytes integer not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_images_ref on images(kind, ref_id);

create table if not exists token_person_links (
  token_id uuid primary key references access_tokens(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  linked_at timestamptz not null default now()
);
create unique index if not exists uq_token_person_links_person on token_person_links(person_id);

create table if not exists profiles (
  person_id uuid primary key references people(id) on delete cascade,
  about text not null default '',
  published boolean not null default true,
  updated_by_token uuid references access_tokens(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists stories (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  token_id uuid references access_tokens(id) on delete set null,
  title text not null,
  content text not null,
  cover_image_id uuid references images(id) on delete set null,
  status text not null default 'published' check (status in ('published','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_stories_person on stories(person_id, created_at desc);
create index if not exists idx_stories_status on stories(status, created_at desc);

create table if not exists business_ideas (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  token_id uuid references access_tokens(id) on delete set null,
  title text not null,
  description text not null,
  category text,
  location text,
  funding_needed text,
  skills_needed text,
  website text,
  status text not null default 'active' check (status in ('active','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ideas_status on business_ideas(status, created_at desc);
create index if not exists idx_ideas_category on business_ideas(lower(category));
create index if not exists idx_ideas_title on business_ideas(lower(title));

create table if not exists business_interests (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references business_ideas(id) on delete cascade,
  token_id uuid not null references access_tokens(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  contact_method text not null check (contact_method in ('email','phone','whatsapp','other')),
  contact_value text not null,
  created_at timestamptz not null default now(),
  unique (idea_id, token_id)
);
create index if not exists idx_interest_idea on business_interests(idea_id);

create index if not exists idx_people_given on people(lower(given_name));
create index if not exists idx_people_surname on people(lower(surname));
create index if not exists idx_people_occupation on people(lower(occupation));
create index if not exists idx_people_birth_place on people(lower(birth_place));
create index if not exists idx_people_location on people(lower(location));
create index if not exists idx_people_aliases on people using gin (aliases);
create index if not exists idx_comments_status on comments(status, created_at desc);
create index if not exists idx_tokens_active on access_tokens(active);
`,
  },
  {
    version: '003_hardening',
    sql: `
alter table images add column if not exists token_id uuid references access_tokens(id) on delete set null;
create index if not exists idx_images_token on images(token_id, created_at) where kind = 'story';

alter table people add column if not exists kind text not null default 'person';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'people_kind_check') then
    alter table people add constraint people_kind_check check (kind in ('person','placeholder','place'));
  end if;
end $$;
update people set kind = 'placeholder' where kind = 'person' and given_name ~* '^unknown( |$)';
update people set kind = 'place' where kind = 'person' and lower(given_name) = 'oda aboho' and lower(coalesce(surname,'')) = 'sacred rock';

create table if not exists person_revisions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  token_label text,
  actor text not null default 'contributor',
  action text not null default 'edit',
  before jsonb not null,
  after jsonb not null,
  reverted_of uuid references person_revisions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rev_person on person_revisions(person_id, created_at desc);
create index if not exists idx_rev_created on person_revisions(created_at desc);
create index if not exists idx_attempts_time on token_attempts(attempted_at);
`,
  },
  {
    version: '004_features',
    sql: `
create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text unique not null,
  person_id uuid references people(id) on delete cascade,
  label text,
  expires_at timestamptz not null,
  used_at timestamptz,
  token_id uuid references access_tokens(id) on delete set null,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_invites_person on invites(person_id);
create index if not exists idx_proposals_pending on proposals(action, status);
`,
  },
];
