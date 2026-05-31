---
name: Backend index
description: Catalog of backend pages — Express routes, middleware, job queue, SSE, email, ingestion, newsletter.
type: index
last_reviewed: 2026-05-09
---

# Backend

- [[express-routes]] — every Express route by file. Auth, schema, side effects.
- [[middleware]] — auth, error handler, shared-secret factory, validation.
- [[job-queue]] — BullMQ topology + worker behavior + per-user concurrency + tracker.
- [[classifier-and-priority]] — message classifier rule book.
- [[session-and-sse]] — session-store (Redis) + sse-pubsub + EventSource flow.
- [[email-pipeline]] — Postal client + rate-limit + bounce handling.
- [[ingestion-routes]] — newsletter ingestion shared-secret API.
- [[newsletter-backend]] — newsletter routes, render, approval tokens, generate, cron callback.
