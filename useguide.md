# The Author Agent — User Guide

> **Welcome!** This guide walks you through every feature of The Author Agent, your AI-powered writing assistant. Whether you're typing commands or speaking to Eve (your voice agent), this guide has sample prompts and conversations for everything you can do.
>
> **No prior experience with voice agents or AI assistants is needed.** Just speak naturally or type your request — the system handles the rest.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Getting Started with Eve (Voice)](#2-getting-started-with-eve-voice)
3. [Your Genres](#3-your-genres)
4. [Switching Genres](#4-switching-genres)
5. [Chat Features](#5-chat-features-typing)
6. [Voice Features (Eve)](#6-voice-features-eve)
7. [Content Library](#7-content-library)
8. [Research & Reports](#8-research--reports)
9. [Brainstorming & Outlining](#9-brainstorming--outlining)
10. [Writing Chapters (Book Projects)](#10-writing-chapters-book-projects)
11. [Story Bible](#11-story-bible)
12. [Eve Review Mode (Voice Callbacks)](#12-eve-review-mode-voice-callbacks)
13. [Tips & Troubleshooting](#13-tips--troubleshooting)
14. [Acceptance Test Walkthroughs](#14-acceptance-test-walkthroughs)

---

## 1. Getting Started

The Author Agent works in two ways:

- **Chat** — Type your requests directly into the n8n chat interface. Best for detailed prompts with specific parameters.
- **Voice (Eve)** — Speak your requests to Eve, your ElevenLabs voice assistant. Best for quick commands, brainstorming sessions, and hands-free writing.

Both methods access the same tools. Anything you can type, you can say — and vice versa.

### What You'll Receive

Most features deliver results by email. When you ask the agent to write something, you'll get:
- The written content in a formatted email
- Cover art (for stories, blog posts, and some social posts)
- A draft saved to your content library for later review

---

## 2. Getting Started with Eve (Voice)

Eve is your voice-powered writing partner. Think of her like calling a co-author on the phone — you talk, she listens, and she kicks off whatever you need. Here's how to get comfortable with her, starting simple and building up to a full book project.

### Your First Conversation with Eve

When you first connect with Eve, just say hello. She'll greet you and ask what you'd like to work on. You don't need special commands — talk like you're speaking to a colleague.

> **You:** "Hey Eve, I'm new to this. What can you help me with?"
>
> **Eve:** *(She'll walk you through the basics — writing, research, brainstorming, reviewing content.)*

### Scenario 1: Write Your First Blog Post

Start with something simple — a single blog post. Just tell Eve what you want to write about and which genre it's in.

> **You:** "I'd like to write a blog post about the lost city of Petra and why it still fascinates us. Genre is ancient history. About fifteen hundred words."

That's it. Eve sends the request to the hub, and within a couple of minutes you'll receive an email with:
- A complete blog post in the ancient-history tone (immersive, sensory-rich)
- A DALL-E generated cover image (classical painting style, warm golden light)
- A draft saved to your content library

**Want to try a different genre?** Just say another one:

> **You:** "Now write a blog post about how AI copywriters are replacing human ad agencies. Genre slug ai-marketing. About two thousand words."

The tone and cover art style shift automatically to match the genre.

### Scenario 2: Research a Chapter Before You Write It

Before diving into a chapter, you might want to do background research. Eve can research any topic using live internet search and return results with real citations.

> **You:** "I'm working on a chapter set during the siege of Constantinople in 1453. Can you research what daily life was like inside the city during the final siege? What did ordinary people experience?"

Eve runs a Perplexity search and returns findings with sources. You can then use this to inform your writing.

> **You:** "That's great. Now save that research as a report. Call it 'Constantinople Final Siege Daily Life.' Genre slug ancient-history."

Now the research is stored and you can reference it anytime.

> **You:** "Alright, now write a chapter using that research. Genre slug ancient-history. Project title: 'The Walls of God.' Chapter number: 3. Brief: Alexios, a baker's son turned militia volunteer, spends his last night inside the walls before the final assault. He writes a letter to his mother, helps repair a breach, and watches the Ottoman campfires stretch to the horizon."

Eve researches any additional topics, writes the chapter in your ancient-history tone, updates the story bible with characters and locations, and emails you the result.

### Scenario 3: Start a Book from Scratch — Research, Brainstorm, and Write

This is where Eve really shines. Here's a full conversation flow for starting a new book project, from initial research through brainstorming to writing the first chapters.

**Step 1 — Explore your subject:**

> **You:** "I want to write a book set during the Roman Republic. Research what caused the fall of the Roman Republic — the key events, the political players, and what modern historians think really went wrong."

*Eve returns research with citations. You read through it and get inspired.*

**Step 2 — Brainstorm the story:**

> **You:** "Okay, brainstorm a story called 'The Last Tribune.' It's about a young Roman tribune who uncovers a conspiracy to assassinate Julius Caesar — but he can't decide if stopping it would save the Republic or doom it. Genre slug political-history. Eight chapters. Themes are loyalty versus principle, the cost of power, and whether one person can change history."

Eve runs additional research, then builds a full structured outline with:
- Character profiles (your tribune, the conspirators, Caesar, allies)
- Eight chapter breakdowns with titles, briefs, arc notes, and research topics
- Thematic threads woven through the structure

You receive this as a formatted HTML email and it's saved to your writing projects.

**Step 3 — Review the outline with Eve:**

> **You:** "Pull up the outline for 'The Last Tribune' and call me back so we can go over it together."

Eve loads the outline into her knowledge base, then calls your phone. Now you're having a live conversation about your book:

> **Eve:** "I've got the outline for 'The Last Tribune' loaded up. You've got eight chapters following Tribune Marcus Decimus as he uncovers the conspiracy. Want to walk through it chapter by chapter, or is there a specific part you want to rework?"
>
> **You:** "I think chapter 3 is weak. The pacing feels off — he discovers the conspiracy too easily. Can we add more tension?"
>
> **Eve:** "Good instinct. Right now chapter 3 has Marcus finding a list of conspirators in Brutus's study. What if instead he overhears a fragment of conversation — just enough to suspect, but not enough to be sure? That way the tension builds through chapters 3 and 4..."

You brainstorm back and forth until you're happy with the structure.

**Step 4 — Write chapter 1:**

> **You:** "Write chapter one of 'The Last Tribune.' Genre slug political-history. Chapter number one."

Eve automatically loads your saved outline — you don't need to re-describe the story. The chapter is written to match your outline's brief, tone, and character details.

**Step 5 — Write chapter 2:**

> **You:** "Write chapter two of 'The Last Tribune.' Genre slug political-history. Chapter number two."

Each chapter builds on the story bible from previous chapters. Characters, locations, and plot threads stay consistent.

**Step 6 — Review chapter 2 with Eve:**

> **You:** "Get my chapter two of 'The Last Tribune' and call me back so we can revise it."

Eve calls you back with the chapter loaded. She can quote specific passages, point out pacing issues, suggest stronger openings, and help you tighten dialogue.

**Step 7 — Continue writing:**

Repeat steps 5 and 6 for each chapter. You can also:
- Check the story bible at any time: *"Get the story bible for 'The Last Tribune.'"*
- Do additional research mid-project: *"Research Roman funeral customs for chapter 5."*
- Generate cover art: *"Generate cover art for 'The Last Tribune.' Genre slug political-history. A Roman forum at dusk with a lone figure standing before the Senate steps."*

### Quick-Start Commands for Eve

Here are simple one-line commands to get you going immediately:

| What You Want | What to Say |
|---------------|-------------|
| Write a blog post | *"Write a blog post about [topic]. Genre [name]. About [number] words."* |
| Write a newsletter | *"Write a newsletter for the [genre] genre about [topic]. Date today."* |
| Write a short story | *"Write a short story in the [genre] genre about [premise]. About [number] words."* |
| Research a topic | *"Research [topic]. Include citations."* |
| Brainstorm a book | *"Brainstorm a story called [title] about [premise]. Genre [name]. [Number] chapters."* |
| Write a chapter | *"Write chapter [number] of [title]. Genre [name]."* |
| Generate cover art | *"Generate cover art for [title]. Genre [name]. [Description of the image]."* |
| List your drafts | *"Show me my drafts."* |
| Review something | *"Pull up [content description] and call me back so we can [review/brainstorm]."* |
| Save research | *"Save that research as a report called [title]."* |

---

## 3. Your Genres

You have six genres available. Each genre has its own writing tone, style guidelines, and cover art aesthetic.

| Genre | Genre Slug | Tone | Cover Art Style |
|-------|-----------|------|-----------------|
| Post-Apocalyptic Science Fiction | `post-apocalyptic` | Gritty, visceral, atmospheric | Muted colors, ruins, decay, desolate landscapes |
| Political Science Fiction | `political-scifi` | Cerebral, tense, morally ambiguous | Dark, imposing, institutional settings |
| Historical Time Travel | `historical-time-travel` | Meticulous, wonder-infused, literary | Period-appropriate imagery, blended eras |
| AI & Marketing Technology | `ai-marketing` | Authoritative, forward-looking, practical | Clean gradients, blues/purples, circuit patterns |
| Political & Historical Events | `political-history` | Analytical, layered, draws parallels to today | Documentary/oil painting style, amber lighting |
| Ancient History & Historical Novels | `ancient-history` | Immersive, sensory-rich, reverent of detail | Classical painting, warm golden light, earth tones |

### What Is a "Genre Slug"?

A genre slug is the short identifier the system uses to look up your genre's settings. You'll see it in many of the example prompts below. The six slugs are:

`post-apocalyptic` · `political-scifi` · `historical-time-travel` · `ai-marketing` · `political-history` · `ancient-history`

---

## 4. Switching Genres

Switching genres is simple: **just include the genre slug in your request.** There is no separate "switch genre" command — you set the genre each time you ask for something.

### Chat Examples

Write in post-apocalyptic:
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

If you don't specify a genre, the agent will try to infer one from your topic:
- A story about pharaohs → `ancient-history`
- A story about AI and advertising → `ai-marketing`
- A story about a dystopian wasteland → `post-apocalyptic`

But for best results, always include the genre slug explicitly.

---

## 5. Chat Features (Typing)

These are all the things you can do by typing into the n8n chat interface.

### 5.1 Write a Blog Post

Creates an SEO-optimized blog post with cover art, saves a draft, and emails you the result.

```
Write a blog post for the post-apocalyptic genre.
Topic: "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026".
Genre slug: post-apocalyptic.
Keywords: post-apocalyptic books, climate fiction, survival stories, dystopian novels.
Target length: 1500 words.
```

**What you get:** An email with the blog post text + a DALL-E generated cover image + a draft saved to your content library.

#### More Blog Post Examples (Other Genres)

Ancient history:
```
Write a blog post in the ancient-history genre.
Topic: "The Forgotten Engineers of Rome: How Aqueducts Shaped an Empire".
Genre slug: ancient-history.
Keywords: Roman engineering, aqueducts, ancient infrastructure, Frontinus.
Target length: 1500 words.
```

AI & Marketing:
```
Write a blog post about how AI is transforming content marketing in 2026.
Genre slug: ai-marketing.
Keywords: AI tools, marketing automation, content strategy.
Target length: 1500 words.
```

Political history:
```
Write a blog post about revolutions that reshaped the modern world.
Genre slug: political-history.
Keywords: French Revolution, American Revolution, political upheaval.
Target length: 1500 words.
```

---

### 5.2 Write a Newsletter

Creates a structured newsletter (subject line, intro, sections, outro) and emails it to you.

```
Write a newsletter for the political-scifi genre.
Topic: "Power Structures in Space: How Sci-Fi Predicts Real-World Politics".
Genre slug: political-scifi.
Date: 2026-03-09.
```

#### More Newsletter Examples

```
Write a newsletter for the political-history genre.
Topic: "This Month in Political History: Revolutions That Changed the Map".
Genre slug: political-history.
Date: 2026-03-09.
```

```
Write a newsletter for the ancient-history genre.
Topic: "Ancient Roman Festivals and Their Modern Echoes".
Genre slug: ancient-history.
Date: 2026-03-09.
```

---

### 5.3 Write a Short Story

Creates a complete short story with research, cover art, and email delivery.

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

#### More Short Story Examples

AI & Marketing:
```
Write a short story in the ai-marketing genre.
Genre slug: ai-marketing.
Premise: An AI trained to write ad copy for a luxury perfume brand starts composing
poetry instead — and the poems sell better than any ad ever did.
Tone: satirical, sharp, funny.
Length: 2000 words.
Research topics: ["AI generated advertising 2026", "perfume marketing psychology",
"computational creativity"]
```

Ancient history:
```
Write a short story in the ancient history genre about a Roman soldier who discovers
a hidden library beneath the Colosseum. Genre slug: ancient-history. Length: 3000 words.
Research topics: ["Roman military life", "Colosseum underground tunnels"]
```

---

### 5.4 Generate Cover Art

Creates a DALL-E image based on your description and genre art style, then emails it.

```
Generate cover art for a political-scifi short story called "The Senate of Stars".
The story is about a diplomat navigating a galactic parliament where every species
has a fundamentally different concept of justice. Genre slug: political-scifi.
The image should show a vast circular chamber with alien delegates, lit by the light
of a dying star through a massive viewport.
```

#### More Cover Art Examples

Post-apocalyptic:
```
Generate cover art for a post-apocalyptic story called "Ash".
Genre slug: post-apocalyptic.
A lone figure walking through a gray, ash-covered landscape.
```

Ancient history:
```
Generate cover art for an ancient-history novel called "The Last Pharaoh's Scribe".
Genre slug: ancient-history.
The image should show an ancient Egyptian library with papyrus scrolls, oil lamps,
and a view of Alexandria's harbor through a columned window.
```

AI & Marketing:
```
Generate cover art for an ai-marketing blog post called "The Algorithm That Learned
to Dream". Genre slug: ai-marketing. The image should represent the intersection of
artificial intelligence and human creativity.
```

---

### 5.5 Repurpose to Social Media

Converts content into platform-specific social media posts.

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

---

### 5.6 Deep Research

Runs a live internet search using Perplexity AI and returns results with citations. No email sent — results appear in the chat.

```
Research the current state of post-apocalyptic fiction in 2026. What are the trending
themes, notable new releases, and how has the genre evolved since COVID? Include citations.
```

```
Research ancient Roman gladiator training methods.
```

```
Research the fall of the Roman Empire and why it collapsed.
```

---

### 5.7 Email a Report

Sends any content as a formatted HTML email.

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

Send it to eric@agileadtesting.com with subject line "My Research Summary"
```

---

## 6. Voice Features (Eve)

Eve is your voice assistant. You speak to her naturally — no special syntax needed. She understands casual, messy, real-world speech.

### How to Talk to Eve

- **Be natural.** You don't need to speak in commands. "Um, yeah, can you write a blog post about, like, AI marketing?" works just as well as a formal request.
- **Say the genre.** Include the genre name or slug: "in the ancient history genre" or "genre slug ancient-history."
- **Say the platform** for social posts: "platform twitter" or "make it for LinkedIn."
- **Numbers are flexible.** "fifteen hundred words" and "1500 words" both work.
- **You can chain requests.** "Research X, then write a blog about it."

### 6.1 Voice — Research

> "Hey, can you research what's going on with post-apocalyptic fiction right now? Like what are the big trends and new books coming out? What are the current hot Amazon Kindle keywords and best sellers?"

> "Research the fall of the Roman Empire and why it collapsed."

---

### 6.2 Voice — Save Research

After the agent returns research results:

> "Save that research as a report. Call it 'Post-Apocalyptic Trends 2026.'"

---

### 6.3 Voice — Email a Report

> "Send me an email with a summary of that research. Use the subject line 'Voice Test Research Report.'"

---

### 6.4 Voice — Write a Blog Post

> "Write a blog post about how AI is changing marketing in 2026. Genre slug ai-marketing. Keywords: AI tools, marketing automation. Target about fifteen hundred words."

---

### 6.5 Voice — Write a Newsletter

> "Write me a newsletter for the political history genre about revolutions that changed the world. Date today."

---

### 6.6 Voice — Write a Short Story

> "Write a short story in the ancient history genre about a Roman soldier who discovers a hidden library beneath the Colosseum. Make it about three thousand words and research Roman military life and the Colosseum underground tunnels."

---

### 6.7 Voice — Generate Cover Art

> "Generate cover art for a post-apocalyptic story called 'The Last Signal.' Show a figure on a rooftop with a radio antenna surrounded by a flooded city at sunset."

---

### 6.8 Voice — Social Media Posts

> "Take this and make Twitter posts from it: 'The Last Signal is a new story about a radio operator in flooded Manhattan picking up a mysterious broadcast.' Platform Twitter."

> "Repurpose that blog post about AI marketing into LinkedIn posts."

---

### 6.9 Voice — Natural/Messy Speech

Eve handles filler words, pauses, and casual language. All of these work:

> "Um, yeah, so I want to, uh, write a blog post about like how political science fiction predicted the rise of, like, AI governance and surveillance states, you know, like 1984 and all that. Genre is political sci-fi, about two thousand words."

> "Write me a story about ancient Egypt, like pharaohs and pyramids and stuff."

(Eve infers the genre as `ancient-history` from context.)

---

## 7. Content Library

Every piece of content you create is saved as a draft. You can manage drafts through a simple lifecycle:

```
Draft → Approved → Published
          ↓
       Scheduled (auto-publishes)
          ↓
       Rejected
```

**Status rules enforced automatically:**
- Only **drafts** can be approved
- Only **approved** items can be published (must approve first)
- Only **draft or approved** items can be rejected or scheduled
- Only **published** items can be unpublished
- Only **scheduled** items can be unscheduled

Email notifications are sent automatically when you approve, publish, reject, schedule, unschedule, or unpublish content.

### 7.1 View All Content

See everything in your library at once — all statuses shown with a label.

**Chat:**
```
Show me all my content
```

**Voice:**
> "Show me everything in my library."
> "What's all my content?"
> "Show all my posts."

Returns every item labeled `[DRAFT]`, `[APPROVED]`, `[PUBLISHED]`, `[SCHEDULED]`, or `[REJECTED]`.

### 7.2 List by Status

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

### 7.3 Filter by Content Type

**Chat:**
```
List my draft blog posts
List my draft short stories
List my published newsletters
```

This filters to only show blog posts, short stories, newsletters, or chapters.

### 7.4 Approve a Draft

Moves an item from **draft** to **approved**. A version snapshot is automatically saved.

**Chat:**
```
Approve the draft titled "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```

**Voice:**
> "Approve the draft called 'Why Post-Apocalyptic Fiction Matters.'"
> "Approve my latest blog post."

> ⚠️ Only drafts can be approved. If you try to approve something that's already approved or published, you'll get an error.

### 7.5 Publish Content

Moves an item from **approved** to **published**. A version snapshot is automatically saved. You **must approve first**.

**Chat:**
```
Publish the content titled "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```

**Voice:**
> "Publish it."
> "Now publish that story."

> ⚠️ Only approved items can be published. If you try to publish a draft, you'll be told to approve it first.

### 7.6 Unpublish Content

Removes an item from **published** status, reverting it back to **approved**. Use this to pull content without deleting it.

**Chat:**
```
Unpublish "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```

**Voice:**
> "Unpublish that article."
> "Take 'Why Post-Apocalyptic Fiction Matters' off of published."
> "Remove that post from published."

### 7.7 Reject a Draft

Moves an item from **draft** or **approved** to **rejected**.

**Chat:**
```
Reject the draft titled "The Forgotten Engineers of Rome"
```

**Voice:**
> "Reject that draft."

### 7.8 Schedule Publishing

Instead of publishing immediately, schedule content to be published at a future date. A background process checks every hour and auto-publishes when the date arrives.

**Chat:**
```
Schedule "Why Post-Apocalyptic Fiction Matters" for 2026-03-15
```

**Voice:**
> "Schedule that for March fifteenth."
> "Schedule my blog post for next Friday."

You receive an email confirmation when scheduled, and another when it auto-publishes.

### 7.9 Unschedule Content

Cancels a scheduled publication, reverting the item back to **draft** status.

**Chat:**
```
Unschedule "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```

**Voice:**
> "Unschedule that post."
> "Cancel the schedule for 'Why Post-Apocalyptic Fiction Matters.'"
> "Remove that from the schedule."

### 7.10 Version History

Every time you approve or publish content, a version snapshot is automatically saved. You can view the history and retrieve older versions.

**List versions:**
```
Show version history for [content title or ID]
```

**Voice:**
> "Show me the version history for my blog post about AI marketing."

**Get a specific version:**
```
Get version 2 of [content title or ID]
```

**Voice:**
> "Get version one of that blog post."

### 7.11 Notifications

You receive an email notification whenever you:
- **Approve** a draft
- **Publish** content
- **Unpublish** content
- **Reject** a draft
- **Schedule** content for future publishing
- **Unschedule** content
- Content is **auto-published** by the scheduler

Notifications are sent to your configured email address and include the content title, action taken, new status, and timestamp.

---

## 8. Research & Reports

Save, organize, and retrieve your research for later use.

### 8.1 Save a Research Report

After running a deep research query:

```
Save that research as a report with topic "Post-Apocalyptic Fiction Trends 2026"
and genre slug post-apocalyptic.
```

### 8.2 List Research Reports

**Chat:**
```
List my research reports
```

**Voice:**
> "Show me all my research reports."

### 8.3 Get a Specific Report

```
Get the research report about "Post-Apocalyptic Fiction Trends 2026"
```

### 8.4 Update a Report

```
Update the research report "Post-Apocalyptic Fiction Trends 2026" — change its
status to published.
```

---

## 9. Brainstorming & Outlining

Brainstorm generates a structured outline with character profiles, chapter breakdowns, themes, and research — then saves it for later chapter writing.

### 9.1 Brainstorm a Story

**Chat:**
```
Brainstorm a post-apocalyptic story called "The Seed Vault" about the last botanist
on Earth protecting the Svalbard seed vault from raiders who don't understand its
value. Themes: preservation, sacrifice, legacy, nature vs. human destruction.
6 chapters. Genre slug: post-apocalyptic.
```

**Voice:**
> "Brainstorm a new story called 'The Clockwork Rebellion.' It's about sentient clockwork automatons in Victorian London who organize a labor revolution. Genre post-apocalyptic. Eight chapters. Themes are freedom versus control and what makes someone human."

**What you get:**
- An email with an HTML-formatted outline containing:
  - Title, premise, and themes
  - Character profiles (name, role, character arc, description)
  - Chapter-by-chapter breakdowns (title, brief, arc notes, research topics)
- The outline is saved to your writing projects for use with Write Chapter

### 9.2 Revise or Expand an Outline

After brainstorming, you can expand the chapter count or deepen character development. The system re-runs research and generates a new outline, saving it over the original.

**Add more chapters:**
```
expand the outline for "The Seed Vault" to 16 chapters
```

**Develop characters:**
```
expand the outline for "The Seed Vault" to 16 chapters and develop 5 main characters with backstories
```

**Revise the story arc:**
```
revise the outline for "The Seed Vault" — shift the arc to focus more on the antagonist's motivation
```

**Voice:**
> "Expand the outline for 'The Seed Vault' to sixteen chapters and add detailed backstories for the five main characters."

**What you get:** A new email with the updated outline. The revised version is saved to your writing projects, replacing the previous outline for use by Write Chapter.

> ⚠️ **Always include the project title** so the system knows which outline to update. The title must match what you used when you first brainstormed it.

---

## 10. Writing Chapters (Book Projects)

After brainstorming, you can write individual chapters. The system automatically loads your saved outline so each chapter stays consistent with the plan.

### 10.1 Write a Chapter from a Stored Outline

**Chat:**
```
Write chapter 1 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 1.
```

**Voice:**
> "Write chapter one of 'The Clockwork Rebellion.' Genre post-apocalyptic. Chapter number one."

You don't need to re-describe the story — the agent loads the outline you brainstormed.

### 10.2 Write a Chapter for a New Project (No Prior Outline)

```
Write chapter 1 of a new book. Genre slug: ancient-history.
Project title: "The Last Pharaoh's Scribe".
Chapter number: 1.
Brief: A young scribe in Cleopatra's court discovers that the Library of Alexandria
holds a map to a weapon that could repel the Roman invasion.
Outline: Chapter 1 introduces Nefertari in the library, the discovery of the hidden
map fragment, and a tense encounter with a Roman centurion posing as a scholar.
Research topics: ["Library of Alexandria daily operations", "Cleopatra's court structure
and politics", "Roman military presence in Egypt 30 BC", "ancient Egyptian scribal practices"]
```

### 10.3 Retrieve a Written Chapter

After writing a chapter, retrieve it to review it or pass it to Eve for a voice callback session.

**Step 1 — Check what's saved (if unsure of the exact title):**
```
show me my drafts
```

**Step 2 — Retrieve using the title from the list:**
```
retrieve my draft for The Seed Vault chapter 1
```

> ⚠️ **Retrieve only works after Write Chapter has run.** If you get "content not found," the chapter hasn't been written yet — run Write Chapter first (section 10.1), then retrieve.

**Voice:**
> "Pull up my draft for The Seed Vault chapter one."

### 10.4 Book Project Workflow Order

The correct sequence for writing a book:

| Step | Command | What Happens |
|------|---------|--------------|
| 1 | Brainstorm the story | Outline saved to writing projects, emailed |
| 2 | *(Optional)* Expand the outline | Updated outline saved, emailed |
| 3 | Write chapter 1 | Chapter written using outline, saved as draft, emailed |
| 4 | Write chapter 2, 3… | Each chapter uses stored outline for consistency |
| 5 | Retrieve a chapter | Pull it up to review or load into Eve |
| 6 | Approve / publish | Move through content library workflow |

> **Common mistake:** Trying to retrieve chapter 1 before writing it. The brainstorm saves an *outline*, not a written chapter. You must run Write Chapter to produce the actual prose.

---

## 11. Story Bible

The story bible tracks characters, locations, and plot threads across chapters. It's updated automatically when you write chapters.

### 11.1 Read the Story Bible

**Chat:**
```
Get the story bible for project "The Seed Vault"
```

**Voice:**
> "Get the story bible for 'The Clockwork Rebellion.'"

Returns all character entries, location entries, and plot threads, organized by the chapter they were introduced in.

### 11.2 Update the Story Bible

```
Update the story bible for project "The Seed Vault". Add a new character:
Name: Marcus, Role: antagonist, Description: A former military commander
who leads the raiders threatening the vault.
```

---

## 12. Eve Review Mode (Voice Callbacks)

This is one of Eve's most powerful features. You can ask Eve to **pull up any saved content, load it into her memory, and call you back** to discuss, review, or brainstorm from it.

### How It Works

1. You ask Eve to retrieve content and call you back
2. Eve finds the content in your library
3. The content is loaded into Eve's knowledge base
4. Eve calls your phone
5. You discuss the content — Eve can reference specific passages, give editorial feedback, or brainstorm new ideas

### 12.1 Retrieve Content (No Callback)

Just look something up without a callback:

> "Can you pull up my research report about post-apocalyptic fiction trends?"

> "Find my draft short story about the Titanic."

Eve summarizes what she found — no phone call.

### 12.2 Review Mode — Revise Your Writing

Ask Eve to call you back to revise a piece:

> "Pull up my draft blog post about aqueducts and call me back so we can revise it."

Eve will:
- Find your blog post
- Load it into her knowledge base
- Call you back within about 30 seconds
- Open with something like: "I've got your blog post about Roman aqueducts loaded up. Would you like to go through it section by section, or is there a specific part you want to focus on?"
- Give specific editorial feedback: pacing, word choice, structure, opening strength
- Reference and quote specific passages from your draft

### 12.3 Brainstorm Mode — Build on Research

Ask Eve to call you back to brainstorm from existing research:

> "Load the research report on post-apocalyptic trends and call me back. Let's brainstorm a new story outline from it."

Eve will:
- Load your research into her knowledge base
- Call you back
- Reference specific data points and findings from the research
- Help you develop characters, themes, and plot points interactively

### 12.4 Review a Story for Improvement

> "Get my short story about the Roman soldier under the Colosseum and help me improve it."

Eve will call back with specific, actionable editorial feedback — not generic praise. She'll identify weak openings, suggest stronger word choices, flag structural issues, and quote passages that need work.

### 12.5 Back-to-Back Reviews

You can review multiple pieces in sequence. When Eve loads new content, the previous content is automatically cleared:

> "Pull up my research report about post-apocalyptic trends and call me back to review it."

*(Discuss, then hang up.)*

> "Now pull up my draft blog post about aqueducts and call me back to revise that instead."

Eve loads the blog post and clears the research report — she'll only have the current document.

### 12.6 Content Not Found

If you ask for something that doesn't exist:

> "Pull up my draft story about alien wizards on Neptune and call me back."

Eve will let you know the content wasn't found and suggest trying a different search term or listing your drafts. No phone call is triggered.

### 12.7 Parallel Tasks + Callback

You can ask Eve to do two things at once:

> "Write a newsletter about ancient Roman festivals for the ancient history genre, and also pull up my research report about post-apocalyptic trends and call me back to brainstorm."

Eve handles both:
- The newsletter is written and emailed (runs in the background)
- The research report is loaded and Eve calls you back for brainstorming

---

## 13. Tips & Troubleshooting

### General Tips

- **Always specify the genre slug** for best results, even if the topic seems obvious.
- **Check your email** — most outputs are delivered there, not in the chat.
- **Be patient with long tasks.** Short stories and chapters with research can take 1–2 minutes.
- **Multi-step conversations work.** You can research first, then write based on that research in the next message.

### Voice Tips

- Speak naturally. Eve handles "um," "like," "you know," and other filler words.
- You don't need to pause between parameters. "Genre slug post-apocalyptic about fifteen hundred words" runs together just fine.
- If Eve misunderstands a genre, say: "No, I meant the ancient history genre."

### Common Issues

| Problem | Solution |
|---------|----------|
| Email didn't arrive | Check spam folder. The email comes from your connected Gmail account. |
| Cover art looks wrong for the genre | Make sure you included the correct genre slug. Each genre has different art guidelines. |
| "Content not found" when retrieving | Try listing your drafts first to see exact titles. Search terms need to roughly match. |
| Eve didn't call back | Make sure you used callback language like "call me back" or "help me improve it." |
| Story doesn't match brainstormed outline | Make sure the project title matches exactly what you used during brainstorming. |
| "Content not found" when retrieving a chapter | The chapter hasn't been written yet — only the outline exists. Run Write Chapter first (section 10.1), then retrieve. |
| Outline revision went to chat instead of email | Use exact phrasing: "expand the outline for [title]" or "revise the outline for [title]". Include the project title. |

---

## 14. Acceptance Test Walkthroughs

Use these step-by-step scenarios to verify every feature works. Each walkthrough is self-contained and tells you exactly what to say or type, and what to expect.

---

### Test 1: Research → Save → Email (Chat)

**Step 1 — Run a research query:**
```
Research the current state of post-apocalyptic fiction in 2026. What are the
trending themes, notable new releases, and how has the genre evolved since COVID?
Include citations.
```
*Expected: Research results appear in chat with citations.*

**Step 2 — Save the research:**
```
Save that research as a report with topic "Post-Apocalyptic Fiction Trends 2026"
and genre slug post-apocalyptic.
```
*Expected: Confirmation that the report was saved.*

**Step 3 — Email the research:**
```
Send me an email report with this content:

# Post-Apocalyptic Fiction Trends 2026

## Key Findings
- Climate fiction is merging with post-apocalyptic themes
- AI apocalypse stories have surged since 2024

Send it to eric@agileadtesting.com with subject line "Test: Research Report"
```
*Expected: Email arrives with formatted HTML.*

---

### Test 2: Blog Post in Every Genre (Chat)

Run each of these one at a time. Verify the email arrives with genre-appropriate tone and cover art.

**Post-Apocalyptic:**
```
Write a blog post for the post-apocalyptic genre. Topic: "Survival Communities After
the Collapse". Genre slug: post-apocalyptic. Keywords: survival, community, rebuilding.
Target length: 1500 words.
```

**Political Sci-Fi:**
```
Write a blog post for the political-scifi genre. Topic: "AI Governance in Science Fiction".
Genre slug: political-scifi. Keywords: AI governance, surveillance, dystopia.
Target length: 1500 words.
```

**Historical Time Travel:**
```
Write a blog post for the historical-time-travel genre. Topic: "What If You Could
Visit the Library of Alexandria?" Genre slug: historical-time-travel. Keywords: time
travel, ancient libraries, history. Target length: 1500 words.
```

**AI & Marketing:**
```
Write a blog post for the ai-marketing genre. Topic: "How AI is Transforming Content
Marketing in 2026". Genre slug: ai-marketing. Keywords: AI tools, marketing automation.
Target length: 1500 words.
```

**Political History:**
```
Write a blog post for the political-history genre. Topic: "Revolutions That Reshaped
the Modern World". Genre slug: political-history. Keywords: revolution, political change.
Target length: 1500 words.
```

**Ancient History:**
```
Write a blog post for the ancient-history genre. Topic: "The Forgotten Engineers of
Rome". Genre slug: ancient-history. Keywords: Roman engineering, aqueducts.
Target length: 1500 words.
```

*For each: Verify the tone matches the genre, the cover art style is appropriate, and the email arrives.*

---

### Test 3: Short Story + Cover Art (Chat)

**Step 1 — Write the story:**
```
Write a short story. Genre slug: historical-time-travel. Premise: A historian
discovers that antique photographs can transport her to the moment they were taken.
She finds a photo of the Titanic's maiden voyage and must decide whether to warn
the passengers. Tone: literary, bittersweet. Length: 2500 words.
Research topics: ["Titanic maiden voyage Southampton 1912", "history of early
photography techniques", "time travel paradoxes in fiction"]
```
*Expected: Email with the full story + cover art. Draft saved to library.*

**Step 2 — Generate standalone cover art:**
```
Generate cover art for a political-scifi story called "The Senate of Stars".
Genre slug: political-scifi. A vast circular chamber with alien delegates, lit
by a dying star through a massive viewport.
```
*Expected: Email with image. Art style is dark and cerebral (political-scifi), not post-apocalyptic.*

---

### Test 4: Social Media Repurposing (Chat)

**Twitter:**
```
Repurpose this into Twitter posts: "The Senate of Stars is a new political sci-fi
short story about a diplomat navigating a galactic parliament where every species
has a different concept of justice." Platform: twitter.
```
*Expected: Thread of tweets, each under 280 characters, with hashtags.*

**LinkedIn:**
```
Repurpose this into LinkedIn posts: "We published a blog post about post-apocalyptic
fiction and why it matters in 2026." Platform: linkedin.
```
*Expected: Professional, longer-format posts with LinkedIn hashtags.*

**Facebook:**
```
Repurpose this into Facebook posts: "The Last Signal is a post-apocalyptic short story
about a radio operator in flooded Manhattan." Platform: facebook.
Genre slug: post-apocalyptic.
```
*Expected: Conversational posts + a cover image.*

---

### Test 5: Content Library Lifecycle (Chat)

**Step 1 — List drafts:**
```
List my drafts
```
*Expected: A list of all your draft content.*

**Step 2 — Filter by type:**
```
List my draft blog posts
```
*Expected: Only blog posts shown.*

**Step 3 — Approve one (use an actual title from your list):**
```
Approve the draft titled "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```
*Expected: Status changes to approved.*

**Step 4 — Publish it:**
```
Publish the content titled "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
```
*Expected: Status changes to published with a timestamp.*

**Step 5 — Verify:**
```
List my published content
```
*Expected: Your published item appears.*

**Step 6 — Reject a different draft:**
```
Reject the draft titled "The Forgotten Engineers of Rome"
```
*Expected: Status changes to rejected.*

---

### Test 6: Brainstorm → Chapter → Story Bible (Chat)

**Step 1 — Brainstorm:**
```
Brainstorm a post-apocalyptic story called "The Seed Vault" about the last botanist
on Earth protecting the Svalbard seed vault from raiders who don't understand its
value. Themes: preservation, sacrifice, legacy, nature vs. human destruction.
6 chapters. Genre slug: post-apocalyptic.
```
*Expected: Email with full outline (characters, chapter breakdowns). Saved to writing projects.*

**Step 2 — Write chapter 1 from the outline:**
```
Write chapter 1 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 1.
```
*Expected: Chapter loads the brainstormed outline automatically. Email with the chapter. Story bible entries created.*

**Step 3 — Check the story bible:**
```
Get the story bible for project "The Seed Vault"
```
*Expected: Characters and locations from chapter 1, with chapter_introduced=1.*

---

### Test 7: Voice Agent — Full Walkthrough

Do these in order, speaking to Eve.

**7a — Research:**
> "Hey, can you research what's going on with post-apocalyptic fiction right now? What are the big trends and new books?"

*Expected: Research results returned.*

**7b — Save it:**
> "Save that research as a report. Call it 'Post-Apocalyptic Trends 2026.'"

*Expected: Report saved.*

**7c — Write a blog post:**
> "Write a blog post about how AI is changing marketing in 2026. Genre slug ai-marketing. Keywords: AI tools, marketing automation. About fifteen hundred words."

*Expected: Blog written and emailed.*

**7d — Write a newsletter:**
> "Write me a newsletter for the political history genre about revolutions that changed the world. Date today."

*Expected: Newsletter emailed.*

**7e — Write a short story:**
> "Write a short story in the ancient history genre about a Roman soldier who discovers a hidden library beneath the Colosseum. About three thousand words. Research Roman military life and the Colosseum underground tunnels."

*Expected: Story researched, written, and emailed.*

**7f — Generate cover art:**
> "Generate cover art for a post-apocalyptic story called 'The Last Signal.' Show a figure on a rooftop with a radio antenna surrounded by a flooded city at sunset."

*Expected: Cover image emailed.*

**7g — Social media:**
> "Take this and make Twitter posts from it: 'The Last Signal is a new story about a radio operator in flooded Manhattan picking up a mysterious broadcast.' Platform Twitter."

*Expected: Tweet thread emailed.*

**7h — Brainstorm:**
> "Brainstorm a new story called 'The Clockwork Rebellion.' It's about sentient clockwork automatons in Victorian London who organize a labor revolution. Genre post-apocalyptic. Eight chapters. Themes are freedom versus control and what makes someone human."

*Expected: Outline emailed. Saved to writing projects.*

**7i — Write a chapter:**
> "Write chapter one of 'The Clockwork Rebellion.' Genre post-apocalyptic. Chapter number one."

*Expected: Chapter loads the stored outline. Chapter emailed.*

**7j — List drafts:**
> "Show me my drafts."

*Expected: List of all drafts returned.*

**7k — Approve and publish:**
> "Approve the draft called [title from 7j]."

Then:

> "Now publish it."

*Expected: Draft approved, then published.*

**7l — Story bible:**
> "Get the story bible for 'The Clockwork Rebellion.'"

*Expected: Character and location entries from chapter 1.*

---

### Test 8: Eve Review Mode — Callback Walkthrough

**8a — Retrieve without callback:**
> "Can you pull up my research report about post-apocalyptic fiction trends?"

*Expected: Eve summarizes what she found. No phone call.*

**8b — Review mode callback:**
> "Pull up my draft blog post about aqueducts and call me back so we can revise it."

*Expected: Eve says she'll pull it up and call back. Phone rings within 30 seconds. Eve discusses the blog post with specific references to the text.*

**8c — Brainstorm mode callback:**
> "Load the research report on post-apocalyptic trends and call me back. Let's brainstorm a new story outline from it."

*Expected: Eve calls back in brainstorm mode. She references specific findings from the research and helps you develop story ideas.*

**8d — Content not found:**
> "Pull up my draft story about alien wizards on Neptune and call me back."

*Expected: Eve tells you the content wasn't found. No phone call. Suggests listing drafts or trying a different search.*

**8e — Back-to-back reviews (verifies cleanup):**
> "Pull up my research report about post-apocalyptic trends and call me back to review it."

*(Discuss briefly, then hang up.)*

> "Now pull up my draft blog post about aqueducts and call me back to revise that instead."

*Expected: Second callback has only the blog post loaded. Eve cannot reference the previous research report.*

---

### Test 9: Edge Cases

**9a — Unknown genre:**
```
Write a blog post in the cyberpunk genre. Genre slug: cyberpunk.
Topic: "Neon and Chrome". Target length: 1000 words.
```
*Expected: Agent asks for clarification or picks the closest genre. Does not crash.*

**9b — Minimal input (agent fills gaps):**
```
Write me a short story about a robot learning to paint
```
*Expected: Agent infers a genre, creates a premise, picks a tone and length. Story written and emailed.*

**9c — Multi-step conversation:**
```
Research ancient Roman gladiator training methods
```
*(Wait for response.)*
```
Now write a blog post about that research. Genre slug: ancient-history.
Keywords: gladiators, Roman arena, combat training. Target length: 1200 words.
```
*Expected: Blog incorporates the research findings from the first message.*

**9d — Cross-genre cover art (verify styles change):**
```
Generate cover art for a post-apocalyptic story called "Ash". Genre slug: post-apocalyptic.
A lone figure walking through a gray, ash-covered landscape.
```
*(Wait for email.)*
```
Generate cover art for an ancient-history novel called "The Golden Temple".
Genre slug: ancient-history. A grand temple at sunset with priests on the steps.
```
*Expected: Two clearly different art styles — muted/desolate vs. warm golden/classical.*

**9e — Messy voice (speak to Eve):**
> "Um, yeah, so I want to, uh, write a blog post about like how political science fiction predicted the rise of, like, AI governance and surveillance states, you know, like 1984 and all that. Genre is political sci-fi, about two thousand words."

*Expected: Eve parses through filler words. Blog written in political-scifi genre.*

**9f — Research reports management:**
```
List my research reports
```
```
Get the research report about "Post-Apocalyptic Fiction Trends 2026"
```
```
Update the research report "Post-Apocalyptic Fiction Trends 2026" — change its
status to published.
```
*Expected: List, retrieve, and update all work correctly.*

---

**Congratulations!** If all tests pass, your Author Agent is fully operational across all 6 genres, all writing tools, the content library, brainstorming, the story bible, and Eve's voice and review mode features.
