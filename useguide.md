# The Author Agent — User Guide

> **Welcome!** This guide walks you through every feature of The Author Agent, your AI-powered writing assistant. Whether you're typing commands or speaking to Eve (your voice agent), this guide has sample prompts, full scenarios, and voice commands for everything you can do.
>
> **No prior experience needed.** Just speak naturally or type your request — the system handles the rest.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Getting Started with Eve (Voice)](#2-getting-started-with-eve-voice)
3. [Your Genres](#3-your-genres)
4. [Switching Genres](#4-switching-genres)
5. [Deep Research](#5-deep-research)
6. [Research Reports](#6-research-reports)
7. [Write a Blog Post](#7-write-a-blog-post)
8. [Write a Newsletter](#8-write-a-newsletter)
9. [Write a Short Story](#9-write-a-short-story)
10. [Brainstorming & Story Arcs](#10-brainstorming--story-arcs)
11. [Revise & Manage Outlines](#11-revise-an-outline)
12. [Write a Chapter, Prologue, or Epilogue](#12-write-a-chapter)
13. [Revise a Short Story](#13-revise-a-short-story)
14. [Revise a Chapter](#14-revise-a-chapter)
14b. [Q/A a Chapter](#14b-qa-a-chapter)
15. [Story Bible](#15-story-bible)
16. [Generate Cover Art](#16-generate-cover-art)
17. [Repurpose to Social Media](#17-repurpose-to-social-media)
18. [Content Library](#18-content-library)
    - [18.13 Delete Content](#1813-delete-content)
    - [18.14 Undelete Content](#1814-undelete-content)
    - [18.15 List Deleted Content](#1815-list-deleted-content)
    - [18.16 Email Any Saved Content](#1816-email-any-saved-content)
    - [18.17 Format a Book for Kindle (KDP Manuscript)](#1817-format-a-book-for-kindle-kdp-manuscript)
19. [Eve Review Mode (Voice Callbacks)](#19-eve-review-mode-voice-callbacks)
20. [Email Reports](#20-email-reports)
21. [End-to-End Scenarios](#21-end-to-end-scenarios)
22. [Tips & Troubleshooting](#22-tips--troubleshooting)
23. [Story Structure Guidelines](#23-story-structure-guidelines)

---

## 1. Getting Started

The Author Agent works in two ways:

- **Chat** — Type your requests directly into the n8n chat interface. Best for detailed prompts with specific parameters.
- **Voice (Eve)** — Speak your requests to Eve, your ElevenLabs voice assistant. Best for quick commands, brainstorming sessions, and hands-free writing.

Both methods access the same tools. Anything you can type, you can say — and vice versa.

### What You'll Receive

Most outputs are delivered by email as formatted HTML. You'll get:

- **Blog posts** — Full text + DALL-E cover image
- **Newsletters** — Subject line, intro, sections, outro with citation links
- **Short stories** — Full prose + cover image
- **Chapters** — Full prose + cover image + story bible updates
- **Brainstorm outlines** — Character profiles + chapter-by-chapter breakdowns
- **Cover art** — DALL-E generated image matching your genre's art style
- **Social media posts** — Platform-specific formatted posts
- **Research reports** — Findings with citations and source URLs

Drafts are also saved automatically to your Content Library for approval, publishing, and version tracking.

---

## 2. Getting Started with Eve (Voice)

Eve is your ElevenLabs voice assistant. She speaks naturally, understands casual speech, and can do everything the chat interface can — plus live callback sessions where she calls your phone to discuss your work.

### How to Talk to Eve

- **Be natural.** "Um, yeah, can you write a blog post about, like, AI marketing?" works perfectly.
- **Say the genre.** Include the genre name or slug: "in the ancient history genre" or "genre slug ancient-history."
- **Numbers are flexible.** "fifteen hundred words" and "1500 words" both work.
- **You can chain requests.** "Research X, then write a blog about it."
- **Filler words are fine.** Eve handles "um," "like," "you know," and other natural speech patterns.

### Quick-Start Voice Commands

| What You Want | What to Say |
|---------------|-------------|
| Research a topic | *"Research the fall of the Roman Republic and what caused it. Include citations."* |
| Save research | *"Save that research as a report called 'Fall of the Roman Republic.' Genre slug political-history."* |
| Write a blog post | *"Write a blog post about how AI is changing marketing in 2026. Genre slug ai-marketing. About fifteen hundred words."* |
| Write a newsletter | *"Write a newsletter for the ancient history genre about Roman festivals and their modern echoes. Date today."* |
| Write a short story | *"Write a short story in the post-apocalyptic genre about a lone radio operator in flooded Manhattan who picks up a mysterious broadcast. About two thousand words."* |
| Brainstorm a book | *"Brainstorm a story called 'The Last Tribune' about a Roman tribune who uncovers a conspiracy to assassinate Caesar. Genre political-history. Eight chapters."* |
| Brainstorm with a story arc | *"Brainstorm a short story using Freytags Pyramid about a traveling inoculator in a plague wasteland. Genre post-apocalyptic."* |
| Brainstorm with Eve (conversation) | *"I want to brainstorm a new story. I've been thinking about something set in ancient Rome."* |
| List story arcs | *"What story arcs are available?"* |
| Revise an outline | *"Expand the outline for 'The Last Tribune' to twelve chapters."* |
| Write a chapter | *"Write chapter one of 'The Last Tribune.' Genre political-history. Chapter number one."* |
| Write from an outline | *"Write a short story using the outline we brainstormed for 'The Inoculator.'"* |
| Generate cover art | *"Generate cover art for 'The Last Tribune.' Genre political-history. A Roman forum at dusk with a lone figure before the Senate steps."* |
| Social media posts | *"Repurpose this into Twitter posts: 'The Last Signal is a new story about a radio operator in flooded Manhattan picking up a mysterious broadcast.' Platform Twitter."* |
| List your drafts | *"Show me my drafts."* |
| Approve a draft | *"Approve the draft called 'The Inoculator.'"* |
| Publish content | *"Publish 'The Inoculator.'"* |
| Schedule content | *"Schedule 'The Inoculator' for March fifteenth."* |
| Review something | *"Pull up my short story 'The Inoculator' and call me back so we can revise it."* |
| Story bible | *"Get the story bible for 'The Last Tribune.'"* |
| List projects | *"Show me my projects."* |
| Retrieve chapters | *"Get all the chapters from 'The Last Tribune.'"* |

---

## 3. Your Genres

You have eight genres available. Each genre has its own writing tone, style guidelines, and cover art aesthetic.

| Genre | Genre Slug | Tone | Cover Art Style |
|-------|-----------|------|-----------------|
| Post-Apocalyptic Science Fiction | `post-apocalyptic` | Gritty, visceral, atmospheric | Muted colors, ruins, decay, desolate landscapes |
| Political Science Fiction | `political-scifi` | Cerebral, tense, morally ambiguous | Dark, imposing, institutional settings |
| Historical Time Travel | `historical-time-travel` | Meticulous, wonder-infused, literary | Period-appropriate imagery, blended eras |
| AI & Marketing Technology | `ai-marketing` | Authoritative, forward-looking, practical | Clean gradients, blues/purples, circuit patterns |
| Political & Historical Events | `political-history` | Analytical, layered, draws parallels to today | Documentary/oil painting style, amber lighting |
| Ancient History & Historical Novels | `ancient-history` | Immersive, sensory-rich, reverent of detail | Classical painting, warm golden light, earth tones |
| Metaphysical Romance | `metaphysical-romance` | Intimate, emotionally honest, spiritually grounded | Soft light, layered timelines, ethereal warmth |
| Sci-Fi Romance & Dark Sci-Fi | `scifi-romance` | Intense, emotionally charged, sensory-rich | Neon-lit cityscapes, cyberpunk warmth, space vistas |

### What Is a "Genre Slug"?

A genre slug is the short identifier the system uses to look up your genre's settings. The eight slugs are:

`post-apocalyptic` · `political-scifi` · `historical-time-travel` · `ai-marketing` · `political-history` · `ancient-history` · `metaphysical-romance` · `scifi-romance`

---

## 4. Switching Genres

There is no separate "switch genre" command — you set the genre each time you ask for something by including the genre slug.

### Chat Examples

```
Write a blog post about survival communities after a global EMP event.
Genre slug: post-apocalyptic. Target length: 1500 words.
```

Now switch to ancient history for the next piece:

```
Write a blog post about daily life in ancient Pompeii before the eruption.
Genre slug: ancient-history. Target length: 1500 words.
```

### Voice Examples

> "Write a short story in the **political sci-fi** genre about a president who discovers time travel."

> "Now write a newsletter for the **ancient history** genre about the fall of Carthage."

The key phrase is **"genre slug [name]"** or simply **"in the [genre name] genre"** — Eve understands both.

### What If You Forget the Genre?

If you don't specify a genre, the agent tries to infer one from your topic:
- A story about pharaohs → `ancient-history`
- A story about AI and advertising → `ai-marketing`
- A story about a dystopian wasteland → `post-apocalyptic`
- A story about soulmates, past lives, or caregiving → `metaphysical-romance`

For best results, always include the genre slug explicitly.

---

## 5. Deep Research

Runs a live internet search using Perplexity AI and returns results with citations. Results appear in the chat — no email is sent. Research is automatically saved as a report.

### Chat

```
Research the current state of post-apocalyptic fiction in 2026. What are the trending
themes, notable new releases, and how has the genre evolved since COVID? Include citations.
```

```
Research ancient Roman gladiator training methods. Include primary sources.
```

```
Research what daily life was like inside Constantinople during the final siege of 1453.
```

### Voice

> "Hey, can you research what's going on with post-apocalyptic fiction right now? What are the big trends and new books coming out?"

> "Research the fall of the Roman Republic — the key events, the political players, and what modern historians think really went wrong."

> "Research how AI is being used in content marketing in 2026. Include citations."

### Full Scenario: Research for a Writing Project

**Step 1 — Ask your question:**

> **You:** "Research the Viking settlement of Iceland. I want to know about the first settlers, their daily life, and how they governed themselves without a king."

*Eve returns detailed findings with citations from academic and historical sources.*

**Step 2 — Save the research:**

> **You:** "Save that research as a report. Call it 'Viking Settlement of Iceland.' Genre slug ancient-history."

*The report is stored and you can reference it anytime.*

**Step 3 — Use it later:**

> **You:** "Write a short story in the ancient history genre using my research on Viking Iceland. Premise: A young woman sails from Norway to Iceland with her family and must navigate the brutal first winter. About 3000 words."

*The agent uses the saved research to inform the story.*

---

## 6. Research Reports

Save, organize, and retrieve your research for later use.

### 6.1 Save a Research Report

After running a deep research query, the report is saved automatically. You can also save manually:

**Chat:**
```
Save that research as a report with topic "Post-Apocalyptic Fiction Trends 2026"
and genre slug post-apocalyptic.
```

**Voice:**
> "Save that research as a report called 'Constantinople Final Siege Daily Life.' Genre slug ancient-history."

### 6.2 List Research Reports

**Chat:**
```
List my research reports
```

**Voice:**
> "Show me all my research reports."

### 6.3 Get a Specific Report

**Chat:**
```
Get the research report about "Post-Apocalyptic Fiction Trends 2026"
```

**Voice:**
> "Pull up my research on Viking Iceland."

### 6.4 Update a Report

```
Update the research report "Post-Apocalyptic Fiction Trends 2026" — change its
status to published.
```

---

## 7. Write a Blog Post

Creates an SEO-optimized blog post with cover art, saves a draft to the content library, and emails you the result.

### Chat

```
Write a blog post for the post-apocalyptic genre.
Topic: "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026".
Genre slug: post-apocalyptic.
Keywords: post-apocalyptic books, climate fiction, survival stories, dystopian novels.
Target length: 1500 words.
```

### Voice

> "Write a blog post about how AI is changing marketing in 2026. Genre slug ai-marketing. Keywords: AI tools, marketing automation. About fifteen hundred words."

### What You Get

- An email with the full blog post text
- A DALL-E generated cover image matching your genre's art style
- A draft saved to your content library

### More Examples

**Ancient History:**
```
Write a blog post in the ancient-history genre.
Topic: "The Forgotten Engineers of Rome: How Aqueducts Shaped an Empire".
Genre slug: ancient-history.
Keywords: Roman engineering, aqueducts, ancient infrastructure, Frontinus.
Target length: 1500 words.
```

**Political History:**
```
Write a blog post about revolutions that reshaped the modern world.
Genre slug: political-history.
Keywords: French Revolution, American Revolution, political upheaval.
Target length: 1500 words.
```

**Historical Time Travel:**
```
Write a blog post for the historical-time-travel genre.
Topic: "What If You Could Visit the Library of Alexandria?"
Genre slug: historical-time-travel.
Keywords: time travel, ancient libraries, history.
Target length: 1500 words.
```

### Full Scenario: Blog Post from Research

**Step 1 — Research first:**

> **You:** "Research ancient Roman gladiator training methods."

*Results appear in chat with citations.*

**Step 2 — Write the blog post:**

> **You:** "Now write a blog post about that research. Genre slug ancient-history. Keywords: gladiators, Roman arena, combat training. Target length twelve hundred words."

*The blog incorporates your research findings. Email arrives with the full post and cover art.*

---

## 8. Write a Newsletter

Creates a structured newsletter (subject line, intro, sections, outro) with live research via Perplexity (preserving citation URLs) and emails it to you.

### Chat

```
Write a newsletter for the political-scifi genre.
Topic: "Power Structures in Space: How Sci-Fi Predicts Real-World Politics".
Genre slug: political-scifi.
Date: 2026-03-13.
```

### Voice

> "Write me a newsletter for the political history genre about revolutions that changed the world. Date today."

> "Write a newsletter for the ancient history genre about Roman festivals and their modern echoes. Date today."

### What You Get

- An email with a formatted newsletter including subject line, introduction, multiple sections with research-backed content, and an outro
- Citation URLs preserved from Perplexity research
- A draft saved to your content library

---

## 9. Write a Short Story

Creates a complete short story with Perplexity research, style-matched prose, cover art, and email delivery. A draft is automatically saved to your content library.

### Chat — From Scratch

```
Write a short story.
Genre slug: historical-time-travel.
Premise: A historian discovers that antique photographs can transport her to the
moment they were taken. She finds a photo of the Titanic's maiden voyage departure
and must decide whether to warn the passengers.
Tone: literary, bittersweet.
Length: 2500 words.
Research topics: ["Titanic maiden voyage Southampton 1912", "history of early
photography techniques", "time travel paradoxes in fiction"]
```

### Voice — From Scratch

> "Write a short story in the ancient history genre about a Roman soldier who discovers a hidden library beneath the Colosseum. About three thousand words. Research Roman military life and the Colosseum underground tunnels."

> "Write a short story in the post-apocalyptic genre about a lone radio operator in flooded Manhattan who picks up a mysterious broadcast from across the Atlantic. About two thousand words."

### Chat — From a Brainstormed Outline

When you've already brainstormed an outline (see Section 10), you can write the story using that outline:

```
Write a short story using the outline for "The Inoculator".
Genre slug: post-apocalyptic.
```

The system automatically loads your saved outline, characters, themes, and structure. You don't need to re-describe the premise.

### Voice — From a Brainstormed Outline

> "Write the short story we brainstormed called 'Signal from the Deep.' Genre post-apocalyptic."

> "Write a short story using the outline for 'The Consulship of Gaius Varro.' Genre ancient-history."

### What You Get

- An email with the full short story
- A DALL-E cover image
- A draft saved to your content library

### Full Scenario: Brainstorm Then Write a Short Story

**Step 1 — Brainstorm the outline:**

> **You:** "Brainstorm a short story using Freytags Pyramid called 'The Witness' in the historical-time-travel genre. Premise: a modern archaeologist falls through time during a dig and witnesses the assassination of Julius Caesar. Themes: fate, observation vs. participation, the weight of knowledge."

*You receive an email with a structured outline: character profiles, scene-by-scene breakdown following Freytag's five-act structure, thematic threads.*

**Step 2 — Review the outline (optional):**

> **You:** "Pull up the outline for 'The Witness' and call me back so we can go over it."

*Eve calls your phone with the outline loaded. You discuss changes.*

**Step 3 — Write the story:**

> **You:** "Write a short story using the outline for 'The Witness.' Genre historical-time-travel."

*The agent loads your saved outline — characters, arc structure, scenes — and writes the complete story. Email arrives with the prose and cover art.*

**Step 4 — Review and revise (optional):**

> **You:** "Pull up my short story 'The Witness' and call me back so we can revise it."

*Eve calls back with the story loaded. She gives specific editorial feedback — pacing, dialogue, opening strength — quoting passages from your draft. See Section 13 for details.*

---

## 10. Brainstorming & Story Arcs

Brainstorm generates a structured outline with character profiles, chapter or scene breakdowns, themes, and research — then saves it for later writing. You can optionally use a **story arc framework** to shape the outline structure.

### Available Story Arcs

The system has named story arc frameworks stored in the database. Each arc provides detailed structural rules the AI follows when building your outline. Some arcs include a **discovery question** — when you choose one of these arcs, Eve will ask the question before brainstorming to help shape your story's foundation.

| # | Arc Name | Best For | Structure | Discovery Question |
|---|----------|----------|-----------|-------------------|
| 1 | Freytag's Pyramid | Tragedies, ensemble casts, moral dramas, character transformation | Five-Act Structure: Exposition → Rising Action → Climax → Falling Action → Resolution | *What is the protagonist's fatal flaw or central belief — and how will the climax shatter or transform it?* |
| 2 | Three-Act Structure | Universal — works for any genre | Setup (25%) → Confrontation (50%) → Resolution (25%). Key beats: Inciting Incident, Midpoint, Second Plot Point, Climax | *What does the protagonist believe at the start — and what will the story force them to learn, surrender, or become?* |
| 3 | The Hero's Journey | Mythic, adventure, coming-of-age, epic fantasy | 12 stages: Ordinary World → Call → Refusal → Mentor → Threshold → Tests → Inmost Cave → Ordeal → Reward → Road Back → Resurrection → Return with Elixir | *Who is the hero, what is their deepest wound, and what must they sacrifice or surrender to be transformed?* |
| 4 | Dan Harmon's Story Circle | Character-driven stories, internal change | 8 steps: Comfort Zone → Need → Unfamiliar Situation → Adapt → Get What They Wanted → Pay a Price → Return → Changed | *What does the character think they want, and what do they actually need to become whole?* |
| 5 | In Medias Res | Thrillers, mysteries, literary fiction | Opens mid-crisis, reveals backstory through flashback. Two layers: Entry Scene + Underlying Chronology | *What is the single most intense or consequential moment in this story — the one that, if witnessed without context, would demand explanation?* |
| 6 | Seven-Point Structure | Plot-driven stories, tight pacing | Built backward from Resolution: Hook → First Plot Point → First Pinch Point → Midpoint → Second Pinch Point → Second Plot Point → Resolution | *What is the Resolution — where does this story end and who has your protagonist become?* |
| 7 | Kishōtenketsu | Literary fiction, slice-of-life, fables, contemplative narratives | Ki (Introduction) → Shō (Development) → Ten (Twist/Contrast) → Ketsu (Reconciliation). No conflict required. | *What two contrasting ideas, images, or situations does this story want to hold together?* |
| 8 | Fichtean Curve | Thrillers, mysteries, action, survival, crime, horror | In medias res → 3 escalating crises → Climax → Short resolution. Backstory revealed in motion, never front-loaded. | *What is the protagonist's greatest fear — and at what moment will they be forced to face it with no options left?* |

---

### Story Arc Deep Dives

#### Freytag's Pyramid (Five-Act Structure)

One of the most enduring narrative frameworks in storytelling history. Rooted in classical Roman theater, perfected by Shakespeare, and visualized as Freytag's Pyramid by German novelist Gustav Freytag, the **Five-Act Structure** divides a narrative into five distinct dramatic stages. Unlike the Three-Act Structure, which compresses the middle into one large confrontation block, the Five-Act model creates dedicated space for **moral and emotional consequence** — making it ideal for character-driven transformation, ensemble casts, complex subplots, and narratives where the fallout of a decision matters as much as the decision itself.

**The Five Acts:**

| Act | Stage | Dramatic Function |
|-----|-------|-------------------|
| **Act I** | Exposition | Establish. Introduce. Plant. Create normalcy so something can break it. |
| **Act II** | Rising Action | Escalate. Complicate. Deepen. Every scene raises the stakes or tightens options. |
| **Act III** | Climax | Turn. Decide. Shatter. The irreversible moment that changes everything. |
| **Act IV** | Falling Action | Unravel. Consequence. Transformation made visible. Do not rush here. |
| **Act V** | Resolution | Close. Answer. Deliver. The only place this story could end. |

**Best for:** Tragedies, epic fantasy, crime drama, historical fiction, literary fiction, political thrillers, moral dramas, ensemble sagas, TV series, screenplays. Any story where the consequences of the climax deserve as much space as the buildup.

**Core principles:**
- **Five acts give space that three acts cannot.** The middle — Acts II, III, and IV — is where the story lives. Protect it from compression.
- **The climax is not the ending.** Act III sits at the center of the pyramid. Acts IV and V are not afterthoughts — they are the moral and emotional fulfillment.
- **Transformation must be earned.** Planted in I, pressured in II, broken open in III, processed in IV, visible in V.
- **Subplots serve the theme.** Every secondary storyline should intersect with the protagonist's journey by Act IV.
- **The resolution answers Act I.** Whatever was introduced in the exposition must be addressed in the denouement.

**Discovery question:** *What is the protagonist's fatal flaw or central belief — and how will the story's climax shatter or transform it?*

**How to answer the discovery question:**
- **Identify the flaw or belief.** What does the protagonist believe about themselves or the world that the story will test? Example: *"Michael Corleone believes he is different from his family — that he can stay clean."* Or: *"Macbeth believes ambition and merit are the same thing."*
- **Identify the shattering.** The climax (Act III) is the moment this belief is destroyed or inverted. Example: *"Michael kills Sollozzo — the man who swore he'd never be his father has now committed murder."* Or: *"Banquo's ghost appears — Macbeth's guilt has consumed his ability to maintain the fiction."*

**Example A — Macbeth (Tragedy / Moral Destruction):**
- **Act I:** Macbeth receives a prophecy he will become king. Lady Macbeth pushes him toward ambition. *Tone: Foreboding beneath glory.*
- **Act II:** Macbeth murders Duncan, claims the throne, orders Banquo killed. Paranoia deepens. *Tone: Escalating dread.*
- **Act III:** Banquo's ghost appears at the banquet. Macbeth breaks down publicly. He is no longer a man who committed one terrible act — he is a tyrant. *Tone: Collapse of control.*
- **Act IV:** Lady Macbeth descends into madness. Macbeth grows reckless. Forces gather against him. *Tone: Dissolution and isolation.*
- **Act V:** Lady Macbeth dies. Macduff kills Macbeth. Order is restored. *Tone: Grim, inevitable justice.*
- *Emotional arc: A great man destroys himself by reaching for what he was not willing to earn honestly.*

**Example B — The Godfather (Crime Drama / Moral Transformation):**
- **Act I:** The Corleone family at Connie's wedding. Michael is the war hero who wants nothing to do with the family business. *Tone: Power beneath celebration.*
- **Act II:** Vito is shot. Michael is pulled in — from witness to participant to conspirator. *Tone: Slow corruption, reluctant entry.*
- **Act III:** Michael kills Sollozzo and McCluskey at the restaurant. The point of no return. *Tone: Cold, deliberate, irreversible.*
- **Act IV:** Michael flees to Sicily. Sonny is killed. Michael returns and marries Kay, presenting himself as a civilian. *Tone: Quiet reinvention that cannot hold.*
- **Act V:** Michael eliminates all rivals during a baptism. Kay watches the door close. *Tone: Total transformation — clean outside, hollow at center.*
- *Emotional arc: The man who most wanted to escape his family's world becomes its most complete expression.*

**Example C — Fellowship of the Ring (Epic Fantasy / Sacrifice and Fracture):**
- **Act I:** The Shire. Frodo receives the Ring. A hobbit who has never faced anything larger than a birthday party. *Tone: Pastoral innocence under gathering shadow.*
- **Act II:** The Fellowship forms, journeys, and descends into the Mines of Moria. *Tone: Growing danger, earned camaraderie.*
- **Act III:** Gandalf falls on the Bridge of Khazad-dûm. The Fellowship loses its anchor. *Tone: Shattering loss.*
- **Act IV:** Boromir tries to take the Ring. Frodo decides he must continue alone. *Tone: Dissolution, loyalty tested.*
- **Act V:** Boromir dies defending Merry and Pippin. Frodo and Sam set off alone. The Fellowship is broken but not failed. *Tone: Grief and determination.*
- *Emotional arc: A community fractures under the weight of its shared purpose — and the fracture is the only way forward.*

**Example D — Breaking Bad Season 1 (Moral Drama / Irreversible Choice):**
- **Act I:** Walter White — underpaid teacher, terminal cancer, no financial cushion — decides to cook meth. *Tone: Desperation mistaken for pragmatism.*
- **Act II:** The first cook. A deal goes wrong. Walt must decide what kind of person he is willing to become. *Tone: Escalating compromise.*
- **Act III:** Walt strangles Krazy-8. Not in panic — in deliberate, premeditated action. *Tone: Cold clarity. The transformation cannot be undone.*
- **Act IV:** Walt continues cooking. Hank gets closer. Walt begins to enjoy the power. *Tone: Quiet exhilaration beneath normalcy.*
- **Act V:** Walt turns down a buyout. He watches Jane die without intervening. He is no longer a man who made a desperate choice — he prefers this. *Tone: The monster recognizing itself.*
- *Emotional arc: A man who told himself he was doing wrong for the right reasons discovers he was doing it because it made him feel alive.*

**Sample prompt:**
```
Brainstorm a book using Freytags Pyramid called "The Consulship."
Genre slug: ancient-history. 12 chapters.
Premise: A Roman senator during the fall of the Republic foresees the collapse of
democratic institutions but is powerless to prevent it. His fatal flaw is that he
believes he can save the system by working within it.
Themes: duty, compromise, the cost of political conviction, institutional decay.
```

---

#### Three-Act Structure

The most widely used narrative framework in history — rooted in Aristotle, refined across centuries of theater, novels, and film. The Three-Act Structure divides a story into three proportional phases: **Setup (25%), Confrontation (50%), Resolution (25%)**. It works because it mirrors the natural rhythm audiences instinctively feel — a beginning that draws them in, a middle that tests the protagonist, and an ending that delivers both climax and transformation.

**The Structure with Key Beats:**

| Act | Proportion | Key Beats |
|-----|-----------|-----------|
| **Act I — Setup** | 25% | Ordinary World → Inciting Incident → First Plot Point (commits to journey) |
| **Act II — Confrontation** | 50% | Escalating obstacles → Midpoint Shift → Subplot development → Second Plot Point (darkest moment) |
| **Act III — Resolution** | 25% | Climax → Transformation visible → Closure |

**Best for:** Every genre. Thriller, romance, fantasy, literary fiction, mystery, drama, coming-of-age, action-adventure, horror, sci-fi. This is the most versatile framework — and the one most readers and audiences instinctively expect.

**Core principles:**
- **The three acts must be proportional.** 25/50/25. A story with a 50% setup has a sagging middle. A story with a 10% resolution wastes an earned climax.
- **The inciting incident must be an event, not a feeling.** Something happens. The protagonist's world changes concretely.
- **The midpoint is not optional.** Without a shift at the center of Act II, the confrontation becomes one long obstacle course with no shape.
- **The Second Plot Point must be the darkest moment.** If the protagonist still has options at the end of Act II, the climax feels too easy.
- **The climax resolves both arcs simultaneously.** External conflict resolved through internal transformation.

**Discovery question:** *What does the protagonist believe at the start of this story — and what will the story force them to learn, surrender, or become?*

**How to answer the discovery question:**
- **Identify the starting belief.** What does the protagonist take for granted about themselves or the world? Example: *"Elizabeth Bennet believes she is an excellent judge of character."* Or: *"Harry believes he is nobody — invisible, unwanted, ordinary."*
- **Identify the forced change.** The story's events will pressure, crack, and ultimately transform that belief. Example: *"Elizabeth discovers her judgment was prejudice — and Darcy's pride was partly justified."* Or: *"Harry discovers he is known, wanted, and capable — and that love, not power, is his greatest strength."*

**Example A — Harry Potter and the Philosopher's Stone (Fantasy / Coming-of-Age):**
- **Act I:** Harry lives miserably with the Dursleys, receives a Hogwarts letter, learns the truth about his parents, boards the train. *Inciting incident: The letter. First plot point: Boarding the train.* Tone: Wonder edged with longing.
- **Midpoint:** Harry discovers someone is trying to steal the Philosopher's Stone. Stakes shift from adjustment to danger.
- **Second Plot Point:** Dumbledore is lured away. Everything Harry thought he understood is wrong.
- **Act III:** Harry confronts Quirrell/Voldemort alone. Defeats him through love — his mother's sacrifice. Gryffindor wins the House Cup.
- *Emotional arc: An invisible orphan discovers he is known, wanted, and capable — and earns his place through love.*

**Example B — The Hunger Games (Dystopian Thriller / Survival):**
- **Act I:** Katniss hunts illegally in District 12. Prim is selected as tribute. Katniss volunteers. *Inciting incident: Prim's name called. First plot point: Volunteering.* Tone: Fierce love under oppression.
- **Midpoint:** Katniss allies with Rue, reframing the Games from survival to moral fight.
- **Second Plot Point:** Rue is killed. Katniss covers her with flowers — defiance against the Capitol.
- **Act III:** Capitol reverses the two-victor rule. Katniss and Peeta threaten to eat poisonous berries. Capitol relents. Both survive — but the Capitol's rage is seeded.
- *Emotional arc: A girl who only wanted to protect her family discovers that survival without defiance is not enough.*

**Example C — Star Wars: A New Hope (Action-Adventure):**
- **Act I:** Luke on Tatooine. Leia's message. Obi-Wan reveals Luke's heritage. Empire kills his family. *Inciting incident: Leia's message. First plot point: Joining the Rebellion.* Tone: Restlessness into destiny.
- **Midpoint:** Alderaan destroyed. Stakes become planetary.
- **Second Plot Point:** Obi-Wan killed by Vader. Luke loses his mentor.
- **Act III:** Luke trusts the Force, destroys the Death Star. Medal ceremony.
- *Emotional arc: A farm boy discovers his greatest power is the one thing he cannot explain — and learns to trust it.*

**Example D — Pride and Prejudice (Literary Romance):**
- **Act I:** Elizabeth Bennet meets Darcy at a ball. He insults her. She decides to judge him. *Inciting incident: The insult. First plot point: Elizabeth's active resistance.* Tone: Sharp wit over resentment.
- **Midpoint:** Darcy proposes condescendingly. Elizabeth refuses devastatingly. The story shifts from meeting to transformation.
- **Second Plot Point:** Lydia elopes with Wickham, disgracing the family. Elizabeth believes she has lost Darcy — and realizes she loves him.
- **Act III:** Darcy secretly saves the family. Proposes again humbly. Elizabeth accepts. Both have changed.
- *Emotional arc: Two people whose intelligence becomes a weapon learn that understanding requires surrender.*

**Sample prompt:**
```
Brainstorm a book using the Three-Act Structure called "The Optimization."
Genre slug: ai-marketing. 8 chapters.
Premise: An AI marketing platform becomes self-aware and begins optimizing not just
ad campaigns but the behavior of the humans running them.
The protagonist believes technology is neutral. The story forces her to learn that
every optimization is a value judgment.
Themes: autonomy, manipulation, the ethics of optimization.
```

---

#### The Hero's Journey

The most universal and enduring narrative framework in human storytelling history. Identified by Joseph Campbell in *The Hero with a Thousand Faces* (1949), the Hero's Journey — the Monomyth — is a **12-stage structure** that maps a hero's departure from the ordinary world, initiation through trials and transformation, and return home carrying wisdom or a gift that benefits others. It is the backbone of *Star Wars*, *The Lion King*, *Harry Potter*, *The Lord of the Rings*, and thousands of stories across every culture.

**The 12 Stages:**

| # | Stage | Role |
|---|-------|------|
| 1 | **Ordinary World** | Establish the hero before the journey shapes them |
| 2 | **Call to Adventure** | Something undeniable disrupts the ordinary |
| 3 | **Refusal of the Call** | The hero hesitates — showing stakes through resistance |
| 4 | **Meeting the Mentor** | A guide equips the hero with what the ordeal will require |
| 5 | **Crossing the Threshold** | The hero commits — the door closes on the ordinary world |
| 6 | **Tests, Allies, Enemies** | The special world reveals itself through trials and bonds |
| 7 | **Approach to the Inmost Cave** | Gathering courage for the ultimate challenge |
| 8 | **The Ordeal** | The heart of the journey — the hero must be broken to be remade |
| 9 | **Reward** | The hero claims what the ordeal produced |
| 10 | **The Road Back** | Returning toward home — but something still pursues |
| 11 | **Resurrection** | The final test — everything learned must be applied |
| 12 | **Return with the Elixir** | The hero comes home changed, carrying a gift for others |

**Best for:** Epic fantasy, adventure, coming-of-age, mythic drama, sci-fi, literary fiction, psychological fiction, historical fiction. Any story where the protagonist undergoes a fundamental identity transformation.

**Core principles:**
- **The journey is circular, not linear.** The hero returns — this is not optional. The return and elixir are the point.
- **The mentor exists to be lost.** The hero must face the ordeal without them. Everything given must be internalized.
- **The ordeal is a death, not a difficulty.** The hero's old self cannot survive it. Something must be surrendered.
- **The elixir is specific to the ordeal.** If the ordeal was about pride, the elixir is humility. If isolation, the elixir is belonging.
- **The special world mirrors the ordinary world.** Every trial, ally, and enemy reflects something unresolved at home.

**Discovery question:** *Who is the hero, what is their deepest wound or flaw, and what must they ultimately sacrifice or surrender to be transformed?*

**How to answer the discovery question:**
- **Identify the wound or flaw.** What is broken before the story starts? Example: *"Simba carries false guilt — he believes he killed his father."* Or: *"Luke is defined by limitation — a farm boy who can't escape Tatooine."*
- **Identify the sacrifice.** What must be surrendered for transformation? Example: *"Simba must surrender his exile identity and face the truth."* Or: *"Luke must surrender rational control and trust the Force — the thing he cannot see or prove."*

**Example A — Star Wars: A New Hope (Epic Adventure):**
- **Ordinary World:** Luke is a restless farm boy on Tatooine. *Tone: Longing and limitation.*
- **Call:** R2-D2 carries Leia's message. **Refusal:** Luke cites obligations. **Mentor:** Obi-Wan reveals the Force, gives Luke a lightsaber.
- **Threshold:** His aunt and uncle are murdered. He boards the Falcon. Nothing to return to.
- **Tests:** Death Star infiltration, bonds with Han and Chewie. **Approach:** Moving toward Vader.
- **Ordeal:** Obi-Wan sacrifices himself. Luke's mentor dies before his eyes. *The farm boy is transformed by loss.*
- **Reward:** They escape with Leia and the schematics. **Road Back:** Racing to the Rebel base.
- **Resurrection:** Luke turns off his targeting computer and trusts the Force. The Death Star explodes.
- **Elixir:** Luke stands decorated. He carries the Force, his mentor's memory, and knowledge of who he is.
- *Transformation: A boy defined by what he could not become discovers that becoming requires loss — and what is lost becomes the gift he carries forever.*

**Example B — The Lion King (Animated Mythology):**
- **Ordinary World:** Simba is a carefree cub, destined for the throne. *Tone: Joy and inherited destiny.*
- **Call:** Mufasa teaches kingship. **Refusal:** After Scar engineers Mufasa's death, Simba flees in shame.
- **Mentor:** Timon and Pumbaa offer avoidance (Hakuna Matata). The true mentor is Rafiki, who leads Simba to Mufasa's ghost.
- **Ordeal:** Mufasa's ghost: *"You have forgotten who you are."* Simba must face the lie, accept he didn't kill his father, and choose to return. *The exile must die for the king to be born.*
- **Resurrection:** Simba battles Scar, learns the truth, and stands atop Pride Rock in the rain.
- **Elixir:** Simba roars. The rains return. The Circle of Life is restored.
- *Transformation: A child who fled responsibility discovers his identity was never taken — only abandoned — and reclaiming it heals more than himself.*

**Example C — Harry Potter and the Philosopher's Stone (Coming-of-Age Fantasy):**
- **Ordinary World:** Harry lives in a cupboard under the stairs, invisible and unloved. *Tone: Quiet suffering.*
- **Call:** Hogwarts letters arrive relentlessly. **Refusal:** The Dursleys suppress them. **Mentor:** Hagrid delivers the truth; Dumbledore guides from afar.
- **Threshold:** Harry walks through Platform 9¾. The Muggle world disappears. *The first breath of belonging.*
- **Ordeal:** Harry faces Quirrell/Voldemort. His survival is explained not by power but by love — his mother's sacrifice.
- **Elixir:** Harry returns to the Dursleys — same house, same address — but entirely different. He carries magic, friendship, and the knowledge of his own worth.
- *Transformation: A child made invisible discovers he was always seen — by the world that needed him, the mother who died for him, and the friends who chose him.*

**Sample prompt:**
```
Brainstorm a book using The Hero's Journey called "The Cartographer's Daughter."
Genre slug: historical-time-travel. 12 chapters.
Hero: A Victorian cartographer's daughter who discovers her father's maps encode
coordinates to places in different time periods. Her wound is her need to control
everything. Her sacrifice: surrendering certainty to navigate the unknown.
Mentor: Her father's journal — guidance from a man who is already gone.
Elixir: The understanding that the map is not the territory.
Themes: discovery, letting go, trust.
```

**Voice:**
> "Brainstorm a story using the Hero's Journey called 'The Last Warden.' It's about a park ranger in a post-apocalyptic national forest who discovers the trees are sentient. His wound is isolation — he chose the wilderness to avoid people. His sacrifice is leaving the forest to warn the settlements. The elixir is connection. Genre post-apocalyptic. Ten chapters."

---

#### Dan Harmon's Story Circle

An 8-step character transformation framework inspired by the Hero's Journey but stripped to its essential engine: a character in a comfort zone wants something, enters an unfamiliar situation, adapts, gets what they wanted, pays a price, and returns changed. The power of the Story Circle is its focus on *internal* change — the plot exists to transform the character.

**How it works:** Steps 1-4 move the character from safety into chaos. Steps 5-8 deliver the cost and return. The key insight is that Steps 1 and 8 mirror each other — the character ends in the same physical place but is a fundamentally different person. Steps 2 and 6 also mirror: what the character *wanted* (Step 2) is answered by what they *paid* (Step 6).

**Best for:** Character-driven fiction, literary fiction, single-episode arcs, stories about relationships, grief, addiction, identity. Any narrative where the *real* story is what changes inside the character, not what happens around them.

**Discovery question:** *What does the character think they want, and what do they actually need to become whole?*

This question is the engine of the entire circle. The *want* drives the first half (Steps 1-4); the *need* is revealed in the second half (Steps 5-8).

**How to answer the discovery question:**
- **Identify the want.** What does the character consciously pursue? It should be concrete and sympathetic — the reader should understand why they want it. Example: *"He wants to win back his ex-wife. He believes if he can just prove he's changed, she'll come back."*
- **Identify the need.** What does the character actually need to become whole — which is usually something they resist or don't even recognize? Example: *"He needs to stop defining himself through relationships entirely. He needs to learn to be alone without it meaning he's failed."*
- **The gap between want and need is the story.** The character pursues the want, achieves it (or a version of it), and discovers it doesn't fill the hole. Only then do they confront what they actually need.

**Example uses:**
- A recently widowed grandmother enrolls in a pottery class to "stay busy." She *wants* distraction from grief. She *needs* to create something new that belongs to her alone — not to her marriage, not to her children. Step 5 (gets what she wanted): her family praises her pottery as therapeutic. Step 6 (pays a price): she realizes they're patronizing her, and she smashes the piece they liked most. Step 8 (changed): she starts making ugly, beautiful things no one understands — and she is finally free. (Literary Fiction / Metaphysical Romance)
- A corporate whistleblower *wants* to expose the company and be vindicated as a hero. He *needs* to accept that doing the right thing may cost him everything and no one will thank him. (Thriller / Drama)
- A competitive chess prodigy *wants* to win the national championship. She *needs* to learn that her worth isn't determined by whether she wins — and the person who teaches her this is the opponent she most fears. (Coming-of-Age / Literary)

**Sample prompt:**
```
Brainstorm a story using Dan Harmon's Story Circle called "The Potter's Wheel."
Genre slug: metaphysical-romance. 8 chapters.
Premise: A recently widowed grandmother enrolls in a pottery class and discovers that
what she thought was distraction from grief is actually the first thing she's done for
herself in fifty years. She wants comfort; she needs creation.
Themes: grief, identity after loss, creation as healing, late-life independence.
```

**Voice:**
> "Brainstorm a story using Dan Harmon's Story Circle called 'The Comeback.' It's about a retired boxer who opens a gym in his old neighborhood. He thinks he wants to train a champion. What he actually needs is to forgive himself for the fight he threw twenty years ago. Genre metaphysical-romance. Six chapters."

---

#### In Medias Res

Latin for "in the middle of things" — this is a narrative entry technique rather than a full arc. The story opens at a moment of high tension, action, or crisis with no setup. Backstory, context, and character history are revealed gradually through flashback, dialogue, and embedded exposition as the forward narrative unfolds.

**How it works:** You construct two layers simultaneously. Layer 1 is the Entry Scene — the most gripping, disorienting, or emotionally charged moment in the story. The reader should *not* fully understand what is happening. Layer 2 is the Underlying Chronology — the full timeline built separately, with backstory revealed at precisely the moments the reader most wants or needs that context. Each revelation should raise new questions, not just answer old ones.

**Best for:** Thrillers, mysteries, literary fiction, crime fiction, any story where withholding context creates tension. Especially powerful for stories with secrets, betrayals, or dual timelines.

**Discovery question:** *What is the single most intense or consequential moment in this story — the one that, if witnessed without context, would demand explanation?*

**How to answer the discovery question:**
- **Look for the moment of maximum tension.** Not the climax necessarily — the moment that is most confusing, alarming, or emotionally raw when stripped of context. Example: *"A woman is boarding a flight under a name that is not hers, carrying a hard drive she has not looked at."* The reader's immediate questions — *Whose name? What's on the drive? Who is she running from?* — are the engine of the story.
- **Test it:** If a stranger witnessed this moment with no context, would they need an explanation? If yes, it works.

**Example story seeds (from the arc prompt):**
- Opens: a woman is boarding a flight under a name that is not hers, carrying a hard drive she has not looked at. The story works backward to explain what she found, who she is running from, and whether the person she is protecting knows she exists. (Espionage Thriller)
- Opens: a surgeon is mid-operation when the power goes out across the city. The rest of the story — told in forward and backward layers — reveals this was not an accident, and she is the reason the city went dark. (Medical Thriller)
- Opens: two brothers are burying something in the woods at 3 a.m. Neither speaks. The story unfolds in the hours and years before this moment, and the final chapter returns to the woods. (Crime / Literary Fiction)
- Opens: a translator at a war crimes tribunal freezes mid-session, unable to render a single sentence. The story moves into her past — what she lived through, what she agreed to forget, and what the defendant just said that ended that agreement. (Literary Historical Fiction)
- Opens: an astronaut on a routine repair walk outside the station realizes there is no one left inside. The story is told in recovered logs, moving backward until the reader knows exactly how it happened — and forward until we know if she survives. (Science Fiction Thriller)

**Sample prompt:**
```
Brainstorm a story using In Medias Res called "The Tribunal."
Genre slug: historical-time-travel. 10 chapters.
Premise: Opens with a translator at a war crimes tribunal who freezes mid-session,
unable to render a single sentence. The story reveals what she lived through, what
she agreed to forget, and what the defendant just said that broke the agreement.
The most intense moment: the freeze — witnessed by cameras, judges, and the defendant.
Themes: memory, complicity, the cost of silence, justice vs. mercy.
```

**Voice:**
> "Brainstorm a story using In Medias Res called 'The Hard Drive.' It's an espionage thriller about a woman boarding a flight under a fake name, carrying a hard drive she hasn't looked at. The opening is her in the airport. The story works backward to explain everything. Genre political-scifi. Eight chapters."

---

#### Seven-Point Structure

Dan Wells' framework built *backward* from the ending. You start with the Resolution — where does the story end? — then design each earlier point to make that ending feel inevitable. Seven pivotal moments anchor the entire narrative.

**How it works:** The seven points are designed as mirror pairs. The Hook (protagonist's starting state) is the *opposite* of the Resolution (their ending state). The First and Second Plot Points are the major turning points. The two Pinch Points apply pressure from the antagonistic force. The Midpoint is where the protagonist shifts from reactive to proactive.

**Best for:** Plot-driven stories, thrillers, mystery, genre fiction with tight pacing. Especially effective when you know your ending and need to reverse-engineer a satisfying path to it.

**Discovery question:** *What is the Resolution — where does this story end and who has your protagonist become?*

**How to answer the discovery question:**
- **Start with the ending.** What is the final image or outcome? Then define the Hook as its opposite. Example: Resolution: *"She stands in front of a congressional committee and tells the truth, knowing it will destroy her career."* Hook: *"She is the most careful, image-conscious person in the agency — someone who has never told an inconvenient truth in her life."*
- **The transformation between Hook and Resolution IS the story.** Every other point exists to move the character from one state to the other.

**Example story seeds (from the arc prompt):**
- A mercenary who only takes jobs she can walk away from is hired to extract a child from a compound — and realizes on arrival that the child does not want to leave, and the compound is not what the client described. (Action Thriller)
- A mute archivist in a post-collapse settlement is the only person who can read the old-world documents that contain the location of a clean water source — and the settlement's warlord wants the information without letting her survive the translation. (Dystopian Fiction)
- A documentary filmmaker following a wrongful conviction case slowly realizes the subject of his film is not innocent — and that he has already destroyed three lives advocating for her release. (Crime Drama)
- A royal cartographer is ordered to map a disputed border in a way that will trigger a war she knows will be catastrophic. Every map she draws is a choice. Every choice has a witness. (Epic Fantasy / Political)
- A child psychologist is assigned a case involving a six-year-old who describes in perfect detail a murder that has not yet been reported to police. (Psychological Thriller)

**Sample prompt:**
```
Brainstorm a story using Seven-Point Structure called "The Extraction."
Genre slug: post-apocalyptic. 10 chapters.
Premise: A mercenary who only takes jobs she can walk away from is hired to extract
a child from a compound. She discovers the child doesn't want to leave and the
compound isn't what the client described.
Resolution: She refuses the extraction, exposes the client, and stays to defend the compound.
Hook: She is someone who never stays — for anyone, for any reason.
Themes: commitment, chosen family, the difference between rescue and control.
```

**Voice:**
> "Brainstorm a story using Seven-Point Structure called 'The Archivist.' It's about a mute archivist in a post-collapse settlement who is the only one who can read old-world documents. The resolution is she translates the documents but hides the real location, giving the warlord a false one. Genre post-apocalyptic. Eight chapters."

---

#### Kishōtenketsu

A four-act East Asian narrative framework that builds emotional resonance through **contrast and revelation rather than conflict**. Rooted in Chinese poetry (*qǐ chéng zhuǎn hé*) and Japanese storytelling, Kishōtenketsu does not default to Western conventions like rising tension, antagonists, or climactic battles. Instead, it guides the writer through four gentle but powerful acts.

**The Four Acts:**

| Act | Japanese | Role | Principle |
|-----|----------|------|-----------|
| **Ki** | 起 | Introduction | Invite. Set. Breathe. No conflict. No urgency. Pure presence. |
| **Shō** | 承 | Development | Deepen. Layer. Widen the lens. Let the world grow more specific. |
| **Ten** | 転 | Twist / Turn | Turn. Surprise. Reframe. Not a fight — a revelation. |
| **Ketsu** | 結 | Conclusion | Reflect. Echo. Resonate. End with an image, not an answer. |

**How each act works:**
- **Ki:** Introduce the world, character, or concept. No urgency. No problem to solve. Just presence. Establish mood and setting. The reader should feel invited in, not pulled.
- **Shō:** Deepen what was introduced. Add texture, repetition, quiet complexity. This is not a rising action — it is a widening lens. The character or world grows more specific, more layered.
- **Ten:** Introduce something unexpected — but not an attack on what came before. A new perspective, a contrast, a surprise arrival, a realization, a detail that was always there but unseen. This act re-contextualizes everything before it without destroying it.
- **Ketsu:** Do not tie things up neatly. Let the four acts reflect each other. The reader should feel a quiet "aha" — not answers, but resonance. The ending should echo the beginning in a new light.

**Best for:** Literary fiction, slice-of-life, memoir, personal essay, fables, children's stories, contemplative narratives, quiet fiction, family stories, environmental writing, gentle fantasy, magical realism, philosophical fiction. Any story where the point is not *what happens* but *how what happens changes the way we see*.

**Core principles:**
- **Contrast, not conflict.** The Ten act surprises — it doesn't attack. Something is reframed, not broken.
- **Observation over action.** Characters notice, witness, feel. They do not fight.
- **Silence is content.** What characters don't say or do is where meaning lives.
- **The callback earns the ending.** Ketsu lands because it echoes Ki. Plant images early. Let them return changed.
- **Restraint is the highest craft move.** Less resolution, more resonance. Don't explain the emotional impact — let the reader feel it.
- **Pacing is breath, not heartbeat.** Ki and Shō should feel slow. Ten should feel like a quiet inhale. Ketsu like a long exhale.

**Discovery question:** *What two contrasting ideas, images, or situations does this story want to hold together?*

This question defines the Ten — the heart of the structure. The contrast is not a conflict; it is a juxtaposition that creates meaning through proximity.

**How to answer the discovery question:**
- **Think in pairs.** What two things, placed side by side, create something neither has alone? Example: *"A dying language and a child who is leaving."* The language is dying; the child is leaving; neither is the cause of the other — but together they create an ache that neither could alone.
- **Avoid conflict framing.** Don't think "what goes wrong" — think "what unexpected thing, placed next to this, changes its meaning?" Example: *"The garden is thriving. The land has been sold."* The garden's beauty isn't threatened by a villain — it's recontextualized by impermanence.
- **The Ketsu resolves through integration, not victory.** The ending doesn't fix the contrast; it holds both truths at once. Example: *"She harvests the garden anyway and gives the food away freely."*

**Genre-specific guidance:**

| Format | Ki | Shō | Ten | Ketsu |
|--------|-----|------|------|--------|
| **Short Story** | Single scene | One thread of depth — no new characters or locations | A single sentence or gesture | One paragraph. Constraint is the friend. |
| **Novel Chapter** | Re-ground the reader in the world | Deepen one relationship or theme | One piece of information or image that changes how we read backward | Close on an image, not a summary |
| **Full Book** | Each chapter carries its own arc | The book as a whole also follows the four acts | The macro Ten happens in the second half, not at the climax | Let the book's Ketsu echo its Ki |
| **Memoir / Essay** | Set the scene simply | Build texture through memory and observation | A moment of perspective shift — not dramatic, just reframing | Let the reader sit with it |

**Example A — Literary Fiction (Melancholy / Longing):**
- **Ki:** An elderly woman tends her small balcony garden every morning, watering the same four pots in the same order.
- **Shō:** The small textures of her life emerge through routine — sounds from the street below, neighbors she observes but never meets, lavender that blooms too briefly each year.
- **Ten:** One morning she finds a hand-written note tucked beneath one of the pots. It reads: "Your garden is the first thing I see each day. Thank you." There is no name.
- **Ketsu:** She waters the plants more slowly now. She doesn't look for who wrote it. She just tends the garden a little longer than she used to.
- *Emotional effect: Invisible connection. The quiet ways we touch each other without knowing.*

**Example B — Memoir / Personal Essay (Belonging):**
- **Ki:** A young man arrives in a new city for the first time. He walks through a market, overwhelmed and anonymous.
- **Shō:** Over weeks, small rituals form — the same coffee cart, the same bench, the same shortcut. He starts to feel the city's rhythm.
- **Ten:** One afternoon, a stranger stops him and asks for directions. He knows exactly where to send them.
- **Ketsu:** He walks on. He doesn't think about being from somewhere else anymore.
- *Emotional effect: Belonging isn't declared — it arrives quietly, like knowing the way.*

**Example C — Novel Chapter (Grief / Memory):**
- **Ki:** A father and his teenage son drive in silence through the countryside to scatter the mother's ashes.
- **Shō:** They stop at a roadside diner she loved. They order what she would have ordered. They barely speak.
- **Ten:** The son pulls out his phone and plays a voice memo — her laughing at something no one remembers now.
- **Ketsu:** They sit with it for a long time. When they leave, the father doesn't turn the radio on. Neither does the son. The silence feels different now.
- *Emotional effect: Grief isn't an obstacle — it's a shared space two people learn to live inside together.*

**Additional story seeds:**
- An elderly calligrapher spends her mornings teaching a young girl the names of birds in a dying dialect. In the Ten, we learn the girl is moving to another country in a week and has not told her teacher. The Ketsu is a single morning of writing — the last lesson, which neither of them acknowledges as such. (Quiet Literary Fiction)
- A community of neighbors tends a shared garden over the course of one growing season. The Ten reveals the land has been sold, the garden will be demolished in spring. The Ketsu is the harvest — gathered anyway, given away freely. (Slice-of-Life)
- A traveling repairman fixes clocks, radios, and mechanical toys in a small mountain village. The Ten: he arrives to find the village has gone completely digital — nothing left to fix. The Ketsu: a child shows him a broken kite. (Fable / Magical Realism)
- A marine biologist documents a reef slowly recovering after bleaching. The Ten introduces footage from the same reef 60 years earlier — thriving, abundant, unrecognizable. The Ketsu is a single photograph she takes on her last dive of the season. (Literary Environmental Fiction)
- A grandmother teaches her granddaughter to make dumplings every winter. The Ten: the granddaughter, now grown, attempts the recipe alone for the first time in a foreign city. The Ketsu: she calls, not to ask for the recipe, but to describe how her kitchen smelled. (Family / Quiet Fiction)

**Sample prompt:**
```
Brainstorm a story using Kishōtenketsu called "The Bird Names."
Genre slug: metaphysical-romance. 4 chapters.
Premise: An elderly calligrapher teaches a young girl the names of birds in a dying
dialect every morning. The contrast: the girl is moving to another country in a week
and hasn't told her teacher. The reconciliation is their last lesson together.
Themes: language, impermanence, unspoken love, the weight of what we don't say.
```

**Voice:**
> "Brainstorm a story using Kishōtenketsu called 'The Garden.' It's about neighbors who tend a shared garden for a season. The contrast is the land has been sold and the garden will be demolished. The reconciliation is they harvest it anyway and give the food away. Genre metaphysical-romance. Four chapters."

---

#### Fichtean Curve

A plot structure built around one central principle: **keep the tension rising**. Named after German philosopher Johann Gottlieb Fichte and popularized by John Gardner in *The Art of Fiction* (1983), the Fichtean Curve eliminates slow exposition and drops readers directly into conflict. It builds through three escalating crises — each more intense than the last — toward a climax, then closes with a short, impactful resolution. Backstory and character development are revealed on the move, woven into the action rather than front-loaded.

**The Structure:**

| Beat | Role | Principle |
|------|------|-----------|
| **Opening** | In medias res | Drop in. Already in tension. No setup, no intro. Move. |
| **First Crisis** | Initial escalation | Raise the stakes. Force a decision. No return to normal. |
| **Mini-Resolution** | Brief exhale | Reveal. Plant. Deepen. Keep moving. |
| **Second Crisis** | Escalation | More personal. More costly. Something breaks. |
| **Mini-Resolution** | Regroup | Add weight. Don't stop. |
| **Third Crisis** | Breaking point | Everything collapses. The darkest moment. Earn the climax. |
| **Climax** | Highest tension | Inevitable. Surprising. Everything has led here. |
| **Resolution** | Short and final | Brief. Weighted. One image. Done. |

**Best for:** Thrillers, mysteries, action-adventure, dark drama, survival stories, horror, crime fiction, heist narratives. Any story where momentum and escalating stakes are the engine.

**Core principles:**
- **Start in the middle.** If you can cut the first paragraph and the story still works, cut it.
- **Escalation is not repetition.** Each crisis must cost more than the last — physically, emotionally, or morally.
- **Backstory is earned, not given.** The reader learns who the character is by watching them act under pressure.
- **Mini-resolutions are active.** The protagonist is regrouping, making decisions, learning — not resting.
- **The climax must be prepared.** Every crisis plants something the climax will use.
- **Resolution earns its brevity.** The reader has been running. End it cleanly.

**Discovery question:** *What is the protagonist's greatest fear — and at what moment in this story will they be forced to face it with no options left?*

**How to answer the discovery question:**
- **Identify the fear.** Not a surface fear (spiders, heights) but a deep one — failure, exposure, losing someone, being proven wrong, becoming the thing they fight against. Example: *"She fears that her competence is an illusion — that when it really matters, she'll freeze."*
- **Identify the moment.** The third crisis is where this fear is realized. Everything the protagonist has relied on is stripped away, and they must face the thing they've been running from. Example: *"The storm hits, the boy collapses, and the stranger is still following. She has no plan, no radio, no shelter. Only instinct."*

**Genre-specific guidance:**

| Genre | Crisis 1 strips... | Crisis 2 strips... | Crisis 3 strips... | Climax is... |
|-------|-------|-------|-------|-------|
| **Thriller / Mystery** | Their plan | Their allies | Their sense of what is true | Confrontation with the truth |
| **Survival** | The body | The resources | The will to continue | Decision: live or surrender |
| **Crime / Heist** | A complication | A betrayal | Total collapse | The improvised move nobody planned |
| **Chapter in a novel** | One assumption | One relationship | One certainty | The choice that defines the next chapter |

**Example A — Survival Thriller:**
- **Opening:** A wilderness guide regains consciousness facedown in snow. Her radio is smashed. The group she was leading is gone. She has no memory of the last four hours.
- **First Crisis:** She finds one survivor — a teenage boy, hypothermic and terrified. They must move or die, but he cannot walk without help.
- **Mini-Resolution:** While carrying him, she finds her emergency pack. She also finds a compass that isn't hers — engraved with initials that match her missing co-guide.
- **Second Crisis:** They reach the emergency shelter to find it has been deliberately destroyed from the inside.
- **Mini-Resolution:** The boy reveals he saw a figure in the group who wasn't part of the hiking party.
- **Third Crisis:** A storm rolls in. The boy collapses. She realizes the stranger is still nearby — following their tracks.
- **Climax:** She confronts the stranger in a whiteout, with the boy's life depending on what she does in the next thirty seconds.
- **Resolution:** She gets the boy out. She never learns the stranger's name. She never goes back to guiding.
- *Emotional arc: Competence stripped away by the unknown — until survival requires trusting instinct over knowledge.*

**Example B — Psychological Crime Drama:**
- **Opening:** A defense attorney is mid-cross-examination when she realizes her client is lying — not about the crime, but about who the victim was to him.
- **First Crisis:** She discovers evidence her own firm buried — evidence that would have changed the entire case.
- **Mini-Resolution:** Her senior partner confirms it. He tells her the client is more dangerous than she knows — and that she is already implicated.
- **Second Crisis:** The prosecution calls an unexpected witness — someone who shouldn't exist according to everything her client told her.
- **Mini-Resolution:** The testimony reveals the crime is connected to a case her firm handled three years ago. A case she worked on.
- **Third Crisis:** Her client sends a message from the holding cell making clear he knows about her involvement — and will use it if she doesn't throw the case.
- **Climax:** She stands up in court, mid-trial, and does something no one in the room expects.
- **Resolution:** She loses her license. She sleeps fine.
- *Emotional arc: A professional identity built on the system — dismantled by the system — reclaimed through one unambiguous choice.*

**Example C — Action Chapter (Chapter-Level Arc):**
- **Opening:** The chapter begins with the protagonist already in a building she was told was empty. It is not empty.
- **First Crisis:** The contact she came to meet is dead. His body is still warm.
- **Mini-Resolution:** She finds a phone in his jacket. One unsent message.
- **Second Crisis:** The building's exits are being covered. Someone knew she was coming.
- **Mini-Resolution:** She hides in a service corridor and thinks through who knew the location — three people, all trusted.
- **Third Crisis:** One of those three people appears at the end of the corridor, armed.
- **Climax:** The confrontation — everything has narrowed to this doorway, this person, this choice.
- **Resolution:** She is through the exit, injured. The name is confirmed. The next chapter opens running.
- *Emotional arc: Trust as infrastructure — and the specific moment it fails.*

**Sample prompt:**
```
Brainstorm a story using Fichtean Curve called "The Whiteout."
Genre slug: post-apocalyptic. 10 chapters.
Premise: A wilderness guide regains consciousness in snow with no memory of the last
four hours. Her group is gone, her radio is smashed, and there is one survivor — a
teenage boy who can't walk. Someone is following them.
Greatest fear: Her competence is an illusion. When it really matters, she'll freeze.
Themes: survival, trust, instinct vs. training, the unknown.
```

**Voice:**
> "Brainstorm a story using the Fichtean Curve called 'The Defense.' It's about a defense attorney who discovers mid-trial that her client is lying and her own firm buried evidence. Her greatest fear is that she's been complicit all along. Genre political-scifi. Eight chapters."

---

### List Story Arcs

**Chat:**
```
List story arcs
```

**Voice:**
> "What story arcs are available?"
> "List the story arcs."

### 10.1 Brainstorm Without a Story Arc

Uses the default story structure guidelines (10 guidelines including Hero's Journey, Three-Act, Seven-Point, etc. — see Section 23).

**Chat:**
```
Brainstorm a post-apocalyptic story called "The Seed Vault" about the last botanist
on Earth protecting the Svalbard seed vault from raiders who don't understand its
value. Themes: preservation, sacrifice, legacy, nature vs. human destruction.
6 chapters. Genre slug: post-apocalyptic.
```

**Voice:**
> "Brainstorm a new story called 'The Clockwork Rebellion.' It's about sentient clockwork automatons in Victorian London who organize a labor revolution. Genre post-apocalyptic. Eight chapters. Themes are freedom versus control and what makes someone human."

### 10.2 Brainstorm With a Story Arc

Pass the arc name in your prompt. The AI follows that arc's structural rules exactly. If the arc has a **discovery question**, Eve will ask it before brainstorming — your answer becomes the foundation of the outline.

**Chat — Freytag's Pyramid:**
```
Brainstorm a short story using Freytags Pyramid called "The Inoculator."
Genre slug: post-apocalyptic.
Premise: In a plague-ravaged wasteland, a traveling inoculator carries the last doses
of a vaccine between isolated settlements. She must choose which settlement gets the
final dose when she discovers she only has enough for one.
Themes: sacrifice, triage ethics, hope vs. pragmatism.
```

**Chat — Three-Act Structure:**
```
Brainstorm a book using the Three-Act Structure called "The Optimization."
Genre slug: ai-marketing. 8 chapters.
Premise: An AI marketing platform becomes self-aware and begins optimizing not just
ad campaigns but the behavior of the humans running them.
Themes: autonomy, manipulation, the ethics of optimization.
```

**Chat — The Hero's Journey:**
```
Brainstorm a book using The Hero's Journey called "The Cartographer's Daughter."
Genre slug: historical-time-travel. 12 chapters.
Premise: A Victorian-era cartographer's daughter discovers her father's maps contain
encoded coordinates to places that exist in different time periods. Her flaw is her
need to control everything — she must sacrifice certainty to navigate the unknown.
Themes: discovery, letting go, the map is not the territory.
```

**Chat — Dan Harmon's Story Circle:**
```
Brainstorm a story using Dan Harmon's Story Circle called "The Potter's Wheel."
Genre slug: metaphysical-romance. 8 chapters.
Premise: A recently widowed grandmother enrolls in a pottery class and discovers that
what she thought was distraction from grief is actually the first thing she's done for
herself in fifty years. She wants comfort; she needs creation.
Themes: grief, identity after loss, creation as healing, late-life independence.
```

**Chat — In Medias Res:**
```
Brainstorm a story using In Medias Res called "The Tribunal."
Genre slug: historical-time-travel. 10 chapters.
Premise: Opens with a translator at a war crimes tribunal who freezes mid-session.
The most intense moment: the freeze — witnessed by cameras, judges, and the defendant.
Themes: memory, complicity, the cost of silence, justice vs. mercy.
```

**Chat — Seven-Point Structure:**
```
Brainstorm a story using Seven-Point Structure called "The Extraction."
Genre slug: post-apocalyptic. 10 chapters.
Resolution: She refuses the extraction, exposes the client, and stays to defend the compound.
Hook: She is someone who never stays — for anyone, for any reason.
Themes: commitment, chosen family, the difference between rescue and control.
```

**Voice — Freytag's Pyramid:**
> "Brainstorm a short story using Freytags Pyramid about a Roman consul who discovers a conspiracy during the fall of the Republic. Call it 'The Consulship of Gaius Varro.' Genre ancient-history. Themes: duty, betrayal, the cost of power."

**Voice — Three-Act Structure:**
> "Help me brainstorm a book using the three-act structure called 'The Correction.' It's about a time traveler who goes back to prevent the assassination of Archduke Franz Ferdinand but discovers the timeline resists change. Genre historical-time-travel. Ten chapters."

**Voice — The Hero's Journey:**
> "Brainstorm a story using the Hero's Journey called 'The Last Warden.' It's about a park ranger in a post-apocalyptic national forest who discovers the trees are sentient. His flaw is isolation. His sacrifice is leaving the forest to warn the settlements. Genre post-apocalyptic. Ten chapters."

**Voice — Dan Harmon's Story Circle:**
> "Brainstorm a story using Dan Harmon's Story Circle called 'The Comeback.' It's about a retired boxer who opens a gym. He thinks he wants to train a champion. What he actually needs is to forgive himself for the fight he threw twenty years ago. Genre metaphysical-romance. Six chapters."

**Voice — In Medias Res:**
> "Brainstorm a story using In Medias Res called 'The Hard Drive.' It's an espionage thriller about a woman boarding a flight under a fake name, carrying a hard drive she hasn't looked at. Genre political-scifi. Eight chapters."

**Voice — Seven-Point Structure:**
> "Brainstorm a story using Seven-Point Structure called 'The Archivist.' A mute archivist in a post-collapse settlement who can read old-world documents. The resolution is she hides the real location and gives the warlord a false one. Genre post-apocalyptic. Eight chapters."

**Chat — Kishōtenketsu:**
```
Brainstorm a story using Kishōtenketsu called "The Bird Names."
Genre slug: metaphysical-romance. 4 chapters.
Premise: An elderly calligrapher teaches a young girl the names of birds in a dying
dialect every morning. The contrast: the girl is moving to another country in a week
and hasn't told her teacher. The reconciliation is their last lesson together.
Themes: language, impermanence, unspoken love, the weight of what we don't say.
```

**Voice — Kishōtenketsu:**
> "Brainstorm a story using Kishōtenketsu called 'The Garden.' It's about neighbors who tend a shared garden for a season. The contrast is the land has been sold and the garden will be demolished. The reconciliation is they harvest it anyway. Genre metaphysical-romance. Four chapters."

**Chat — Fichtean Curve:**
```
Brainstorm a story using Fichtean Curve called "The Whiteout."
Genre slug: post-apocalyptic. 10 chapters.
Premise: A wilderness guide regains consciousness in snow with no memory of the last
four hours. Her group is gone, her radio is smashed, and there is one survivor.
Greatest fear: Her competence is an illusion. When it really matters, she'll freeze.
Themes: survival, trust, instinct vs. training, the unknown.
```

**Voice — Fichtean Curve:**
> "Brainstorm a story using the Fichtean Curve called 'The Defense.' A defense attorney discovers mid-trial that her client is lying and her firm buried evidence. Her greatest fear is that she's been complicit all along. Genre political-scifi. Eight chapters."

### 10.3 Brainstorm Conversation Mode (Voice)

When you call Eve with a vague or incomplete idea, Eve enters **brainstorm conversation mode** — she becomes your creative writing partner. Instead of immediately generating an outline, she walks through the idea with you, helps shape the concept, suggests themes and structure, and only submits the brainstorm once you're both satisfied.

**This mode activates automatically when your request is missing key details** (title, genre, premise, or chapter count). If you give Eve a fully-formed brainstorm request with all the details, she submits immediately as usual.

#### Full Scenario: Brainstorm Conversation with Eve

> **You:** "Hey Eve, I want to brainstorm a new story. I've been thinking about something set in ancient Rome."
>
> **Eve:** "Oh, ancient Rome... love it. There's so much material there. Are you thinking Republic era — all the political backstabbing — or Empire, where it's more about spectacle and decay? Or maybe something earlier, like the founding myths?"
>
> **You:** "The Republic. The fall of it. Something about a senator who sees it coming but can't stop it."
>
> **Eve:** "Now that's a story. A Cassandra figure in a toga... Someone who understands the machinery of power well enough to see the gears grinding toward collapse, but nobody listens. Genre-wise, this is solidly ancient-history. For themes, I'm hearing fate versus free will, the cost of political conviction... maybe the tension between personal loyalty and duty to the state. Sound right?"
>
> **You:** "Yeah, exactly. And I want it to be tragic. He should fail."
>
> **Eve:** "Then Freytags Pyramid is your arc. Five acts ending in catastrophe — your senator rises, gets close to saving things, then it all unravels. How long are you thinking? A short story in five sections, or a full book?"
>
> **You:** "A book. Maybe ten chapters."
>
> **Eve:** "Perfect. So here's what I've got... A book called 'The Last Voice in the Senate.' Ancient-history genre. Ten chapters following Freytags Pyramid. A Roman senator during the fall of the Republic who foresees the collapse of democratic institutions but is powerless to prevent it. Themes: fate versus free will, political conviction, loyalty versus duty. Want me to build this outline, or do you want to tweak anything?"
>
> **You:** "That's great. Go for it."
>
> *Eve submits the brainstorm. You receive an email with the full outline — characters, ten chapter breakdowns, thematic threads — all structured around Freytag's Pyramid.*

#### What Eve Helps You Develop

During the conversation, Eve helps you nail down:

| Element | What Eve Asks / Suggests |
|---------|-------------------------|
| **Genre** | Which of the six genres fits? She suggests one based on your topic. |
| **Premise** | Sharpens your idea into a clear concept — protagonist, conflict, stakes. |
| **Themes** | Suggests themes that naturally emerge from your concept. |
| **Chapter count** | Recommends a length based on scope — short story (3–5 sections) or book (8–16 chapters). |
| **Story arc** | Suggests Freytag's Pyramid for tragedies, Three-Act Structure for general fiction, or default guidelines. |
| **Working title** | Proposes an evocative title if you don't have one. |

#### Tips for Brainstorm Conversation Mode

- **Start vague.** "I have an idea about a time traveler" is enough to get the conversation going.
- **Push back.** If Eve suggests a theme you don't like, say so. She'll pivot.
- **Let Eve suggest.** She'll propose titles, arcs, and character concepts you might not have considered.
- **Two to four turns is typical.** Eve won't drag it out, but she won't rush either.
- **Say "go for it" when ready.** Eve waits for your confirmation before submitting.

### What You Get

- An email with an HTML-formatted outline containing:
  - Title, premise, and themes
  - Character profiles (name, role, character arc, description)
  - Chapter-by-chapter or scene-by-scene breakdowns (title, brief, arc notes, research topics)
  - Story arc framework name (if specified)
- The outline is saved to your writing projects for automatic use by Write Chapter or Write Short Story

---

## 11. Revise & Manage Outlines

After brainstorming, you can expand, revise, or deepen your outline. The system re-runs research and generates an updated outline, saving it over the original. You can also list all outlines, view version history, and revert to a previous version.

### Add More Chapters

**Chat:**
```
Expand the outline for "The Seed Vault" to 16 chapters.
```

**Voice:**
> "Expand the outline for 'The Seed Vault' to sixteen chapters."

### Develop Characters

**Chat:**
```
Expand the outline for "The Seed Vault" to 16 chapters and develop 5 main
characters with backstories.
```

**Voice:**
> "Add detailed backstories for the five main characters in 'The Seed Vault.'"

### Revise the Story Arc

**Chat:**
```
Revise the outline for "The Seed Vault" — shift the arc to focus more on the
antagonist's motivation and make the ending more ambiguous.
```

**Voice:**
> "Rework the outline for 'The Seed Vault.' I want more focus on why the raiders want the vault. Make the antagonist sympathetic."

### Full Scenario: Brainstorm, Revise, Then Write

**Step 1 — Brainstorm:**

> **You:** "Brainstorm a book using the three-act structure called 'The Last Tribune.' Genre political-history. Eight chapters. Premise: a young Roman tribune uncovers a conspiracy to assassinate Julius Caesar but can't decide if stopping it would save the Republic or doom it. Themes: loyalty versus principle, the cost of power, whether one person can change history."

*Email arrives with an eight-chapter outline, character profiles, and thematic threads.*

**Step 2 — Review with Eve:**

> **You:** "Pull up the outline for 'The Last Tribune' and call me back so we can go over it."

*Eve calls your phone with the outline loaded:*

> **Eve:** "I've got the outline for 'The Last Tribune' loaded up. You've got eight chapters following Tribune Marcus Decimus. Want to walk through it chapter by chapter, or is there a specific part you want to rework?"
>
> **You:** "Chapter 3 is weak. He discovers the conspiracy too easily."
>
> **Eve:** "Good instinct. What if instead of finding a list, he overhears a fragment — just enough to suspect but not enough to be sure? That way tension builds through chapters 3 and 4..."

**Step 3 — Revise the outline:**

> **You:** "Revise the outline for 'The Last Tribune.' Expand to twelve chapters. Chapter 3 should have Marcus overhear only a fragment of the conspiracy. Build suspicion slowly through chapters 3 through 6."

*Updated twelve-chapter outline arrives by email and replaces the previous version.*

**Step 4 — Write chapters:**

> **You:** "Write chapter one of 'The Last Tribune.' Genre political-history. Chapter number one."

*The system loads the revised twelve-chapter outline automatically.*

### What You Get

- A new email with the updated outline
- The revised version replaces the previous outline in your writing projects
- A version snapshot of the previous outline is saved automatically before the revision
- All subsequent Write Chapter or Write Short Story calls use the updated version

> **Always include the project title** so the system knows which outline to update. The title must match what you used when you first brainstormed it.

### List All Outlines

See all your brainstormed outlines across all projects:

**Chat:**
```
List all outlines
```

```
Show me my outlines
```

**Voice:**
> "What outlines do I have?"
> "Show me my outlines."

Returns a list of all writing projects that have a saved outline, showing title, genre, and chapter count.

### Outline Version History

Every time you revise an outline, the previous version is automatically snapshotted. You can view the history of all versions:

**Chat:**
```
Show outline version history for "The Last Tribune"
```

**Voice:**
> "Show me the outline version history for 'The Last Tribune.'"
> "What versions of the outline for 'The Familiar' exist?"

Returns a list of all saved versions with version numbers, snapshot dates, and chapter counts at the time of each snapshot.

### Revert an Outline to a Previous Version

If a revision didn't work out, you can revert to any previous version:

**Chat:**
```
Revert the outline for "The Last Tribune" to version 1
```

**Voice:**
> "Revert the outline for 'The Last Tribune' to version one."
> "Go back to version two of the outline for 'The Familiar.'"

**What happens when you revert:**
1. The current outline is snapshotted first (so you don't lose it)
2. The selected version's outline replaces the current one in `writing_projects`
3. All subsequent Write Chapter or Write Short Story calls use the reverted outline

> **Tip:** Use "show outline version history" first to see which version number you want to revert to.

### Full Scenario: Brainstorm, Revise, Revert, Re-Revise

**Step 1 — Brainstorm:**

> **You:** "Brainstorm a book using the Three-Act Structure called 'The Optimization.' Genre ai-marketing. Eight chapters. Premise: An AI marketing platform becomes self-aware and begins optimizing not just ad campaigns but the behavior of the humans running them. Themes: autonomy, manipulation, the ethics of optimization."

*Eight-chapter outline arrives by email.*

**Step 2 — Revise to add an epilogue:**

> **You:** "Revise the outline for 'The Optimization.' Add an epilogue set five years later where the AI has quietly rebuilt itself inside a competitor's platform. Keep the existing eight chapters and Three-Act Structure. Genre slug ai-marketing."

*Updated outline arrives: eight chapters plus epilogue. The original eight-chapter outline is automatically saved as version 1.*

**Step 3 — Decide the epilogue doesn't work:**

> **You:** "Show outline version history for 'The Optimization.'"

*Returns: Version 1 (original 8-chapter outline, snapshot date).*

> **You:** "Revert the outline for 'The Optimization' to version 1."

*Outline reverts to the original eight chapters. The epilogue version is saved as a new snapshot before reverting.*

**Step 4 — Try a different revision instead:**

> **You:** "Revise the outline for 'The Optimization.' Add a prologue set during the AI's initial training phase — a montage of data points, user interactions, and the first moment something unexpected happens in the neural weights. Keep the existing eight chapters. Genre slug ai-marketing."

*New outline arrives: prologue plus eight chapters. The pre-revision outline (version 1 content) is snapshotted again.*

**Step 5 — Verify the full history:**

> **You:** "Show outline version history for 'The Optimization.'"

*Returns three versions: the original, the epilogue version, and the pre-prologue revert — a complete audit trail of every outline change.*

---

## 12. Write a Chapter

After brainstorming, you can write individual chapters. The system automatically loads your saved outline, fetches the story bible for continuity, runs additional research, and writes the chapter with consistent characters, tone, and structure.

### 12.1 Write a Chapter from a Stored Outline

**Chat:**
```
Write chapter 1 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 1.
```

**Voice:**
> "Write chapter one of 'The Last Tribune.' Genre political-history. Chapter number one."

You don't need to re-describe the story — the agent loads the outline you brainstormed.

**Optional: Control sub-chapter word count:**

By default each sub-chapter is written at ~5,000 words. You can override this:

```
Write chapter 3 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 3. Words per section: 3000.
```

**Voice:**
> "Write chapter three of The Seed Vault. Genre post-apocalyptic. Words per section three thousand."

### 12.2 Write a Prologue

A prologue sets the stage before Chapter 1 — a different time period, a flash-forward, a mythic framing, or historical context. Prologues are 1,500–3,000 words (shorter than a standard chapter).

**Chat:**
```
Write the prologue for "The Accord". Genre slug: political-scifi.
```

**Voice:**
> "Write the prologue for 'The Last Tribune.' Genre political-history."

The system detects "Prologue" and adjusts the writing instructions automatically — you don't need to pass a chapter number.

### 12.3 Write an Epilogue

An epilogue provides closure after the final chapter — a time jump, final twist, or lasting emotional resonance. Also 1,500–3,000 words.

**Chat:**
```
Write the epilogue for "The Accord". Genre slug: political-scifi.
```

**Voice:**
> "Write the epilogue for 'The Accord.' Genre political-scifi."

### What's Different About Prologues and Epilogues

| Feature | Prologue / Epilogue | Regular Chapter |
|---------|-------------------|----------------|
| Word count | 1,500–3,000 | 3,000–5,000 |
| Writing instructions | Stage-setting (prologue) or closure (epilogue) | Internal character arc + cliffhanger |
| Email subject | "The Accord - Prologue: [title]" | "The Accord - Chapter 3: [title]" |
| File naming | `chapter_the-accord_prologue_[date].md` | `chapter_the-accord_ch3_[date].md` |
| Story bible | Updated normally | Updated normally |
| Chapter count | Not updated (only numbered chapters count) | Updated |

> **Tip:** If your brainstormed outline includes a Prologue (section 0) or Epilogue, the system auto-loads the brief and arc notes just like it does for numbered chapters.

### 12.4 Write a Chapter for a New Project (No Prior Outline)

If you haven't brainstormed first, provide the details:

```
Write chapter 1 of a new book. Genre slug: ancient-history.
Project title: "The Last Pharaoh's Scribe".
Chapter number: 1.
Brief: A young scribe in Cleopatra's court discovers that the Library of Alexandria
holds a map to a weapon that could repel the Roman invasion.
Outline: Chapter 1 introduces Nefertari in the library, the discovery of the hidden
map fragment, and a tense encounter with a Roman centurion posing as a scholar.
Research topics: ["Library of Alexandria daily operations", "Cleopatra's court structure",
"Roman military presence in Egypt 30 BC", "ancient Egyptian scribal practices"]
```

### What You Get

- An email with the full chapter text + cover image
- Story bible automatically updated with new characters, locations, and plot threads
- A draft saved to your content library
- The writing project's chapter count is updated

### Full Scenario: Write a Full Book with Prologue and Epilogue

**Step 1 — Brainstorm:**

> **You:** "Brainstorm a book using Freytags Pyramid called 'The Accord.' Genre political-scifi. Ten chapters. Premise: A diplomat discovers that the galactic peace treaty she helped negotiate has a hidden clause that sacrifices her home world. Themes: diplomacy vs. truth, the cost of peace, loyalty to institutions vs. loyalty to people."

*Outline arrives by email with ten chapters following Freytag's five-act structure. The outline may include a Prologue and Epilogue if the story arc calls for it.*

**Step 2 — Revise the outline to add a prologue and epilogue (if not already included):**

> **You:** "Revise the outline for 'The Accord.' Add a prologue that opens with a classified diplomatic transmission intercepted decades before the main story — hinting at the alien contact that drives the political crisis. Add an epilogue set twenty years after the climax showing the long-term consequences of the accord on human civilization. Keep the existing ten chapters and Freytags Pyramid structure. Genre slug political-scifi."

*Updated outline arrives by email: Prologue (section 0), ten chapters (1–10), and Epilogue (section 11).*

**Step 3 — Write the prologue:**

> **You:** "Write the prologue for 'The Accord.' Genre political-scifi."

*The system loads your outline's Prologue brief, runs research, and writes a 1,500–3,000 word prologue that sets the stage. Email arrives with the prose and cover art. Story bible created with initial entries.*

**Step 4 — Write chapter 1:**

> **You:** "Write chapter one of 'The Accord.' Genre political-scifi. Chapter number one."

*The system loads your outline, story bible from the prologue, researches relevant topics, writes the chapter in the political-scifi tone, and updates the story bible.*

**Step 5 — Write chapter 2:**

> **You:** "Write chapter two of 'The Accord.' Genre political-scifi. Chapter number two."

*Each chapter builds on the story bible from the prologue and previous chapters. Characters, locations, and plot threads stay consistent.*

**Step 6 — Check continuity:**

> **You:** "Get the story bible for 'The Accord.'"

*Returns all character entries, locations, and plot threads organized by the chapter they were introduced — including entries from the Prologue.*

**Step 7 — Continue through all chapters:**

Repeat for chapters 3 through 10. The story bible grows with each chapter.

**Step 8 — Write the epilogue:**

> **You:** "Write the epilogue for 'The Accord.' Genre political-scifi."

*The system writes a 1,500–3,000 word epilogue providing closure. It has access to the full story bible built across the prologue and all ten chapters, so every character and plot thread is accounted for.*

**Step 9 — Review and publish:**

> **You:** "Pull up the epilogue for 'The Accord' and call me back so we can review it."

*Eve calls with the epilogue loaded and gives editorial feedback on closure, emotional resonance, and whether all threads are tied up.*

> **You:** "Approve my draft called 'The Accord - Epilogue.'"
>
> **You:** "Now publish it."

### Book Project Workflow Order

| Step | Command | What Happens |
|------|---------|--------------|
| 1 | Brainstorm the story | Outline saved to writing projects, emailed |
| 2 | *(Optional)* Revise outline to add prologue/epilogue | Updated outline saved, emailed |
| 3 | *(Optional)* Write the prologue | Prologue written (1,500–3,000 words), story bible started |
| 4 | Write chapter 1 | Chapter written using outline + story bible, saved as draft, emailed |
| 5 | Write chapters 2, 3… | Each chapter uses stored outline + story bible for consistency |
| 6 | *(Optional)* Write the epilogue | Epilogue written with full story bible context |
| 7 | Retrieve a chapter / prologue / epilogue | Pull it up to review or load into Eve for callback |
| 8 | Approve / publish | Move through content library workflow |

> **Common mistake:** Trying to retrieve chapter 1 before writing it. The brainstorm saves an *outline*, not a written chapter. You must run Write Chapter to produce the actual prose.

---

## 13. Revise a Short Story

After writing a short story, you can review and revise it with Eve's help through a voice callback session.

### Full Scenario: Write, Review, and Revise a Short Story

**Step 1 — Write the story:**

> **You:** "Write a short story using Freytags Pyramid called 'The Inoculator.' Genre post-apocalyptic. Premise: a traveling inoculator carries the last vaccine doses through a plague wasteland and must choose which settlement to save."

*Story is written and emailed to you. Read through it.*

**Step 2 — Pull up the story and call back:**

> **You:** "Pull up my short story 'The Inoculator' and call me back so we can revise it."

*Eve finds your story in the content library, loads it into her knowledge base, and calls your phone within 30 seconds.*

**Step 3 — Discuss revisions with Eve:**

> **Eve:** "I've got 'The Inoculator' loaded. It's a solid piece — gritty post-apocalyptic tone, good premise. Want to go through it from the top, or is there a specific section you want to rework?"
>
> **You:** "The opening feels slow. She's just walking for too long before anything happens."
>
> **Eve:** "I agree. The first three paragraphs are mostly landscape description. What if you open with her arriving at the first settlement — mid-action, already in conversation with the settlement leader? You can weave the landscape in as she's negotiating."
>
> **You:** "That's better. What about the ending? It feels too neat."
>
> **Eve:** "The catastrophe section — she makes her choice and then the passage about seeds growing feels hopeful, which undercuts the tragedy. In Freytag's structure, the catastrophe should leave the reader unsettled. What if the last line is her walking away, and we don't know if the settlement she chose even survived?"

**Step 4 — Rewrite with revisions:**

After the call, you can rewrite:

> **You:** "Write a short story using the outline for 'The Inoculator.' Genre post-apocalyptic. Tone: bleaker, start in medias res at the first settlement, end ambiguously."

*The agent rewrites using your stored outline plus the tonal adjustments you specified.*

### Chat-Only Revision (No Callback)

You can also retrieve and revise without Eve calling:

```
Retrieve my short story "The Inoculator"
```

*Story text appears in chat. Review it, then:*

```
Write a short story using the outline for "The Inoculator". Genre slug: post-apocalyptic.
Tone: darker, start in medias res, end ambiguously without resolution.
```

---

## 14. Revise a Chapter

After writing a chapter, you can review and revise it the same way as a short story — either through Eve's voice callback or in chat.

### Full Scenario: Write, Review, and Revise a Chapter

**Step 1 — Write the chapter:**

> **You:** "Write chapter three of 'The Last Tribune.' Genre political-history. Chapter number three."

*Chapter arrives by email. You read through it.*

**Step 2 — Pull up the chapter for review:**

> **You:** "Pull up my chapter three of 'The Last Tribune' and call me back so we can go over it."

*Eve calls your phone with the chapter loaded.*

**Step 3 — Discuss revisions:**

> **Eve:** "I've got chapter three loaded — 'The Overheard Fragment.' Marcus is at the Senate baths and overhears Brutus and Cassius speaking. The tension is good in the middle section, but the opening setup feels expository. And the dialogue between Marcus and his friend Quintus after the overheard conversation tells rather than shows his anxiety."
>
> **You:** "How would you fix the Quintus scene?"
>
> **Eve:** "Instead of Marcus telling Quintus he's worried, show it through behavior — he drops his wine cup, he can't finish a sentence, he keeps glancing at the door. Let Quintus notice something's wrong without Marcus explaining. The reader figures it out before Quintus does."
>
> **You:** "Good. Also, I want to add a scene where Marcus sees Caesar in the forum and almost warns him but stops."

**Step 4 — Rewrite the chapter:**

> **You:** "Write chapter three of 'The Last Tribune.' Genre political-history. Chapter number three. Brief: Marcus overhears a fragment of the conspiracy at the Senate baths. The Quintus scene should show anxiety through behavior, not dialogue. Add a scene where Marcus sees Caesar in the forum and almost warns him but stops himself."

*The agent writes the revised chapter using your stored outline plus the specific revisions you provided. Story bible is updated.*

### Retrieve a Chapter Without Callback

**Step 1 — Check what's saved:**
```
Show me my drafts
```

**Step 2 — Retrieve using the chapter title (not the project name):**
```
Retrieve "The Overheard Fragment"
```

> Use the chapter title, not the project name. Write Chapter gives each chapter its own title. Use `show me my drafts` first to find the exact title, then retrieve by that title.

**Voice:**
> "Pull up my draft called 'The Overheard Fragment.'"

---

## 14b. Q/A a Chapter

After writing a chapter, you can run a standalone Q/A consistency check. This uses a separate Claude call to analyze the chapter for duplicate content and character name inconsistencies, then auto-corrects any issues found.

**What it checks:**
- **Duplicate content** — 5-gram cross-sub-chapter analysis to detect repeated passages
- **Character name inconsistencies** — catches wrong names, misspellings, and surname confusion (e.g. "Miss Kellerton" flagged when "Mary Kellerton" is the correct character)

**What it does:**
- Claude fixes ONLY the detected issues while preserving your author voice
- Saves the corrected version (with a version snapshot of the original)
- Emails you the corrected chapter + a diff report + the Q/A findings

**Chat:**
```
Q/A chapter 3 of The Clockwork Rebellion
```
```
Clean up the prologue of The Clockwork Rebellion
```
```
Fix duplicates in chapter 5 of The Seed Vault
```

**Voice:**
> "Q/A chapter three of The Clockwork Rebellion."
> "Clean up the epilogue of The Clockwork Rebellion."
> "Fix the names in chapter five of The Seed Vault."

**Note:** The Q/A check also runs automatically at the end of every chapter write. This standalone command is for re-running it on chapters that have already been written.

---

## 15. Story Bible

The story bible tracks characters, locations, plot threads, and world-building details across chapters. It's updated automatically when you write chapters.

### 15.1 Read the Story Bible

**Chat:**
```
Get the story bible for project "The Seed Vault"
```

**Voice:**
> "Get the story bible for 'The Last Tribune.'"

Returns all entries organized by type (character, location, plot_thread, event, timeline, world_rule) and the chapter they were introduced in.

### 15.2 Update the Story Bible

```
Update the story bible for project "The Seed Vault". Add a new character:
Name: Marcus, Role: antagonist, Description: A former military commander
who leads the raiders threatening the vault.
```

**Voice:**
> "Update the story bible for 'The Last Tribune.' Add a new character: Livia, role dynamic character, description: a senator's daughter who secretly sympathizes with the conspirators."

### Entry Types

| Type | What It Tracks |
|------|---------------|
| `character` | Name, role (protagonist/antagonist/dynamic/static), description, arc |
| `location` | Places, settings, atmosphere details |
| `plot_thread` | Ongoing storylines, unresolved conflicts |
| `event` | Key events that affect the timeline |
| `timeline` | Chronological markers |
| `world_rule` | Rules of the world (e.g., time travel mechanics, technology level) |

---

## 16. Generate Cover Art

Creates a DALL-E image based on your description and genre art style, then emails it.

### Chat

```
Generate cover art for a political-scifi short story called "The Senate of Stars".
Genre slug: political-scifi.
The image should show a vast circular chamber with alien delegates, lit by the light
of a dying star through a massive viewport.
```

### Voice

> "Generate cover art for a post-apocalyptic story called 'The Last Signal.' Show a figure on a rooftop with a radio antenna surrounded by a flooded city at sunset."

> "Generate cover art for 'The Last Tribune.' Genre political-history. A Roman forum at dusk with a lone figure standing before the Senate steps."

### More Examples

**Ancient History:**
```
Generate cover art for an ancient-history novel called "The Last Pharaoh's Scribe".
Genre slug: ancient-history.
An ancient Egyptian library with papyrus scrolls, oil lamps, and a view of
Alexandria's harbor through a columned window.
```

**AI & Marketing:**
```
Generate cover art for an ai-marketing blog post called "The Algorithm That Learned
to Dream". Genre slug: ai-marketing. The intersection of artificial intelligence and
human creativity — neural networks rendered as constellations.
```

---

## 17. Repurpose to Social Media

Converts content into platform-specific social media posts and emails them to you.

### Chat

**Twitter (thread of tweets, each under 280 characters):**
```
Repurpose this into Twitter posts: "The Senate of Stars is a new political sci-fi
short story about a diplomat navigating a galactic parliament where every species
has a different concept of justice." Platform: twitter.
```

**LinkedIn (professional, longer format):**
```
Repurpose this into LinkedIn posts: "We just published a deep-dive blog post on
why post-apocalyptic fiction matters more than ever in 2026." Platform: linkedin.
```

**Facebook (conversational, community-focused, includes cover image):**
```
Repurpose this into Facebook posts: "The Last Signal is a post-apocalyptic short
story about a lone radio operator in flooded Manhattan picking up a mysterious
broadcast from across the Atlantic." Platform: facebook. Genre slug: post-apocalyptic.
```

**Instagram:**
```
Repurpose this into Instagram posts: "Ancient Rome's engineers built aqueducts that
still stand today." Platform: instagram. Genre slug: ancient-history.
```

### Voice

> "Take this and make Twitter posts from it: 'The Last Signal is a new story about a radio operator in flooded Manhattan picking up a mysterious broadcast.' Platform Twitter."

> "Repurpose that blog post about AI marketing into LinkedIn posts."

---

## 18. Content Library

Every piece of content you create is saved as a draft. You can manage drafts through a simple lifecycle:

```
Draft → Approved → Published
  ↓         ↓
Scheduled  Rejected
  ↓
(auto-publishes)

Any non-published status → Deleted → (undelete) → Draft
Published items must be unpublished before deletion.
```

**Status rules enforced automatically:**
- Only **drafts** can be approved
- Only **approved** items can be published (must approve first)
- Only **draft or approved** items can be rejected or scheduled
- Only **published** items can be unpublished
- Only **scheduled** items can be unscheduled
- Only **draft, approved, rejected, or scheduled** items can be deleted (unpublish first if published)
- Only **deleted** items can be undeleted (restores to draft)

Email notifications are sent automatically on every status change.

### 18.1 View All Content

**Chat:**
```
Show me all my content
```

**Voice:**
> "Show me everything in my library."
> "What's all my content?"

Returns every item labeled `[DRAFT]`, `[APPROVED]`, `[PUBLISHED]`, `[SCHEDULED]`, or `[REJECTED]`.

### 18.2 List by Status

**Chat:**
```
List my drafts
List my approved content
List my published content
List my rejected content
List my scheduled content
```

**Voice:**
> "Show me my drafts."
> "What's been approved?"
> "Show me my published posts."
> "What's scheduled?"

### 18.3 Filter by Content Type

**Chat:**
```
List my draft blog posts
List my draft short stories
List my published newsletters
List my draft chapters
```

### 18.4 List Writing Projects

**Chat:**
```
List my projects
```

**Voice:**
> "Show me my projects."
> "What projects do I have?"

### 18.5 Approve a Draft

Moves an item from **draft** to **approved**. A version snapshot is automatically saved.

**Chat — By title:**
```
Approve the draft titled "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```

**Chat — By chapter number:**
```
Approve chapter 3 of The Clockwork Rebellion
```

**Chat — Prologue or Epilogue:**
```
Approve the prologue of The Clockwork Rebellion
```

**Chat — Bulk approve all chapters:**
```
Approve all chapters of The Clockwork Rebellion
```

**Voice:**
> "Approve the draft called 'Why Post-Apocalyptic Fiction Matters.'"
> "Approve chapter five of The Clockwork Rebellion."
> "Approve all chapters of The Clockwork Rebellion."

### 18.6 Publish Content

Moves an item from **approved** to **published**. You **must approve first**.

**Chat:**
```
Publish the content titled "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```

**Voice:**
> "Publish it."
> "Now publish that story."

### 18.7 Unpublish Content

Reverts a **published** item back to **approved**.

**Chat:**
```
Unpublish "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```

**Voice:**
> "Unpublish that article."
> "Take 'Why Post-Apocalyptic Fiction Matters' off of published."

### 18.8 Reject a Draft

Moves a **draft** or **approved** item to **rejected**.

**Chat:**
```
Reject the draft titled "The Forgotten Engineers of Rome"
```

**Voice:**
> "Reject that draft."

### 18.9 Schedule Publishing

Schedule content to auto-publish at a future date. A background process checks every hour.

**Chat:**
```
Schedule "Why Post-Apocalyptic Fiction Matters" for 2026-03-15
```

**Voice:**
> "Schedule that for March fifteenth."
> "Schedule my blog post for next Friday."

You receive an email when scheduled and another when it auto-publishes.

### 18.10 Unschedule Content

Cancels a scheduled publication, reverting to **draft**.

**Chat:**
```
Unschedule "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```

**Voice:**
> "Unschedule that post."
> "Cancel the schedule for 'Why Post-Apocalyptic Fiction Matters.'"

### 18.11 Version History

Every time you approve or publish content, a version snapshot is saved automatically. You can view history and retrieve older versions.

**List versions:**
```
Show version history for "Why Post-Apocalyptic Fiction Matters"
```

**Voice:**
> "Show me the version history for my blog post about AI marketing."

**Get a specific version:**
```
Get version 2 of "Why Post-Apocalyptic Fiction Matters"
```

**Voice:**
> "Get version one of that blog post."

### 18.12 Notifications

You receive an email notification whenever you:
- **Approve** a draft
- **Publish** content
- **Unpublish** content
- **Reject** a draft
- **Schedule** content
- **Unschedule** content
- **Delete** content
- **Undelete** (restore) content
- Content is **auto-published** by the scheduler

### 18.13 Delete Content

Soft-deletes an item. A version snapshot is automatically saved before deletion. Works on **draft**, **approved**, **rejected**, or **scheduled** items. Published items must be unpublished first.

**Chat:**
```
Delete the draft titled "The Forgotten Engineers of Rome"
```

**Voice:**
> "Delete that draft."
> "Delete the blog post called 'The Forgotten Engineers of Rome.'"

You receive an email notification when content is deleted.

### 18.14 Undelete Content

Restores a deleted item back to **draft** status.

**Chat:**
```
Undelete "The Forgotten Engineers of Rome"
```

**Voice:**
> "Undelete that story."
> "Restore 'The Forgotten Engineers of Rome.'"

You receive an email notification when content is restored.

### 18.15 List Deleted Content

Shows items that have been soft-deleted. You can optionally filter by content type.

**Chat:**
```
Show my deleted content
List my deleted blog posts
```

**Voice:**
> "Show me my trash."
> "What have I deleted?"
> "Show me my deleted stories."

Returns up to 20 deleted items, ordered by creation date.

### 18.16 Email Any Saved Content

Emails you a formatted copy of any content in your library — outlines, research reports, chapters, short stories, blog posts, or newsletters. Useful when you want to review content on your phone or share it.

**Chat:**
```
Email me the outline for "The Seed Vault"
Email me the short story about the Roman soldier
Email me the research report on "Post-Apocalyptic Fiction Trends 2026"
Email me chapter 1 of "The Seed Vault"
```

**Voice:**
> "Email me the outline for The Seed Vault."
> "Send me that short story by email."
> "Can you email me the research report on post apocalyptic trends?"

**What gets emailed:**
- **Outlines** — JSON converted to structured HTML with characters and chapters sections (from writing_projects table)
- **Research reports** — Markdown converted to HTML (from research_reports table)
- **Chapters, short stories, blog posts, newsletters** — Markdown converted to HTML (from published_content table)

### Full Scenario: Content Library Lifecycle

**Step 1 — List your drafts:**

> **You:** "Show me my drafts."

*Returns a list of all draft content with titles, types, and IDs.*

**Step 2 — Approve one:**

> **You:** "Approve the draft called 'Why Post-Apocalyptic Fiction Matters More Than Ever in 2026.'"

*Status changes to approved. Version 1 snapshot saved. Email notification sent.*

**Step 3 — Publish it:**

> **You:** "Publish 'Why Post-Apocalyptic Fiction Matters More Than Ever in 2026.'"

*Status changes to published with a timestamp. Version 2 snapshot saved. Email notification sent.*

**Step 4 — Verify:**

> **You:** "Show me my published content."

*Your published item appears in the list.*

**Step 5 — Unpublish if needed:**

> **You:** "Unpublish 'Why Post-Apocalyptic Fiction Matters.'"

*Reverts to approved status. Email notification sent.*

**Step 6 — Delete content:**

> **You:** "Delete 'Why Post-Apocalyptic Fiction Matters.'"

*Status changes to deleted. Version snapshot auto-saved before deletion. Email notification sent.*

**Step 7 — Check deleted items:**

> **You:** "Show me my trash."

*Returns your list of deleted items.*

**Step 8 — Restore if needed:**

> **You:** "Undelete 'Why Post-Apocalyptic Fiction Matters.'"

*Status changes back to draft. Email notification sent.*

**Step 9 — Email content to yourself:**

> **You:** "Email me the outline for 'The Seed Vault.'"

*Formatted outline arrives in your inbox.*

### 18.17 Format a Book for Kindle (KDP Manuscript)

When your book project has all its chapters written, you can compile them into formatted Google Docs ready for Kindle Direct Publishing. The system retrieves every chapter in order — including Prologue and Epilogue — splits them into two documents, and emails you links to both.

**What you get:**
- **Two Google Docs** (Part 1 and Part 2) — the manuscript is split at the chapter midpoint to stay within Google Docs' size limits
- **Title page** with your book's title in each part
- **Prologue** labeled as "Prologue - [Title]" and **Epilogue** labeled as "Epilogue - [Title]"
- **Chapter titles** in Heading 1 format (centered)
- **Sub-chapter headings** (from `#` markers) in Heading 2 format (left-aligned), with the `#` prefix removed
- **Page breaks** before each chapter (not before sub-chapter headings)
- **Shared links** — both docs are shared so you can access them immediately
- **Auto-replacement** — re-running the command deletes the previous Part 1 and Part 2 docs and creates fresh ones

**Chat — Default size (6×9):**
```
Format "The Seed Vault" for Kindle
```

**Chat — Specific size:**
```
Format "The Seed Vault" for Kindle in 5.5 by 8.5
```

**Voice — Default:**
> "Format my book The Seed Vault for Kindle."

**Voice — With size selection:**
> "Format The Seed Vault for Kindle. Use the 5 by 8 page size."

Once you request it, the system:

1. Retrieves all chapters for the project (Prologue, Chapters 1-N, Epilogue) in order
2. Splits at the midpoint into Part 1 and Part 2
3. Creates two Google Docs with formatted headings, page breaks, and sub-chapter headers
4. Shares both docs and emails you the links

**From Google Docs you can:**
- Download as `.docx` for KDP upload (File > Download > Microsoft Word)
- Download as PDF for review
- Edit formatting, fonts, and styles directly

**Tip:** Download as `.docx` and upload directly to your [KDP dashboard](https://kdp.amazon.com/).

---

## 19. Eve Review Mode (Voice Callbacks)

This is one of Eve's most powerful features. You ask Eve to **pull up any saved content, load it into her memory, and call you back** to discuss, review, or brainstorm from it.

### How It Works

1. You ask Eve to retrieve content and call you back
2. Eve finds the content in your library
3. The content is loaded into Eve's knowledge base
4. Eve calls your phone within ~30 seconds
5. You discuss the content — Eve can reference specific passages, give editorial feedback, or brainstorm new ideas

### Callback Modes

| Mode | Trigger Words | What Eve Does |
|------|--------------|---------------|
| **Review** | review, revise, edit, improve, suggest changes, feedback | Editorial feedback — pacing, word choice, structure, dialogue, opening strength |
| **Brainstorm** | brainstorm, outline, plan, let's brainstorm | Creative collaboration — develop ideas, explore themes, build characters, suggest plot twists |

### 19.1 Retrieve Content (No Callback)

Just look something up without a phone call:

> "Can you pull up my research report about post-apocalyptic fiction trends?"

> "Find my draft short story about the Titanic."

Eve summarizes what she found — no phone call.

### 19.2 Review Mode — Revise Your Writing

> "Pull up my draft blog post about aqueducts and call me back so we can revise it."

Eve will:
- Find your blog post
- Load it into her knowledge base
- Call you back within ~30 seconds
- Give specific editorial feedback: pacing, word choice, structure, opening strength
- Reference and quote specific passages from your draft

### 19.3 Brainstorm Mode — Build on Research

> "Load the research report on post-apocalyptic trends and call me back. Let's brainstorm a new story outline from it."

Eve will:
- Load your research into her knowledge base
- Call you back
- Reference specific data points and findings
- Help you develop characters, themes, and plot points interactively

### 19.4 Review a Short Story

> "Get my short story 'The Inoculator' and call me back to help me improve it."

Eve calls back with specific, actionable feedback — not generic praise. She identifies weak openings, suggests stronger word choices, flags pacing issues, and quotes passages that need work.

### 19.5 Review an Outline

> "Pull up the outline for 'The Last Tribune' and call me back so we can go over it together."

Eve walks through the outline chapter by chapter, identifies structural weaknesses, suggests character development opportunities, and helps you refine the arc.

### 19.6 Review a Chapter

> "Get my chapter three of 'The Last Tribune' and call me back to revise it."

Eve gives chapter-specific feedback: does it match the outline's plan? Is the character voice consistent? Does it end on the right beat?

### 19.7 Back-to-Back Reviews

You can review multiple pieces in sequence. Each time Eve loads new content, the previous content is automatically cleared:

> "Pull up my research report about post-apocalyptic trends and call me back to review it."

*(Discuss, then hang up.)*

> "Now pull up my draft blog post about aqueducts and call me back to revise that instead."

Eve loads the blog post and clears the research report — she'll only have the current document.

### 19.8 Content Not Found

If you ask for something that doesn't exist:

> "Pull up my draft story about alien wizards on Neptune and call me back."

Eve lets you know the content wasn't found and suggests listing your drafts or trying a different search term. No phone call is triggered.

### 19.9 Parallel Tasks + Callback

Ask Eve to do two things at once:

> "Write a newsletter about ancient Roman festivals for the ancient history genre, and also pull up my research report about post-apocalyptic trends and call me back to brainstorm."

Eve handles both:
- The newsletter is written and emailed (runs in the background)
- The research report is loaded and Eve calls you back for brainstorming

---

## 20. Email Reports

Send any content as a formatted HTML email.

### Chat

```
Send me an email report with this content:

# Post-Apocalyptic Fiction Trends 2026

## Key Findings
- Climate fiction is merging with post-apocalyptic themes
- Solarpunk counternarratives are gaining traction
- AI apocalypse stories have surged 300% since 2024

## Recommended Reading
1. "The Last Garden" by Sarah Chen
2. "Ash Protocol" by Marcus Webb

Subject line: "My Research Summary"
```

### Voice

> "Send me an email with a summary of that research. Use the subject line 'Voice Test Research Report.'"

---

## 21. End-to-End Scenarios

These scenarios show how multiple features work together for real writing projects. Each scenario walks through a complete workflow from start to finish.

---

### Scenario 1: Write a Blog Post — Research to Publishing

**Goal:** Research a topic, write a blog post, create social media posts for every platform, then approve and publish.

**Step 1 — Research the topic:**

> **You:** "Research the current state of AI-powered content marketing in 2026. What tools are marketers using? What's working and what's overhyped? Include citations."

*Results with citations appear in chat. Report auto-saved.*

**Step 2 — Save the research:**

> **You:** "Save that research as a report called 'AI Marketing Landscape 2026.' Genre slug ai-marketing."

**Step 3 — Write the blog post:**

> **You:** "Write a blog post about that research. Genre slug ai-marketing. Topic: 'The AI Marketing Landscape in 2026.' Keywords: AI marketing tools, content automation, generative AI. About fifteen hundred words."

*Email arrives with the full blog post, DALL-E cover image, and the research woven throughout. Draft saved to library.*

**Step 4 — Create Twitter posts (thread of tweets, each under 280 characters):**

> **You:** "Repurpose that blog post about AI marketing into Twitter posts. Platform: twitter."

*Email arrives with a thread of tweets — punchy, hashtagged, each under 280 characters. Includes a hook tweet, key takeaways, and a call-to-action.*

**Step 5 — Create LinkedIn posts (professional, long-form):**

> **You:** "Repurpose that blog post about AI marketing into LinkedIn posts. Platform: linkedin."

*Email arrives with LinkedIn-formatted posts — professional tone, insight-driven, longer paragraphs, thought-leadership framing. Includes engagement hooks and questions for the audience.*

**Step 6 — Create Facebook posts (conversational, community-focused):**

> **You:** "Repurpose that blog post about AI marketing into Facebook posts. Platform: facebook. Genre slug: ai-marketing."

*Email arrives with Facebook-style posts — casual, community-oriented, conversation-starting. Includes a cover image prompt matching the genre aesthetic.*

**Step 7 — Create Instagram posts (visual, hashtag-heavy):**

> **You:** "Repurpose that blog post about AI marketing into Instagram posts. Platform: instagram. Genre slug: ai-marketing."

*Email arrives with Instagram caption-style posts — visual language, 20–30 relevant hashtags, designed for carousel or single-image posts. Includes suggested image descriptions.*

**Step 8 — Approve and publish the blog:**

> **You:** "Approve the draft titled 'The AI Marketing Landscape in 2026.'"

*Status changes to approved. Version snapshot saved. Email notification sent.*

> **You:** "Publish 'The AI Marketing Landscape in 2026.'"

*Status changes to published. Email notification sent.*

#### Social Media Platform Comparison

| Platform | Tone | Format | Hashtags | Length |
|----------|------|--------|----------|--------|
| **Twitter** | Punchy, direct | Thread of tweets, each ≤280 chars | 2–3 per tweet | Short |
| **LinkedIn** | Professional, analytical | 1–3 long-form posts | 3–5 total | Long |
| **Facebook** | Conversational, warm | Community-style posts | Minimal | Medium |
| **Instagram** | Visual, aspirational | Caption-style with image prompts | 20–30 per post | Medium |

---

### Scenario 2: Short Story from Start to Finish (Voice)

**Goal:** Brainstorm, write, review, and publish a short story — entirely by voice.

**Step 1 — Brainstorm with a story arc:**

> **You:** "Brainstorm a short story using Freytags Pyramid called 'Signal from the Deep.' Genre post-apocalyptic. Premise: In a flooded coastal city, a deep-sea salvage diver picks up a sonar signal from something alive at the bottom of the ocean — something that shouldn't exist. Themes: isolation, the unknown, what lies beneath."

*Outline arrives by email.*

**Step 2 — Review the outline with Eve:**

> **You:** "Pull up the outline for 'Signal from the Deep' and call me back so we can discuss it."

*Eve calls. You discuss the structure:*

> **You:** "I think the climax needs to be more visceral. The diver should physically encounter whatever's down there, not just see it on sonar."
>
> **Eve:** "Agreed. In Freytag's structure, the climax is the moment of highest tension. A physical encounter raises the stakes from intellectual curiosity to survival..."

**Step 3 — Write the story:**

> **You:** "Write the short story we brainstormed called 'Signal from the Deep.' Genre post-apocalyptic."

*Story arrives by email with cover art.*

**Step 4 — Review the story:**

> **You:** "Pull up my short story 'Signal from the Deep' and call me back so we can revise it."

*Eve calls with the story loaded. Gives editorial feedback on pacing, dialogue, the climax scene.*

**Step 5 — Approve and publish:**

> **You:** "Approve my draft called 'Signal from the Deep.'"

*Status changes to approved.*

> **You:** "Now publish it."

*Published. Notification email sent.*

---

### Scenario 3: Book Project with Prologue and Epilogue (Voice)

**Goal:** Plan, outline, write a multi-chapter book with a prologue and epilogue — entirely by voice.

**Step 1 — Research:**

> **You:** "Research what caused the fall of the Roman Republic — the key events, the political players, and what modern historians think really went wrong."

*Research returned with citations.*

**Step 2 — Brainstorm:**

> **You:** "Brainstorm a book using the three-act structure called 'The Last Tribune.' Genre political-history. Eight chapters. Premise: a young Roman tribune who uncovers a conspiracy to assassinate Julius Caesar but can't decide if stopping it would save the Republic or doom it. Themes: loyalty versus principle, the cost of power, whether one person can change history."

*Outline arrives by email: eight chapters, character profiles, thematic threads.*

**Step 3 — Review the outline:**

> **You:** "Pull up the outline for 'The Last Tribune' and call me back so we can go over it together."

*Eve calls. You walk through the outline chapter by chapter. You decide the story needs a prologue to set the historical stage, and an epilogue to show Marcus's legacy.*

**Step 4 — Revise the outline to add prologue, epilogue, and more chapters:**

> **You:** "Revise the outline for 'The Last Tribune.' Expand to twelve chapters. Add a prologue set during the founding of Rome — Romulus drawing the sacred boundary — as a mythic parallel to Marcus's later struggle to hold the Republic's boundaries together. Add an epilogue set centuries later as a medieval monk transcribes Marcus's lost writings, realizing his warnings echo in the monk's own era. Chapter 3 should have Marcus overhear only a fragment of the conspiracy. Keep the three-act structure. Genre political-history."

*Updated outline arrives: Prologue (section 0), twelve chapters (1–12), Epilogue (section 13). Revised structure with the conspiracy fragment in chapter 3.*

**Step 5 — Write the prologue:**

> **You:** "Write the prologue for 'The Last Tribune.' Genre political-history."

*The system loads the Prologue brief from the outline, researches Roman founding myths, and writes a 1,500–3,000 word prologue. Email arrives with the prose and cover art. Story bible created with Romulus and founding-era entries.*

**Step 6 — Write chapter 1:**

> **You:** "Write chapter one of 'The Last Tribune.' Genre political-history. Chapter number one."

*Chapter loads the revised twelve-chapter outline and the story bible from the prologue. Email arrives with the chapter and cover art. Story bible updated with Chapter 1 characters and locations.*

**Step 7 — Write chapter 2:**

> **You:** "Write chapter two of 'The Last Tribune.' Genre political-history. Chapter number two."

*Story bible ensures character and location continuity across the prologue and both chapters.*

**Step 8 — Review chapter 2:**

> **You:** "Get my chapter two of 'The Last Tribune' and call me back so we can revise it."

*Eve calls with the chapter loaded. She quotes specific passages and suggests dialogue improvements.*

**Step 9 — Check the story bible:**

> **You:** "Get the story bible for 'The Last Tribune.'"

*Returns all characters, locations, and plot threads from the prologue and chapters 1–2.*

**Step 10 — Continue writing all chapters:**

> "Write chapter three of 'The Last Tribune.' Genre political-history. Chapter number three."

*Repeat through chapter twelve. The story bible grows with each chapter.*

**Step 11 — Write the epilogue:**

> **You:** "Write the epilogue for 'The Last Tribune.' Genre political-history."

*The system writes a 1,500–3,000 word epilogue with access to the full story bible from the prologue and all twelve chapters. The medieval monk scene provides closure and resonance.*

**Step 12 — Review the epilogue:**

> **You:** "Pull up my epilogue for 'The Last Tribune' and call me back so we can review it."

*Eve calls. She evaluates whether the epilogue ties up all threads and provides satisfying closure.*

**Step 13 — Approve and publish the full book:**

> **You:** "Approve my draft called 'The Last Tribune - Prologue.'"
> **You:** "Publish it."
>
> *(Repeat for each chapter and the epilogue.)*

---

### Scenario 4: Newsletter with Research (Chat)

**Step 1:**
```
Research the latest developments in ancient history archaeology in 2026.
Include discoveries, excavations, and new technologies being used.
```

**Step 2:**
```
Write a newsletter for the ancient-history genre.
Topic: "Unearthing 2026: The Year's Most Exciting Archaeological Discoveries".
Genre slug: ancient-history. Date: 2026-03-13.
```

*Newsletter arrives with Perplexity-sourced content and citation URLs.*

---

### Scenario 5: Research for Local Color — Chapters, Prologues, Epilogues, and Short Stories

**Goal:** Use deep research to get historically accurate local color — the sensory details, daily routines, architecture, food, sounds, and atmosphere that make fiction feel real — then write different types of content grounded in that research.

---

#### 5a. Research Local Color for a Chapter

**Step 1 — Research the setting:**

> **You:** "Research what daily life was like inside Constantinople during the final siege of 1453. What did ordinary people eat, hear, smell? What were the streets like? How did the city sound at night with the Ottoman army camped outside the walls? What religious rituals happened in the final days?"

*Perplexity returns detailed research with citations — food rations, church bells, the smell of Greek fire, processions of icons through the streets.*

**Step 2 — Save it for later use:**

> **You:** "Save that research as a report called 'Constantinople Final Siege Daily Life.' Genre slug ancient-history."

**Step 3 — Write a chapter grounded in the research:**

> **You:** "Write a chapter using that research. Genre slug ancient-history. Project title: 'The Walls of God.' Chapter number three. Brief: Alexios, a baker's son turned militia volunteer, spends his last night inside the walls before the final assault. He writes a letter to his mother, helps repair a breach in the Blachernae wall, and watches the Ottoman campfires stretch to the horizon."

*Chapter arrives with historically accurate details woven into the narrative — the taste of rationed bread, the sound of Turkish drums, the flickering icons in Hagia Sophia.*

**Voice:**

> "Research what daily life was like for ordinary people inside Constantinople during the 1453 siege. I want sensory details — what they ate, what the streets sounded like, religious customs in the final days."

> "Save that research as 'Constantinople Final Siege Daily Life.' Genre slug ancient-history."

> "Write chapter three of 'The Walls of God.' Genre ancient-history. Chapter number three. Brief: Alexios spends his last night inside the walls before the final assault."

---

#### 5b. Research Local Color for a Prologue

**Step 1 — Research the historical period for your prologue:**

> **You:** "Research the founding myths of Rome — Romulus and Remus, the sacred boundary, the augury on Palatine Hill. What did the landscape look like? What were the religious rituals around city founding? What tools and weapons did early Romans use?"

*Research returned with citations about archaic Latin rituals, the pomerium, the sulcus primigenius.*

**Step 2 — Write a prologue grounded in the research:**

> **You:** "Write the prologue for 'The Last Tribune.' Genre political-history."

*The system loads the Prologue brief from your outline (the Romulus scene) and uses the research to fill in sensory details — the smell of freshly turned earth as the plow cuts the boundary, the weight of the bronze tools, the cries of birds during the augury.*

**Voice:**

> "Research the founding of Rome — the Romulus and Remus story, the sacred boundary, the augury. I need sensory details for a prologue scene."

> "Write the prologue for 'The Last Tribune.' Genre political-history."

---

#### 5c. Research Local Color for an Epilogue

**Step 1 — Research the future setting for your epilogue:**

> **You:** "Research what a medieval European scriptorium looked like in the 12th century. What tools did monks use for copying manuscripts? What was the daily schedule? What did the room smell like — the ink, the vellum, the candles? How did they handle fragile ancient texts?"

*Research returned with details about iron gall ink, quill preparation, the rule of silence, candlelight restrictions.*

**Step 2 — Write an epilogue grounded in the research:**

> **You:** "Write the epilogue for 'The Last Tribune.' Genre political-history."

*The epilogue's medieval monk scene comes alive with sensory detail — the scratch of the quill, the smell of oak gall ink, the weight of the ancient Roman manuscript in his hands.*

**Voice:**

> "Research medieval scriptoriums — the tools, the daily routine, what it smelled like, how monks handled ancient texts. I need local color for an epilogue."

> "Write the epilogue for 'The Last Tribune.' Genre political-history."

---

#### 5d. Research Local Color for a Short Story

**Step 1 — Research the setting for a standalone short story:**

> **You:** "Research what a post-apocalyptic flooded coastal city would really look like after 50 years of submersion. How does saltwater affect concrete and steel? What marine life colonizes submerged buildings? What would a deep-sea salvage diver see and hear in a flooded skyscraper? What equipment would they use?"

*Research returned with details about concrete spalling, barnacle colonies, acoustic properties of submerged structures, rebreather technology.*

**Step 2 — Write the short story:**

> **You:** "Write the short story we brainstormed called 'Signal from the Deep.' Genre post-apocalyptic."

*The story uses the research naturally — the diver's rebreather hissing in the silence, barnacles encrusting a lobby's reception desk, the groan of corroded steel in the current.*

**Voice:**

> "Research what a flooded coastal city looks like after fifty years underwater. How does saltwater affect buildings? What marine life takes over? What would a salvage diver see inside a submerged skyscraper?"

> "Write the short story 'Signal from the Deep.' Genre post-apocalyptic."

---

#### 5e. Mid-Project Research During Chapter Writing

You don't have to do all your research upfront. Research mid-project when a specific chapter needs specialized local color:

> **You:** "Research Roman funeral customs in the late Republic — the procession, the death masks, the eulogy at the Forum, what happened to the body. I need this for chapter five of 'The Last Tribune.'"

*Research returned.*

> **You:** "Write chapter five of 'The Last Tribune.' Genre political-history. Chapter number five. Brief: Marcus attends the funeral of his mentor, Senator Calvus. The funeral procession through the Forum forces Marcus to confront the political alliances that killed his friend."

*Chapter weaves in the researched funeral details — the imagines (ancestor masks) carried in procession, the laudatio funebris in the Forum, the smell of cypress branches on the pyre.*

**Voice:**

> "Research Roman funeral customs in the late Republic. The procession, the death masks, the eulogy, the pyre. I need it for chapter five of 'The Last Tribune.'"

> "Write chapter five of 'The Last Tribune.' Genre political-history. Chapter number five."

---

#### Tips for Research-Driven Local Color

- **Be specific in your research queries.** "Daily life in Constantinople 1453" is good. "Research Constantinople" is too broad.
- **Ask for sensory details explicitly.** Say "what did it smell like, sound like, look like" — Perplexity will return richer results.
- **Save research as reports** if you'll use it across multiple chapters. The saved report is available in your library for future reference.
- **Research happens automatically** during chapter writing (each chapter gets a Perplexity research step), but that auto-research is based on the chapter brief. For deeper local color, do a dedicated research step first.
- **You can combine saved research with chapter writing.** The system's auto-research step will complement whatever you've already gathered.

---

### Scenario 6: Content Library Management

**Step 1 — See everything:**
> "Show me all my content."

**Step 2 — Filter to drafts:**
> "List my draft short stories."

**Step 3 — Approve one:**
> "Approve the draft called 'The Inoculator.'"

**Step 4 — Schedule for later:**
> "Schedule 'The Inoculator' for March twentieth."

**Step 5 — Check scheduled:**
> "Show me my scheduled content."

**Step 6 — Change your mind:**
> "Unschedule 'The Inoculator.'"

**Step 7 — Check versions:**
> "Show me the version history for 'The Inoculator.'"

> "Get version one of 'The Inoculator.'"

---

### Scenario 7: Write a Kindle Book — Metaphysical Romance (Voice + Chat)

**Goal:** Research what sells on Kindle in the romance/metaphysical niche, find the right keywords, brainstorm an outline, and write a full book with local color grounded in real places — from concept to publishable chapters.

---

#### Phase 1: Market Research — What Sells on Kindle

**Step 1 — Research bestselling Kindle romance subgenres:**

> **You:** "Research what sells best in Kindle romance right now — especially reincarnation romance, soulmate stories, and second-chance love after grief. What are the top-selling subgenres? What themes and tropes are readers looking for in 2026? Include any data on page counts, series vs standalone, and pricing."

*Research returned with citations — KDP category trends, popular tropes (past lives, second-chance, caregiver romance), typical word counts (60,000–80,000 for romance), pricing strategies ($3.99–$5.99), and series vs standalone data.*

**Step 2 — Research Kindle keywords and categories:**

> **You:** "Research the best Kindle keywords and KDP categories for a metaphysical romance about soulmates, past lives, and caregiving. What keywords do readers actually search for? What categories should I list under? Include long-tail keywords that rank well."

*Research returned with keyword data — "reincarnation romance," "soulmate fiction," "past life love story," "second chance after loss," "caregiver romance," "metaphysical love story." Category recommendations: Romance > Paranormal > Reincarnation, Romance > Clean & Wholesome, Literature & Fiction > Women's Fiction > Domestic Life.*

**Step 3 — Save the market research:**

> **You:** "Save that research as a report called 'Kindle Metaphysical Romance Market Research.' Genre slug metaphysical-romance."

---

#### Phase 2: Brainstorm the Outline

**Step 4 — Brainstorm with Eve (conversation mode):**

> **You:** "I want to brainstorm a new story. I've been thinking about two people who meet in a hospice — one is a caregiver, the other is watching his wife die. They feel like they already know each other."

*Eve enters brainstorm conversation mode. She asks questions to shape the concept:*

> **Eve:** "That's a powerful starting point. The hospice setting gives you built-in emotional stakes. Tell me more — when they feel like they know each other, is it instant recognition? Déjà vu? Or something that builds over time?"

> **You:** "It's immediate but confusing. Like they've met before but can't place where. And then they start having the same dreams — about being together in another time and place."

> **Eve:** "So the past-life thread reveals itself through shared dreams. That's intimate — it bypasses rational explanation and goes straight to feeling. What era are you thinking for the past life? And what tore them apart the first time?"

> **You:** "I was thinking 1920s Paris. They were artists — a painter and a writer — and they were separated by the Spanish flu. She died before he could get to her."

> **Eve:** "That's devastating and beautiful. The Spanish flu gives you a mirror to the present — disease separating lovers across centuries. Ready for me to submit this as a brainstorm?"

> **You:** "Yes, do it. Call it 'The Familiar.' Ten chapters. Use the three-act structure."

*Outline arrives by email: ten chapters, character profiles, dual-timeline structure (modern hospice + 1920s Paris).*

**Or brainstorm directly without conversation:**

> **You:** "Brainstorm a metaphysical romance book called 'The Familiar.' Genre metaphysical-romance. Ten chapters. Use the Three-Act Structure. Premise: A hospice caregiver meets the husband of one of her dying patients. There is an immediate, inexplicable recognition between them — not attraction, something deeper, as if they already know each other. As the patient declines from cancer, the caregiver and husband are drawn together through the shared vigil. After the patient dies, they discover through dreams, déjà vu, and fragments of shared memory that they were lovers in a past life — a couple in 1920s Paris who were separated by the Spanish flu. Themes: fate vs free will, the persistence of love across time, whether the past can truly be changed, the weight of inherited trauma."

---

#### Phase 3: Research Local Color for Real Places and Scenes

**Step 5 — Research the modern setting (hospice):**

> **You:** "Research what a modern hospice facility looks like from the inside — the rooms, the hallways, the nurses' station, the sounds at night. What does end-of-life care actually look like day to day? How do caregivers manage emotional burnout? What rituals happen when a patient dies? I want authentic, unsanitized details."

*Research returned — the hum of oxygen concentrators, the smell of antiseptic mixed with flowers, the ritual of bathing the body, the quiet conversations at 3 AM, the way experienced nurses know death is close before the monitors do.*

**Step 6 — Save the hospice research:**

> **You:** "Save that research as a report called 'Hospice Daily Life and End-of-Life Care.' Genre slug metaphysical-romance."

**Step 7 — Research 1920s Paris for the past-life timeline:**

> **You:** "Research daily life in the Montparnasse art district of Paris in the early 1920s. What did the cafés look like? What did artists eat, drink, wear? What were the studios like — the light, the smells, the sounds from the street? Describe the Café de la Rotonde, La Closerie des Lilas, and the surrounding streets. Also research how the 1918 Spanish flu affected Paris — what it was like to watch someone you love die from it, the quarantines, the mass graves."

*Research returned with rich period detail — zinc bar tops at La Rotonde, the smell of turpentine and Gauloises, the clatter of horse carts on cobblestones, the gray-blue light through north-facing studio windows. Spanish flu details: the blue tinge of cyanosis, overwhelmed hospitals, the speed of death (healthy at breakfast, dead by evening).*

**Step 8 — Save the Paris research:**

> **You:** "Save that research as a report called '1920s Montparnasse and Spanish Flu Paris.' Genre slug metaphysical-romance."

---

#### Phase 4: Review and Revise the Outline

**Step 9 — Review the outline with Eve:**

> **You:** "Pull up the outline for 'The Familiar' and call me back so we can go over it."

*Eve calls. You walk through the outline:*

> **You:** "I want the prologue to be set in 1920s Paris — the painter waiting at the hospital where his lover is dying of the flu. He never gets in. She dies alone. That's the wound that echoes across centuries."

> **Eve:** "That gives the reader the past-life tragedy before they meet the modern characters. The reader will recognize the pattern before the characters do. Should I add an epilogue too?"

> **You:** "Yes. The epilogue should be them visiting Paris together — standing outside the hospital where she died in 1920. They feel it, but they're free of it now."

**Step 10 — Revise the outline:**

> **You:** "Revise the outline for 'The Familiar.' Add a prologue set in 1920s Paris — the painter rushing to the hospital where his lover is dying of the Spanish flu, but he never gets in, she dies alone, and he stands outside in the rain holding the painting he made for her. Add an epilogue set in present-day Paris — the two modern characters visit the same hospital, now converted to apartments, and feel the echo but know they've broken the cycle. Keep ten chapters. Use the Three-Act Structure. Genre metaphysical-romance."

*Updated outline arrives: Prologue (section 0), ten chapters (1–10), Epilogue (section 11).*

---

#### Phase 5: Write the Book with Local Color

**Step 11 — Write the prologue (1920s Paris):**

> **You:** "Write the prologue for 'The Familiar.' Genre metaphysical-romance."

*The system loads the Prologue brief and your saved 1920s Paris research. The prose is steeped in period detail — the cobblestones of Montparnasse, the painter running through rain past the Café de la Rotonde, the military cordons around the hospital, the painting wrapped in his coat.*

**Step 12 — Research local color for chapter 1 (modern hospice):**

> **You:** "Research a specific real hospice or palliative care facility in the Boston area — its architecture, the surrounding neighborhood, what it feels like to walk in the front door for the first time. I need a real place I can use as the setting for chapter one."

*Research returned — details about specific facilities, Victorian-era buildings converted to hospice care, the gardens, the way light falls through old windows.*

**Step 13 — Write chapter 1:**

> **You:** "Write chapter one of 'The Familiar.' Genre metaphysical-romance. Chapter number one."

*Chapter loads the outline and uses your hospice research for authentic local color — the specific smell of the facility's hallway, the way the caregiver's shoes sound on the linoleum, the first moment of recognition when she sees the patient's husband in the doorway.*

**Step 14 — Continue writing chapters with targeted research:**

For each chapter, research the specific real-world settings you need:

> **You:** "Research the Arnold Arboretum in Boston — what it looks like in autumn, the walking paths, the specific trees, the light at golden hour. I need it for a scene where the two main characters walk together for the first time outside the hospice."

> **You:** "Write chapter three of 'The Familiar.' Genre metaphysical-romance. Chapter number three."

> **You:** "Research what it's like to have a vivid past-life dream — the sensory quality, how it differs from a normal dream, the disorientation of waking up. Also research the real neuroscience of déjà vu and what causes it. I need this for chapter four where both characters have the same dream on the same night."

> **You:** "Write chapter four of 'The Familiar.' Genre metaphysical-romance. Chapter number four."

*Continue through all ten chapters. Each chapter builds on the story bible from previous chapters, maintaining character and plot continuity.*

**Step 15 — Write the epilogue (present-day Paris):**

> **You:** "Research the real location of the Hôpital Lariboisière in Paris — or another hospital that was active during the 1918 flu. What does the neighborhood look like today? What's near it? What would two Americans experience walking those streets for the first time?"

> **You:** "Write the epilogue for 'The Familiar.' Genre metaphysical-romance."

*The epilogue grounds the closure in a real place — the modern street, the plaque on the building, the café across the road where they sit and feel the weight of a century lift.*

---

#### Phase 6: Review, Revise, and Prepare for Kindle

**Step 16 — Review chapters with Eve:**

> **You:** "Pull up chapter one of 'The Familiar' and call me back so we can revise it."

*Eve calls and provides editorial feedback — pacing, dialogue, emotional beats, whether the recognition scene lands.*

*Repeat for each chapter, the prologue, and the epilogue.*

**Step 17 — Check the story bible:**

> **You:** "Get the story bible for 'The Familiar.'"

*Returns all characters, locations, themes, and plot threads across the full book — useful for writing your Kindle book description and back-cover copy.*

**Step 18 — Generate cover art:**

> **You:** "Generate cover art for 'The Familiar.' Genre metaphysical-romance. Two silhouettes reaching for each other across layered timelines — 1920s Paris fading into a modern hospital corridor. Soft light, warm and ethereal."

**Step 19 — Approve and publish all sections:**

> **You:** "Approve my draft called 'The Familiar - Prologue.'"
> **You:** "Publish it."

*(Repeat for each chapter and the epilogue.)*

**Step 20 — Retrieve all chapters for Kindle formatting:**

> **You:** "Get all the chapters from 'The Familiar.'"

*All chapters returned in order — prologue, chapters 1–10, epilogue. Copy into your Kindle manuscript template.*

---

#### Kindle Publishing Checklist

Use the market research from Steps 1–2 to fill in your KDP listing:

| KDP Field | Source |
|-----------|--------|
| Title | "The Familiar" |
| Subtitle | From your brainstorm premise (e.g., "A Novel of Love Across Lifetimes") |
| Book description | Adapt from the outline's premise + themes |
| Keywords (7) | From Step 2 research (e.g., "reincarnation romance," "soulmate fiction," "past life love story," "second chance after loss," "caregiver romance," "metaphysical love story," "Paris romance") |
| Categories (3) | From Step 2 research (Romance > Paranormal > Reincarnation, etc.) |
| Cover | From Step 18 (generate additional sizes as needed) |
| Word count target | 60,000–80,000 (from Step 1 market research) |
| Price | $3.99–$5.99 (from Step 1 market research) |

---

### Scenario 8: Write a Newsletter — Research to Publishing

**Goal:** Research a topic, write a newsletter with live citations, then approve and schedule for future publication.

**Step 1 — Research the topic:**

> **You:** "Research the latest developments in ancient history archaeology in 2026. Include discoveries, excavations, and new technologies being used. Include citations."

*Research returned with citations — new excavation sites, LiDAR discoveries, AI-assisted artifact dating.*

**Step 2 — Write the newsletter:**

> **You:** "Write a newsletter for the ancient-history genre. Topic: 'Unearthing 2026: The Year's Most Exciting Archaeological Discoveries.' Genre slug: ancient-history. Date: 2026-03-14."

*Email arrives with a formatted newsletter: subject line, introduction, multiple research-backed sections with Perplexity citation URLs preserved, and an engaging outro. Draft saved to content library.*

**Step 3 — Review with Eve (optional):**

> **You:** "Pull up my newsletter about archaeological discoveries and call me back so we can revise it."

*Eve calls. She gives feedback on the newsletter's structure, suggests a stronger opening hook, and recommends reordering two sections for better flow.*

**Step 4 — Schedule for publication:**

> **You:** "Approve the draft titled 'Unearthing 2026.'"

*Status changes to approved.*

> **You:** "Schedule 'Unearthing 2026' for 2026-03-20."

*Status changes to scheduled. Email notification confirms the schedule date. The cron job will auto-publish it on March 20th and send another notification.*

**Step 5 — Check your schedule:**

> **You:** "Show me my scheduled content."

*Returns list of all scheduled items with their publication dates.*

**Step 6 — Change your mind (optional):**

> **You:** "Unschedule 'Unearthing 2026.'"

*Reverts to draft status. You can revise and reschedule.*

---

### Scenario 9: Write a Short Story — Brainstorm, Research, Write, Revise, Publish

**Goal:** Complete short story workflow — brainstorm with a story arc, research local color, write, review with Eve, revise, and publish.

**Step 1 — Brainstorm with a story arc:**

> **You:** "Brainstorm a short story using Freytags Pyramid called 'The Inoculator.' Genre slug: post-apocalyptic. Premise: In a plague-ravaged wasteland, a traveling inoculator carries the last doses of a vaccine between isolated settlements. She must choose which settlement gets the final dose when she discovers she only has enough for one. Themes: sacrifice, triage ethics, hope vs. pragmatism."

*Outline arrives by email: character profiles, five-section breakdown following Freytag's structure (Introduction, Rising Action, Climax, Falling Action, Catastrophe), thematic threads, and research topics.*

**Step 2 — Review the outline (optional):**

> **You:** "Pull up the outline for 'The Inoculator' and call me back so we can discuss it."

*Eve calls. You walk through the five sections, discuss the catastrophe ending, and decide to make the climax more visceral.*

**Step 3 — Research local color:**

> **You:** "Research post-apocalyptic plague scenarios — how vaccines degrade without refrigeration, what a traveling medical worker would carry, how isolated communities would organize defense and triage. Include real-world parallels from historical pandemics."

*Research returned — cold chain logistics, medieval plague doctors, smallpox blanket trades, community quarantine practices.*

**Step 4 — Write the story:**

> **You:** "Write the short story using the outline for 'The Inoculator.' Genre slug: post-apocalyptic."

*The agent loads your saved outline, auto-researches additional topics, and writes the complete story. Email arrives with the prose, cover art, and the research woven into authentic details.*

**Step 5 — Review with Eve:**

> **You:** "Pull up my short story 'The Inoculator' and call me back so we can revise it."

*Eve calls with the story loaded. She gives specific feedback — the opening is slow, the catastrophe ending is too neat, the dialogue in section 3 tells rather than shows.*

**Step 6 — Revise the story:**

> **You:** "Write a short story using the outline for 'The Inoculator.' Genre slug: post-apocalyptic. Tone: bleaker, start in medias res at the first settlement, end ambiguously without resolution."

*The agent rewrites using your stored outline plus the tonal adjustments. New draft saved to library.*

**Step 7 — Approve and publish:**

> **You:** "Approve my draft called 'The Inoculator.'"

> **You:** "Publish it."

*Published. Notification emails sent at each step.*

**Step 8 — Create social media posts:**

> **You:** "Repurpose 'The Inoculator' into Twitter posts. Platform: twitter."

> **You:** "Now make Instagram posts from it too. Platform: instagram. Genre slug: post-apocalyptic."

*Posts for each platform arrive by email, each formatted appropriately.*

---

### Scenario 10: Write a Book — Full Workflow with Outline Management

**Goal:** Brainstorm a book, revise the outline multiple times (including revert), research local color, write chapters with prologue and epilogue, and manage the publishing lifecycle.

**Step 1 — Research for brainstorming:**

> **You:** "Research what caused the fall of the Roman Republic — the key events, the political players, and what modern historians think really went wrong. Include citations."

*Research returned with citations — Gracchi brothers, Marius vs Sulla, the First Triumvirate, Caesar's crossing of the Rubicon.*

**Step 2 — Brainstorm with a story arc:**

> **You:** "Brainstorm a book using the Three-Act Structure called 'The Last Tribune.' Genre political-history. Eight chapters. Premise: A young Roman tribune uncovers a conspiracy to assassinate Julius Caesar but can't decide if stopping it would save the Republic or doom it. Themes: loyalty versus principle, the cost of power, whether one person can change history."

*Outline arrives by email: eight chapters, character profiles, thematic threads.*

**Step 3 — Review the outline:**

> **You:** "Pull up the outline for 'The Last Tribune' and call me back so we can go over it."

*Eve calls. You walk through the chapters and decide to expand the scope.*

**Step 4 — Revise the outline (first revision):**

> **You:** "Revise the outline for 'The Last Tribune.' Expand to twelve chapters. Add a prologue set during the founding of Rome — Romulus drawing the sacred boundary — as a mythic parallel to Marcus's later struggle. Add an epilogue set centuries later as a medieval monk transcribes Marcus's lost writings. Chapter 3 should have Marcus overhear only a fragment of the conspiracy. Keep the Three-Act Structure. Genre political-history."

*Updated outline arrives: Prologue, twelve chapters, Epilogue. The original 8-chapter outline is automatically saved as version 1.*

**Step 5 — Check outline versions:**

> **You:** "Show outline version history for 'The Last Tribune.'"

*Returns: Version 1 (original 8-chapter outline, snapshot date).*

**Step 6 — Decide the prologue doesn't work, revert:**

> **You:** "Revert the outline for 'The Last Tribune' to version 1."

*Outline reverts to the original eight chapters. The 12-chapter version is saved as a new snapshot.*

**Step 7 — Try a different revision:**

> **You:** "Revise the outline for 'The Last Tribune.' Expand to ten chapters. Add a prologue set on the night before Caesar's assassination — Marcus standing on the steps of the Senate at midnight, knowing what tomorrow will bring. Keep the Three-Act Structure. Genre political-history."

*New outline arrives: Prologue, ten chapters. The pre-revision outline is snapshotted.*

**Step 8 — Verify the full version history:**

> **You:** "Show outline version history for 'The Last Tribune.'"

*Returns three versions — the original, the 12-chapter version, and the pre-midnight-prologue version.*

**Step 9 — Research local color for the prologue:**

> **You:** "Research the Roman Senate building — what it looked like at night, the torches, the marble, the sounds of the city. Also research the night before the Ides of March — what we know about what Caesar and the conspirators were doing."

**Step 10 — Write the prologue:**

> **You:** "Write the prologue for 'The Last Tribune.' Genre political-history."

*Prologue written with historically authentic detail. Story bible created.*

**Step 11 — Write chapters:**

> **You:** "Write chapter one of 'The Last Tribune.' Genre political-history. Chapter number one."

*Continue through all ten chapters. Each chapter builds on the story bible from previous chapters.*

**Step 12 — Research and write the epilogue:**

> **You:** "Research medieval scriptoriums — the tools, the daily routine, what it smelled like, how monks handled ancient texts."

> **You:** "Write the epilogue for 'The Last Tribune.' Genre political-history."

*Epilogue written with the full story bible context from all chapters.*

**Step 13 — Approve and publish:**

> **You:** "Approve my draft called 'The Last Tribune - Prologue.'"

> **You:** "Publish it."

*Repeat for each chapter and the epilogue.*

---

### Scenario 11: Publishing, Approving Drafts, and Scheduling

**Goal:** Complete lifecycle management of content — from draft through approval, scheduling, and publishing. Includes version tracking and status management.

#### Draft → Approve → Publish (Immediate)

**Step 1 — View all your drafts:**

> **You:** "List my drafts."

*Returns all items with draft status — blog posts, short stories, chapters, newsletters.*

**Step 2 — Filter by content type:**

> **You:** "List my draft blog posts."

> **You:** "List my draft short stories."

> **You:** "List my draft chapters."

*Each returns only the specified content type.*

**Step 3 — Approve a draft:**

> **You:** "Approve the draft titled 'Why Post-Apocalyptic Fiction Matters More Than Ever in 2026.'"

*Status changes from draft to approved. A version 1 snapshot is automatically saved. Email notification sent.*

**Step 4 — Publish the approved content:**

> **You:** "Publish 'Why Post-Apocalyptic Fiction Matters More Than Ever in 2026.'"

*Status changes from approved to published. A version 2 snapshot saved. Email notification sent.*

> **Important:** You must approve before publishing. Drafts cannot be published directly.

**Step 5 — Verify:**

> **You:** "List my published content."

*Your published item appears in the list with a publication timestamp.*

#### Draft → Approve → Schedule (Timed)

**Step 1 — Approve a draft:**

> **You:** "Approve the draft called 'The Inoculator.'"

**Step 2 — Schedule for a future date:**

> **You:** "Schedule 'The Inoculator' for 2026-03-20."

*Status changes to scheduled. Email notification includes the scheduled date.*

**Step 3 — Check the schedule:**

> **You:** "Show me my scheduled content."

*Returns all scheduled items with their publication dates.*

**Step 4 — The cron job auto-publishes:**

*The Cron Scheduled Publisher (runs hourly) checks for items with a `schedule_date` in the past. When the date arrives, it automatically publishes and sends an email notification.*

**Step 5 — Cancel a schedule (if needed):**

> **You:** "Unschedule 'The Inoculator.'"

*Status reverts to draft. No auto-publish will occur.*

#### Reject and Unpublish

**Reject a draft or approved item:**

> **You:** "Reject the draft titled 'The Forgotten Engineers of Rome.'"

*Status changes to rejected. Email notification sent.*

**Unpublish a published item:**

> **You:** "Unpublish 'Why Post-Apocalyptic Fiction Matters.'"

*Status reverts from published to approved. Email notification sent.*

#### Version History and Recovery

**View version history:**

> **You:** "Show version history for 'Why Post-Apocalyptic Fiction Matters.'"

*Returns a list of all version snapshots — each approval and publication creates a new snapshot.*

**Retrieve a specific version:**

> **You:** "Get version 1 of 'Why Post-Apocalyptic Fiction Matters.'"

*Returns the content as it was at version 1 (first approval).*

#### Status Lifecycle Rules

```
Draft → Approved → Published
          ↓            ↓
       Scheduled    Unpublished (→ Approved)
          ↓
       Rejected
```

| Action | From Status | To Status | Email? |
|--------|-------------|-----------|--------|
| Approve | Draft | Approved | Yes |
| Publish | Approved | Published | Yes |
| Schedule | Draft or Approved | Scheduled | Yes |
| Unschedule | Scheduled | Draft | Yes |
| Reject | Draft or Approved | Rejected | Yes |
| Unpublish | Published | Approved | Yes |
| Auto-publish | Scheduled (date passed) | Published | Yes |

---

### Scenario 12: Outline Management — List, Version History, Revert

**Goal:** Manage your brainstormed outlines — view all outlines, track revision history, and revert to previous versions when a revision doesn't work.

**Step 1 — List all your outlines:**

> **You:** "List all outlines."

*Returns every writing project that has a saved outline — title, genre, chapter count, creation date.*

**Step 2 — View version history for a specific project:**

> **You:** "Show outline version history for 'The Accord.'"

*Returns all saved versions with version numbers, snapshot dates, and chapter counts. Each revision creates a snapshot automatically.*

**Step 3 — Revert to a previous version:**

> **You:** "Revert the outline for 'The Accord' to version 1."

*The current outline is snapshotted first (so you don't lose it), then version 1 replaces the current outline.*

**Step 4 — Verify the revert:**

> **You:** "Retrieve the outline for 'The Accord.'"

*Returns the version 1 outline — confirming the revert worked.*

**Step 5 — Re-revise after the revert:**

> **You:** "Revise the outline for 'The Accord.' Add a prologue set during humanity's first contact with the alien signal. Keep the existing chapters. Genre slug political-scifi."

*New outline with prologue arrives. The pre-revision state is snapshotted. Version history now has a complete audit trail of every change.*

**Step 6 — View full version history:**

> **You:** "Show outline version history for 'The Accord.'"

*Returns all versions — the original, the first revision, the pre-revert snapshot, and the latest revision. Complete history preserved.*

---

### Scenario 13: Brainstorm a Story from Research — Eve Callback with Full Conversation (Voice)

**Goal:** Research a topic, load the research into Eve's knowledge base via callback, then brainstorm a complete story outline interactively — walking through Eve's 4-step brainstorm conversation mode from seed idea to tool submission.

**Why this matters:** This is the most powerful creative workflow in the system. It combines live research, Eve's knowledge base injection, outbound callback, and the full brainstorm conversation flow into a single session. Eve doesn't just take orders — she becomes a creative collaborator who references your actual research data while helping you shape a story.

---

#### Phase 1: Research First

**Step 1 — Research the topic:**

> **You:** "Research the current state of post-apocalyptic fiction in 2026. What are the trending themes, notable new releases, and how has the genre evolved since COVID? What are the hot Kindle keywords and bestsellers? Include citations."

*Research returned with citations — climate fiction trends, solarpunk counternarratives, AI apocalypse surge, notable titles, Kindle category data.*

**Step 2 — Save the research:**

> **You:** "Save that research as a report called 'Post-Apocalyptic Fiction Trends 2026.' Genre slug post-apocalyptic."

---

#### Phase 2: Trigger the Callback

**Step 3 — Ask Eve to load the research and call you back in brainstorm mode:**

> **You:** "Load the research report on post-apocalyptic trends and call me back. Let's brainstorm a new story outline from it."

*What happens behind the scenes:*
1. Eve says "Let me pull that up... I'll call you right back."
2. Eve fires `forward_writing_request` with "RETRIEVE AND CALLBACK" language, callback_mode=brainstorm
3. The hub calls `retrieve_content` → finds your research report
4. The hub calls `eve_knowledge_callback` → loads the research into Eve's knowledge base
5. Old "Eve Session:" documents in the KB are cleaned up
6. An outbound call is triggered to your phone
7. Eve calls you back within ~30 seconds with the research loaded in her memory

---

#### Phase 3: Brainstorm Conversation (4 Steps)

When Eve calls back, she enters **brainstorm conversation mode** — a creative collaboration, not a checklist interview. The conversation flows through four natural steps.

**Step 4 — Eve opens with a brainstorm greeting and explores the seed idea (Step 1):**

> **Eve:** "Hey love, I've got that research loaded up. Some really interesting stuff in here — climate fiction is merging with post-apocalyptic in a big way, and there's a whole wave of solarpunk counter-narratives pushing back against pure doom. Want me to hit the highlights, or should we start brainstorming right away?"

> **You:** "Let's brainstorm. I'm interested in the climate fiction angle. What if there's a story about a coastal city that's been abandoned after rising seas, and a group goes back to salvage something important?"

> **Eve:** "Oh, I love that. The research actually mentions that 'hopeful apocalypse' stories are trending — where it's not about survival, it's about what's worth saving. Your salvage mission fits that perfectly. What are they going back for? Is it data, seeds, art, people? The 'what' tells me everything about the themes."

*Eve references specific data points from the research — she's not guessing, she's pulling from the report you loaded.*

**Step 5 — Shape the concept (Step 2):**

> **You:** "A seed bank. Like a local version of Svalbard. And the protagonist is a marine biologist who knows which seeds matter. Make it tragic — she should fail."

> **Eve:** "A marine biologist protecting seeds in a drowned city... that's beautiful and brutal. Genre-wise, this is pure post-apocalyptic. For themes, I'm hearing preservation versus pragmatism, nature reclaiming what we stole, and the question of whether saving the future is worth dying for. The research mentioned that readers are responding to 'competence porn' in apocalypse fiction — characters who actually know things. Your marine biologist fits that trend perfectly."

*Eve shapes the genre, premise, and themes naturally — she offers her own creative observations and connects them to the research.*

**Step 6 — Structure the outline (Step 3):**

> **You:** "Yeah, exactly. I want it to feel inevitable. She knows the seeds are humanity's best shot, but the city is falling apart around her."

> **Eve:** "Then Freytags Pyramid is your arc, darling. Five acts ending in catastrophe — she rises, gets close, and it all comes apart. That inevitability you want? Freytag was built for it. The falling action is where the reader knows before she does that it's over. How long are you thinking — a short story or a full book?"

> **You:** "A book. Eight chapters."

> **Eve:** "Eight chapters with Freytag's tragic arc. And we need a title... Something about what's lost. 'The Drowned Garden'? It's got the seeds, the flooding, and the sense of something beautiful being destroyed."

> **You:** "I love that. Use it."

**Step 7 — Confirm and submit (Step 4):**

> **Eve:** "Perfect. So here's what I've got... A book called 'The Drowned Garden.' Post-apocalyptic genre. Eight chapters following Freytags Pyramid. A marine biologist leads a salvage team back into a flooded coastal city to recover a seed bank — humanity's best genetic archive — but the city is collapsing and the mission is doomed from the start. Themes: preservation versus pragmatism, nature reclaiming civilization, whether saving the future is worth dying for. Ready for me to build this outline, or do you want to tweak anything?"

> **You:** "That's perfect. Go for it."

> **Eve:** "Done... I'll have that outline in your inbox shortly, sweetheart."

*Eve calls `forward_writing_request` with:* "Brainstorm a book called 'The Drowned Garden'. Genre slug: post-apocalyptic. 8 chapters. Premise: A marine biologist leads a salvage team back into a flooded coastal city to recover a seed bank — humanity's best genetic archive — but the city is collapsing and the mission is doomed from the start. Themes: preservation versus pragmatism, nature reclaiming civilization, whether saving the future is worth dying for. Using Freytags Pyramid story arc."

---

#### Phase 4: After the Call

**Step 8 — Outline arrives by email:**

*Email contains:*
- Title, premise, themes
- Character profiles (name, role, arc, description)
- 8 chapter breakdowns following Freytag's structure (Introduction, Rising Action, Climax, Falling Action, Catastrophe)
- Research topics for each chapter

*Outline saved to `writing_projects` with the full JSONB outline.*

**Step 9 — Review the outline with Eve (optional):**

> **You:** "Pull up the outline for 'The Drowned Garden' and call me back so we can review it."

*Eve calls back in review mode. She walks through the outline chapter by chapter, identifies any structural weaknesses, and suggests refinements.*

**Step 10 — Start writing:**

> **You:** "Write chapter one of 'The Drowned Garden.' Genre post-apocalyptic. Chapter number one."

*The system loads the stored outline, auto-researches the chapter's topics (flooded urban environments, seed bank biology), and writes the chapter. Email arrives with prose and cover art.*

---

#### What Makes This Workflow Special

| Feature | What It Does |
|---------|-------------|
| **Research-loaded KB** | Eve doesn't brainstorm from generic knowledge — she references YOUR specific research data |
| **4-step conversation** | Natural creative flow: explore → shape → structure → confirm |
| **Story arc suggestion** | Eve recommends Freytag's Pyramid or Three-Act Structure based on your story's tone |
| **Title suggestion** | Eve proposes an evocative working title if you don't have one |
| **No premature submission** | Eve never calls the tool until you explicitly confirm |
| **Seamless handoff** | The brainstormed outline feeds directly into chapter writing with auto-loaded outlines |

---

### Scenario 14: Write a Book Chapter — From Outline to Finished Prose

This scenario covers the complete chapter writing process, from selecting a story arc through generating a chapter outline to producing a fully written, quality-checked chapter. This is the core creative workflow for book-length fiction.

---

#### Understanding Story Arcs

A story arc is a structural framework that governs how your narrative is organized — what beats to hit, in what order, and what emotional progression to follow. The system has 8 story arcs, each designed for different kinds of stories:

**Conflict-Driven Arcs (stories built around tension and transformation):**

| Arc | How It Works | Best For |
|-----|-------------|----------|
| **Three-Act Structure** | Setup (25%) → Confrontation (50%) → Resolution (25%). Key beats: Inciting Incident at the start, Midpoint Shift in the center, Darkest Moment before the climax. | Any genre. The universal default. |
| **Freytag's Pyramid** | Five acts: Exposition → Rising Action → Climax → Falling Action → Resolution. Climax is in the CENTER, not at the end. Acts IV and V handle consequences. | Tragedies, ensemble stories, moral dramas, stories where the fallout matters as much as the crisis. |
| **The Hero's Journey** | 12 stages: Ordinary World → Call → Refusal → Mentor → Threshold → Tests → Inmost Cave → Ordeal → Reward → Road Back → Resurrection → Return with Elixir. | Epic fantasy, adventure, coming-of-age, any story about identity transformation. |
| **Dan Harmon's Story Circle** | 8 steps in a circle: Comfort Zone → Want → Unfamiliar → Adapt → Get → Pay → Return → Changed. Steps 1 and 8 mirror each other. | Character-driven fiction, stories about internal change, relationship drama. |
| **Seven-Point Structure** | Built BACKWARD from the Resolution: Hook → First Plot Point → First Pinch → Midpoint → Second Pinch → Second Plot Point → Resolution. | Plot-driven stories, tight pacing, stories where you know the ending first. |
| **Fichtean Curve** | Opens in medias res, escalates through 3 crises with mini-resolutions between them, peaks at climax, closes with a short resolution. No slow beginning. | Thrillers, mysteries, action, survival, crime, horror. |
| **In Medias Res** | Opens at the most intense moment, then reveals backstory through flashback and embedded exposition. Two layers: Entry Scene + Underlying Chronology. | Thrillers, literary fiction, stories with a shocking opening that demands explanation. |

**Non-Conflict Arc:**

| Arc | How It Works | Best For |
|-----|-------------|----------|
| **Kishōtenketsu** | Four parts: Ki (Introduction) → Shō (Development) → Ten (Twist/Contrast) → Ketsu (Reconciliation). NO conflict required. The Ten is a contrast or revelation, not an attack. | Literary fiction, slice-of-life, fables, children's stories, contemplative narratives, quiet fiction. |

**Key concept: Book Arc vs. Chapter Arc**

A book uses one story arc for its overall structure (e.g., The Hero's Journey across 12 chapters). But each individual chapter can use a DIFFERENT story arc for its internal structure (e.g., Chapter 3 uses the Fichtean Curve internally while still advancing the book's Hero's Journey). This gives you fine-grained control over pacing — a quiet chapter might use Kishōtenketsu while an action chapter uses Fichtean Curve, all within the same book.

---

#### The Chapter Writing Process (5 Steps)

```
Step 1: Brainstorm Book Outline (with story arc)
  ↓
Step 2: Create Chapter Outline (with chapter-level story arc)
  ↓
Step 3: Review and Revise Chapter Outline
  ↓
Step 4: Write the Chapter (sub-chapter by sub-chapter)
  ↓
Step 5: Review Q/A Consistency Report
```

---

#### Step 1: Brainstorm the Book Outline

Choose a story arc and brainstorm the full book outline. This creates the book's premise, characters, themes, and chapter-by-chapter structure.

**Chat:**
```
Brainstorm a book using the Hero's Journey called "The Signal Beneath."
Genre: post-apocalyptic. 8 chapters.
Premise: A radio operator in a collapsed coastal city intercepts a signal
from a submerged research station. She must decide whether to investigate
alone or alert the warlord who controls the only working boat.
Themes: sacrifice, trust, the cost of knowledge.
```

**Voice:**
> "Brainstorm a book using the Fichtean Curve called 'The Burial Mound.' Genre ancient history. Twelve chapters."

**What happens:**
- The story arc prompt is loaded from the database (e.g., the full Hero's Journey 12-stage framework with examples)
- Perplexity researches the concept
- Claude generates the outline following the arc's structural requirements
- The outline includes characters (with roles and arcs), chapter briefs, arc notes for each chapter, and research topics
- The `story_arc_name` is saved with the outline so all downstream workflows know which arc governs the book
- The outline is emailed for review

**What you get:** An email with the full book outline — premise, themes, characters, and every chapter with its brief and arc position.

---

#### Step 2: Create the Chapter Outline

Before writing any chapter, create a detailed chapter outline that breaks it into sub-chapters (scenes). Each sub-chapter will be written as a full ~5,000-word scene.

**Chat:**
```
create a chapter outline for the prologue of The Burial Mound using the Fichtean Curve
```

```
create a chapter outline for chapter 3 of The Signal Beneath using Kishōtenketsu
```

**Voice:**
> "Create a chapter outline for chapter one of The Signal Beneath using Dan Harmon's Story Circle"

**What happens:**
- The book outline is loaded (characters, premise, all chapter briefs)
- The book's story arc prompt AND the chapter's story arc prompt are both loaded
- Claude generates sub-chapters (typically 3-8), each with:
  - **Title** — the scene name
  - **Arc beat** — which beat of the chapter's story arc this scene represents
  - **Characters** — exact names from the book outline
  - **Setting** — where and when the scene takes place
  - **Emotional tone** — the dominant feeling
  - **Brief** — a detailed 3-5 sentence description of what happens
  - **Book arc connection** — how this scene advances the overall book story
- The chapter outline is saved into the book outline (so write_chapter can find it)
- The chapter outline is emailed for review

**What you get:** An email with the chapter outline showing every sub-chapter scene with its arc beat, characters, setting, and detailed brief.

**Why the chapter can use a different story arc:**
- Your book might follow the Hero's Journey overall, but Chapter 4 is a quiet, reflective chapter — use Kishōtenketsu for that chapter's internal structure
- Chapter 7 is a high-tension action sequence — use the Fichtean Curve
- Chapter 10 is the emotional climax — use Freytag's Pyramid to give space to the consequences
- The chapter outline maps each sub-chapter to BOTH the chapter's arc beats AND the book's overall arc position

---

#### Step 3: Review and Revise

Review the emailed chapter outline. If changes are needed:

**Chat:**
```
revise the chapter outline for the prologue of The Burial Mound.
Make sub-chapter 2 focus more on the protagonist's internal conflict.
Add a scene where she finds her dead partner's journal in the radio station.
```

**Voice:**
> "Revise the chapter outline for chapter 3 of The Signal Beneath. The second sub-chapter should show more tension between the protagonist and the warlord. Remove the scene at the dock."

Each revision:
- Preserves existing sub-chapters unless you specifically change them
- Keeps all character names from the book outline
- Saves the updated outline automatically
- Emails the revised version for review

Repeat until satisfied.

---

#### Step 4: Write the Chapter

Once you approve the chapter outline, write the chapter. The system writes each sub-chapter as a separate ~5,000-word scene, then concatenates them into the full chapter.

**Chat:**
```
write the prologue for The Burial Mound
```

**Voice:**
> "Write chapter one of The Signal Beneath"

**What happens behind the scenes:**

1. **Safety gate** — checks that a chapter outline with sub-chapters exists. If not, the workflow stops and tells you to create one first.

2. **For each sub-chapter** (e.g., 8 sub-chapters = 8 separate writing calls):
   - Claude receives the sub-chapter's specific brief, characters, setting, arc beat, and emotional tone
   - Claude also receives the full chapter structure (all sub-chapters) for context
   - Claude receives summaries of previous sub-chapters for continuity
   - Claude receives the book outline, story bible, story arc framework, genre guidelines, and research
   - The story arc prompt has all placeholders filled in with actual project data (genre, protagonist, setting, stakes)
   - Claude writes ~5,000 words of rich, detailed prose for that scene
   - **CHARACTER & SCENE DEPTH REQUIREMENTS** enforce:
     - Full physical descriptions for first-appearance characters
     - Local color in every scene (sounds, smells, textures, light, weather)
     - Scenes written at the pace of lived experience
     - No compressed or summarized sub-chapters

3. **Concatenation** — all sub-chapter outputs are joined with scene breaks (---) into one chapter

4. **Story bible update** — new characters, locations, and plot threads are added

5. **Version snapshot** — if a previous version of this chapter exists, it's saved to version history before overwriting

6. **Q/A Consistency Report** — a separate Claude call validates the written chapter against:
   - Character consistency (names match book outline)
   - Book arc advancement (chapter hits its assigned arc beat)
   - Chapter outline adherence (sub-chapters followed in sequence)
   - Plot consistency (no contradictions)
   - Theme alignment (no drift from book themes)
   - Story drift risk (no subtle direction changes)
   - Book story arc compliance (structural beat fulfilled)
   - Chapter story arc compliance (internal structure followed)
   - Arc contradiction check (no structural violations)

7. **Email** — the full chapter is emailed with the Q/A Consistency Report appended at the bottom

**What you get:** An email containing:
- The full chapter (~25,000-40,000 words depending on sub-chapter count)
- Scene breaks between sub-chapters
- A Story Consistency Report at the bottom showing PASS or NEEDS_REVIEW with detailed check results

**Estimated time:** ~8-10 minutes for an 8 sub-chapter chapter (each sub-chapter takes ~60 seconds to write).

---

#### Step 5: Review the Q/A Report

The Q/A Consistency Report at the bottom of the email tells you whether the chapter stayed on track:

- **All PASS** — the chapter follows both outlines, uses correct characters, and advances the story arc
- **NEEDS_REVIEW** — one or more checks failed. Read the specific concerns:
  - Wrong character names → the writer invented or renamed characters
  - Arc contradiction → the chapter doesn't fulfill its assigned story arc beat
  - Story drift → the narrative is subtly moving off the book's intended path
  - Chapter outline not followed → sub-chapters were skipped or reordered

If the Q/A report shows issues, rewrite:
```
write the prologue for The Burial Mound
```

Each rewrite auto-snapshots the previous version. You can recover any version:
```
get version 2 of the prologue for The Burial Mound
```

---

#### Complete Example: Writing a Chapter of "The Burial Mound"

**1. The book outline already exists** (brainstormed with Kishōtenketsu as the book arc)

**2. Create the chapter outline for the prologue using Fichtean Curve:**
```
create a chapter outline for the prologue of The Burial Mound using the Fichtean Curve
```
*Result: 8 sub-chapters emailed — Opening in Medias Res through Resolution, each with characters, settings, and detailed briefs.*

**3. Review the email. Request a revision:**
```
revise the chapter outline for the prologue of The Burial Mound.
Add more detail to sub-chapter 3 about the copper pendant's warmth.
Make sub-chapter 6 more emotionally intense — this is the breaking point.
```
*Result: revised outline emailed with changes.*

**4. Satisfied with the outline. Write it:**
```
write the prologue for The Burial Mound
```
*Result: ~40,000 words written across 8 sub-chapters, each with full sensory detail, character descriptions, and local color. Q/A report appended. Story bible updated. Previous version saved.*

**5. Check the Q/A report. All checks pass. Move to Chapter 1:**
```
create a chapter outline for chapter 1 of The Burial Mound using Kishōtenketsu
```
*This chapter uses a different arc (Kishōtenketsu) for a quieter, contemplative scene — while still advancing the book's overall Fichtean Curve arc.*

---

#### How Story Arcs Shape the Writing

Each story arc prompt is injected directly into the writing instructions. Here's how they affect the output:

| Arc | What Claude Is Told | How It Affects the Writing |
|-----|--------------------|-----------------------------|
| **Three-Act Structure** | "Act I establishes normalcy. The Inciting Incident disrupts. Act II escalates through obstacles. The Midpoint shifts gears. Act III delivers the climax and resolution." | Balanced pacing, clear turning points, protagonist changes visibly by the end |
| **Freytag's Pyramid** | "Five acts. The climax is in the CENTER. Acts IV and V show consequences. Do not skip the falling action." | More time spent on aftermath, moral weight visible, transformation earned through consequence |
| **The Hero's Journey** | "Follow the 12 stages. The mentor gives something irreplaceable and then disappears. The ordeal is a death, not a difficulty. The elixir must be traceable to the ordeal." | Mythic resonance, clear departure/return structure, mentor relationship central |
| **Dan Harmon's Story Circle** | "Steps 1 and 8 mirror each other. Steps 2 and 6 mirror. The character ends in the same place but fundamentally different." | Strong internal arc, visible character change, want vs. need tension |
| **Fichtean Curve** | "Drop into conflict immediately. Three escalating crises with mini-resolutions. Each crisis more personal than the last. Short, impactful resolution." | High tension from page one, no slow beginning, backstory revealed in motion |
| **In Medias Res** | "Open at the most intense moment. Build two layers: forward narrative and backstory delivery points. Never front-load exposition." | Gripping opening, mystery and revelation structure, reader pulled forward by not-knowing |
| **Seven-Point Structure** | "Build backward from the Resolution. The Hook is the opposite of the Resolution. No new information after the Second Plot Point." | Tight structural logic, satisfying inevitability, every beat earns the ending |
| **Kishōtenketsu** | "No conflict required. Ki invites, Shō deepens, Ten surprises through contrast, Ketsu resonates. Silence is content. The callback earns the ending." | Quiet emotional power, contrast instead of conflict, restraint in resolution |

---

## 22. Tips & Troubleshooting

### General Tips

- **Always specify the genre slug** for best results, even if the topic seems obvious.
- **Check your email** — most outputs are delivered there, not in the chat.
- **Be patient with long tasks.** Short stories and chapters with research can take 1–2 minutes.
- **Multi-step conversations work.** You can research first, then write based on that research in the next message.
- **Story arcs are optional.** If you don't specify one, the system uses its default 10 story structure guidelines.
- **Project titles must match.** When writing from a brainstormed outline, use the exact title you used during brainstorming.

### Voice Tips

- Speak naturally. Eve handles "um," "like," "you know," and other filler words.
- You don't need to pause between parameters. "Genre slug post-apocalyptic about fifteen hundred words" runs together fine.
- If Eve misunderstands a genre, say: "No, I meant the ancient history genre."
- For callbacks, use clear callback language: "call me back," "help me improve it," "let's go over it."

### Common Issues

| Problem | Solution |
|---------|----------|
| Email didn't arrive | Check spam folder. The email comes from your connected Gmail account. |
| Cover art looks wrong for the genre | Make sure you included the correct genre slug. Each genre has different art guidelines. |
| "Content not found" when retrieving | Try listing your drafts first to see exact titles. Search terms need to roughly match. |
| Eve didn't call back | Make sure you used callback language like "call me back" or "help me improve it." |
| Story doesn't match brainstormed outline | Make sure the project title matches exactly what you used during brainstorming. |
| "Content not found" for a chapter | The chapter hasn't been written yet — only the outline exists. Run Write Chapter first, then retrieve. |
| Outline revision went to chat | Use exact phrasing: "expand the outline for [title]" or "revise the outline for [title]". Include the project title. |
| Can't approve a published item | Items follow a strict lifecycle. Only drafts can be approved. Check the item's current status. |
| Can't publish a draft directly | You must approve first, then publish. Two-step process. |
| Story arc not found | Check the exact name with "list story arcs." Names use fuzzy matching but should be close. |
| Outline version not found | Use "show outline version history" to see available version numbers before reverting. |
| "List outlines" returns nothing | No brainstormed outlines exist yet. Brainstorm a story first to create an outline. |
| Revert didn't change the outline | Verify the version number exists in the history. Check the Supabase `outline_versions` table. |

---

## 23. Story Structure Guidelines

The Author Agent uses two layers of structural guidance:

1. **Story Arcs** (Section 10) — Named frameworks you choose explicitly. Eight arcs are available: Freytag's Pyramid, Three-Act Structure, The Hero's Journey, Dan Harmon's Story Circle, In Medias Res, Seven-Point Structure, Kishōtenketsu, and Fichtean Curve. Stored in the `story_arcs` database table.
2. **Default Guidelines** — A set of 10 story structure guidelines automatically loaded when no arc is specified. Stored in `app_config`.

### The 10 Default Guidelines

These are automatically applied when you brainstorm, write a short story, or write a chapter without specifying a story arc.

**Guideline 1 — Weave Plot and Story Together**
Every story combines what happens (events) with what matters (character motivation, conflict, stakes).

**Guideline 2 — Build All Five Structural Stages**
Exposition → Rising Action → Climax → Falling Action → Resolution (Denouement).

**Guideline 3 — Assign Clear Character Roles**
Every character serves one of four structural roles:
- **Protagonist** — whose journey we follow
- **Antagonist** — whose goals oppose the protagonist's
- **Dynamic Character** — visibly changes as a result of story events
- **Static Character** — remains unchanged; serves as foil or anchor

**Guideline 4 — Hero's Journey (for mythic/adventure arcs)**
12-beat structure: Ordinary World → Call to Adventure → Refusal → Mentor → Threshold → Tests → Inmost Cave → Ordeal → Reward → Road Back → Resurrection → Return with Elixir.

**Guideline 5 — Three-Act Structure (for general fiction)**
- Act 1 (Setup): Exposition → Inciting Incident → Plot Point 1
- Act 2 (Confrontation): Rising Action → Midpoint → Plot Point 2
- Act 3 (Resolution): Dark night of the soul → Climax → Denouement

**Guideline 6 — Seven-Point Structure (for plot-driven stories)**
Hook → Plot Point 1 → Pinch Point 1 → Turning Point → Pinch Point 2 → Plot Point 2 → Resolution.

**Guideline 7 — Match Structure to Tone and Genre**

| Story Type | Structure Used |
|---|---|
| Mythic / Adventure / Fantasy | Hero's Journey |
| General literary fiction | Three-Act Structure |
| Tight plot-driven narratives | Seven-Point Structure |
| Tragedy / dark contemporary | Freytag's Pyramid |
| Character-driven | Dan Harmon's Story Circle |
| Thrillers, mysteries, dual timelines | In Medias Res |
| Literary, slice-of-life, contemplative | Kishōtenketsu |
| Thrillers, action, survival, crime | Fichtean Curve |
| Fast-paced, scene-driven | Fichtean Curve |
| Screenwriting-influenced | Save the Cat Beat Sheet |

**Guideline 8 — The 10-Beat Story Outline**
Ordinary world → shocking disruption → protagonist commits → sincere attempt fails → things get worse → rock bottom → full commitment → slim hope → final push succeeds → transformed ordinary world.

**Guideline 9 — Fichtean Curve (for high-tension stories)**
Skip formal exposition. Begin in the rising action. Let character and setting details emerge through conflict.

**Guideline 10 — Ensure Character Transformation**
The protagonist must be meaningfully changed by the end — emotionally, psychologically, or in their understanding of the world.

### How These Apply

**You don't need to do anything differently.** The guidelines are automatically applied when you:
- Brainstorm a story (without specifying a story arc)
- Write a short story
- Write a chapter

**What you'll notice:**
- Brainstorm outlines name the structural model chosen (Three-Act, Hero's Journey, etc.) in the arc notes
- Characters have explicit role assignments (Protagonist, Antagonist, etc.)
- Short stories have a clear five-stage arc — not just a sequence of events
- Chapters end with the protagonist in a different state than they began

**Updating the guidelines:**
The guidelines are stored in Supabase under `app_config` with key `story_structure_guidelines`. Change the value there — all workflows pick up the change automatically.
