-- ============================================
-- Migration 014 — Newsletter Templates Sprint, Story T1
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD waits for release-time
-- promotion via scripts/promote-dev-to-prod.py. Do NOT apply to PROD
-- during this sprint.
--
-- Governance: additive only. Adds one new table, one trigger, four RLS
-- policies, three indexes, and one seed row. No base-table mutations.
--
-- Why this exists: see writers-workbench/docs/newsletter-templates-sprint.md.
-- The Course Worx Media design-system zip shipped a sample HTML layout
-- (samples/the-workbench-newsletter-sample.html) that the AI pipeline must
-- populate at send time. This migration stores user- and admin-managed
-- Handlebars templates and seeds the canonical Course Worx "Workbench"
-- template parameterised so AI-generated content (intro, lead, sponsor,
-- pull-quote, trending list, "From the Workbench" section, signoff) can
-- be merged in.
--
-- Branding (wordmark, subheader, palette, footer kicker, stamp) is
-- baked into the seeded template by design — every template carries its
-- own complete branding. Users creating new templates supply their own
-- branding inline; the n8n send-time render call only varies the
-- content placeholders.
-- ============================================

CREATE TABLE IF NOT EXISTS newsletter_templates_v2 (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  edition_id   text,                                 -- references newsletter_editions_v2.id (no FK to allow NULL = any edition)
  user_id      text REFERENCES users_v2(user_id) ON DELETE CASCADE,
                                                    -- NULL = system / admin-curated; populated = owned by that user
  source_type  text NOT NULL DEFAULT 'user' CHECK (source_type IN ('system','user')),
  html         text NOT NULL,                       -- Handlebars template source
  sample_data  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- design-time preview + fallback values
  is_default   boolean NOT NULL DEFAULT false,      -- exactly one default per edition_id (enforced by partial unique below)
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- "Default template for this edition" — fast lookup at send time.
CREATE INDEX IF NOT EXISTS idx_newsletter_templates_v2_default
  ON newsletter_templates_v2 (edition_id, is_default) WHERE active;

-- "My templates for this edition" — used by the in-app templates list.
CREATE INDEX IF NOT EXISTS idx_newsletter_templates_v2_owner
  ON newsletter_templates_v2 (user_id, edition_id);

-- At most one ACTIVE default per edition. NULL edition_id rows aren't
-- constrained — they are reusable across editions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_newsletter_templates_v2_default
  ON newsletter_templates_v2 (edition_id) WHERE is_default AND active AND edition_id IS NOT NULL;

-- updated_at upkeep — re-uses the function created in migration 009.
DROP TRIGGER IF EXISTS trg_newsletter_templates_v2_touch ON newsletter_templates_v2;
CREATE TRIGGER trg_newsletter_templates_v2_touch
  BEFORE UPDATE ON newsletter_templates_v2
  FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();

ALTER TABLE newsletter_templates_v2 ENABLE ROW LEVEL SECURITY;

-- SELECT: system templates (user_id IS NULL), own templates, or admin/superuser.
DROP POLICY IF EXISTS newsletter_templates_select ON newsletter_templates_v2;
CREATE POLICY newsletter_templates_select ON newsletter_templates_v2
  FOR SELECT
  USING (
    user_id IS NULL
    OR user_id = get_current_user_id()
    OR is_admin_v2()
  );

-- INSERT: caller may insert their own row, OR an admin may insert a
-- system template (user_id IS NULL).
DROP POLICY IF EXISTS newsletter_templates_insert ON newsletter_templates_v2;
CREATE POLICY newsletter_templates_insert ON newsletter_templates_v2
  FOR INSERT
  WITH CHECK (
    (user_id = get_current_user_id())
    OR (user_id IS NULL AND is_admin_v2())
  );

-- UPDATE / DELETE: owner OR admin.
DROP POLICY IF EXISTS newsletter_templates_update ON newsletter_templates_v2;
CREATE POLICY newsletter_templates_update ON newsletter_templates_v2
  FOR UPDATE
  USING (user_id = get_current_user_id() OR is_admin_v2())
  WITH CHECK (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS newsletter_templates_delete ON newsletter_templates_v2;
CREATE POLICY newsletter_templates_delete ON newsletter_templates_v2
  FOR DELETE
  USING (user_id = get_current_user_id() OR is_admin_v2());

-- ============================================
-- Seed: the canonical Course Worx Workbench template.
--
-- HTML is the parameterised version of
-- writers-workbench/docs/samples/the-workbench-newsletter-template.html
-- (which itself is the Handlebars-ised version of the design-system zip's
-- samples/the-workbench-newsletter-sample.html). Wordmark, palette,
-- subheader, footer-kicker, stamp URL — all baked in literally because
-- this template IS the Course Worx Workbench template; users will create
-- their own templates with their own branding.
-- ============================================
INSERT INTO newsletter_templates_v2
  (id, name, description, edition_id, user_id, source_type, html, sample_data, is_default, active)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'The Workbench (default)',
  'Course Worx-branded weekly newsletter layout. AI pipeline injects intro, lead story, sponsor, pull quote, trending list, "From the Workbench" section, and signoff. Issue number and date come from the generator at send time.',
  'ai-news',
  NULL,
  'system',
  $tpl$<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>{{#if title}}{{title}}{{else}}The Workbench{{/if}}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Dancing+Script:wght@600&display=swap" rel="stylesheet">
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;display:block;max-width:100%;height:auto}
  body{margin:0!important;padding:0!important;background:#efeadf;font-family:Georgia,'Times New Roman',serif}
  a{color:#14288c;text-decoration:underline}
  a:hover{color:#0b1a5f}
  .preheader{display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden}
  @media only screen and (max-width:620px){
    .container{width:100%!important}
    .px-pad{padding-left:24px!important;padding-right:24px!important}
    .h-title{font-size:26px!important;line-height:1.2!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#efeadf;">

<div class="preheader">{{preheader}}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#efeadf;">
  <tr><td align="center" style="padding:24px 12px;">

    <!-- View-on-web bar -->
    <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
      <tr><td align="center" style="padding:0 0 10px 0;font-family:Inter,Arial,sans-serif;font-size:11px;color:#6b6256;letter-spacing:.08em;text-transform:uppercase;">
        Issue #{{issue.number}} &nbsp;·&nbsp; {{issue.date}} &nbsp;·&nbsp; <a href="{{issue.view_url}}" style="color:#6b6256;text-decoration:underline;">View in browser</a>
      </td></tr>
    </table>

    <!-- MAIN CARD -->
    <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#fbf8f2;border:1px solid #e8dfc9;">

      <!-- Masthead — Course Worx branding baked into THIS template. -->
      <tr><td align="center" class="px-pad" style="padding:40px 48px 8px 48px;border-bottom:1px solid #e8dfc9;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:48px;line-height:1;letter-spacing:-0.02em;color:#14288c;font-weight:700;padding-bottom:6px;">
            The <em style="font-style:italic;font-weight:400;">Workbench</em>
          </td>
        </tr><tr>
          <td align="center" style="font-family:'Playfair Display',Georgia,serif;font-size:15px;font-style:italic;color:#6b6256;padding-bottom:16px;">
            Dispatches from the Machine Room
          </td>
        </tr><tr>
          <td align="center" style="font-family:Inter,Arial,sans-serif;font-size:10px;letter-spacing:.32em;text-transform:uppercase;color:#6b6256;padding-bottom:28px;">
            A&nbsp;&nbsp;CourseworxAI&nbsp;&nbsp;Weekly
          </td>
        </tr></table>
      </td></tr>

      <!-- Intro — AI-generated paragraph. -->
      {{#if intro_html}}
      <tr><td class="px-pad" style="padding:32px 48px 0 48px;font-family:'Playfair Display',Georgia,serif;font-size:17px;line-height:1.7;color:#2a2620;">
        {{{intro_html}}}
      </td></tr>
      {{/if}}

      <!-- Lead story — AI-generated. -->
      {{#if lead}}
      <tr><td class="px-pad" style="padding:28px 48px 0 48px;">
        <div style="font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#14288c;font-weight:600;margin-bottom:10px;">{{#if lead.eyebrow}}{{lead.eyebrow}}{{else}}Lead story{{/if}}</div>
        <h1 class="h-title" style="margin:0 0 14px 0;font-family:'Playfair Display',Georgia,serif;font-size:34px;line-height:1.15;letter-spacing:-0.015em;color:#14288c;font-weight:700;">
          {{lead.headline}}
        </h1>
        {{{lead.body_html}}}
        {{#if lead.read_more_url}}
        <div style="font-family:Inter,Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-top:14px;">
          <a href="{{lead.read_more_url}}" style="color:#14288c;text-decoration:none;">{{#if lead.read_more_label}}{{lead.read_more_label}}{{else}}Read the full breakdown →{{/if}}</a>
        </div>
        {{/if}}
      </td></tr>
      <tr><td class="px-pad" style="padding:28px 48px 0 48px;"><hr style="border:0;border-top:1px solid #e8dfc9;margin:0;"></td></tr>
      {{/if}}

      <!-- Sponsor — optional, AI/editorial-supplied. -->
      {{#if sponsor}}
      <tr><td style="padding:28px 48px 0 48px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4ede0;border:1px solid #e8dfc9;">
          <tr><td style="padding:22px 24px;">
            <div style="font-family:Inter,Arial,sans-serif;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#6b6256;font-weight:600;margin-bottom:8px;">Presented by &nbsp;·&nbsp; {{sponsor.name}}</div>
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:22px;line-height:1.25;color:#14288c;font-weight:700;margin-bottom:8px;">{{sponsor.headline}}</div>
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:15px;line-height:1.6;color:#2a2620;margin-bottom:14px;">{{{sponsor.body_html}}}</div>
            <a href="{{sponsor.cta_url}}" style="display:inline-block;font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#fbf8f2;background:#14288c;padding:10px 16px;text-decoration:none;">{{sponsor.cta_label}}</a>
          </td></tr>
        </table>
      </td></tr>
      {{/if}}

      <!-- Pull quote — optional, AI- or editorial-supplied. -->
      {{#if pull_quote}}
      <tr><td class="px-pad" style="padding:28px 48px 0 48px;">
        <div style="border-left:3px solid #14288c;padding-left:20px;font-family:'Playfair Display',Georgia,serif;font-style:italic;font-size:22px;line-height:1.4;color:#14288c;">
          "{{pull_quote.quote}}"
        </div>
        {{#if pull_quote.attribution}}
        <div style="font-family:Inter,Arial,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#6b6256;padding-left:23px;margin-top:10px;font-weight:500;">
          — {{pull_quote.attribution}}
        </div>
        {{/if}}
      </td></tr>
      <tr><td class="px-pad" style="padding:28px 48px 0 48px;"><hr style="border:0;border-top:1px solid #e8dfc9;margin:0;"></td></tr>
      {{/if}}

      <!-- Trending — AI-curated story list. -->
      {{#if trending}}
      <tr><td class="px-pad" style="padding:28px 48px 0 48px;">
        <div style="font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#6b6256;font-weight:600;margin-bottom:8px;">{{#if trending.eyebrow}}{{trending.eyebrow}}{{else}}Trending this week{{/if}}</div>
        <h2 style="margin:0 0 18px 0;font-family:'Playfair Display',Georgia,serif;font-size:26px;line-height:1.2;color:#14288c;font-weight:700;">{{#if trending.headline}}{{trending.headline}}{{else}}What builders are reading{{/if}}</h2>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          {{#each trending.items}}
          <tr><td style="padding:14px 0;{{#unless @last}}border-bottom:1px solid #e8dfc9;{{/unless}}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="44" valign="top" style="font-family:'Playfair Display',Georgia,serif;font-size:26px;color:#14288c;font-weight:700;line-height:1;">{{rank @index}}</td>
              <td valign="top">
                <a href="{{url}}" style="display:block;font-family:'Playfair Display',Georgia,serif;font-size:17px;line-height:1.35;color:#14288c;font-weight:700;text-decoration:none;margin-bottom:4px;">{{title}}</a>
                <div style="font-family:Inter,Arial,sans-serif;font-size:12px;color:#6b6256;">{{source}}{{#if read_time}} · {{read_time}}{{/if}}</div>
              </td>
            </tr></table>
          </td></tr>
          {{/each}}
        </table>
      </td></tr>
      <tr><td class="px-pad" style="padding:28px 48px 0 48px;"><hr style="border:0;border-top:1px solid #e8dfc9;margin:0;"></td></tr>
      {{/if}}

      <!-- From the Workbench — optional editorial section. -->
      {{#if workbench_section}}
      <tr><td class="px-pad" style="padding:28px 48px 0 48px;">
        <div style="font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#6b6256;font-weight:600;margin-bottom:8px;">{{#if workbench_section.eyebrow}}{{workbench_section.eyebrow}}{{else}}From the Workbench{{/if}}</div>
        <h2 style="margin:0 0 14px 0;font-family:'Playfair Display',Georgia,serif;font-size:24px;line-height:1.2;color:#14288c;font-weight:700;">{{workbench_section.headline}}</h2>
        {{{workbench_section.body_html}}}
      </td></tr>
      <tr><td class="px-pad" style="padding:28px 48px 0 48px;"><hr style="border:0;border-top:1px solid #e8dfc9;margin:0;"></td></tr>
      {{/if}}

      <!-- Signoff — editor's name + role per send. -->
      <tr><td class="px-pad" style="padding:32px 48px 8px 48px;">
        {{#if signoff.body_html}}{{{signoff.body_html}}}{{/if}}
        <div style="font-family:'Dancing Script','Brush Script MT',cursive;font-size:36px;color:#14288c;line-height:1;margin-bottom:4px;">— {{#if signoff.signature_name}}{{signoff.signature_name}}{{else}}Eric{{/if}}</div>
        <div style="font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#6b6256;font-weight:600;">
          {{#if signoff.role}}{{signoff.role}}{{else}}Editor, The Workbench{{/if}}
        </div>
      </td></tr>

      <!-- CourseworxAI stamp — baked into this template. -->
      <tr><td align="center" style="padding:8px 48px 36px 48px;">
        <img src="{{#if stamp_url}}{{stamp_url}}{{else}}/static/logos/courseworx-stamp-black.png{{/if}}" width="84" alt="CourseworxAI stamp" style="display:inline-block;width:84px;height:auto;opacity:.7;">
      </td></tr>

    </table>

    <!-- Footer — Course Worx address + standard preference links. -->
    <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
      <tr><td align="center" style="padding:24px 12px 40px 12px;font-family:Inter,Arial,sans-serif;font-size:11px;color:#6b6256;line-height:1.6;">
        <div style="margin-bottom:8px;">{{#if footer.reason}}{{footer.reason}}{{else}}You're getting this because you subscribed to The Workbench at courseworx.media.{{/if}}</div>
        <div>
          <a href="{{footer.preferences_url}}" style="color:#6b6256;text-decoration:underline;">Update preferences</a> ·
          <a href="{{footer.unsubscribe_url}}" style="color:#6b6256;text-decoration:underline;">Unsubscribe</a> ·
          <a href="{{issue.view_url}}" style="color:#6b6256;text-decoration:underline;">View in browser</a>
        </div>
        <div style="margin-top:12px;">{{#if footer.address}}{{footer.address}}{{else}}CourseworxAI · 1140 Broadway, New York, NY 10001{{/if}}</div>
      </td></tr>
    </table>

  </td></tr>
</table>

</body>
</html>
$tpl$,
  $sample${"title": "👀 The Workbench — issue preview", "preheader": "Plus: short preview text shown in inbox preview pane.", "issue": {"number": 1, "date": "Friday, April 24, 2026", "view_url": "#"}, "intro_html": "<p>Good morning. This is a preview of how a Workbench issue renders. The masthead, palette, fonts, and footer are baked into this template; everything below comes from the AI pipeline at send time.</p>", "lead": {"eyebrow": "Lead story", "headline": "OpenAI drops a privacy-focused model — and the trade-off is real", "body_html": "<p>OpenAI quietly shipped a new model this week tuned for local inference and strict data boundaries. If you've been waiting to pilot AI inside a regulated workflow — healthcare notes, legal drafts, HR — <a href=\"#\">this is the first serious option</a> from a major lab.</p><p>The catch: about 12% on reasoning benchmarks traded for the privacy guarantees. Fine for compliance teams. Harder for consumer apps.</p>", "read_more_url": "#", "read_more_label": "Read the full breakdown →"}, "sponsor": {"name": "Nvidia Inception", "headline": "Eighty frontier models. Zero setup. Free for builders.", "body_html": "Inception members get managed access to Llama, Mistral, DeepSeek, and 77 more — plus credits, office hours, and GTM support. Apply in ten minutes.", "cta_label": "Apply now", "cta_url": "#"}, "pull_quote": {"quote": "A 1.8-billion-parameter model can match a 1.8-trillion-parameter model on most practical tasks — if you're willing to do the data work.", "attribution": "Andrej Karpathy, on small models"}, "trending": {"eyebrow": "Trending this week", "headline": "What builders are reading", "items": [{"title": "Karpathy: a 1.8B model can match a 1.8T giant on practical tasks", "url": "#", "source": "X thread", "read_time": "4 min"}, {"title": "Anthropic publishes a new post-training recipe", "url": "#", "source": "Anthropic blog", "read_time": "12 min"}, {"title": "How one solo dev shipped a $30k/mo writing tool", "url": "#", "source": "IndieHackers", "read_time": "9 min"}, {"title": "The case against RAG for most internal search", "url": "#", "source": "Substack", "read_time": "7 min"}, {"title": "Postal v3.3 ships native DKIM rotation", "url": "#", "source": "postalserver.io", "read_time": "3 min"}]}, "workbench_section": {"eyebrow": "From the Workbench", "headline": "New in The Writers Workbench", "body_html": "<p style=\"margin:0 0 14px 0;font-family:'Playfair Display',Georgia,serif;font-size:17px;line-height:1.75;color:#2a2620;\">Eve now supports voice capture during chapter drafts. Hold space, speak, and she'll transcribe straight into your manuscript — no context-switch to another app. It's rough, it's fast, and <a href=\"#\">it's exactly how I drafted this issue</a>.</p><p style=\"margin:0;font-family:'Playfair Display',Georgia,serif;font-size:17px;line-height:1.75;color:#2a2620;\">Cost dashboards also got a real date range picker. If you're burning budget on Sonnet, you'll see it now.</p>"}, "signoff": {"body_html": "<p style=\"margin:0 0 14px 0;font-family:'Playfair Display',Georgia,serif;font-size:16px;line-height:1.7;color:#2a2620;\">That's it for this week. Reply and tell me what landed. I read every one.</p>", "signature_name": "Eric", "role": "Editor, The Workbench"}, "stamp_url": "/static/logos/courseworx-stamp-black.png", "footer": {"reason": "You're getting this because you subscribed to The Workbench at courseworx.media.", "preferences_url": "#", "unsubscribe_url": "#", "address": "CourseworxAI · 1140 Broadway, New York, NY 10001"}}$sample$::jsonb,
  true,
  true
)
ON CONFLICT (id) DO NOTHING;
