# Schema Governance

**Status:** Mandatory. Enforced by CI on every PR.

## The rule

The seven **base tables** of the V2 Supabase schema are immutable once released. No feature may `ALTER`, `DROP`, or otherwise mutate their shape. Features that need to extend a base entity create a **meta table** with a foreign key to the base row.

This rule makes blue-green database cutovers (spinning up a new Supabase project per release cycle) tractable: base rows can be cloned verbatim, while meta tables travel with the release branch that introduced them.

## The seven base tables

Defined in `/supabase_setup_v2.sql`:

1. `users_v2`
2. `writing_projects_v2`
3. `published_content_v2`
4. `story_bible_v2`
5. `research_reports_v2`
6. `genre_config_v2`
7. `story_arcs_v2`

Two derived tables (`content_versions_v2`, `outline_versions_v2`) are also base — history tables bound to the lifecycle of their parent. They are covered by the immutability rule but are not counted separately in the seven.

## What is forbidden

In any migration file **numbered 008 or higher**, on any of the seven base tables (or `content_versions_v2` / `outline_versions_v2`):

- `ALTER TABLE ... ADD COLUMN`
- `ALTER TABLE ... DROP COLUMN`
- `ALTER TABLE ... RENAME ...`
- `ALTER TABLE ... ALTER COLUMN ...`
- `DROP TABLE ...`
- `DROP INDEX ...` on indexes that belong to the base tables
- `CREATE OR REPLACE` on triggers, policies, or functions that the base tables depend on

In migrations **001–007**: these files are frozen. Any change to their byte contents after the baseline commit fails CI. If you need to fix a real bug in one of them, you write a new migration that compensates — you do not edit the original.

## What is allowed

- New tables in any migration from 008 onward.
- `ALTER`/`DROP` on tables you introduced in the same release cycle (i.e., in migrations you yourself are adding).
- Indexes, triggers, policies on your new tables.
- Data-only `INSERT` / `UPDATE` / `DELETE` that does not change schema shape — though prefer seeding code in the application layer where possible.

## The meta-table pattern

When a feature needs a new attribute on a base entity, add a sibling table rather than a column.

### Good

```sql
-- migrations/012_user_subscription_tier.sql
CREATE TABLE IF NOT EXISTS user_subscription_tier_v2 (
    user_id     uuid PRIMARY KEY REFERENCES users_v2(id) ON DELETE CASCADE,
    tier        text NOT NULL CHECK (tier IN ('free','pro','studio')),
    started_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz
);
```

The relationship is one-to-one, keyed on the base PK, and the lifecycle is tied to the user via `ON DELETE CASCADE`. The base table is untouched.

### Bad

```sql
-- migrations/012_user_subscription_tier.sql  -- ❌ violates governance
ALTER TABLE users_v2 ADD COLUMN subscription_tier text;
ALTER TABLE users_v2 ADD COLUMN subscription_started_at timestamptz;
```

CI rejects this PR.

## The genuinely-new-attribute-on-base case

Sometimes a change really is a permanent, universal property of a base entity — not a feature-scoped extension. Example: you decide every `writing_projects_v2` row needs a `language_code` column forever.

This is a **base-schema revision**, not a migration. The procedure:

1. Propose it in a dedicated ADR / design doc that explains why it cannot live in a meta table.
2. If approved, it is a **release event**: a new Supabase project is generated, `supabase_setup_v2.sql` is edited to include the new column, data is migrated from the old project, and the old project is retired per the blue-green schedule.
3. The migration series does **not** get an `ALTER` statement — the new column is present from the first write in the new project.

In practice, meta tables are almost always the right answer.

## How migrations are classified

- `001_*.sql` through `007_*.sql` — **baseline, frozen**. Byte-identical to the release commit.
- `008_*.sql` and above — **additive**. May create new tables, indexes, functions. May not touch the base tables.

## CI enforcement

`scripts/check-base-table-immutability.py` runs as a required check on every PR:

1. Parses each file in `writers-workbench/migrations/`.
2. For files numbered ≥ 008, flags any statement that targets a base table with a forbidden operation.
3. For files 001–007, compares each file's current SHA-256 to the baseline recorded in `writers-workbench/migrations/.baseline-hashes.json`. Drift fails CI.

Violations are reported with file, line number, and the specific statement.

## If this rule gets in the way

It means one of two things:

- You are adding a feature-scoped attribute and should be writing a meta table. Do that.
- You have a genuine base-schema revision. Stop coding, write the ADR, schedule the release event.

Do **not** disable the CI check, edit the baseline hashes, or split a forbidden change across multiple migrations to evade detection. The rule exists so release cutovers remain a mechanical clone rather than a manual reconciliation.

## References

- `CLAUDE.md` — three-tier baseline protection
- `writers-workbench/docs/workflow-governance.md` — the parallel rule for n8n workflows
- `writers-workbench/sprint_document_v2.md` Sprint 10.a — the sprint that established this rule
