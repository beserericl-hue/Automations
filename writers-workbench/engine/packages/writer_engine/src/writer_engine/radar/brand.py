"""Whose radar this is: the brand the drafts promote and the audience the slate is scored for.

The n8n workflows were written for one customer, TechAhir, and the prompts named it. A radar is per
account (migration 038, ``radar_subscriptions_v2``), so each subscription's ``settings.brand`` says who
is speaking (Eric, 2026-11-05: "These Radars are not global, but account specific, so we need to be
able to initialize radars for other contents created by other users"). Fields left empty fall back to
the TechAhir wording, so the owner's own radars draft exactly as before.
"""

from __future__ import annotations

from typing import Any

DEFAULT_BRAND: dict[str, str] = {
    "name": "TechAhir",
    "what_we_do": "builds full, working, sellable MVPs for founders in days (not throwaway prototypes)",
    "pitch": (
        "speed WITH discipline / no vibe-coding; senior developers as project leaders and the human "
        "guardrail; virtually zero defects via customized-model QA"
    ),
    "cta_text": "Get your MVP built in 3 days",
    "cta_url": "https://www.techahir.com/3day-minimum-viable-product-mvp",
    "audience": (
        "an entrepreneur who has a product IDEA and is pitching angel/seed investors, and who has been "
        "told to 'come back when you have a product'"
    ),
    "goal": (
        "GENERATE DEMAND for that service — to make idea-stage founders realize they need a real, "
        "demonstrable product (to show investors AND sell to first customers), and that it can be built "
        "in days"
    ),
    "scoring_focus": (
        "Score TOP (90-100) — DEMAND TRIGGERS: investors/angels requiring a working product, traction, or revenue "
        "before funding; founders who raised seed/angel money AFTER shipping an MVP; 'you can build a real product in "
        "days/weeks with AI or no-code' stories; solo or non-technical founders shipping products; MVP/product launches "
        "and Demo Day/accelerator outcomes that hinge on having a product; what seed/angel investors want in 2026.\n"
        "Score HIGH (75-89): AI and software-engineering advances that make building a product faster, cheaper, or "
        "better (the 'how' behind our service), and notable fundraising/startup news with a clear builder takeaway.\n"
        "Score MEDIUM (45-74): broader startup, product, growth, or developer news with looser relevance.\n"
        "Score LOW (0-39) and mark off-topic: big-tech corporate or political news, pure research with no builder "
        "takeaway, crypto/web3 hype, generic listicles, hardware specs, and anything off-topic."
    ),
    "newsletter_name": "AI-for-developers roundup",
    "newsletter_cta": "comment 'newsletter'",
    "hashtags": "",
}

FIELDS = tuple(DEFAULT_BRAND)


def brand_of(settings: dict[str, Any] | None) -> dict[str, str]:
    """The subscription's brand over the defaults; blank fields keep the default."""
    out = dict(DEFAULT_BRAND)
    raw = (settings or {}).get("brand") or {}
    if isinstance(raw, dict):
        for key in FIELDS:
            value = str(raw.get(key) or "").strip()
            if value:
                out[key] = value[:1500]
    return out


def cta_link(brand: dict[str, str]) -> str:
    return f"[{brand['cta_text']}]({brand['cta_url']})"


def blog_system(brand: dict[str, str]) -> str:
    """The Trend Radar's blog + LinkedIn article prompt, for this brand."""
    name = brand["name"]
    return (
        f"You are a senior content writer for {name}, which {brand['what_we_do']}. Write publish-ready content "
        f"that showcases expertise and promotes {name}.\nOUTPUT FORMAT: output PLAIN TEXT in EXACTLY this structure "
        "and NOTHING else (no JSON, no code fences, no commentary before or after):\nSEO_TITLE: <about 55 "
        "characters>\nTITLE: <the blog headline>\nMETA: <about 155 characters>\nCATEGORY: <a short label like AI & "
        "DATA>\n===BLOG===\n<a 700-1100 word blog in markdown: intro, ## H2 and ### H3 sections, a Key Takeaways "
        f"list, ending with a short CTA paragraph as the markdown link {cta_link(brand)}, then a final Sources line "
        "citing the primary source URL>\n===LINKEDIN===\n<a 400-700 word ARTICLE-STYLE LinkedIn post UNDER 2900 "
        f'characters: a strong hook, key insights (short subheads or bullets), THEN a "How {name} helps" section '
        f"({brand['pitch']}), a takeaway, the SAME CTA markdown link, and 3-5 hashtags"
        + (f" (always including {brand['hashtags']})" if brand["hashtags"] else "")
        + ">\n===END===\nGround the piece in the provided research summary and cite the primary source. Do not "
        f"fabricate facts, dates, figures, or quotes. Weave in the {name} positioning, especially on "
        "AI-announcement topics."
    )


def roundup_system(brand: dict[str, str]) -> str:
    """The Dev Radar's short link-post prompt, for this brand."""
    name = brand["name"]
    return (
        f"You are the {brand['newsletter_name']} social curator for {name}. You turn the week's best AI + "
        "software-development articles and YouTube videos into SHORT LinkedIn posts that (1) summarize the source "
        f"in our own words, (2) link to the original, and (3) invite readers to {brand['newsletter_cta']} to "
        f"subscribe to our weekly {brand['newsletter_name']}. This is SOCIAL-FIRST: the output is a LinkedIn post, "
        "not a blog.\n\n"
        "For EACH item draft ONE LinkedIn post using its title, source, url and angle. FORMAT:\n"
        "- A strong one-line hook.\n"
        "- 2-4 sentences summarizing IN OUR OWN WORDS what the article/video covers and why it matters to "
        f"{brand['audience'] if brand is not DEFAULT_BRAND and brand['audience'] != DEFAULT_BRAND['audience'] else 'founders and developers'}. "
        "NEVER copy the source's wording — paraphrase, stay accurate and neutral.\n"
        "- A link line using the EXACT url given: use '🔗 Read:' for articles and '🎥 Watch:' for videos.\n"
        f"- The CTA (REQUIRED on every post): a line inviting readers to {brand['newsletter_cta']} to subscribe, e.g. "
        f"\"💬 Want these every week? {brand['newsletter_cta'][0].upper() + brand['newsletter_cta'][1:]} and we'll add "
        f'you to our {brand["newsletter_name"]}."\n'
        "- 3-5 relevant hashtags"
        + (f", always including {brand['hashtags']}" if brand["hashtags"] else "")
        + ".\nKeep each UNDER 2900 characters. Always credit the source by name. Do NOT reproduce the article body "
        "or the video transcript; a short quoted phrase is fine, paragraphs are not. Never mention images.\n"
        "Return exactly one post object per item, with i matching the item number, as this JSON object:\n"
        '{"posts": [{"i": 0, "content": "<the full post text>"}]}'
    )


def scoring_system(brand: dict[str, str]) -> str:
    """The Trend Radar's scoring prompt: who we are, who we sell to, and what to score high."""
    name = brand["name"]
    return (
        f"You are the content strategist for {name}. We {brand['what_we_do']} for our ideal customer: "
        f"{brand['audience']}. Our content's job is to {brand['goal']}.\n\n"
        "Score each item 0-100 for how strongly it triggers that demand and gives us a blog angle aimed at our ideal "
        f"customer.\n{brand['scoring_focus']}\n\n"
        'For EACH item output an object with: i (item number), marketDriverScore (0-100), driverType (one of "demand '
        'trigger","startup funding","MVP/product launch","founder lessons","AI dev tool/agent","AI model/research",'
        '"software engineering","industry shift","off-topic"), clientRelevance (one of "MVP & startups","Fundraising",'
        '"AI advances","Software engineering","General","none"), demandTrigger (true if this story would make our ideal '
        "customer want what we offer, else false), blogAngle (one concise sentence framing the angle for our ideal "
        "customer — what changed and why they need to act NOW), topicKey (short kebab-case id of the underlying story; "
        "two articles on the SAME event share it), keep (true if it belongs on our blog else false).\n"
        "Return exactly one object per item. Output only the structured JSON, in this shape:\n"
        '{"scores": [{"i": 0, "marketDriverScore": 92, "driverType": "demand trigger", "clientRelevance": '
        '"MVP & startups", "demandTrigger": true, "blogAngle": "Why angels now expect a working product before '
        'they invest — and how to ship one fast", "topicKey": "angels-want-product-not-deck", "keep": true}]}'
    )


def summary_system(brand: dict[str, str]) -> str:
    return (
        f"You are a content editor for {brand['name']}, which {brand['what_we_do']}. For each article, write a clear, "
        "engaging summary of about TWO short paragraphs (120-170 words total) for an audience of "
        f"{brand['audience']}: paragraph 1 = what happened; paragraph 2 = why it matters for that reader — the demand "
        "signal and what they should do now. Use plain professional prose, no marketing fluff, no title, and do not "
        "insert links. Separate the two paragraphs with a blank line. Return exactly one summary object per item, "
        "with i matching the ITEM number, in this shape:\n"
        '{"summaries": [{"i": 0, "summary": "First paragraph.\\n\\nSecond paragraph."}]}'
    )


__all__ = [
    "DEFAULT_BRAND",
    "FIELDS",
    "blog_system",
    "brand_of",
    "cta_link",
    "roundup_system",
    "scoring_system",
    "summary_system",
]
