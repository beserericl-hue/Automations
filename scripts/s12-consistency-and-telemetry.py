#!/usr/bin/env python3
"""
Sprint 12 consistency + telemetry closure.

Applies four targeted changes to DEV - Worker - Write Chapter
(fsKRGkzphWT62rja):

  (1) Wire S12-2 Build Chapter Context into the flow. A new
      `build_chapter_context` executeWorkflow node is inserted between
      `get_project_data` and `research_topic`. Its output is injected
      into `build_sub_chapter_prompts` so every sub-chapter prompt
      carries the outline's locked character roster and previous-
      chapter summaries.

  (2) LOCKED CHARACTERS / DO-NOT-INTRODUCE-ALTERNATES reinforcement in
      the sub-chapter system prompt. The existing CHARACTER NAME RULES
      block is kept; a stronger negative rule is prepended.

  (3) Continuity merge pass. A new Claude chain `continuity_merge` is
      inserted between `concatenate_chapter` and `update_story_bible`.
      It reads the outline + previous-chapter summaries (via the S12-2
      context doc) and reconciles character names, pronouns, and
      timeline against the just-concatenated chapter before QA runs.
      Skip logic lives inside the Code node: if <=2 sub-chapters it
      passes the chapter through unchanged.

  (4) Write-timing node at the tail. After `set_result` we insert a
      row into token_usage_v2 with execution_time_ms / queue_wait_ms /
      llm_time_ms so the S12-5 Performance dashboard has data.
      Relies on migration 011 (applied 2026-04-24). Fails open on
      Supabase error.

Replay-safe: every node is idempotent. If a node named
`build_chapter_context`, `continuity_merge_llm`, `continuity_merge_claude`,
`continuity_finalize`, or `write_timing` already exists we update it
in place.

Usage:
  N8N_API_KEY=...
  DEV_SUPABASE_SERVICE_ROLE_KEY=...
  ANTHROPIC_CRED_ID=5LhCYKsaFO3fF7II
  CONTEXT_BUILDER_WF_ID=jJe84zB3U1HA9xVv
  python3 scripts/s12-consistency-and-telemetry.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
DEV_WORKER_ID = "fsKRGkzphWT62rja"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

DEV_SUPABASE_URL = "https://gvbvwcnmjkdpclcisqrr.supabase.co"


def api(method: str, path: str, body: Any | None = None) -> Any:
    key = os.environ.get("N8N_API_KEY")
    if not key:
        print("N8N_API_KEY not set", file=sys.stderr)
        sys.exit(2)
    req = Request(
        f"{N8N_BASE}/api/v1{path}",
        method=method,
        headers={
            "X-N8N-API-KEY": key,
            "User-Agent": UA,
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:500]}", file=sys.stderr)
        raise


def clean_put_body(wf: dict) -> dict:
    keep = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"]}
    if "settings" in wf:
        keep["settings"] = wf["settings"]
    for n in keep["nodes"]:
        if "disabled" in n and not isinstance(n["disabled"], bool):
            n.pop("disabled")
    return keep


# --------------------------------------------------------------------
# Code node bodies

CONTINUITY_MERGE_PROMPT_BUILDER = r"""// Build the continuity-merge prompt. Skips the LLM pass entirely when
// the chapter is small enough that drift is unlikely (<= 2 sub-chapters).

const concat = $input.first().json;
const chapterText = concat.output?.chapter_text || '';
const chapterTitle = concat.output?.chapter_title || 'Chapter';
const wordCount = concat.output?.word_count || 0;
const totalSubs = $('build_sub_chapter_prompts').first().json.total_sub_chapters || 0;

const ctx = $('build_chapter_context').first()?.json || {};
const contextDoc = ctx.context_document || '';

// Preserve everything so the finalize node can pass-through on skip.
const passThroughPayload = { ...concat };

if (totalSubs <= 2 || !contextDoc || !chapterText) {
  return [{
    json: {
      ...passThroughPayload,
      _skip_merge: true,
      _skip_reason: totalSubs <= 2 ? 'only ' + totalSubs + ' sub-chapters' : 'missing context or chapter',
    },
  }];
}

const systemPrompt =
  'You are a continuity editor. You receive a fresh chapter and the\n' +
  'book project context (outline, story bible, previous chapters).\n' +
  'Your ONE job is to smooth continuity without rewriting the prose:\n' +
  '\n' +
  '  1. Reconcile character names against the outline. If the chapter\n' +
  '     uses a name variant that contradicts the locked character\n' +
  '     roster (e.g. "Santos-Martinez" when the outline locks\n' +
  '     "Morales"), fix every occurrence.\n' +
  '  2. Reconcile pronouns and relationships. If the chapter treats a\n' +
  '     character as a stranger when prior chapters establish them as\n' +
  '     a friend, fix the framing.\n' +
  '  3. Fix obvious timeline contradictions (discoveries treated as\n' +
  '     new when prior chapters already established them, ages that\n' +
  '     contradict the outline, etc).\n' +
  '  4. Preserve the chapter voice, pacing, and prose style completely.\n' +
  '     Do NOT rewrite scenes. Do NOT add new plot. Do NOT shorten or\n' +
  '     expand. ONLY fix continuity.\n' +
  '  5. Keep the exact sub-chapter breaks (---) unchanged.\n' +
  '\n' +
  'OUTPUT: return ONLY the smoothed chapter prose in markdown. No\n' +
  'preamble, no change log, no commentary. First line is the chapter\n' +
  'heading.';

const userPrompt =
  'PROJECT CONTEXT (authoritative — reconcile the chapter against this):\n\n' +
  contextDoc +
  '\n\n---\n\nFRESH CHAPTER (smooth this):\n\n' +
  chapterText;

return [{
  json: {
    ...passThroughPayload,
    _skip_merge: false,
    _merge_system_prompt: systemPrompt,
    _merge_user_prompt: userPrompt,
  },
}];
"""

CONTINUITY_FINALIZE = r"""// Package the smoothed chapter back into the same output shape
// update_story_bible expects. Preserves the pre-merge text in
// metadata.versions.pre_merge for audit.

const upstream = $('continuity_prepare').first().json;

if (upstream._skip_merge) {
  // Bypass — just forward the concat output unchanged.
  return [{ json: { output: upstream.output } }];
}

const llm = $input.first().json;
const smoothed = (llm.text || llm.output || llm.response || '').toString().trim();
const preMerge = upstream.output?.chapter_text || '';

if (!smoothed) {
  // LLM returned nothing — fail open, keep the pre-merge text.
  return [{ json: { output: upstream.output } }];
}

const newWordCount = smoothed.split(/\s+/).filter(Boolean).length;

const output = {
  ...upstream.output,
  chapter_text: smoothed,
  word_count: newWordCount,
  metadata: {
    ...(upstream.output?.metadata || {}),
    versions: {
      ...((upstream.output?.metadata || {}).versions || {}),
      pre_merge: preMerge,
    },
    continuity_merged: true,
    pre_merge_word_count: upstream.output?.word_count || null,
  },
};

return [{ json: { output } }];
"""

WRITE_TIMING_CODE = r"""// S12-5 write-path. Inserts a token_usage_v2 row with the end-to-end
// timing so the admin Performance dashboard has data. Fails open on
// any Supabase error — telemetry must NEVER block chapter delivery.

const trigger = $('workflow_trigger').first().json;
const startMs = trigger.s12_start_ms;
const now = Date.now();
const execMs = startMs ? now - startMs : null;

// queue_wait_ms: time between BullMQ enqueue (forwarded via trigger
// body if available) and the n8n execution start. Only populated when
// the caller threads a _queued_at field.
const queuedAt = trigger._queued_at || null;
const queueWaitMs = queuedAt && startMs ? Math.max(0, startMs - queuedAt) : null;

// llm_time_ms: rough estimate — total minus non-LLM overhead is not
// knowable from n8n. For now we record execution_time_ms only and
// leave llm_time_ms null; a future iteration can instrument each LLM
// call's duration.
const llmTimeMs = null;

const supabaseUrl = 'https://gvbvwcnmjkdpclcisqrr.supabase.co';
const apiKey = $env.SUPABASE_SERVICE_ROLE_KEY || '';
const userId = trigger.user_id || 'unknown';

if (!apiKey) {
  return [{ json: { telemetry_skipped: 'no SUPABASE_SERVICE_ROLE_KEY env' } }];
}

try {
  await this.helpers.httpRequest({
    method: 'POST',
    url: supabaseUrl + '/rest/v1/token_usage_v2',
    headers: {
      apikey: apiKey,
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      user_id: userId,
      workflow_name: 'Worker - Write Chapter',
      model: 'claude-sonnet-4-5',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      execution_time_ms: execMs,
      queue_wait_ms: queueWaitMs,
      llm_time_ms: llmTimeMs,
      metadata: {
        source: 's12-5 write_timing',
        project_title: trigger.project_title,
        chapter_number: trigger.chapter_number,
      },
    }),
  });
  return [{ json: { telemetry_recorded: true, execution_time_ms: execMs } }];
} catch (e) {
  // Failing open: log but don't block.
  return [{ json: { telemetry_error: String(e), execution_time_ms: execMs } }];
}
"""

# Stronger CHARACTER LOCK insertion. We patch the existing system
# prompt build block: insert a negative-instruction paragraph right
# BEFORE the existing "## CHARACTER NAME RULES" section.
LOCKED_CHARACTERS_NEEDLE = "'## CHARACTER NAME RULES"
LOCKED_CHARACTERS_REPLACE = (
    "'## LOCKED CHARACTER ROSTER — MANDATORY\\n"
    "The character list below is LOCKED by the book outline and the story\\n"
    "bible. You MUST use these names exactly. NEVER introduce alternate\\n"
    "surnames, nicknames, or name variants that are not in the outline\\n"
    "(e.g. do NOT write \"Santos-Martinez\" for a character the outline\\n"
    "locks as \"Morales\"). If a character is established in a previous\\n"
    "chapter (see PREVIOUS CHAPTERS in the project context), you MUST\\n"
    "treat them with the established relationship — friend, enemy,\\n"
    "stranger — and NOT reset the relationship.\\n\\n"
    "FINAL CHECK before writing each scene: every proper noun referring\\n"
    "to a character must match the outline exactly. If you are unsure,\\n"
    "use the full name from the outline rather than inventing a variant.\\n\\n' +\n"
    "  '## CHARACTER NAME RULES"
)

# Injection of the Build Chapter Context output into the systemPrompt.
# We prepend the context_document so the LLM sees it first.
CONTEXT_DOC_NEEDLE = "systemPrompt =\n  'You are a world-class novelist"
CONTEXT_DOC_REPLACE = (
    "const bccContextDoc = ($('build_chapter_context').first()?.json || {}).context_document || '';\n"
    "const contextPreamble = bccContextDoc\n"
    "  ? '# PROJECT CONTEXT (read first — authoritative over any inference)\\n\\n' + bccContextDoc + '\\n\\n---\\n\\n'\n"
    "  : '';\n\n"
    "systemPrompt = contextPreamble +\n  'You are a world-class novelist"
)


def patch_build_sub_chapter_prompts(code: str) -> tuple[str, bool]:
    changed = False

    # Inject the context-doc preamble if not already present.
    if "bccContextDoc" not in code:
        if CONTEXT_DOC_NEEDLE not in code:
            raise RuntimeError(
                "build_sub_chapter_prompts: could not find systemPrompt needle"
            )
        code = code.replace(CONTEXT_DOC_NEEDLE, CONTEXT_DOC_REPLACE, 1)
        changed = True

    # Inject the LOCKED CHARACTER ROSTER block if not already present.
    if "LOCKED CHARACTER ROSTER" not in code:
        if LOCKED_CHARACTERS_NEEDLE not in code:
            raise RuntimeError(
                "build_sub_chapter_prompts: could not find CHARACTER NAME RULES needle"
            )
        code = code.replace(LOCKED_CHARACTERS_NEEDLE, LOCKED_CHARACTERS_REPLACE, 1)
        changed = True

    return code, changed


# --------------------------------------------------------------------


def upsert_node(wf: dict, node: dict) -> bool:
    """Insert node if missing, update in place if present. Returns True if changed."""
    for i, n in enumerate(wf["nodes"]):
        if n.get("name") == node["name"]:
            if n == node:
                return False
            wf["nodes"][i] = node
            return True
    wf["nodes"].append(node)
    return True


def remove_connection(conns: dict, src: str, dst: str, port: str = "main", idx: int = 0) -> bool:
    outs = conns.get(src, {}).get(port, [])
    if len(outs) <= idx:
        return False
    branch = outs[idx]
    before = len(branch)
    outs[idx] = [c for c in branch if c.get("node") != dst]
    return len(outs[idx]) < before


def ensure_connection(conns: dict, src: str, dst: str, port: str = "main", idx: int = 0, dst_port: str = "main") -> bool:
    outs = conns.setdefault(src, {}).setdefault(port, [])
    while len(outs) <= idx:
        outs.append([])
    for c in outs[idx]:
        if c.get("node") == dst and c.get("type") == dst_port:
            return False
    outs[idx].append({"node": dst, "type": dst_port, "index": 0})
    return True


def main() -> int:
    for var in ("DEV_SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_CRED_ID", "CONTEXT_BUILDER_WF_ID"):
        if not os.environ.get(var):
            print(f"ERROR: {var} not set", file=sys.stderr)
            return 2

    context_wf_id = os.environ["CONTEXT_BUILDER_WF_ID"]
    anthropic_cred = os.environ["ANTHROPIC_CRED_ID"]

    wf = api("GET", f"/workflows/{DEV_WORKER_ID}")
    changed = False

    # ---------------------------------------------------------------
    # (1) Build Chapter Context node
    build_ctx_node = {
        "parameters": {
            "workflowId": {"__rl": True, "mode": "id", "value": context_wf_id},
            "workflowInputs": {
                "mappingMode": "defineBelow",
                "value": {
                    "user_id": "={{ $('workflow_trigger').first().json.user_id }}",
                    "project_title": "={{ $('workflow_trigger').first().json.project_title }}",
                    "chapter_number": "={{ $('workflow_trigger').first().json.chapter_number }}",
                    "focus": "={{ $('workflow_trigger').first().json.brief || '' }}",
                    "max_prev_chapters": "={{ 3 }}",
                },
                "matchingColumns": [],
                "schema": [
                    {"id": "s1", "displayName": "user_id", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                    {"id": "s2", "displayName": "project_title", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                    {"id": "s3", "displayName": "chapter_number", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                    {"id": "s4", "displayName": "focus", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                    {"id": "s5", "displayName": "max_prev_chapters", "required": False, "defaultMatch": False, "display": True, "type": "number", "canBeUsedToMatch": True},
                ],
            },
            "options": {},
        },
        "id": "bcc_node",
        "name": "build_chapter_context",
        "type": "n8n-nodes-base.executeWorkflow",
        "typeVersion": 1.2,
        "position": [460, -300],
    }
    if upsert_node(wf, build_ctx_node):
        changed = True
        print("  upserted build_chapter_context")

    # Insert between get_project_data and research_topic.
    conns = wf["connections"]
    if remove_connection(conns, "get_project_data", "research_topic"):
        changed = True
        print("  removed get_project_data -> research_topic (inserting build_chapter_context)")
    if ensure_connection(conns, "get_project_data", "build_chapter_context"):
        changed = True
        print("  wired get_project_data -> build_chapter_context")
    if ensure_connection(conns, "build_chapter_context", "research_topic"):
        changed = True
        print("  wired build_chapter_context -> research_topic")

    # ---------------------------------------------------------------
    # (2) Patch build_sub_chapter_prompts Code node
    for n in wf["nodes"]:
        if n.get("name") == "build_sub_chapter_prompts":
            old = n["parameters"].get("jsCode", "")
            new_code, did_change = patch_build_sub_chapter_prompts(old)
            if did_change:
                n["parameters"]["jsCode"] = new_code
                changed = True
                print("  patched build_sub_chapter_prompts (context doc + locked chars)")
            break

    # ---------------------------------------------------------------
    # (3) Continuity merge pass — three new nodes inserted between
    #     concatenate_chapter and update_story_bible.
    merge_prep = {
        "parameters": {"jsCode": CONTINUITY_MERGE_PROMPT_BUILDER},
        "id": "cm_prep",
        "name": "continuity_prepare",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [2080, -96],
    }
    merge_llm = {
        "parameters": {
            # chainLlm needs promptType=define + text field. Concatenate
            # system + user prompts into one text blob so the model reads
            # both. The prepare node sets both fields to sentinel values
            # on skip so this still produces a valid (but ignored) call.
            "promptType": "define",
            "text": "={{ ($json._merge_system_prompt || 'passthrough') + '\\n\\n---\\n\\n' + ($json._merge_user_prompt || 'passthrough') }}",
        },
        "id": "cm_llm",
        "name": "continuity_merge_llm",
        "type": "@n8n/n8n-nodes-langchain.chainLlm",
        "typeVersion": 1.7,
        "position": [2300, -96],
    }
    merge_claude = {
        "parameters": {
            "model": {"__rl": True, "mode": "list", "value": "claude-sonnet-4-5"},
            "options": {"temperature": 0.3, "maxTokensToSample": 8000},
        },
        "id": "cm_claude",
        "name": "continuity_merge_claude",
        "type": "@n8n/n8n-nodes-langchain.lmChatAnthropic",
        "typeVersion": 1.3,
        "position": [2300, 104],
        "credentials": {
            "anthropicApi": {"id": anthropic_cred, "name": "Anthropic account"}
        },
    }
    merge_final = {
        "parameters": {"jsCode": CONTINUITY_FINALIZE},
        "id": "cm_final",
        "name": "continuity_finalize",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [2520, -96],
    }
    for n in (merge_prep, merge_llm, merge_claude, merge_final):
        if upsert_node(wf, n):
            changed = True
            print(f"  upserted {n['name']}")

    # Rewire concatenate_chapter -> update_story_bible to go through merge chain.
    if remove_connection(conns, "concatenate_chapter", "update_story_bible"):
        changed = True
        print("  removed concatenate_chapter -> update_story_bible")
    ensure_connection(conns, "concatenate_chapter", "continuity_prepare")
    ensure_connection(conns, "continuity_prepare", "continuity_merge_llm")
    ensure_connection(conns, "continuity_merge_llm", "continuity_finalize")
    ensure_connection(conns, "continuity_finalize", "update_story_bible")
    # Claude as ai_languageModel sub-node of the chain:
    ensure_connection(
        conns, "continuity_merge_claude", "continuity_merge_llm",
        port="ai_languageModel", idx=0, dst_port="ai_languageModel",
    )
    changed = True
    print("  wired continuity merge chain between concatenate_chapter and update_story_bible")

    # ---------------------------------------------------------------
    # (4) write_timing node at the tail. Goes after set_result, parallel
    #     to track_token_usage so it fires even if token tracker breaks.
    timing_node = {
        "parameters": {"jsCode": WRITE_TIMING_CODE},
        "id": "s12_timing",
        "name": "write_timing",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [3400, 200],
    }
    if upsert_node(wf, timing_node):
        changed = True
        print("  upserted write_timing")
    if ensure_connection(conns, "set_result", "write_timing"):
        changed = True
        print("  wired set_result -> write_timing")

    if not changed:
        print("No changes needed — worker already at this revision.")
        return 0

    # Deactivate may 403 on worker; tolerate.
    try:
        api("POST", f"/workflows/{DEV_WORKER_ID}/deactivate")
    except HTTPError as e:
        print(f"  deactivate returned {e.code}, continuing with PUT")
    api("PUT", f"/workflows/{DEV_WORKER_ID}", clean_put_body(wf))
    try:
        api("POST", f"/workflows/{DEV_WORKER_ID}/activate")
    except HTTPError as e:
        print(f"  activate returned {e.code}; workflow may already be active")
    print("DEV worker updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
