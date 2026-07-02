---
name: Master UI test plan — every page, button, PASS + FAIL criteria
description: The authoritative run-after-every-sprint matrix. Every page/route, every interactive element, its expected result, explicit PASS criteria, explicit FAIL criteria, and the covering result-asserting test + status (GREEN / PENDING).
type: reference
last_reviewed: 2026-07-02
---

# Master UI test plan

Rule: every test asserts the **real produced result** (DOM output that is not a spinner/empty state **AND**
the backing DB row/field changed; async actions poll to completion first), data-isolated (create → assert →
hard-delete), pinned to demo user `+14105914612`. Harness: `e2e/pages/api.ts`. **Status legend:**
🟢 GREEN = result-asserting test passing on DEV · 🟡 PENDING = test to build/finish · 🔴 BUG = open defect.

Bugs found + fixed so far (result-asserting caught what click-only tests missed):
`import-from-genre` 500 (broken upsert) · CSV subscriber import 500 (broken upsert) · new editions had no
default template · **newsletter had no Preview button** · **per-chapter artwork missing + book cover never
associated project_id → Art tab always empty**. All fixed; commits on `develop`.

---

## 1. Newsletter Setup Wizard — `/newsletter/editions/:id/setup`  · spec `newsletter-wizard.spec.ts` 🟢
| Element | Expected result | PASS criteria | FAIL criteria |
|---|---|---|---|
| Feeds: "Copy N feeds from `<genre>`" | imports genre feeds | "N feeds attached" count > 0 **AND** `newsletter_feed_sources_v2` rows exist for edition | count stays 0, no rows, or 500 |
| Template step preview | renders default template | iframe `srcdoc` length > 100 **AND** default `newsletter_templates_v2` row exists | "No active default template" shown / blank iframe |
| Subscriber "Add" | creates subscriber | `newsletter_subscribers_v2` row for edition+email exists; button → "Added ✓" | no row / error |
| Done step | shows completion | "All set" + "Generate now →" + "Back to my newsletters" visible | missing buttons |

## 2. Newsletter editions list — `/newsletter/editions`  · `newsletter-wizard.spec.ts` (Preview) 🟢 / rest 🟡
| Element | Expected result | PASS criteria | FAIL criteria |
|---|---|---|---|
| **Preview** (per row) | modal renders the default template | dialog "Preview of …" opens; iframe `srcdoc` > 100 chars | no dialog / blank iframe / "no template" |
| New newsletter | → EditionEditor | URL `/newsletter/editions/new`, form renders | 🟡 |
| Feeds / Edit | navigate | correct URL + page renders | 🟡 |
| Disable / Re-enable | toggles `enabled` | `newsletter_editions_v2.enabled` flips in DB + row status label changes | 🟡 |
| Show disabled | includes disabled rows | disabled editions appear when checked (verify server honours include_disabled) | 🟡 |

## 3. EditionEditor — `/newsletter/editions/new` + `/:id`  🟡
| Element | Expected result | PASS criteria | FAIL criteria |
|---|---|---|---|
| Save (create) | inserts edition | 201 + `newsletter_editions_v2` row with all field values; **+ default template seeded** | missing row/fields |
| Save (edit) | updates edition | changed fields persisted in DB | stale values |
| LogoUploader | uploads/removes logo | `stamp_url` set/cleared in DB | 🟡 |
| SubscribersPanel add / import CSV / activate / unsubscribe / remove | mutates subscribers | corresponding `newsletter_subscribers_v2` change in DB | 🟡 (CSV import bug fixed) |

## 4. Newsletter Generate / Templates / Approvals / Sends / Ingestion  🟡
| Element | Expected result | PASS criteria | FAIL criteria |
|---|---|---|---|
| Generate "Preview template" | modal renders HTML | iframe `srcdoc` > 100 | blank |
| Generate submit | starts execution | navigates to `/newsletter/execution/:id`; execution row/state exists | no execution |
| Generate `?edition=` deep-link | preselects edition | `#edition` value === param (fallback if stale) | ignored (fixed earlier) |
| TemplateEditor Save + Render preview | persists + previews template | `newsletter_templates_v2` row updated; preview iframe HTML > 100 | 🟡 |
| ApprovalDetail Approve/Reject/Revise | resolves the gate | approval status transitions server-side; rendered payload preview shows real HTML | 🟡 |
| Sends detail | html preview | iframe `srcdoc` = stored html_body (> 0) | blank |
| Ingestion drawer markdown/html | shows ingested content | pre/iframe non-empty for a real item | 🟡 |

## 5. ProjectDetail — `/projects/:id` (9 tabs)  · Export 🟢, Cover/Chapter Art 🟢, rest 🟡
| Element | Expected result | PASS criteria | FAIL criteria |
|---|---|---|---|
| **Export → Download .docx** | downloads KDP doc | download event fires; file > 2 KB; filename `.docx` | dialog opens but no download / tiny file |
| **Generate Cover Art** (Outline) | book cover in gallery | `generated_images_v2` row (image_type cover_art, **project_id set**) + Art tab thumbnail | no row / project_id null / Art empty |
| **Generate Art** (per chapter, Chapters tab) | chapter art in gallery | `generated_images_v2` row (image_type chapter_art, project_id) + Art thumbnail | no row / Art empty |
| Outline / Re-outline, Write / Rewrite | queue engine job → artifact | job completes; `published_content_v2` chapter/outline updated with real content | queued forever / no DB change |
| Fix Drift (+Cancel) | repair job flips QA | after job, `chapter_qa_v2`/metadata aligned=true | drift persists |
| Social tab Copy | copies post text | clipboard has post text; posts render from `social_posts_v2` | empty |
| Story Bible tab | lists entries | entries render matching `story_bible_v2` count | 🟡 |
| Research / Cost tabs | list/analytics | real rows/values render | 🟡 |
| Edit form Save | updates project | `writing_projects_v2` fields persisted | stale |
| Delete Project | soft-deletes + cascade | project + children soft-deleted; nav to `/projects` | 🟡 |

## 6. ContentDetail — `/content/:id`  · lifecycle 🟢, rest 🟡
| Element | Expected result | PASS criteria | FAIL criteria |
|---|---|---|---|
| **Approve/Publish/Reject/Back-to-Draft/Schedule/Unpublish** | status transition | `published_content_v2.status` on the exact row → expected value; UI advances | wrong/no status change |
| **Run Q/A** | consistency report | after job, panel DISPLAYS checks **AND** `metadata.qa_report.checks` exists (not "No consistency report available") | stays empty / no checks |
| **AnnotationsPanel Apply Fix** | replaces target text | `content_text` changes to include the fix; annotation clears | text unchanged / annotation stays |
| Rewrite with research | queues repair job | job completes; chapter `content_text` updated + research woven | no change |
| VersionHistory Restore | restores a version | `content_text` == chosen version; new snapshot row added | unchanged |
| Editor Save | persists + snapshots | `content_text` saved; `content_versions_v2` row added | not saved |
| Cover image picker | sets cover | `cover_image_path` set on row; banner shows image | unchanged |

## 7. Dashboard / ProjectList  🟡
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| StatCards | counts | numbers match DB counts (Projects/Drafts/Published/Research) | wrong/blank |
| Recent Activity row | navigate | opens the item's detail route | dead |
| Project row | open | `/projects/:id` renders | dead |

## 8. Content Library — `/library`  🟡
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Type filter | filter + `?type=` | rows filter; URL param set | no effect |
| Sort headers | reorder | row order changes by field | no change |
| Bulk Approve/Publish/Delete | mutate selected | selected rows' `status`/`deleted_at` change in DB | no change |
| Row click | open detail | `/content/:id` | dead |

## 9. Reference — story-arcs / genres / brainstorm / research / outlines / sources / cost  🟡
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Story Arc create/edit/delete | CRUD | `story_arcs_v2` row inserted/updated/removed | no DB change |
| Genre create/edit/delete (cascade) | CRUD | `genre_config_v2` row change; cascade count shown | no change |
| Brainstorm submit | project+outline | `writing_projects_v2` row with non-empty outline | no project |
| Research list/detail/delete | read + soft-delete | rows render; delete sets `deleted_at` | no change |

## 10. Account / Auth — settings / credits / onboarding / login/signup/forgot/reset  🟡
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Settings Save | persist profile+email cfg | `users_v2` + `app_config_v2` updated | stale |
| Theme toggle | flips theme | `<html>` `dark` class toggles | 🟢 (nav suite) |
| Update Password | changes pwd | success toast; auth updated | error |
| Credits Purchase | grants credits | balance increases (Stripe-deferred stub) | no change |
| Onboarding profile+tier | creates user+sub | `users_v2` row + subscription | error |
| Login/Signup/Forgot/Reset | auth flows | correct redirect/panel | 🟡 |

## 11. Images / Eve voice widget  · widget 🟢
| Element | Expected | PASS | FAIL |
|---|---|---|---|
| Eve "Talk to Eve" widget | mounts ConvAI | `<elevenlabs-convai>` with agent-id + user dynamic-var | 🟢 |
| ImageDetail Regenerate | new image | new `generated_images_v2` row; navigates to it | 🟡 |
| ImageGallery filters / thumbnail open | filter + open | rows filter; thumbnail → `/images/:id` | 🟡 |

---

### Green today (result-asserting, passing on DEV)
`newsletter-wizard` (feeds+template+subscriber+**Preview**), `content-lifecycle` (status transitions),
`project-export` (.docx download), `project-art` (chapter artwork → gallery), `eve-voice-widget`, plus the
`nav-render` render/guard smoke. See [[result-asserting-suite]].

### Pending (next, same methodology)
Everything marked 🟡 above — being built module by module; each async action polls to completion and
asserts the rendered result + DB row. This page is updated as each flips to 🟢 (or 🔴 when a new bug is found).
