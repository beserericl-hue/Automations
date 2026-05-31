---
name: Database index
description: Catalog of database pages — schemas, tables, migrations, RLS, relationships.
type: index
last_reviewed: 2026-05-09
---

# Database

- [[prod-database]] — PROD Supabase configuration, applied migrations, current state.
- [[dev-database]] — DEV Supabase configuration, applied migrations (often ahead of PROD).
- [[base-tables]] — the 9 immutable base tables + meta-table extension pattern.
- [[migrations]] — full migration list 001-017, what each does, when applied per tier.
- [[rls-policies]] — RLS function, policy templates, public-read tables, service-role bypass rules.
- [[data-relationships]] — entity FK graph, cascades, orphan risks.
