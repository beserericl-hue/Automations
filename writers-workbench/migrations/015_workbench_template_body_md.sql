-- ============================================
-- Migration 015 — Newsletter Templates: extend Workbench template with
-- a {{body_md}} fallback zone for the n8n send-time render path.
--
-- Tier: DEV first. PROD waits for release-day promotion.
--
-- Governance: additive — only updates the seeded template row's html
-- column. No new tables, no schema changes. Schema-governance check
-- still passes (no base-table mutations).
--
-- Why: the n8n `Content - Newsletter Agent V2` workflow produces a
-- single markdown body (`set_full_newsletter.full_newsletter_content`)
-- rather than structured sections. Issue #63 wires that body into a
-- new render_html_template HTTP Request node calling
-- /api/newsletter/render-html. For the rendered HTML to actually look
-- like the Course Worx Workbench template (instead of the existing
-- `<pre>markdown</pre>` fallback), the seeded template needs a
-- generic markdown-body zone.
--
-- The new {{markdown_to_html body_md}} block sits between the
-- intro paragraph and the (currently-unused-by-the-pipeline) structured
-- sections. When the AI pipeline eventually produces structured data
-- (lead/sponsor/pull_quote/trending), those will render below the
-- markdown body and the body_md zone collapses on the {{#if body_md}}
-- guard.
-- ============================================

UPDATE newsletter_templates_v2
SET html = $tpl$<!doctype html>
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

      <!-- Markdown body fallback — when the AI pipeline ships a single
           markdown blob instead of structured sections, render it here
           inside the Workbench shell. The Phase 2a n8n workflow uses this
           path; future iterations should produce structured sections (lead,
           sponsor, pull_quote, trending) for richer typography. -->
      {{#if body_md}}
      <tr><td class="px-pad" style="padding:24px 48px 0 48px;font-family:'Playfair Display',Georgia,serif;font-size:16px;line-height:1.65;color:#2a2620;">
        {{{markdown_to_html body_md}}}
      </td></tr>
      <tr><td class="px-pad" style="padding:24px 48px 0 48px;"><hr style="border:0;border-top:1px solid #e8dfc9;margin:0;"></td></tr>
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
    updated_at = now()
WHERE id = '00000000-0000-4000-8000-000000000001';
