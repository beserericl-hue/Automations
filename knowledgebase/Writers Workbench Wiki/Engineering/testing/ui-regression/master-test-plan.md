---
name: Master UI test plan — every page, button, PASS + FAIL criteria
description: The authoritative run-after-every-sprint matrix. Every page/route, every interactive element, its expected result, explicit PASS criteria, explicit FAIL criteria, and the covering result-asserting test + status (GREEN / PENDING / role-gated).
type: reference
last_reviewed: 2026-07-02
---

# Master UI test plan

Rule: every test asserts the **real produced result** — the DOM shows the real output (never a spinner /
empty state / "no data") **AND** the backing DB row/field actually changed (queried via the DEV Supabase REST
in [`e2e/pages/api.ts`](../../../../../writers-workbench/e2e/pages/api.ts)); async actions poll to completion
first. Every test is data-isolated (seed disposable row → assert → hard-delete) and pinned to demo user
`+14105914612`. **Status legend:** 🟢 GREEN = result-asserting test passing on DEV · 🟡 PENDING = no test
yet · 🔒 ROLE-GATED = needs an elevated (admin/superuser) test account.

## Authoritative run — 2026-07-02 (develop @ `c9d7d99`, DEV Railway)

Runner: [`e2e/run-regression.sh`](../../../../../writers-workbench/e2e/run-regression.sh) (two-pass, `retries=2`).

| Pass | Specs | Tests | Result |
|---|---|---|---|
| A — light (DB/render/fast API) @ workers=3 | 33 | 145 | **145 passed** (2 flaky → green on retry) |
| B — heavy engine/LLM/image jobs @ workers=1 | 7 | 26 | **26 passed** |
| C — sign-out (isolated session) | 1 | 2 | **2 passed** |
| **Total** | **41** | **173** | **173 passed · 0 failed** |

The 2 flaky = `topbar` search-nav + `newsletter` `?edition=` deep-link — both concurrency-timing races that
pass on retry (each retry re-runs the *full* result-assert; no assertion is weakened). Heavy Pass B needed no
retries. Reproduce: `set -a; source e2e/.env.e2e; set +a; bash e2e/run-regression.sh`.

### App bugs the result-asserting bar caught + fixed (click-only tests missed all of these)
`import-from-genre` 500 (broken upsert) · CSV subscriber import 500 (broken upsert) · new editions had no
default template · newsletter had no **Preview** button · per-chapter **artwork missing** + book cover never
set `project_id` → Art tab always empty · VersionHistory stale-cache after save · BrainstormForm auto-match
race · **chapter cover picker listed every user image (no `projectId` scope)** — swapped in another project's
cover. All fixed on `develop`.

---

## 1. Newsletter Setup Wizard — `/newsletter/editions/:id/setup` · `newsletter-wizard.spec.ts` 🟢
| Element | Expected result | PASS | FAIL |
|---|---|---|---|
| "Copy N feeds from `<genre>`" | imports genre feeds | "N feeds attached" > 0 AND `newsletter_feed_sources_v2` rows exist | count 0 / no rows / 500 |
| Template step preview | renders default template | iframe `srcdoc` > 100 AND default `newsletter_templates_v2` row exists | blank / "no default template" |
| Subscriber "Add" | creates subscriber | `newsletter_subscribers_v2` row for edition+email; "Added ✓" | no row |
| Done step | completion | "All set" + "Generate now →" + "Back" visible | missing buttons |

## 2. Newsletter editions list — `/newsletter/editions` · `newsletter-wizard` + `newsletter-crud` + `newsletter` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| **Preview** (per row) | modal renders default template | dialog opens; iframe `srcdoc` > 100 | no dialog / blank |
| New newsletter / EditionEditor Save | create edition | `newsletter_editions_v2` row w/ display_name+genre (+ default template seeded) | missing row |
| Disable / Re-enable | toggle `enabled` | `newsletter_editions_v2.enabled` flips false↔true in DB | no flip |
| Show disabled | include disabled | disabled editions appear when checked | not shown |

## 3. EditionEditor — `/newsletter/editions/new` + `/:id` · `newsletter-crud` + `newsletter` 🟢 (LogoUploader 🟡)
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Save (create/edit) | insert/update edition | row + all field values persisted in DB | missing/stale |
| Feeds add / SubscribersPanel | mutate rows | `newsletter_feed_sources_v2` + `newsletter_subscribers_v2` rows | no row |
| LogoUploader | upload/remove logo | `stamp_url` set/cleared | 🟡 no test |

## 4. Newsletter Generate / Templates / Feeds / Approvals / Sends · `newsletter-generate` + `-templates` + `-feeds` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Generate "Preview template" | modal HTML | iframe `srcdoc` > 100 | blank |
| Generate submit | start execution | navigates `/newsletter/execution/:id`; execution starts | no execution |
| Generate `?edition=` deep-link | preselect edition | select value === param | ignored |
| TemplateEditor Save (POST/PUT) + Render preview | persist + preview | `newsletter_templates_v2` row created/updated; preview iframe HTML > 100 | no row / blank |
| TemplateEditor Import HTML / Default+Active | replace HTML / flags | source textarea replaced (script stripped); `active`/`is_default` persist | unchanged |
| FeedEditor Pause/Resume / Edit / Delete | mutate feed | `active` flips; edit persists; delete removes row | no change |
| ScheduledSends filters + detail | filter + HTML | list narrows; NewsletterDetail iframe = stored html; Markdown toggle reveals `<pre>` | blank |
| Approvals Approve / Revise | resolve gate | seeded approval → Approve resolves in DB; Revise persists decision=revise (feedback required) | no transition |
| HelpButtons (generate/sends/approvals/feeds/templates) | open/close | slide-over opens then closes | stuck |

## 5. ProjectDetail — `/projects/:id` (tabs) · `project-detail*` + `project-tabs` + `project-export` + `project-art` + `project-plan-write` + `content-repair` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| **Export → Download .docx** | KDP doc | download fires; file > 2 KB; `.docx` | no download / tiny |
| **Generate Cover Art** (Outline) | book cover | `generated_images_v2` row (cover_art, project_id set) + Art thumbnail | no row / project_id null |
| **Generate Art** (per chapter) | chapter art | `generated_images_v2` row (chapter_art, project_id) + Art thumbnail | no row / Art empty |
| **Outline** (chapter.plan) | persist outline | `outline.chapters[N].chapter_outline` gains sub-chapters | queued forever / no change |
| **Write / Rewrite** (chapter.write) | write chapter | `published_content_v2` chapter content_text > 200 words | no content |
| **Fix Drift** (chapter.repair) | repair aligns QA | fresh `chapter_qa_v2` row `aligned=true` | drift persists |
| **Rewrite with research** | repair job | `content_text` changes | no change |
| Tabs: Overview/Outline/Bible/Social/Research/Cost | render + interact | each tab's content renders; expanders/filters/Copy work | tab blank |
| Social Copy | copy post | clipboard has post text (from `social_posts_v2`) | empty |
| Edit Save / Delete Project | update / soft-delete | title persisted / `deleted_at` set + nav to /projects | stale / no delete |

## 6. ContentDetail — `/content/:id` · `content-detail*` + `content-editor` + `content-qa` + `content-lifecycle` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Approve/Publish/Reject/Back-to-Draft/Schedule/Unschedule/Unpublish | status transition | `published_content_v2.status` on the exact row → expected; UI advances | wrong/no change |
| **Run Q/A** | consistency report | after job, `metadata.qa_report.checks` exists (incl. consistency/drift) AND report DISPLAYS | empty / no checks |
| VersionHistory View/Restore/Compare | restore + diff | Restore sets `content_text` == chosen version + new snapshot; Compare gated <2 | unchanged |
| Editor Save + Version History | persist + snapshot | `content_text` persisted + `content_versions_v2` row; History lists it | not saved |
| **Cover image picker** | set/swap/remove cover | `cover_image_path` set to a **seeded project image**, then cleared | wrong image / unchanged |
| Editor toolbar (Bold/Italic/Strike/H1-3/lists/quote/HR/Undo/Redo/Save) | format + persist | each wraps selection in the right tag AND persists content_text | no format / not saved |
| Provenance / Sources toggle | expand | shows sources or the empty state | crash |
| AnnotationsPanel Apply Fix | replace target text | `content_text` includes the fix; annotation clears | 🟡 no test |

## 7. Dashboard / ProjectList · `dashboard.spec.ts` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| StatCards | counts | Projects/Research counts == DB | wrong/blank |
| Project row | open | `/projects/:id` renders | dead |

## 8. Content Library — `/library` · `library-full` + `library-bulk` + `library` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Type/Status/Genre/Project filters | narrow list (+`?type=`) | rows filter; URL param set | no effect |
| Sort headers (Title/Type/Status/Updated) | reorder | sort indicator toggles | no change |
| Clear filters / page-size select | reset / paginate | list resets; row count changes | no effect |
| Bulk Approve / Publish / Delete | mutate selected | selected rows → approved/published/`deleted_at` in DB | no change |
| Row click / select | open / bulk bar | `/content/:id` / toolbar appears | dead |

## 9. Reference — story-arcs / genres / story-bible / brainstorm / research / outlines / sources / cost · `*-crud` + `reference-*` + `brainstorm-submit` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Story Arc / Genre / Story Bible create + edit + delete | CRUD | row inserted → updated → removed/soft-deleted (DB-verified) | no DB change |
| Brainstorm Analyze → Submit | gate + create | Analyze gated by content; Submit creates `writing_projects_v2` row | broken |
| Outlines list | list + link | outlined project appears in `/outlines` (main region) and links to it | missing |
| Research open/delete | read + soft-delete | open detail; delete sets `deleted_at` | no change |
| Sources / Cost | filters + analytics | type filters + range buttons render real content | crash |

## 10. Account / Auth — settings / credits · `settings-result` + `credits` 🟢 (onboarding/pwd 🟡)
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Settings Save | persist email cfg | `app_config_v2` recipient_email persisted (save/restore) | stale |
| Theme toggle | flip theme | `<html>.dark` toggles both directions | stuck |
| Phone + auth email | present, disabled | rendered read-only by design | editable |
| Credits balance | == API | page balance == `/api/credits` | mismatch |
| Onboarding / Update Password | create user / change pwd | user+subscription row / success | 🟡 no test (needs fresh user) |

## 11. Images / Eve voice widget · `images-gallery` + `image-detail` + `eve-voice-widget` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Eve "Talk to Eve" widget | mount ConvAI | `<elevenlabs-convai>` with agent-id + user dynamic-var | not mounted |
| ImageGallery Type filter | filter | 2 seeded images → filter narrows to 1 | no filter |
| ImageDetail render / Download / Regenerate | show + download + gate | image + metadata render; download event fires; Regenerate gated on prompt | blank / no download |

## 12. Global chrome — TopBar / Sidebar / ChatDrawer / Nav · `topbar` + `sidebar` + `chat-drawer` + `nav-render` + `topbar-signout` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| TopBar Search / Cmd+K / result nav | open + navigate | panel opens; searching a seeded project navigates to `/projects/:id` | no nav |
| TopBar Dark-mode / Chat / User menu / Breadcrumb | toggle + navigate | theme flips; ChatDrawer opens; Settings link → /settings; Home → / | dead |
| Sidebar Collapse / section expanders / sub-link / EveOrb close | toggle + navigate | width changes; sections expand; project sub-link → `/projects/:id`; widget hides | stuck |
| ChatDrawer send / Quick Commands / Clear / Close | send + manage | user bubble renders AND POST `/api/chat/proxy` fires; clear/close work | no send |
| All routes render + self-guard | no crash | every route renders; guarded routes show in-page gate | crash / blank |
| User menu → Sign out | logout | redirects to `/login`, session revoked | stays in |

## 13. Trash — `/trash` · `trash.spec.ts` 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Restore → confirm | un-delete | `deleted_at` cleared in DB; row leaves trash | still deleted |

## 14. Admin / Superuser — `/admin`, `/superuser` 🔒 OUT OF SCOPE (decision 2026-07-02)
Demo user `+14105914612` is a normal user; the ~64 admin/superuser controls (user table, impersonation,
role/status edits, global config, queue/exec dashboards) can only be **access-asserted** (denial) as demo.
Result-asserting their real effects needs an elevated DEV test account. **Decided out-of-scope for this
sprint** (2026-07-02) — revisit when an elevated DEV superuser account is available. See [[admin-superuser]].

---

## Coverage gaps (only these remain outside the green suite)
- 🟡 LogoUploader (stamp_url), AnnotationsPanel Apply Fix, newsletter ingestion drawer, onboarding + Update
  Password (need a throwaway auth user), some login/signup/forgot/reset flows.
- 🔒 Admin + Superuser panels — **out of scope by decision 2026-07-02**; revisit with an elevated DEV account.

Everything else on this page is 🟢 and re-runnable via `e2e/run-regression.sh`. See [[result-asserting-suite]].
