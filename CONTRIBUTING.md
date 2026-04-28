# Contributing Guide

## Branching Model

This repository uses Git Flow with two long-lived branches.

| Branch | Purpose | Deploys To |
|--------|---------|-----------|
| `main` | Production baseline. Tagged releases (`v1.0.0`, `v1.1.0`, etc.) | Production Railway |
| `develop` | Active integration branch for all new work | Development Railway |

### Branch Types

- **`feature/<name>`** — new features, non-urgent bug fixes. Branch from `develop`, PR to `develop`.
- **`hotfix/<name>`** — urgent production fixes. Branch from `main`, PR to `main`, then cherry-pick to `develop`.
- **`release/vX.Y`** — release candidates. Branch from `develop`, PR to `main`, then tag.

---

## Workflows

### Feature Work (most common)

```bash
git checkout develop
git pull
git checkout -b feature/my-feature

# ... do work, commit ...

git push -u origin feature/my-feature
gh pr create --base develop --title "..." --body "..."
# After CI passes and optional review: merge
```

### Hotfix (urgent production bug)

```bash
git checkout main
git pull
git checkout -b hotfix/my-fix

# ... fix and commit ...

git push -u origin hotfix/my-fix
gh pr create --base main --title "Hotfix: ..." --body "..."
# After CI passes and approval: merge
# Then cherry-pick to develop:
git checkout develop
git pull
git cherry-pick <merge-commit-sha>
git push
```

### Release (promote develop to main)

```bash
git checkout develop
git pull
git checkout -b release/vX.Y

# ... final QA, update SESSION_CONTEXT.md with release notes ...

git push -u origin release/vX.Y
gh pr create --base main --title "Release vX.Y.0 — ..." --body "..."
# After CI passes: merge

# Tag on main:
git checkout main
git pull
git tag -a vX.Y.0 -m "Description"
git push origin vX.Y.0
# The Release workflow auto-creates the GitHub Release from the tag

# Sync main back to develop:
git checkout develop
git merge main
git push
```

---

## Pull Request Requirements

All PRs must pass:
- `TypeScript & Lint` — `tsc --noEmit` clean for client and server
- `Unit Tests` — all vitest tests passing
- `Production Build` — `npm run build` succeeds
- `E2E Tests (Chromium)` — Playwright tests pass (only runs on PRs)

PRs to `main` additionally require:
- Explicit approval (branch protection enforces this)
- Branch up to date with base before merge

Do not skip CI. Do not use `--no-verify` on commits.

---

## Commit Conventions

No strict format required, but keep messages short, imperative, and descriptive:

```
Good:  Add atomic save_chapter_outline RPC to prevent JSONB race
Good:  Fix stale chunk errors after deploys
Bad:   fixed stuff
Bad:   WIP
```

For multi-line messages, put the summary on line 1 (max ~70 chars), blank line, then details.

---

## Never Commit

- `.env`, `.env.local` — secrets
- `.mcp.json` — contains API keys
- `.DS_Store` — macOS cruft
- `node_modules/`, `dist/`, `public/` — build artifacts
- Any file containing an API key, JWT, password, or service-role secret

If GitHub's secret scanner blocks a push, do NOT bypass it. Remove the secret from the file, rotate the exposed credential, and amend the commit.

---

## Environment Setup

See [writers-workbench/.env.example](writers-workbench/.env.example) for required environment variables.

```bash
cd writers-workbench
npm install
cp .env.example .env
# Fill in .env with real values
npm run dev   # starts client (5173) + server (3001)
npm run test  # runs all unit tests
```

---

## Questions?

- Architecture: [writers-workbench/SESSION_CONTEXT.md](writers-workbench/SESSION_CONTEXT.md)
- Sprint backlog: [writers-workbench/sprint_document.md](writers-workbench/sprint_document.md)
- Project rules: [CLAUDE.md](CLAUDE.md)
