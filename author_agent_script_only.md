# The Author Agent — Script

**Estimated runtime: 12-14 minutes**

---

## INTRO (30 seconds)

Hi, I'm going to walk you through The Author Agent — an AI-powered writing automation system that takes a book from concept to finished chapters, complete with quality assurance, cover art, and content management.

The system is built on n8n workflow automation, powered by Google Gemini as the conversational agent, Claude Sonnet for long-form writing, Perplexity for research, NanoBanana PRO via KIE.AI for cover art, and Supabase as the backend database with a vector store for RAG retrieval.

Let me show you how each piece works.

---

## THE HUB — The Author Agent (1 minute)

This is the hub — the central brain. It connects to Eve, our ElevenLabs voice agent, via webhook, or you can use the built-in chat panel for testing.

When a request comes in, the preprocess_message node analyzes what the user wants — is it a writing task, a brainstorm, a content lookup, or a library operation? It classifies the request, adds the appropriate tool override, and routes it.

For long-running operations like writing chapters, the system responds immediately with an acknowledgment and processes the work in the background. The user gets an email when it's done.

The hub has 18 connected tools organized into three groups: Shared resources like the Gemini LLM and Redis memory, Content Creation tools for writing and brainstorming, and Content Research tools for retrieval and research.

---

## STORY ARCS — The Structural Foundation (1.5 minutes)

Before we get into the tools, let me explain story arcs — they're the backbone of the entire system.

A story arc is a structural framework that shapes how a narrative unfolds. We support 8 different frameworks, and the choice of arc fundamentally changes how the story is organized.

The first three are Western classics:

Three-Act Structure is the most universal — Setup, Confrontation, Resolution. It's the backbone of most Hollywood films and commercial fiction.

Freytag's Pyramid is the five-act tragic arc — Exposition, Rising Action, Climax, Falling Action, Denouement. Great for literary drama.

The Hero's Journey is Joseph Campbell's monomyth — the hero leaves the ordinary world, faces trials, and returns transformed. Think Star Wars or Lord of the Rings.

Then we have more specialized frameworks:

Fichtean Curve drops the reader directly into conflict with no setup. It builds through three escalating crises to a climax, then a short resolution. Perfect for thrillers and action.

Dan Harmon's Story Circle is an 8-step character transformation loop — the character moves from comfort to need to unfamiliar territory and back, changed by the journey. It's what we use for The Clockwork Rebellion's book arc.

Seven-Point Structure works backward from the resolution — you define the ending first, then build the seven pivotal moments that get you there.

In Medias Res opens at a moment of peak tension, then reveals how we got there. It's a technique more than a full structure.

And Kishōtenketsu is the traditional East Asian four-act framework — Introduction, Development, Twist, Conclusion. Uniquely, it builds emotional resonance without relying on conflict.

The key insight is that the book and each chapter can use different arcs. The Clockwork Rebellion uses Dan Harmon's Story Circle for its overall book arc — tracking Cogwheel's transformation from obedient machine to conscious being — while individual chapters can use Fichtean Curve or other arcs for their internal scene structure.

---

## FROM CONCEPT TO CHAPTER — The Three-Step Process (3 minutes)

Now let me show you how a book goes from idea to finished chapter in three steps. I'll use our demo project, The Clockwork Rebellion, as an example.

### Step 1: The Book Outline

Everything starts with a book outline. The user tells the system 'brainstorm a story about a sentient clockwork automaton in 1888 London that awakens to consciousness and organizes factory workers' — and the Brainstorm Story tool takes over.

It runs Perplexity research on the concept, then Claude generates a complete outline. What you're seeing in this email is the result.

At the top: the premise, themes, and the book's story arc — Dan Harmon's Story Circle.

Then a character table with locked details — Cogwheel, the protagonist, a brass and steel clockwork automaton. Sir Reginald Blackwood, the antagonist industrialist. Mary Kellerton, the factory worker ally. These details are locked into the database so every chapter uses them consistently.

Below that, the full chapter structure — 21 sections from Prologue through Epilogue, each with a brief and its position in the Story Circle. The Prologue is Step 1 — Comfort Zone. The early chapters are Step 2 — Need/Want. Later chapters hit Step 5 — Finding What They Wanted, and the final chapters reach Step 8 — Changed.

This outline is versioned. If you revise it, the previous version is saved and you can always revert. Characters are locked on revision — the system won't change them unless you explicitly ask.

### Step 2: The Chapter Outline

Before writing a chapter, we create a detailed chapter outline using the Brainstorm Chapter tool. This is what that looks like.

At the top: the book title, the book's story arc, the chapter's own story arc — here it's also Dan Harmon's Story Circle — and the book arc beat this chapter represents.

Then a chapter summary, followed by the sub-chapters. This chapter has 5 sub-chapters, each one a complete mini-scene.

Look at the detail in each sub-chapter — it has an arc beat from the Story Circle, the specific characters in the scene, the setting, the emotional tone, and a detailed brief.

That brief is critical. It's not a suggestion — when the system writes this chapter, the brief becomes a mandatory script. Every event, action, and detail in the brief must appear in the prose. This is how we maintain structural integrity from outline to finished chapter.

The chapter can use a different story arc than the book. The book uses Dan Harmon's Story Circle, but a chapter could use Fichtean Curve if we wanted the scene to unfold with escalating tension instead.

User instructions for revisions go at the very top of the prompt with mandatory override language, so requests like 'make sub-chapter 3 focus on Cogwheel's internal conflict' are followed exactly.

### Step 3: The Written Chapter with Q/A

And here's the finished chapter. The Write Chapter tool is the most complex workflow in the system.

Scroll through and you'll see the chapter is organized by sub-chapter title headings — Shadows and Steam, The Collapse, Through the Tenements — separated by scene breaks. Each section follows its assigned arc beat and brief.

The system writes each sub-chapter individually using a RAG agent. Before writing, the agent searches the vector store for character details, story bible entries, and chapter context. This keeps every scene consistent with the established world — same character ages, same name formats, same established facts.

At the bottom of every chapter email, you'll see the Story Consistency Report. This is a 9-check quality audit that runs automatically after the chapter is written.

Green checks mean the chapter passes — character names match, the book arc advances correctly, themes align, no plot contradictions.

Red X marks flag issues — maybe the sub-chapter sequence drifted from the outline, or the chapter's arc structure doesn't match the assigned framework.

The Q/A report is stored in the database. When you rewrite the chapter, those concerns are automatically loaded into the writing prompts — so Claude specifically addresses the issues from the previous write. You don't need a special command — just say 'write chapter 1' again and the system feeds in the previous Q/A feedback automatically.

Each chapter also generates photorealistic editorial cover art and updates the story bible with any new characters, locations, or plot elements introduced.

---

## Q/A CHAPTER CLEANUP (45 seconds)

We also have a Q/A Chapter Cleanup tool. When the system writes each sub-chapter individually, sometimes content gets repeated across sub-chapters — the same paragraph appears twice, or a character name drifts from the outline.

Say 'edit chapter 3' and the system scans for duplicate paragraphs using n-gram analysis across all sub-chapters, checks all character names against the book outline, and sends targeted corrections to Claude.

Claude returns a list of find-and-replace operations — not a full rewrite. A fuzzy matching engine applies them even when the duplicate text isn't character-for-character identical.

The email includes three things: the corrected chapter text, a diff report showing exactly what changed and why, and the full 9-check consistency report run on the corrected version.

---

## CONTENT LIBRARY & PUBLISHING (45 seconds)

The manage_library tool handles the content lifecycle. Every piece of content — chapters, blog posts, newsletters, short stories — goes through a status pipeline: draft, approved, scheduled, published, or rejected.

You can approve, schedule for a specific date, publish immediately, or reject content. The scheduled publisher runs hourly via a cron workflow and automatically publishes anything that's reached its scheduled date.

Version history is maintained — every status change creates a snapshot you can revert to.

---

## RESEARCH & KNOWLEDGE (45 seconds)

The retrieve_content tool is the search engine — it can list outlines, find drafts, pull up story arcs, show outline version history, and revert to previous versions.

The deep_research_topic tool runs extended Perplexity research sessions for factual grounding. The manage_research_reports tool stores and organizes research for later use.

All of this feeds into the vector store — the RAG knowledge base that the writing agent searches before writing each scene. It contains character profiles, chapter briefs, story bible entries, genre guidelines, and the book premise.

---

## ADDITIONAL TOOLS (45 seconds)

A few more tools round out the system:

Write Blog Post, Write Newsletter, and Write Short Story each follow similar patterns — Perplexity research, Claude writing, Gmail delivery, and content library storage.

Repurpose to Social Posts takes any written content and generates platform-specific social media posts.

Generate Cover Art creates photorealistic editorial-style images for each chapter using a detailed prompt template — documentary portraiture style, cinematic composition, shallow depth of field.

Edit Outline handles small targeted changes to outlines — fixing ages, names, or descriptions without triggering a full re-brainstorm.

Format Kindle Book packages the completed manuscript for Kindle publishing.

And the Eve Knowledge Callback injects content into the ElevenLabs voice agent's knowledge base for voice-based review sessions.

---

## ARCHITECTURE HIGHLIGHTS (30 seconds)

A few key architectural decisions:

Prompt caching — the system prompt is identical across all sub-chapters, so Anthropic's auto-caching reduces cost by about 85%.

Token optimization — we reduced system prompts from 2,500 tokens to 370 by moving research and chapter structure into the vector store for RAG retrieval.

Error resilience — automatic retries with 60-second backoff on rate limits and server overloads. The hub retries the entire workflow on failure, maintaining story integrity.

Multi-user support — every database table is partitioned by user_id, supporting multiple concurrent authors.

And the entire system is voice-accessible through Eve, the ElevenLabs conversational agent.

---

## CLOSING (15 seconds)

That's The Author Agent — from concept to published chapter in about 15 minutes, with full quality assurance, consistent characters, enforced story arcs, and automatic cover art. Thanks for watching.
