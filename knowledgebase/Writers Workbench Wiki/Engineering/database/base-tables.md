---
name: Base tables (immutable)
description: The 9 base tables, what they contain, and the meta-table extension pattern that's the only way to add attributes.
type: concept
tags: [database, governance, schema]
last_reviewed: 2026-05-09
---

# Base tables

Defined in `writers-workbench/supabase_setup_v2.sql`. **Immutable** in any migration ≥008. See `writers-workbench/docs/schema-governance.md` for the rule + enforcement.

## The seven named base tables

### `users_v2`

Root entity. Cascades EVERYTHING on user deletion.

```
user_id              text PRIMARY KEY      -- E.164 phone number
display_name         text
email                text
recipient_email      text
bcc_email            text
role                 text DEFAULT 'user' CHECK (role IN ('user','admin','viewer'))   -- legacy; superuser lives in user_role_meta_v2
preferences          jsonb                  -- legacy admin storage; now superseded
supabase_auth_uid    uuid                   -- link to auth.users.id
created_at           timestamptz DEFAULT now()
deleted_at           timestamptz            -- soft delete (Sprint 1)
```

### `writing_projects_v2`

Functional root. The concept around which all work revolves.

```
id                    uuid PK DEFAULT gen_random_uuid()
user_id               text NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE
title                 text NOT NULL
genre_slug            text                   -- soft ref to genre_config_v2.slug (no FK)
project_type          text                   -- 'story' | 'series' | 'kindle_book' | …
status                text                   -- 'draft' | 'in-progress' | 'paused' | 'complete'
outline               jsonb DEFAULT '{}'     -- chapters, characters, _scanner_exclusions, _character_drift_scan, themes, etc.
chapter_count         int DEFAULT 0
created_at, updated_at, deleted_at
```

`outline` JSONB shape is convention-only (no schema enforcement). Common keys:
- `chapters: [{number, title, summary, sub_chapters?, chapter_outline?}]`
- `characters: [{name, role, description, age, name_variants?, traits?}]`
- `themes: string[]`
- `premise: string`
- `_scanner_exclusions: string[]` — per-project drift-scanner exemptions (Sprint 12 S12-12)
- `_character_drift_scan: {scanned_at, results, scanner_algorithm}` — latest scan output

### `published_content_v2`

All authored content (chapters, blog posts, newsletters, short stories, social posts).

```
id                  uuid PK
user_id             text NOT NULL FK
project_id          uuid REFERENCES writing_projects_v2(id) ON DELETE SET NULL  -- post-Sprint 1 fix
chapter_number      int                    -- 0=Prologue, 999=Epilogue, normal otherwise
content_type        text NOT NULL CHECK (content_type IN ('chapter','short_story','blog_post','newsletter','social_post'))
title               text
content_text        text                   -- THE BODY. Not "content".
content_html        text                   -- optional pre-rendered HTML
status              text DEFAULT 'draft' CHECK (status IN ('draft','approved','published','rejected','scheduled'))
genre_slug          text
metadata            jsonb DEFAULT '{}'     -- {schedule_date, last_rewrite, qa_report, dismissed_annotations, genre_eval, …}
cover_image_path    text                   -- supabase storage path
created_at, updated_at, deleted_at
```

`metadata` is feature stash:
- `schedule_date` — for `status='scheduled'`
- `qa_report` — chapter QA chain results
- `genre_eval` — Sprint 12 S12-11 evaluator output
- `dismissed_annotations` — array of annotation IDs the user dismissed
- `last_rewrite` — `{research_report_id, rewritten_at, citations_in_prose}`

### `story_bible_v2`

Characters / events / items / locations per project.

```
id              uuid PK
user_id         text FK
project_id      uuid REFERENCES writing_projects_v2(id) ON DELETE CASCADE
entry_type      text CHECK (entry_type IN ('character','event','item','location','organization','plot_thread'))
name            text NOT NULL
description     text
metadata        jsonb DEFAULT '{}'         -- entry_type-specific (e.g. character: {age, role}; event: {chapter_number, when})
created_at, updated_at, deleted_at
```

Populated by `extract_bible_*` chain in Worker - Write Chapter (Sprint 12 hotfix 2026-04-29). Deduped via `(entry_type, lower(name))`. See [[chapter-writer-architecture]].

### `research_reports_v2`

Perplexity-generated research summaries.

```
id              uuid PK
user_id         text FK
project_id      uuid REFERENCES writing_projects_v2(id) ON DELETE SET NULL
topic           text NOT NULL
genre_slug      text
content_text    text
metadata        jsonb DEFAULT '{}'
created_at, updated_at, deleted_at
```

### `genre_config_v2`

Genre presets — public + private.

```
id                  uuid PK
user_id             text FK (or NULL for public)
slug                text NOT NULL
name                text
description         text
prompt_text         text
research_topics     text[]
genre_urls          text[]                 -- RSS feeds for newsletter ingestion (migration 013)
is_public           boolean DEFAULT false
created_at, updated_at, deleted_at
```

8 active public genres: post-apocalyptic, political-scifi, historical-time-travel, ai-marketing, political-history, ancient-history, metaphysical-romance, scifi-romance.

### `story_arcs_v2`

Named outline frameworks (Freytags Pyramid, Three-Act, Hero's Journey, etc.).

```
id                    uuid PK
user_id               text FK (or NULL for public)
name                  text NOT NULL
description           text
prompt_text           text NOT NULL
discovery_question    text                 -- Eve asks before brainstorming
is_public             boolean DEFAULT false
created_at, updated_at, deleted_at
```

8 public arcs: Freytags Pyramid, Three-Act Structure, Hero's Journey, Dan Harmon's Story Circle, In Medias Res, Seven-Point Structure, Kishōtenketsu, Fichtean Curve.

## The two derived base tables

### `content_versions_v2`

Manual snapshots before destructive content edits.

```
id              uuid PK
content_id      uuid REFERENCES published_content_v2(id) ON DELETE CASCADE
user_id         text
version_number  int
content_text    text
changed_by      text                       -- 'user' | 'annotation_apply' | 'auto'
change_note     text                       -- e.g. 'annotation_apply:drift_scan:5'
created_at      timestamptz DEFAULT now()
```

### `outline_versions_v2`

Auto-snapshot of `writing_projects_v2.outline` via Postgres trigger `trg_snapshot_outline` (Sprint 3, migration 003).

```
id              uuid PK
project_id      uuid REFERENCES writing_projects_v2(id) ON DELETE CASCADE
user_id         text
version_number  int
outline         jsonb
created_at      timestamptz
```

## The meta-table pattern

When a feature needs new attributes on a base entity, add a sibling table with FK:

```sql
-- migrations/011_sprint8_rbac_subscriptions.sql excerpt:
CREATE TABLE IF NOT EXISTS user_role_meta_v2 (
    user_id  text PRIMARY KEY REFERENCES users_v2(user_id) ON DELETE CASCADE,
    role     text NOT NULL CHECK (role IN ('admin','superuser')),
    granted_by text REFERENCES users_v2(user_id),
    granted_at timestamptz DEFAULT now()
);
```

PK on the FK column means a 1:1 relation; no row = base default.

Meta tables in current PROD schema:
- `user_role_meta_v2` (Sprint 8)
- `user_account_meta_v2` (Sprint 8)
- `subscription_tiers` (Sprint 8 — semi-meta, public catalog)
- `user_subscriptions` (Sprint 8)
- `credit_transactions` (Sprint 8)
- `impersonation_log` (Sprint 8)
- `job_queue_v2` (Sprint 10b-2)
- `email_bounces_v2` (Sprint 11)
- `content_ingestion_v2` (Sprint S2 newsletter migration)
- `newsletter_approvals_v2` (same)
- `newsletter_sends_v2` (same)
- `newsletter_editions_v2` (DEV only — Sprint S3 newsletter)
- `newsletter_templates_v2` (DEV only)
- `newsletter_feed_sources_v2` (DEV only — multi-user newsletters)
- `newsletter_ingestion_runs_v2` (DEV only)
- `newsletter_subscribers_v2` (DEV only)
- `token_usage_v2` (Sprint 5)

## What is forbidden

In any migration ≥008, on a base table:
- `ALTER TABLE ... ADD COLUMN`
- `ALTER TABLE ... DROP COLUMN`
- `ALTER TABLE ... RENAME ...`
- `ALTER TABLE ... ALTER COLUMN ...`
- `DROP TABLE ...`
- `DROP INDEX ...` on indexes the base table depends on
- `CREATE OR REPLACE` on triggers/policies/functions the base table depends on

In migrations 001-007: any byte change fails CI.

## What is allowed

- New tables (any number) referencing base tables via FK.
- `ALTER`/`DROP` on tables introduced in the same migration / release cycle.
- Indexes, triggers, policies on new tables.
- Data DML (`INSERT`/`UPDATE`/`DELETE`) — though prefer application-layer seeding.

See [[migrations]] for the full migration log.
