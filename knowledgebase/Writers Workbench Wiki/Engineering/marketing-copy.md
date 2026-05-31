---
name: Marketing copy — sales summary + screen-only video plan
description: Production-app website copy. Sales summary + 3-min Heygen avatar video plan with screen-capture-only B-roll. Generated 2026-05-10. Updated for Heygen + zero-budget filming.
type: concept
tags: [marketing, sales, video, copy, heygen, production-launch]
last_reviewed: 2026-05-10
---

# Marketing copy

Production-app website copy. Three deliverables: short sales summary, full Heygen-paste-ready avatar script, screen-only filming plan. Built for zero-budget filming — no actors, no lifestyle B-roll, no audio recording. Heygen avatar provides narration; you provide the screen captures.

> **Pre-launch accuracy check** — verify these before publishing:
> - Newsletter platform is DEV-only as of 2026-05-09 ([[newsletter-cluster]]). Confirm PROD migration before launching site copy that mentions it; otherwise move newsletter to a "Coming soon" callout.
> - URL placeholder `writersworkbench.app` — swap in your real domain. Live URL is `writersworkbench-production.up.railway.app`.
> - 8 genres + 8 story arcs is current count. Reverify before press.
> - 30-day trial maps to `trial` tier in `subscription_tiers`. Confirm discoverable on signup.

---

## 1. Sales summary description

**Tagline:** *Where stories get finished.*

### Elevator pitch (90 words)

The Writers Workbench is the AI-powered writing studio for novelists who refuse to stay stuck on chapter four. Talk to your AI writing partner Eve — by voice or text — and brainstorm full novel outlines, draft chapters in your voice, catch character drift before your readers do, generate cover art, repurpose passages into social posts, and run a subscriber newsletter from one dashboard. No prompt engineering. No API setup. No tab-switching. Just you, your story, and the tools that finish it.

### Capabilities at a glance

- **Eve voice + chat** — natural conversation about your work-in-progress; she runs the system, you run the story.
- **Brainstorm with eight built-in story arcs** — Three-Act, Hero's Journey, Freytag's Pyramid, Story Circle, Kishōtenketsu, Fichtean Curve, Seven-Point, In Medias Res.
- **Chapter generation** — character-locked, genre-aware, written in your voice across eight active genres (sci-fi, romance, speculative, historical, and more).
- **Automatic Story Bible** — characters, locations, plot threads, and events extracted from your prose as you write.
- **Drift scanner + Q/A engine** — every chapter scored on nine craft dimensions; character inconsistencies surfaced and one-click-fixable.
- **Research-backed rewrites** — Perplexity-driven research woven directly into your prose, citations on or off depending on fiction vs non-fiction.
- **Cover art + social fan-out** — KDP-ready visuals plus Twitter / LinkedIn / Instagram / Facebook posts in minutes.
- **Newsletter platform** — DB-driven RSS curation, subscriber import, automated cadence, approval flow, branded templates.
- **KDP-ready export** — `.docx` formatted for Kindle Direct Publishing, one click.

### Pricing line

Plans from $19.99/month with a 30-day free trial. Pro tier ($49.99/mo) unlocks cross-chapter continuity, advanced research, and premium prose models.

---

## 2. Pre-recording setup

One-time setup. ~20 minutes. Run before opening the screen recorder.

### Account

- Sign in to **DEV** Workbench at `writersworkbench-develop.up.railway.app`.
- Account: `eric@agileadtesting.com` / `Fr332bafami!y`.
- Use a clean browser profile (no extensions, no autofill noise) with cache cleared so PR #74 newsletter strings render correctly.

### Demo project to seed

Create a project named **"The Last Signal"** in DEV. Theme is post-apocalyptic so it pairs visually with the newsletter section.

| Field | Value |
|---|---|
| Title | The Last Signal |
| Genre | post-apocalyptic |
| Story arc | Hero's Journey |
| Project type | story |
| Status | in-progress |
| Description | Maya, a former radio engineer, intercepts a signal that shouldn't exist and follows it across the wastelands of the Rust Coast, 2087. |

Fastest seed: ask Eve in chat — *"Brainstorm a post-apocalyptic novel called The Last Signal using the Hero's Journey arc. Protagonist is Maya Chen, a former radio engineer, twenty-eight, scouting the Rust Coast in 2087."* Then approve the outline.

**State at start of recording:**
- 6 chapters in the outline.
- Chapters 1–3 written and approved.
- Story Bible auto-populated with ~10–12 entries (Maya Chen, Rust Coast, Quiet Cascade event, etc.).
- One cover image generated and selected for the project.
- **Pre-introduce a deliberate drift** in chapter 3: replace one occurrence of "Maya Chen" with "Maya Chan". This gives the drift scanner something real to find live during the demo.

### Demo newsletter to seed

Create edition **"The Wasteland Wire"** under My Newsletters. Pairs visually with the project genre.

| Field | Value |
|---|---|
| Name | The Wasteland Wire |
| Sender name | The Wasteland Wire |
| Genre | post-apocalyptic |
| Signature name | Maya Chen |
| Signature role | Signal scout |
| Cadence | weekly |
| Cadence send time | 09:00 Fri |
| Intro | This week from the Rust Coast. |

Use the Setup Wizard's "Copy feeds from genre" to import the post-apocalyptic feed set. Add 5 placeholder subscribers (`reader1@example.invalid` through `reader5@example.invalid`).

### Recorder settings

- Resolution: **1920×1080** (matches Heygen output).
- Frame rate: 30 fps.
- Cursor highlight: ON, soft yellow, ~32 px ring.
- Click animation: ON, subtle.
- Audio: OFF (Heygen provides narration).
- Recording window: full browser tab in app mode (hide bookmarks bar). Use OBS Studio or Loom — both free.

Record each scene as its own clip (don't try to do the whole thing in one take). Re-record any scene that has hesitation, typos, or off-camera mouse drift.

---

## 3. Heygen avatar script (copy-paste, full block)

Paste this verbatim into the Heygen script editor. Total runtime ~3:00 at default voice pace (~140 wpm). 425 words. Plain text — no markdown, no asterisks. Em-dashes and periods provide natural pauses.

```
Every novelist hits the same wall. The blank page. The character whose name drifts by chapter seven. The plot hole nobody catches until the beta reader does. We are going to fix that.

Most writers juggle five tools — a doc editor, a notes app, a cover designer, a newsletter platform, and social media. The Writers Workbench puts all of it in one place.

Meet Eve. The AI writing partner inside The Writers Workbench. Talk to her by voice, or type in chat. Tell her your story idea. She will help you brainstorm using eight proven story arcs — Three-Act, Hero's Journey, Kishotenketsu, Fichtean Curve. Pick one of eight built-in genres. Then she will write your chapters, one at a time, in your voice.

Every project has a Story Bible — characters, locations, plot threads — built automatically as you write. The drift scanner catches when a character's name shifts or their attributes change between chapters, and surfaces it as a one-click fix. The Q and A engine scores every chapter on prose quality, dialogue authenticity, pacing, and character consistency — nine craft dimensions, every chapter, every time.

When you want to deepen a scene with real-world research, Eve runs a research pass and weaves the findings into your prose. Fiction stays clean. Non-fiction gets citations. Or rewrite a chapter end to end with fresh research baked in.

When the book is done, generate cover art that doesn't look AI-generated. Format your manuscript for Kindle Direct Publishing in one click. Repurpose your best passages into Twitter, LinkedIn, Instagram, and Facebook posts — automatically. Run a newsletter that pulls from your genre's best sources, drafts itself, waits for your approval, and goes out to your subscribers on the cadence you set.

Every plan includes Eve. Every tier supports voice and chat. No servers, no API keys, no setup. Plans start at nineteen dollars and ninety-nine cents a month. Try it free for thirty days.

Stop fighting the blank page. Start finishing your book. The Writers Workbench. Sign up at writers workbench dot app.
```

### Per-scene script blocks

If Heygen lets you split into scenes, paste these chunks into separate scene cards. Same content, broken at scene boundaries.

| Scene | Heygen text |
|---|---|
| 1 — Hook | Every novelist hits the same wall. The blank page. The character whose name drifts by chapter seven. The plot hole nobody catches until the beta reader does. We are going to fix that. |
| 2 — Problem | Most writers juggle five tools — a doc editor, a notes app, a cover designer, a newsletter platform, and social media. The Writers Workbench puts all of it in one place. |
| 3 — Eve | Meet Eve. The AI writing partner inside The Writers Workbench. Talk to her by voice, or type in chat. Tell her your story idea. She will help you brainstorm using eight proven story arcs — Three-Act, Hero's Journey, Kishotenketsu, Fichtean Curve. Pick one of eight built-in genres. Then she will write your chapters, one at a time, in your voice. |
| 4 — Story bible + drift + Q/A | Every project has a Story Bible — characters, locations, plot threads — built automatically as you write. The drift scanner catches when a character's name shifts or their attributes change between chapters, and surfaces it as a one-click fix. The Q and A engine scores every chapter on prose quality, dialogue authenticity, pacing, and character consistency — nine craft dimensions, every chapter, every time. |
| 5 — Research + rewrite | When you want to deepen a scene with real-world research, Eve runs a research pass and weaves the findings into your prose. Fiction stays clean. Non-fiction gets citations. Or rewrite a chapter end to end with fresh research baked in. |
| 6 — Publication + reach | When the book is done, generate cover art that doesn't look AI-generated. Format your manuscript for Kindle Direct Publishing in one click. Repurpose your best passages into Twitter, LinkedIn, Instagram, and Facebook posts — automatically. Run a newsletter that pulls from your genre's best sources, drafts itself, waits for your approval, and goes out to your subscribers on the cadence you set. |
| 7 — Pricing | Every plan includes Eve. Every tier supports voice and chat. No servers, no API keys, no setup. Plans start at nineteen dollars and ninety-nine cents a month. Try it free for thirty days. |
| 8 — CTA | Stop fighting the blank page. Start finishing your book. The Writers Workbench. Sign up at writers workbench dot app. |

---

## 4. Filming plan (screen-only B-roll)

Each row = one filming scene. Capture in order. Record each scene as a separate clip; cut + sequence in editor.

Legend for the **Type / Caption** column: `[TYPE: text]` = literally type this into the app field; `[CAPTION: text]` = lower-third or text overlay added in editing.

| Time      | Scene                         | Heygen line                                                           | What to capture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Type / Caption                                                                                                                                                                                                                                                                          |
| --------- | ----------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:10 | 1 — Hook                      | Every novelist hits the same wall...                                  | Fast-cut montage, four screens, ~2.5 sec each:<br>1) Dashboard with populated counts.<br>2) ContentDetail open on Ch3 of The Last Signal with AnnotationsPanel showing the "Maya Chan" drift finding.<br>3) Newsletter ApprovalDetail page with rendered email preview.<br>4) ImageGallery grid with cover-art tiles.<br>Use editor cross-fades, ~250 ms.                                                                                                                                                                                      | `[CAPTION at 0:08: "The Writers Workbench"]`                                                                                                                                                                                                                                            |
| 0:10–0:25 | 2 — Problem                   | Most writers juggle five tools...                                     | Open ProjectDetail for The Last Signal. Hover slowly across the eight tabs (Overview, Outline, Chapters, Story Bible, Art, Social, Research, Cost, Export). Hold ~1.5 sec on each.                                                                                                                                                                                                                                                                                                                                                             | `[CAPTION at 0:21: "All in one workspace"]`                                                                                                                                                                                                                                             |
| 0:25–0:55 | 3 — Eve                       | Meet Eve... eight story arcs... eight genres...                       | Click sidebar "Talk to Eve" → widget popover opens → hold 2 sec on the widget UI.<br>Cut to Story Arc Browser: scroll showing all 8 arcs, hold 1 sec each.<br>Cut to Genre List: scroll showing all 8 genres.<br>Cut to ChatDrawer: type the prompt below; press send. Show the typing indicator pill.                                                                                                                                                                                                                                         | `[TYPE in ChatDrawer at 0:48: "Brainstorm a post-apocalyptic novel called The Last Signal using the Hero's Journey arc."]`                                                                                                                                                              |
| 0:55–1:35 | 4 — Story bible + drift + Q/A | Every project has a Story Bible... drift scanner... Q and A engine... | 1) Open ProjectDetail → Story Bible tab. Show ~10 entries (characters, events, locations).<br>2) Open ContentDetail on Ch3 → click AnnotationsPanel → show "Maya Chan" drift finding → click Apply → text updates in editor.<br>3) Click Q/A Report panel → show all 9 dimensions with green checks + one yellow.<br>Hold ~3 sec on each step.                                                                                                                                                                                                 | `[CAPTION at 1:08: "Story Bible auto-built"]`<br>`[CAPTION at 1:18: "One-click drift fix"]`<br>`[CAPTION at 1:28: "9 craft dimensions"]`                                                                                                                                                |
| 1:35–2:05 | 5 — Research + rewrite        | Eve runs a research pass... rewrite a chapter end to end...           | Open ContentDetail on Ch3 → click "Rewrite with Research" button → modal opens → fill the research focus field → submit → chat-pill flips Queued → Processing → Complete → cut to chapter text refreshing with new prose visible.                                                                                                                                                                                                                                                                                                              | `[TYPE in research_focus at 1:42: "Cold War radio interception techniques and HF propagation in damaged ionosphere"]`<br>`[CAPTION at 1:55: "Citations: off (fiction)"]`                                                                                                                |
| 2:05–2:35 | 6 — Publication + reach       | Cover art... format for Kindle... social posts... newsletter...       | 1) ImageGallery: click "Generate cover art" → type prompt below → watch new image appear in grid.<br>2) Click Export tab → ExportDialog → select "6x9 trade paperback" → click Generate.docx → file appears in browser download bar.<br>3) Open SocialMediaPanel → click through tabs Twitter → LinkedIn → Instagram → Facebook, hold ~1 sec each.<br>4) Open My Newsletters → click The Wasteland Wire → EditionEditor showing logo + signoff → cut to PendingApprovals page → click an approval → ApprovalDetail with rendered HTML preview. | `[TYPE in cover-art prompt at 2:08: "Lone radio scout silhouetted against rust-red wasteland sky, vintage vacuum tubes glowing in foreground"]`<br>`[CAPTION at 2:14: "KDP-ready .docx"]`<br>`[CAPTION at 2:22: "Multi-platform social"]`<br>`[CAPTION at 2:30: "Newsletter platform"]` |
| 2:35–2:55 | 7 — Pricing                   | Every plan includes Eve... nineteen ninety-nine... thirty days...     | Open Onboarding flow (or visit `/signup` as fresh user) → PricingCards page → hold 3 sec showing Trial, Standard, Pro tiles → mouse-hover the Standard "Most Popular" ribbon → cut to Dashboard with realistic counts visible.                                                                                                                                                                                                                                                                                                                 | `[CAPTION at 2:38: "$19.99/mo · Free 30-day trial"]`<br>`[CAPTION at 2:48: "Voice + chat on every plan"]`                                                                                                                                                                               |
| 2:55–3:00 | 8 — CTA                       | Stop fighting the blank page... writers workbench dot app.            | Hold shot: Workbench logo centered on dark gradient background, URL `writersworkbench.app` animated typing-on under the logo.                                                                                                                                                                                                                                                                                                                                                                                                                  | `[CAPTION at 2:56: "writersworkbench.app"]`                                                                                                                                                                                                                                             |

---

## 5. Editing + post-production

- **Cuts**: max 3 sec per shot inside the demo body (scenes 2–7); ~2.5 sec for the hook montage; hold the final CTA logo card for 3–4 sec.
- **Transitions**: hard cuts between scenes; 250 ms cross-fade only inside the hook montage.
- **Captions**: 36 px sans-serif, lower-third, semi-transparent dark background. Fade in 300 ms; hold for narration line; fade out 300 ms.
- **Cursor**: keep cursor highlight throughout for clarity.
- **Avatar placement**: Heygen avatar in lower-right corner, ~25% screen width, with rounded mask. Mute the avatar background; let app screencast fill the frame.
- **Avatar pose**: front-facing, conversational. Avoid hand-waving — it pulls focus from the screen.
- **Music**: optional. If used, royalty-free instrumental at −20 dB so narration stays clear.
- **End card**: 3 sec hold on logo + URL + small "Free 30-day trial" line.

## 6. Recording-day shot list (operator checklist)

In order. Tick each as recorded.

- [ ] Scene 1 hook montage — 4 screens, 10 sec.
- [ ] Scene 2 problem — ProjectDetail tab pan, 15 sec.
- [ ] Scene 3 Eve — widget open + Story Arc browser + Genre list + ChatDrawer prompt, 30 sec.
- [ ] Scene 4 craft — Story Bible + drift apply + Q/A panel, 40 sec.
- [ ] Scene 5 research — Rewrite-with-Research modal + completion, 30 sec.
- [ ] Scene 6 publication — cover art + Kindle export + social tabs + newsletter, 30 sec.
- [ ] Scene 7 pricing — PricingCards + Dashboard, 20 sec.
- [ ] Scene 8 CTA — logo card, 5 sec.

Total raw footage target: ~3:00. Plan for ~10–15 minutes of recording total to allow re-takes.

## 7. Pre-launch flags (do these before publishing the video)

- Confirm newsletter cluster is on PROD before referencing it (currently DEV-only — see [[newsletter-cluster]]).
- Swap `writersworkbench.app` for the real domain in scene 8 caption + CTA narration. If it's still a Railway subdomain, reword to "sign up at the link in the description."
- Verify the Standard tier at `$19.99/mo` is what the live `subscription_tiers` table returns. If pricing changes, re-record scene 7 voice via Heygen and re-cut.
- The deliberate "Maya Chan" drift in chapter 3 should be re-introduced fresh each demo day — the drift scanner stores results and may already mark the row dismissed.

---

## Source pages this copy is grounded in

The features described above all map to real shipped functionality. Verify in:

- [[overview]] — system synthesis.
- [[components]] — the actual React components delivering each feature.
- [[chat-and-eve]] — Eve voice + chat surface.
- [[chapter-writer-architecture]] — chapter generation pipeline.
- [[annotations-panel]] — drift scanner + Q/A surface.
- [[editor-and-content]] — TipTap editor + side panels.
- [[newsletter-ui]] — newsletter platform (DEV-only as of 2026-05-09).
- [[sprint-8-rbac]] — pricing tiers + credit ledger.
- [[productization]] — pricing structure.

Cross-reference if the website team needs to verify a claim before publication.
