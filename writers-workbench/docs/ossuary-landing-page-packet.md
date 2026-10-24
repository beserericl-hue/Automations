# The Ossuary — sales landing page: architecture packet

**v2 is what the code implements** (`server/src/lib/landing-page.ts`, Project → Promotion →
Landing page). v1 is kept below it for the record.

## v2 changes (2026-10-24), and why

```text
PACKET ID:   FA-20261024-the-ossuary-v2
SUPERSEDES:  FA-20261024-the-ossuary-v1
OBJECTIVE:   pre-order sign-up through a form on the page (author: "this is a pre-order, and we
             will add a form"). No price, store or release date exists, so none is shown.
ORDER:       taken from the author's sample page, not fixed. The sample's sections are sorted
             into hero / story / proof / lineup / offer / author / closing and this page follows
             that order; the hero always leads and no section this book has is dropped.
             Button count follows the sample (2-6), never on the form itself.
SKIPPED:     whatever the sample relies on that this book has no data for (reviews, price,
             discount, bundle, guarantee, urgency, ...) is listed on screen, never imitated.
DROPPED:     section 7 "Go deeper": both blog posts are drafts with no public URL to link to.
             Billy Tayac photo: author decision, left out. Archival photos are opt-in per run.
VOL 1 COPY:  `_marketing` (author: either is fine). Volume II/III cards use hooks only; their
             back covers call Marcus "archaeologist" (volume I: tribal advocate) - still open.
ENFORCED IN CODE, not by prompt: facts must quote their report exactly and state no number the
             quote lacks; forbidden claims (reviews, debut, price, urgency, guarantee, federal
             recognition in 2012, ...) are refused in any copy; the published GHL page is checked
             passage by passage against the script.
```

---

Structure for the landing-page generator. The generator fills these sections from DEV Supabase
(project `a1bfb2cf-2949-4d29-80d2-e8b785c6bdae`); this packet decides what each section is for and
which stored field or source feeds it. Reference page for mechanics: offer.michaelreit.com (WWII
three-book bundle). Its structure is borrowed; none of its copy is.

## PART 1 — Architecture packet

```text
PACKET ID:        FA-20261024-the-ossuary-v1
DATE:             2026-10-24
VERSION:          v1
SUPERSEDES:       none
IDEATION STATE:   speculative_ideation
RELEASE:          open-flags (see TRUTH DEBT)

OBJECTIVE:        purchase (or pre-order / notify if not yet on sale — OPEN ASK)
OFFER:            The Ossuary, a trilogy (vol 1 ~610pp, vol 2 ~592pp, vol 3 ~609pp, 6x9).
                  Formats, price, store, release date: [OFFER_*] — none stored.
BUYER:            cold reader of literary/historical fiction, Native American history,
                  archaeology. Has never heard of the book or the author. Awareness: unaware
                  of the product; partly aware of the subject (NAGPRA, repatriation).
DESTINATION MAP:  [TRAFFIC_SOURCE] -> this page -> [OFFER_URL]
CONSTRAINTS:      no invented facts about the book or author; only rights-cleared images, with
                  CC-BY attribution on the page; no urgency unless a real deadline exists.

ROUTE:            story/advertorial, closing as a product page (one page carries both)
WHY THIS ROUTE:   the reference page is product-first and runs on reviews, a bundle price
                  ladder and a guarantee. The Ossuary has none of those yet. What it has is a
                  true story: a real site (18PR8, Accokeek Creek), real ossuaries, a real
                  legal knot, and an author with a personal tie to it. For a cold buyer with
                  no proof to lean on, that story is the strongest believable argument.
FALSIFIER:        traffic is warm (author's list, blog readers), or reviews/blurbs appear ->
                  switch to direct/product-first, the reference page's own shape.
SECOND CHOICE:    direct/product-first. Lost because its proof slot (reader reviews) is empty
                  and the buyer knows neither the book nor the author.

MECHANISM JOB:    embedded product explanation — "this novel is built on the real record"
MECHANISM DEPTH:  compact block
STOP CONDITION:   the reader believes the story is true to real history and real people.
                  Further history is the blog's job; link out rather than lecture.

ARGUMENT SPINE:
  1. Hero — stop the scroll with the gap: a thousand people, no names — open the question
  2. The book — what happens and to whom — "this is a story, not a lecture"
  3. The real record — the site, the excavation, the law are real — "it's true"
  4. Inside the trilogy — three volumes, each with its own hook — "there's a lot here"
  5. The offer — format, price, where to buy — "I can get it now"
  6. About the author — why he wrote it — "he has standing to tell it"
  7. Go deeper — the two blog posts — "there's more if I want it"
  8. Final CTA + credits — close; photo credits and licences
  CTA repeats after 1, 3, 5 and 8 (the reference page's cadence of four).

PROOF PLACEMENT MAP:
  real site 18PR8 / Accokeek Creek -> research_reports_v2 report id -> section 3
  four ossuaries, >1,000 individuals -> research report id -> sections 1, 3
  1930s Ferguson excavation, museum transfer -> research report id -> section 3
  Maryland state recognition 9 Jan 2012 -> research report + reference_photo metadata -> 3
  author's tie (MSW 1974, burial-mound dig, Piscataway friend) -> author_profiles_v2 -> 6
  reader reviews -> NONE EXIST -> slot omitted until real ones exist

OBJECTION ORDER:
  1. "Is this any good / who is this author?" -> sections 3 and 6 (story + standing)
  2. "Is it respectful / accurate about real people?" -> section 3, sourced facts
  3. "Three 600-page volumes is a lot" -> section 4, each volume stands on its own ending
  4. "What does it cost / where do I get it?" -> section 5

CLAIMS USED:
  blurb, back cover, hooks (vols 1-3) | verified: stored marketing copy, used verbatim
  author bio | verified: author_profiles_v2.bio (approved), verbatim
  history facts in section 3 | source-claim: each traced to a research report id in code
  "debut novel" | FORBIDDEN: in _marketing.author_bio only, not in the author profile
  federal recognition in 2012 | FORBIDDEN: false (2012 was Maryland state recognition)
  page counts per volume | assumption: estimated by the volume planner, not final

TRUTH DEBT:
  [OFFER_URL] / [OFFER_PRICE] / [OFFER_FORMATS] / [RELEASE_DATE] | from the author | ask
  which vol-1 copy is current (_marketing vs _marketing_v1) | author picks | ask
  Billy Tayac photo on a sales page (likeness / implied endorsement) | author decides | ask
  vol 2/3 Marcus described as "archaeologist" (vol 1: tribal advocate) | check manuscript | open
  vol 2/3 covers | none exist; render text cards, no fake covers | open
  author photo | none stored; omit until supplied | ask
  bundle price ladder | only if all three volumes are on sale with real prices | ask

VOICE / AWARENESS NOTES: literary, grave, unhurried. No "unputdownable", no exclamation marks.
  Never assume the reader knows NAGPRA, Piscataway or ossuary; define each in a clause.
```

## PART 2 — Sales page brief

```text
ASSET:            sales landing page (GHL)
PACKET:           FA-20261024-the-ossuary-v1
ONE JOB:          turn a stranger into a buyer (or sign-up) of volume 1
HANDOFF IN:       "Who speaks for the dead?" — curious, sceptical, unfamiliar
HANDOFF OUT:      "This is true, it matters, and I want to read it" -> [OFFER_URL]
FORMAT:           single page, mobile first, images from public Supabase URLs

SECTIONS (source field in brackets):
  1. Hero — _marketing.hook as H1; cover art (cover_art image); CTA
  2. The book — _marketing.blurb verbatim
  3. The real record — 3-5 sourced facts, each with its research report id kept in the
     generator's audit output; optional Billy Tayac photo + "Photo: Jay Baker, CC BY 2.0"
  4. Inside the trilogy — three cards: _marketing{,_v2,_v3}.hook + back_cover; page estimate
  5. The offer — [OFFER_*]; price ladder only with real prices, discount computed in code
  6. About the author — author_profiles_v2.bio verbatim; photo only if supplied
  7. Go deeper — the two live blog posts (deleted_at IS NULL): title + first paragraph
  8. Final CTA + image credits with licence links

DO NOT:           reviews, star ratings, "bestseller", "limited time", a guarantee badge or a
                  discount unless each is real and its source is named here first.
```

Lesson from the reference page: its "Save 45%" badge sits over a price ladder that works out to
57% off. The generator computes any discount from the prices it prints, and never takes a
percentage as a separate input.
