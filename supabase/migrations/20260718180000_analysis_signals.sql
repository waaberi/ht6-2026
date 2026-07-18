alter table public.analyses
  add column if not exists signals jsonb not null default '[]'::jsonb;

comment on column public.analyses.signals is
  'Stable machine-readable measurements; user-facing findings are generated separately by the semantic model.';
