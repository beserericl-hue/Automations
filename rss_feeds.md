# RSS Feeds & Content Sources — The Author Agent

## VERIFIED & ACTIVE FEEDS

### Tier 1: Short Fiction Magazines (Best for Newsletter Content)

These publish **full short stories** — ideal for newsletter features and content curation.

| Feed | URL | Content | Update Freq | Full Text? |
|------|-----|---------|-------------|------------|
| Clarkesworld Magazine | `https://clarkesworldmagazine.com/feed/` | Hugo-winning SF short fiction + audio versions | Monthly (multiple stories) | Excerpts w/ links to full text |
| Strange Horizons | `https://www.strangehorizons.com/feed/` | Novelettes, short stories, essays, reviews | Weekly | **Full text in feed** |
| Escape Pod | `https://escapepod.org/feed/` | Weekly SF short fiction podcast (text + audio) | Weekly | Summaries w/ links |
| Lightspeed Magazine | `https://www.lightspeedmagazine.com/feed/` | SF & Fantasy short fiction | Monthly | Feed metadata only (items empty at test) |
| Asimov's (Podcast) | `https://asimovs.podomatic.com/rss2.xml` | Audio readings from Asimov's SF Magazine | Monthly | Audio only |

### Tier 2: Industry News & Reviews (Best for Blog Posts)

| Feed | URL | Content | Update Freq |
|------|-----|---------|-------------|
| Locus Magazine | `https://locusmag.com/feed/` | SF/F industry news, awards, new releases, reviews | Daily |
| Reactor (fka Tor.com) | `https://reactormag.com/feed/` | Entertainment news, TV/film reviews, book coverage | Daily |
| Dystopic | `https://dystopic.co.uk/feed/` | Dystopian/political SF reviews + original short stories | Monthly |

### Tier 3: Book Release Tracking

| Feed | URL | Content | Update Freq |
|------|-----|---------|-------------|
| Rising Shadow (Post-Apoc) | `https://www.risingshadow.net/rss/?genre=post-apocalyptic` | New post-apocalyptic book releases with covers, dates, authors | Weekly |

---

## MEDIUM TAG FEEDS (All Excerpts Only)

All Medium feeds return excerpts with "Continue reading" links. Content is mixed quality — community authors, serialized fiction, reviews, and essays. Use Jina Reader API to fetch full text from links.

### Niche 1: Post-Apocalyptic
| Tag | URL | Content Mix | Activity |
|-----|-----|-------------|----------|
| post-apocalyptic | `https://medium.com/feed/tag/post-apocalyptic` | Serialized fiction, TV reviews, writing updates | Active (Mar 2026) |
| apocalypse | `https://medium.com/feed/tag/apocalypse` | Climate commentary, fiction, prepper content | Active |
| dystopian | `https://medium.com/feed/tag/dystopian` | Flash fiction, film analysis, short stories | Active |
| dystopia | `https://medium.com/feed/tag/dystopia` | Fiction, horror, philosophical narratives | Active |
| survival | `https://medium.com/feed/tag/survival` | Prepper content, outdoor skills, resilience | Active (rarely fiction) |

### Niche 2: Political Science Fiction
| Tag | URL | Content Mix | Activity |
|-----|-----|-------------|----------|
| political-fiction | `https://medium.com/feed/tag/political-fiction` | Book reviews, serialized fiction, game analysis | Active (Mar 2026) |
| political-science-fiction | `https://medium.com/feed/tag/political-science-fiction` | Nearly dead — 1 post from 2018 | **DEAD** |

### Niche 3: Historical Time Travel
| Tag | URL | Content Mix | Activity |
|-----|-----|-------------|----------|
| time-travel | `https://medium.com/feed/tag/time-travel` | Flash fiction, short stories, physics articles | Active (Mar 2026) |
| alternate-history | `https://medium.com/feed/tag/alternate-history` | Serialized chapters, speculative narratives | Active |
| historical-fiction | `https://medium.com/feed/tag/historical-fiction` | Historical fiction, biographical series, romance | Active |

### Cross-Genre
| Tag | URL | Content Mix | Activity |
|-----|-----|-------------|----------|
| science-fiction | `https://medium.com/feed/tag/science-fiction` | Broad: reviews, original fiction, literary analysis | Active |

---

## REDDIT (JSON API Only — RSS Blocked)

Reddit blocks RSS feeds without authentication. Use the **JSON API** instead:
`https://www.reddit.com/r/{subreddit}/hot.json?limit=10`

Requires `User-Agent` header. Already used in the existing marketing agent workflows.

### Verified Subreddits
| Subreddit | URL Pattern | Content |
|-----------|-------------|---------|
| r/postapocalyptic | `/r/postapocalyptic/hot.json` | Recommendations, media, discussion |
| r/PostApocalypticFiction | `/r/PostApocalypticFiction/hot.json` | Book-focused discussion |
| r/timetravel | `/r/timetravel/hot.json` | Theory, fiction, media discussion |
| r/timetravelbooks | `/r/timetravelbooks/hot.json` | Book recommendations |
| r/scifi | `/r/scifi/search.json?q=political+science+fiction&sort=hot` | Filtered search results |
| r/printSF | `/r/printSF/hot.json` | Serious book discussion, all SF subgenres |

---

## FEEDS THAT FAILED

| Feed | Error |
|------|-------|
| `https://www.apex-magazine.com/feed/` | 403 Forbidden |
| `https://www.sfsite.com/rss/news.rdf` | Connection refused |
| `https://www.sfsignal.com/feed/` | TLS cert error (defunct) |
| `https://dailysciencefiction.com/rss` | 404 Not Found |
| `https://www.analogsf.com/feed/` | Subscriber-only download pages |
| `https://justbookreading.com/tag/time-travel/feed/` | Dead (last post 2013) |
| All Reddit `.rss` URLs | Blocked without auth |

---

## RECOMMENDED FEED CONFIGURATION BY WORKFLOW

### For Newsletter Content Curation
Primary sources (short stories):
1. `https://clarkesworldmagazine.com/feed/`
2. `https://www.strangehorizons.com/feed/`
3. `https://escapepod.org/feed/`
4. `https://medium.com/feed/tag/dystopian` (flash fiction)
5. `https://medium.com/feed/tag/time-travel` (short stories)

### For Blog Post Research & Inspiration
1. `https://locusmag.com/feed/`
2. `https://reactormag.com/feed/`
3. `https://dystopic.co.uk/feed/`
4. `https://www.risingshadow.net/rss/?genre=post-apocalyptic`
5. Reddit JSON API (r/postapocalyptic, r/timetravel, r/printSF)

### For Trend Monitoring
1. `https://medium.com/feed/tag/post-apocalyptic`
2. `https://medium.com/feed/tag/political-fiction`
3. `https://medium.com/feed/tag/alternate-history`
4. Reddit search API with genre-specific queries

---

## NOTES

- **Strange Horizons** is the only feed that delivers **full story text** in the RSS feed itself — all others require fetching the linked page
- **Medium feeds** are excerpts only — use Jina Reader API (`https://r.jina.ai/{url}`) to extract full article text
- **Clarkesworld** publishes ~8 stories/month with audio versions — highest quality source
- **Political Science Fiction** has the weakest dedicated feed ecosystem — best approach is monitoring general SF magazines + Medium `political-fiction` tag + Reddit search
- **Copyright consideration**: Magazine stories are copyrighted — use for research/curation/linking, not reproduction. Medium stories vary by author license.
