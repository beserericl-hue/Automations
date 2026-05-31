---
name: Writers Workbench Wiki — schema
description: Schema and conventions for this Obsidian-backed wiki. Skills like /challenge-obsidian and /save-obsidian read this file to know how the vault is structured.
type: schema
last_reviewed: 2026-05-09
---

# Writers Workbench Wiki — schema

This is an LLM-maintained wiki for this project. All content lives under `Engineering/`.

## Page types

- `overview` — system / domain synthesis. Read first.
- `concept` — a topic worth its own page (synthesizable, multi-source).
- `source` — summary of an external document (paper, article, transcript) we've ingested.
- `entity` — a named org / framework / tool that recurs.
- `comparison` — comparing two or more frameworks / approaches / sources.
- `glossary` — domain terms.
- `schema` — this file.

Customize the list per your project's actual content. Skills read this file at runtime, so changes here change skill behavior.

## Frontmatter

Every content page has YAML frontmatter:

```yaml
---
name: <Page Title>
description: <one line — used to find this page later, be specific>
type: <one of the types above>
tags: [<tag1>, <tag2>]
last_reviewed: YYYY-MM-DD
---
```

## Filename convention

`kebab-case.md`. Wikilinks resolve by basename. Avoid duplicate basenames across folders.

## Cross-references

Use `[[basename]]` Obsidian wikilinks, not relative markdown paths.

## Source citations

When a claim is sourced from outside the vault, cite it inline as `[[source-page-name]]` or for code repos, `<repo>/path/file:line`.

## Log format

`log.md` is append-only. Entries:

```
## [YYYY-MM-DD] <action> | <subject>
```

Action verbs: `ingest`, `query`, `lint`, `update`, `build`, `setup`.

## Workflow conventions

- Update `index.md` whenever a new page is added or removed.
- Append a `log.md` entry whenever the vault is meaningfully modified.
- Don't write generic content; this wiki is about *this* project's specifics.

## Hard rules

- Never invent file paths or facts. If unsure, leave a TBD.
- Never delete pages without confirming.
