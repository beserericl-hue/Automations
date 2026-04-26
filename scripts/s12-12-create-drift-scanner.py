#!/usr/bin/env python3
"""
Sprint 12 S12-12.2: create DEV - Tool - Scan Character Drift.

Cross-chapter character canon scan. Reads every chapter of a project,
extracts every named-character mention with surrounding context,
aggregates per-character variant tallies, and surfaces drift flags
against the outline character roster.

Architecture:
  workflow_trigger (user_id, project_title)
    -> settings
    -> load_project (fetch project + outline + ALL chapters sorted)
    -> split_chapters (Code node fans out one item per chapter)
    -> extract_mentions_chain (per-item: Claude extracts named-person mentions)
       \\-> extract_claude (Sonnet 4.5)
    -> aggregate_and_flag (Code node collects all per-chapter outputs,
       matches variants to canonical characters, computes drift flags)
    -> persist_scan (PATCH writing_projects_v2.metadata.character_drift_scan)
    -> shape_output

V1 scope (deliberately narrow):
  - Extract: per chapter, list of {variant, context_before, context_after}
    for every name that looks like a person reference
  - Match: bind variants to canonical outline characters by surname
    fuzzy match + first-name overlap
  - Flag types:
      forbidden_variant — variant whose surface form differs from
        outline.characters[].name_format
      unknown_character — name with no plausible canonical match
      variant_inconsistency — same character appears under multiple
        distinct surnames across chapters
  - Output: project.metadata.character_drift_scan with per-character
    counts, variants_by_chapter, drift_flags, suggested_actions

Future v2 (deferred):
  - relationship inconsistency detection
  - age/role drift detection
  - voice/dialect drift

Usage:
  N8N_API_KEY=...
  DEV_SUPABASE_SERVICE_ROLE_KEY=...
  ANTHROPIC_CRED_ID=5LhCYKsaFO3fF7II
  python3 scripts/s12-12-create-drift-scanner.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
WORKFLOW_NAME = "DEV - Tool - Scan Character Drift"

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
        print(f"  HTTP {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        raise


def clean_put_body(wf: dict) -> dict:
    keep = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"]}
    if "settings" in wf:
        keep["settings"] = wf["settings"]
    for n in keep["nodes"]:
        if "disabled" in n and not isinstance(n["disabled"], bool):
            n.pop("disabled")
    return keep


def find_existing_by_name(name: str) -> str | None:
    cursor = None
    while True:
        path = "/workflows?limit=250"
        if cursor:
            path += "&cursor=" + cursor
        resp = api("GET", path)
        for wf in resp.get("data", []):
            if wf.get("name") == name:
                return wf["id"]
        cursor = resp.get("nextCursor")
        if not cursor:
            return None


# --------------------------------------------------------------------
# Code node bodies

LOAD_PROJECT_CODE = r"""// S12-12.2 — load project, outline characters, all chapters.

const trig = $('workflow_trigger').first().json;
const userId = (trig.user_id || '').toString();
const projectTitle = (trig.project_title || '').toString();

if (!userId) throw new Error('S12-12: user_id is required');
if (!projectTitle) throw new Error('S12-12: project_title is required');

const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = { apikey: apiKey, Authorization: 'Bearer ' + apiKey };

// 1. Project (id + outline)
const projUrl =
  supabaseUrl +
  '/rest/v1/writing_projects_v2?title=eq.' +
  encodeURIComponent(projectTitle) +
  '&user_id=eq.' +
  encodeURIComponent(userId) +
  '&select=id,outline,genre_slug&limit=1';
const projResp = await this.helpers.httpRequest({ method: 'GET', url: projUrl, headers });
const project = Array.isArray(projResp) ? projResp[0] : projResp;
if (!project || !project.id) {
  throw new Error('S12-12: project not found for user=' + userId + ' title=' + projectTitle);
}

const outlineCharacters = (project.outline && Array.isArray(project.outline.characters))
  ? project.outline.characters
  : [];
const scannerExclusions = (project.outline && Array.isArray(project.outline._scanner_exclusions))
  ? project.outline._scanner_exclusions
  : [];

// 2. All chapters of the project
const chUrl =
  supabaseUrl +
  '/rest/v1/published_content_v2?project_id=eq.' +
  encodeURIComponent(project.id) +
  '&content_type=eq.chapter&deleted_at=is.null' +
  '&select=id,chapter_number,title,content_text' +
  '&order=chapter_number';
const chapters = await this.helpers.httpRequest({ method: 'GET', url: chUrl, headers });

if (!Array.isArray(chapters) || chapters.length === 0) {
  throw new Error('S12-12: no chapters found for ' + projectTitle);
}

return [
  {
    json: {
      user_id: userId,
      project_title: projectTitle,
      project_id: project.id,
      outline_characters: outlineCharacters,
      scanner_exclusions: scannerExclusions,
      chapters,
      chapter_count: chapters.length,
    },
  },
];
"""

SCAN_CHAPTERS_DETERMINISTIC_CODE = r"""// S12-12.2 (v4) — deterministic regex-based scan. No LLM, no token limits.
//
// Runs in a single Code node and replaces the prior LLM-chain extraction.
// Three signal classes per chapter, all detected by regex:
//
//   1. Canonical matches — for each canonical character, find every
//      occurrence of every declared name + name_variant + bare-first-name +
//      bare-surname (when surname is unique across the roster). Word-bounded,
//      case-sensitive, possessive-aware.
//
//   2. Drift candidates — patterns that look like a canonical character with
//      a wrong surname or wrong honorific. Pattern: <canonical first_name>
//      <Capitalized-Word(s)> where the full form is NOT in the canonical's
//      allowed variants. Catches "Lucia Santos-Martinez" / "Lucia Moretti" /
//      "Mason Briggs Jr." class drift.
//
//   3. Unknown person mentions — capitalized name-like tokens that don't
//      match any canonical and aren't in the common-non-person exclusion
//      list. Two regexes:
//        - Honorific + Name(s):  Pastor Williams, Mrs. Chen, Justice Brennan
//        - Bare bigram Name(s):  Maria Rodriguez, Lucia Maria Morales
//
// All three classes write into the same per-character / unknown_characters
// data structures the prior LLM pipeline produced, so the aggregator and
// persist nodes don't need to change.
//
// Performance: O(chapter_chars × roster_size) per chapter. ~50ms total for
// the 7-chapter Invisible Wall scan vs ~5 minutes for the LLM version.
// Bounded by chapter size; works for chapters of any length.

const ctx = $input.first().json;
const roster = ctx.outline_characters || [];
const chapters = ctx.chapters || [];
// Optional per-project exclusion list lives at outline._scanner_exclusions
// (string[]). Lets the user mark "Roosevelt Elementary" or "Maple Avenue" as
// known non-person without us hardcoding any story-specific names in the algo.
const projectExclusions = new Set(
  (Array.isArray(ctx.scanner_exclusions) ? ctx.scanner_exclusions : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.toLowerCase())
);

// ---- Helpers ----
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[.,;:"!?]/g, ' ')
    .replace(/[^a-z0-9'\s-]/g, '')
    .replace(/'s\b/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

// Genre-agnostic honorifics. Add to this set rather than enumerating
// genre-specific titles in regex patterns elsewhere.
const HONORIFICS = new Set([
  // civilian titles
  'mr','mrs','ms','miss','mx','sir','madam','madame','master','mistress','mister',
  // medical / academic
  'dr','doctor','professor','prof','dean','provost','nurse',
  // law enforcement / investigative
  'agent','officer','detective','inspector','marshal','warden',
  // military rank
  'sergeant','sgt','captain','cpt','lieutenant','lt','colonel','col',
  'general','gen','major','maj','admiral','adm','commander','cmdr',
  'corporal','cpl','private','pvt','ensign','commodore','brigadier',
  'fleet','rear','vice',
  // religious / clergy
  'father','mother','sister','brother','pastor','rev','reverend',
  'rabbi','imam','monsignor','bishop','archbishop','cardinal',
  'priest','priestess','monk','nun','abbot','abbess','deacon','prelate',
  // judiciary / authority
  'judge','justice','chancellor','magistrate',
  // workplace / organisational titles
  'supervisor','director','manager','chief','commissioner','secretary',
  'president','vice-president','vp','treasurer','administrator',
  // legislative / political (fixes Senator-as-first-name bug)
  'senator','representative','rep','congressman','congresswoman',
  'councilman','councilwoman','councillor','councilor','mayor','governor',
  'minister','ambassador','delegate','deputy','premier','chairman','chairwoman',
  // royalty / nobility (covers fantasy + historical)
  'king','queen','prince','princess','duke','duchess','lord','lady','dame',
  'baron','baroness','count','countess','viscount','viscountess',
  'earl','marquis','marquise','marquess','tsar','sultan','emperor','empress',
  'pharaoh','khan','rajah','rani',
  // fantasy / mystic / sci-fi titles
  'elder','sage','mage','wizard','witch','warlock','sorcerer','sorceress',
  'oracle','seer','high','grand','arch',
]);
function stripHonorifics(toks) {
  let i = 0;
  while (i < toks.length && HONORIFICS.has(toks[i])) i++;
  return toks.slice(i);
}

// SHAPE-BASED non-person filter — works for ANY book/genre. We deliberately
// avoid enumerating story-specific names (Pastor Williams, Mrs. Chen, etc.)
// or story-specific places (Roosevelt Elementary, Maple Avenue) — those would
// only help the test corpus and silently mis-handle the next book.
//
// Two layers:
//  1. NON_PERSON_PATTERNS — true universals: calendar, articles, very common
//     government/legal acronyms, US states, generic constitutional terms.
//  2. SHAPE_RULES — structural heuristics that apply to any string:
//       - place suffix (X Avenue, X Street, X High School, X Hospital, …)
//       - institution suffix (X University, X College, X Department, …)
//       - bureaucratic label (any phrase containing words like Section, Form,
//         Priority, Phase, Code, Rate, Score, Matrix, Protocol, Assessment,
//         Enforcement, Operations, Compliance, Status, Quota, Report,
//         Procedure, Implementation, Optimization, Coordination, Planning,
//         Identification, Distribution, Analysis, Reauthorization, …)
//       - "The X" / "A X" + non-person continuation
//       - newline-spanning phrase (paragraph artifacts)
//
// Story-specific exclusions belong on the project itself
// (writing_projects_v2.outline._scanner_exclusions: string[]) — handled below
// via projectExclusions if present in the input context.

const NON_PERSON_PATTERNS = [
  // Calendar — universal
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i,
  /^(January|February|March|April|May|June|July|August|September|October|November|December)$/i,
  /^(Spring|Summer|Autumn|Fall|Winter)$/i,

  // National / geo demonyms — universal
  /^(United States|US|USA|UK|EU|UN|NATO|America|Americans?|Briton|British|Canadian|Mexican|European|African|Asian|Latino|Hispanic)$/i,

  // US states (universal)
  /^(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia)$/i,

  // Cardinal directions
  /^(North|South|East|West|Northeast|Northwest|Southeast|Southwest|Central)$/i,

  // Common government / legal / org acronyms (>= 3 caps, allow trailing digits)
  /^[A-Z]{2,5}\d{0,3}$/,

  // Generic constitutional / case-law universals
  /^(The\s+)?(Constitution|Bill of Rights|Supreme Court|Court of Appeals|Grand Jury|Habeas Corpus|Due Process|Equal Protection|Magna Carta|Universal Declaration|Geneva Convention|Bill\s+of\s+Rights|Civil War|World War (I|II|One|Two|1|2)|Cold War|Civil Rights( Movement)?)$/i,
  /^(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth|Fourteenth|Fifteenth|Nineteenth|Twentieth|Twenty-First|Twenty-Sixth)\s+Amendments?$/i,

  // Form-field labels: "Form X" / "Section N" / "Article N" / "Chapter N"
  /^(Form|Section|Article|Chapter|Subsection|Subpart|Paragraph|Clause|Title|Volume|Part|Annex|Appendix|Schedule|Exhibit|Subchapter)\s+[A-Z0-9-]+$/i,

  // Single-token articles / connectives / pronouns
  /^(I|We|Us|You|He|She|It|They|Them|The|A|An|This|That|These|Those|Then|And|Or|But|For|However|Meanwhile|Yet|So|Yes|No|Maybe|Perhaps|Today|Tomorrow|Yesterday|Now|Later|Soon|Sometimes|Always|Never)$/,
];

// Token-level "this is a label/header word" set — if the phrase contains
// one of these AND is short, it is almost certainly a bureaucratic header,
// not a person.
const HEADER_TOKENS = new Set([
  // bureaucratic shape words
  'section','form','code','statute','title','article','chapter','schedule','exhibit',
  'rate','score','matrix','protocol','assessment','enforcement','operations',
  'operation','compliance','status','priority','tier','phase','quota','report',
  'reporting','procedure','implementation','optimization','coordination','planning',
  'identification','distribution','analysis','reauthorization','classification',
  'level','category','group','class','type','rank','metric','target','threshold',
  'directive','instruction','memorandum','policy','regulation','registry',
  'index','docket','manifest','log','ledger','roster','review',
  'timeline','workflow','pipeline','process',
  'volume','count','unit','units','intake','outflow','throughput',
  'criteria','factor','factors','requirements','specifications','standards',
  // form-field role words (for "Subject Name", "Detainee File", "Witness Statement", etc.)
  'name','subject','dependent','defendant','plaintiff','witness','suspect','inmate',
  'detainee','case','file','record','sequence','statement','declaration','affidavit',
  // legal universals
  'clause','amendment','preamble','statute','treaty','charter','convention',
  'doctrine','precedent','jurisdiction','custody','proceedings','proceeding',
  'hearing','trial','arraignment','indictment','sentencing','conviction',
  'appeal','remand','injunction','warrant','subpoena','litigation',
  // generic government / law-enforcement nouns
  'patrol','enforcement','surveillance','detention','deportation','removal',
  'arrest','interrogation','interview','interrogate','custody','precinct',
  'borough','county','district','region','province','territory','prefecture',
  // generic bureaucratic / corporate body words
  'state','nation','republic','federation','union','league','consortium',
  'workdays','workday','workweek','overtime','workforce','employee','headcount',
  'available','allocation','budget','allotment','quota','baseline','benchmark',
  // generic action-noun verbs that surface in form titles
  'identifying','harboring','processing','reporting','planning','filing',
  // demonyms / nationality adjectives — typically used as descriptors, not names
  'americans','briton','british','canadian','mexican','european','african','asian',
  'latino','latina','hispanic','russian','chinese','japanese','korean','indian',
  'german','french','italian','spanish','portuguese','brazilian','australian',
  'egyptian','israeli','palestinian','iranian','iraqi','syrian','turkish','greek',
  'polish','dutch','swedish','irish','scottish','welsh','american',
  // place suffixes (also used by SHAPE)
  'avenue','street','road','boulevard','court','lane','drive','way','place',
  'parkway','highway','expressway','turnpike','plaza','square','crescent',
  'terrace','mews','alley','crossroads',
  // institution / building suffixes (genre-agnostic — covers fantasy guilds,
  // sci-fi councils, political committees, religious chapels, etc.)
  'school','elementary','middle','high','college','university','academy',
  'institute','hospital','clinic','library','museum','park','stadium',
  'arena','complex','tower','building','center','centre','department',
  'agency','bureau','commission','council','councilman','committee','board',
  'authority','corporation','foundation','association','society','union',
  'federation','ministry','church','temple','mosque','synagogue','cathedral',
  'chapel','conclave','guild','order','league','alliance','syndicate','cabal',
  'collective','consortium','company','corp','co','llc','ltd','inc',
]);

// Tokens that look like calendar/direction/cardinal — frequently appear in
// story-specific report labels.
const FLAGGED_LEFTMOST = new Set([
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'january','february','march','april','may','june','july','august',
  'september','october','november','december',
  'north','south','east','west','northeast','northwest','southeast','southwest',
]);

function isLikelyNonPerson(s, projectExclusions) {
  // Per-project explicit exclusion list (if the user has populated
  // outline._scanner_exclusions, we honour it without enumerating story names
  // here in code). Case-insensitive exact match on the trimmed surface form.
  if (projectExclusions && projectExclusions.size && projectExclusions.has(s.toLowerCase())) return true;

  // Newline in the surface form = paragraph artifact, never a person.
  if (/\n/.test(s)) return true;

  const stripped = s.replace(/^(The|A|An)\s+/i, '');
  for (const p of NON_PERSON_PATTERNS) {
    if (p.test(s) || p.test(stripped)) return true;
  }

  const lower = stripped.toLowerCase();
  const toks = lower.split(/[\s,\-]+/).filter(Boolean);
  if (toks.length === 0) return true;

  // SHAPE: any token is a known header/place/institution suffix → non-person.
  // We require the matched token to NOT be the first one (a real surname like
  // "Schedule" alone could exist, but "Master Schedule" or "Reporting Schedule"
  // is bureaucratic). For safety, only fire when the phrase is short.
  if (toks.length <= 5) {
    for (let i = 0; i < toks.length; i++) {
      if (HEADER_TOKENS.has(toks[i])) {
        // Avoid filtering "Justice Williams" where 'justice' is canonical honorific
        // — that's already handled by HONORIFICS strip in the matcher. Here we
        // just fire on any header token presence in a short phrase.
        return true;
      }
    }
  }

  // SHAPE: starts with a calendar/direction word (e.g. "Thursday Network",
  // "Monday Morning", "North Star") — almost always a label, not a person.
  if (FLAGGED_LEFTMOST.has(toks[0])) return true;

  // SHAPE: phrase ends in "Operation X", "Phase X", "Project X" (proper noun
  // tail after a label root) — same as header tokens above, just left-side.
  if (toks.length >= 2 && /^(operation|phase|project|task|mission|initiative|case)$/i.test(toks[0])) return true;

  // SHAPE: "The <Word>" / "The <Two words>" where the remainder isn't a
  // canonical character — common family/group/concept reference like
  // "The Constitution" (caught by patterns), "The Gonzalez", "The Tract",
  // "The Privilege". We only fire when the leading article was stripped
  // (i.e. raw form started with "The "/"A ") and the remainder is short.
  if (/^(The|A|An)\s+/i.test(s) && toks.length <= 2) return true;

  // SHAPE: starts with "The/A" + a non-canonical noun + a single suffix.
  // The Constitution / The Court / The Tract / The October — handled above
  // through specific patterns. Keep this only as a fallback for "The <Noun>"
  // when the Noun is a single token and very common (lowercased dictionary
  // lookup not available here without external data, so we skip).

  return false;
}

// Build canonical metadata, including allowed_variants set.
const canonicals = roster.map((c) => {
  const fullName = c.name_format || c.name || '';
  const declared = Array.isArray(c.name_variants) ? c.name_variants : [];
  const fullToks = stripHonorifics(tokens(fullName));
  const allowedSet = new Set();
  for (const v of declared) {
    const vt = stripHonorifics(tokens(v));
    if (vt.length) allowedSet.add(vt.join(' '));
  }
  if (fullToks.length) allowedSet.add(fullToks.join(' '));
  if (fullToks[0]) allowedSet.add(fullToks[0]);
  // Bare surname is also an allowed reference form when it exists.
  // ("Reyes" for "Captain Vael Reyes", "Briggs" for "Mason Briggs", etc.)
  if (fullToks.length > 1) allowedSet.add(fullToks[fullToks.length - 1]);
  return {
    name: c.name,
    name_format: fullName,
    role: c.role || null,
    age: c.age != null ? c.age : null,
    description: c.description || '',
    first_name: fullToks[0] || null,
    surname: fullToks.length > 1 ? fullToks[fullToks.length - 1] : null,
    full_tokens: fullToks,
    declared_variants: declared,
    allowed_set: allowedSet,
  };
});

// Compute which surnames are unique across canonicals (so a bare surname
// can be safely attributed). Briggs is shared between Mason and Craig and
// Darla — bare "Briggs" is ambiguous and won't be auto-attributed.
const surnameOwners = new Map();
for (const c of canonicals) {
  if (!c.surname) continue;
  surnameOwners.set(c.surname, (surnameOwners.get(c.surname) || []).concat(c));
}
const uniqueSurnameToOwner = new Map();
for (const [sn, owners] of surnameOwners.entries()) {
  if (owners.length === 1) uniqueSurnameToOwner.set(sn, owners[0]);
}

const firstNameOwners = new Map();
for (const c of canonicals) {
  if (!c.first_name) continue;
  firstNameOwners.set(c.first_name, (firstNameOwners.get(c.first_name) || []).concat(c));
}
const uniqueFirstNameToOwner = new Map();
for (const [fn, owners] of firstNameOwners.entries()) {
  if (owners.length === 1) uniqueFirstNameToOwner.set(fn, owners[0]);
}

// ---- Per-character output state ----
const perChar = canonicals.map((c) => ({
  name: c.name,
  name_format: c.name_format,
  role: c.role,
  age: c.age,
  total_mentions: 0,
  mentions_by_chapter: {},
  variants_used: {},
  variants_used_by_chapter: {},
  drift_flags: [],
}));
const charByName = new Map(perChar.map((c) => [c.name, c]));

const unknownCharacters = new Map();
const SAMPLE_CTX_PER_VARIANT_PER_CHAPTER = 3; // cap sample contexts to avoid noise

function recordCanonicalMatch(canonical, variantSurfaceForm, chapter, position, contextStr) {
  const c = charByName.get(canonical.name);
  if (!c) return;
  c.total_mentions += 1;
  c.mentions_by_chapter[chapter] = (c.mentions_by_chapter[chapter] || 0) + 1;
  c.variants_used[variantSurfaceForm] = (c.variants_used[variantSurfaceForm] || 0) + 1;
  const vbc = (c.variants_used_by_chapter[chapter] = c.variants_used_by_chapter[chapter] || {});
  vbc[variantSurfaceForm] = (vbc[variantSurfaceForm] || 0) + 1;
}

function recordDriftFlag(canonical, surfaceForm, chapterNumber, chapterTitle, contextStr) {
  const c = charByName.get(canonical.name);
  if (!c) return;
  // Cap drift flags per (variant, chapter) to keep the report manageable
  const key = `forbid:${surfaceForm}:${chapterNumber}`;
  const existing = c.drift_flags.filter((f) => f.type === 'forbidden_variant' && f.variant === surfaceForm && f.chapter_number === chapterNumber);
  if (existing.length >= SAMPLE_CTX_PER_VARIANT_PER_CHAPTER) return;
  c.drift_flags.push({
    type: 'forbidden_variant',
    variant: surfaceForm,
    chapter_number: chapterNumber,
    chapter_title: chapterTitle,
    context: contextStr,
    severity: 'high',
    suggested_action: 'rewrite_chapter_or_expand_canon',
  });
}

function recordUnknown(surfaceForm, chapterNumber, contextStr) {
  const u = unknownCharacters.get(surfaceForm) || {
    variant: surfaceForm,
    total: 0,
    mentions_by_chapter: {},
    sample_contexts: [],
  };
  u.total += 1;
  u.mentions_by_chapter[chapterNumber] = (u.mentions_by_chapter[chapterNumber] || 0) + 1;
  if (u.sample_contexts.length < 3) {
    u.sample_contexts.push({ chapter_number: chapterNumber, context: contextStr });
  }
  unknownCharacters.set(surfaceForm, u);
}

function getContext(text, pos, len, radius) {
  const r = radius != null ? radius : 50;
  const start = Math.max(0, pos - r);
  const end = Math.min(text.length, pos + len + r);
  return text.substring(start, end).replace(/\s+/g, ' ').trim();
}

// ---- Per-chapter scan ----
let total_mentions_scanned = 0;
const matchedRanges = []; // for masking before unknown pass

for (const ch of chapters) {
  const text = ch.content_text || '';
  const cn = ch.chapter_number;
  const ct = ch.title || '';
  const matchedThisChapter = []; // [start, end] pairs

  // Shared mask: all phases check isFree before claiming a span.
  const consumed = new Uint8Array(text.length);
  function isFree(start, end) {
    for (let i = start; i < end; i++) if (consumed[i]) return false;
    return true;
  }
  function consume(start, end) {
    for (let i = start; i < end; i++) consumed[i] = 1;
  }

  // PHASE 0 (runs before Phase 1 so it claims spans first): reverse-order drift —
  // case-file form `<Surname>, <canonical first>`. Catches the Ch5 miss
  // ("Case #2851: Rodriguez, Elena") that Phase 2 (forward-only) doesn't see.
  //
  // CRITICAL: only match in CASE-FILE-SHAPED contexts. A naked `<Word>, <First>`
  // regex over-fires on every sentence transition ("...her careful English,
  // Mason found...", "Instead, Mason thinks...", "Downstairs, Craig stood...").
  // Real case-file/list form is preceded within ~30 chars by a structural
  // anchor: a numeric case label, a "Name:" / "Subject:" / "Defendant:" /
  // "Dependent:" / "Suspect:" / "File:" form-field tag, or a list bullet/colon
  // that implies a row of records. We require one of these anchors immediately
  // before the surname token, on the same line.
  const REVERSE_ANCHORS = [
    // Form-field role word followed by colon: "Subject:", "Defendant Name:",
    // "Dependent Name:", "Detainee:", "Case #2851:", "File:", "Record:", etc.
    /(?:Case|File|Record|Subject|Suspect|Defendant|Dependent|Inmate|Employee|Patient|Plaintiff|Witness|Detainee)\s*(?:Name)?\s*#?\s*\d*\s*:\s*$/i,
    // Bare "Name:" at end of prefix
    /\bName\s*:\s*$/i,
    // Alias / Aka labels
    /\bAlias(?:es)?\s*:\s*$/i,
    /\bA\.?K\.?A\.?\s*:?\s*$/i,
    // Numeric label like "#2851:", "#1.", "#3 -"
    /\#\d+\s*[:.-]\s*$/,
    // Note: deliberately NO start-of-line anchor — paragraph breaks like
    // "\n\nDownstairs, Craig..." are NOT case-file form. Real list rows are
    // identified only by an explicit form-field/colon/numeric anchor.
  ];
  function hasReverseAnchorBefore(pos) {
    // Read up to 60 chars back, stopping at a newline. If anything in that
    // window matches a structural anchor regex, accept.
    const start = Math.max(0, pos - 60);
    let prefix = text.substring(start, pos);
    const nl = prefix.lastIndexOf('\n');
    if (nl >= 0) prefix = prefix.substring(nl + 1);
    for (const re of REVERSE_ANCHORS) if (re.test(prefix)) return true;
    return false;
  }
  for (const c of canonicals) {
    if (!c.first_name) continue;
    const fnCap = c.first_name.charAt(0).toUpperCase() + c.first_name.slice(1);
    const reCommaRev = new RegExp('([A-Z][a-z]+(?:[- ][A-Z][a-z]+)?),\\s*' + escapeRegex(fnCap) + '(?:\\s+([A-Z][a-z]+(?:[- ][A-Z][a-z]+)?))?\\b', 'g');
    let m;
    while ((m = reCommaRev.exec(text)) !== null) {
      const surnameSeen = (m[1] || '').toLowerCase();
      if (surnameSeen === c.surname) continue; // canonical list form, not drift
      if (uniqueSurnameToOwner.has(surnameSeen)) {
        const owner = uniqueSurnameToOwner.get(surnameSeen);
        if (owner.first_name !== c.first_name) continue; // surname owned by someone else
      }
      // Discriminator: must be in a case-file-shaped context.
      if (!hasReverseAnchorBefore(m.index)) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (!isFree(start, end)) continue;
      consume(start, end);
      const surfaceForm = m[0];
      const ctxStr = getContext(text, start, m[0].length, 80);
      recordCanonicalMatch(c, surfaceForm, cn, start, ctxStr);
      total_mentions_scanned += 1;
      const charObj = charByName.get(c.name);
      if (charObj) {
        charObj.drift_flags.push({
          type: 'reverse_order_drift',
          variant: surfaceForm,
          chapter_number: cn,
          chapter_title: ct,
          context: ctxStr,
          severity: 'high',
          suggested_action: 'rewrite_to_canonical_surname',
          note: 'Surname-first/comma form using non-canonical surname for ' + c.name_format,
        });
      }
    }
  }

  // PHASE 1: canonical matches.
  // For each canonical, search ALL its declared/implicit variants. Sort
  // patterns longest-first so "Lucia Morales" wins over "Lucia" at the
  // same position (we mask consumed ranges to prevent double-counting).

  // Build search patterns per canonical, longest-first.
  const allPatterns = [];
  for (const c of canonicals) {
    const seen = new Set();
    function addPattern(surface) {
      if (!surface) return;
      const key = surface;
      if (seen.has(key)) return;
      seen.add(key);
      allPatterns.push({
        canonical: c,
        surface,
        len: surface.length,
      });
    }
    // Declared variants
    for (const v of c.declared_variants) addPattern(v);
    // Canonical full name
    if (c.name_format) addPattern(c.name_format);
    // Bare first-name
    if (c.first_name) addPattern(c.first_name.charAt(0).toUpperCase() + c.first_name.slice(1));
    // Bare surname (only if uniquely owned)
    if (c.surname && uniqueSurnameToOwner.has(c.surname)) {
      addPattern(c.surname.charAt(0).toUpperCase() + c.surname.slice(1));
    }
  }
  // Sort longest first so multi-token forms win over single tokens.
  allPatterns.sort((a, b) => b.len - a.len);

  // Possessive variants are appended on the fly.
  for (const p of allPatterns) {
    const re = new RegExp('\\b' + escapeRegex(p.surface) + '(?:\\u2019s|\'s)?\\b', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!isFree(start, end)) continue;
      consume(start, end);
      const surfaceForm = m[0].replace(/’s$|'s$/, ''); // canonicalise possessive
      const ctxStr = getContext(text, start, m[0].length, 40);
      // Check if this surface form is in the canonical's allowed variants.
      const tokKey = stripHonorifics(tokens(surfaceForm)).join(' ');
      const allowed = p.canonical.allowed_set.has(tokKey);
      recordCanonicalMatch(p.canonical, surfaceForm, cn, start, ctxStr);
      total_mentions_scanned += 1;
      if (!allowed) {
        recordDriftFlag(p.canonical, surfaceForm, cn, ct, ctxStr);
      }
    }
  }

  // PHASE 2: drift candidates — `<canonical first_name> <Capitalized words>`
  // where the resulting full form is NOT in the canonical's allowed set
  // AND has not already been consumed by Phase 1 (which would mean it IS
  // an allowed variant). Catches "Lucia Santos-Martinez", "Mason Briggs Jr.".
  for (const c of canonicals) {
    if (!c.first_name) continue;
    const fnCap = c.first_name.charAt(0).toUpperCase() + c.first_name.slice(1);
    const re = new RegExp('\\b' + escapeRegex(fnCap) + '\\s+([A-Z][a-z]+(?:[- ][A-Z][a-z]+)*)\\b', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!isFree(start, end)) continue;
      const surfaceForm = m[0];
      const tokKey = stripHonorifics(tokens(surfaceForm)).join(' ');
      if (c.allowed_set.has(tokKey)) continue; // already canonical
      consume(start, end);
      const ctxStr = getContext(text, start, m[0].length, 40);
      recordCanonicalMatch(c, surfaceForm, cn, start, ctxStr);
      total_mentions_scanned += 1;
      recordDriftFlag(c, surfaceForm, cn, ct, ctxStr);
    }
  }

  // PHASE 3: unknown person mentions in remaining (un-consumed) text.
  // Two patterns:
  //   (a) Honorific + Name(s):  "Pastor Williams", "Mrs. Chen", "Agent Martinez"
  //   (b) Bare two-or-more capitalized name-like tokens
  // Build honorificRe from the HONORIFICS set so additions stay in sync.
  const honorificAlt = [...HONORIFICS]
    .map((h) => h.charAt(0).toUpperCase() + h.slice(1))
    .map((h) => escapeRegex(h))
    .sort((a, b) => b.length - a.length) // longest-first to avoid prefix swallow
    .join('|');
  const honorificRe = new RegExp('\\b(?:' + honorificAlt + ')\\.?\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2}\\b', 'g');
  const bareNameRe = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g;

  function scanUnknown(re, kind) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!isFree(start, end)) continue;
      const surface = m[0];
      // Skip non-person matches (shape-based + per-project exclusions)
      if (isLikelyNonPerson(surface, projectExclusions)) { consume(start, end); continue; }
      // Skip if any token is the canonical first/last name we already track
      // (this means the regex caught a canonical mention with extra words —
      // safer to ignore for unknown pass; Phase 2 already caught the drift).
      const t = stripHonorifics(tokens(surface));
      if (t.some((tok) => uniqueFirstNameToOwner.has(tok) || uniqueSurnameToOwner.has(tok))) continue;
      consume(start, end);
      const ctxStr = getContext(text, start, m[0].length, 40);
      recordUnknown(surface, cn, ctxStr);
      total_mentions_scanned += 1;
    }
  }
  scanUnknown(honorificRe, 'honorific');
  scanUnknown(bareNameRe, 'bare');
}

// Variant-inconsistency drift flag (cross-chapter) — same character used
// with multiple distinct surnames anywhere in the book. Only consider
// FORWARD-ORDER variants (first-name leads, surname trails) so we don't
// double-flag the comma-form variants that already produced a
// reverse_order_drift entry. We identify forward-order by requiring the
// first token to match the canonical's first_name.
for (let i = 0; i < perChar.length; i++) {
  const c = perChar[i];
  const canon = canonicals[i]; // parallel arrays
  const variantList = Object.keys(c.variants_used);
  const distinctSurnames = new Set();
  for (const v of variantList) {
    const vt = stripHonorifics(tokens(v));
    if (vt.length < 2) continue;
    if (canon.first_name && vt[0] !== canon.first_name) continue; // skip reverse/comma forms
    const sn = vt[vt.length - 1];
    if (sn) distinctSurnames.add(sn);
  }
  if (distinctSurnames.size > 1) {
    c.drift_flags.push({
      type: 'variant_inconsistency',
      variants: variantList,
      distinct_surnames: [...distinctSurnames],
      severity: 'medium',
      suggested_action: 'pick_canonical_surname',
    });
  }
}

const unknown = [...unknownCharacters.values()].sort((a, b) => b.total - a.total);

const stats = {
  scanned_at: new Date().toISOString(),
  scanner_algorithm: 'deterministic-regex-v4',
  scanned_chapter_count: chapters.length,
  parse_failures: 0, // not applicable to deterministic algorithm
  total_mentions_scanned,
  characters_with_drift: perChar.filter((c) => c.drift_flags.length > 0).length,
  unknown_character_count: unknown.length,
  total_drift_flags: perChar.reduce((s, c) => s + c.drift_flags.length, 0),
};

return [{
  json: {
    user_id: ctx.user_id,
    project_title: ctx.project_title,
    project_id: ctx.project_id,
    character_drift_scan: {
      ...stats,
      characters: perChar,
      unknown_characters: unknown,
    },
  },
}];
"""

# --------------------------------------------------------------------
# Legacy LLM-based extraction code retained as constants but no longer wired
# into the workflow graph. Kept for reference if we want to A/B against the
# deterministic algorithm later.

SPLIT_CHAPTERS_CODE = r"""// LEGACY (unused) — see SCAN_CHAPTERS_DETERMINISTIC_CODE for the live impl.
// S12-12.2 — fan out one item per chapter so the chainLlm node runs
// once per chapter. Each emitted item carries the chapter prose + the
// outline character roster so the per-chapter prompt has everything
// it needs.

const ctx = $input.first().json;
const items = [];
for (const ch of ctx.chapters) {
  // Build the per-chapter extraction prompt inline so chainLlm just
  // pipes $json.extract_prompt through.
  const rosterLines = ctx.outline_characters.map((c) => {
    const nf = c.name_format || c.name;
    const role = c.role ? ` [${c.role}]` : '';
    const age = c.age != null ? ` age ${c.age}` : '';
    return `- ${nf}${role}${age}`;
  }).join('\n');

  const promptText =
    'You are scanning a single chapter for every named-person reference. Extract a structured list of mentions.\n\n' +
    '# OUTLINE CHARACTER ROSTER (canonical names)\n' +
    (rosterLines || '_(empty)_') + '\n\n' +
    '# YOUR TASK\n' +
    'For every named-person reference in the chapter prose below, emit a compact JSON object:\n' +
    '  - v: the EXACT surface form used in the prose (e.g. "Lucia Morales", "Lucia", "Mrs. Morales", "the Santos-Martinez file")\n' +
    '  - c: 30-50 chars of surrounding prose containing the variant — JUST enough to disambiguate which character is meant. Be terse; long context wastes output budget.\n' +
    '\n' +
    'Use the SHORT keys "v" and "c" (not "variant"/"context") to keep the output compact.\n' +
    'Include every variant occurrence, not just the first. If "Lucia" appears 12 times, emit 12 entries.\n' +
    'Skip generic noun references ("his father", "the agent", "the girl") and pronouns. Only emit when an actual NAMED form appears in the prose.\n' +
    'Skip historical/cited figures who are not characters in the story (e.g. "Justice Brennan" cited in a textbook).\n' +
    '\n' +
    '# OUTPUT — return ONLY valid JSON, no markdown fences\n' +
    '{\n' +
    '  "chapter_number": ' + JSON.stringify(ch.chapter_number) + ',\n' +
    '  "chapter_title": ' + JSON.stringify(ch.title || '') + ',\n' +
    '  "mentions": [\n' +
    '    {"v": "<exact surface form>", "c": "<surrounding 30-50 chars>"},\n' +
    '    ...\n' +
    '  ]\n' +
    '}\n\n' +
    '# JSON QUOTING\n' +
    'Replace any double quotes inside string values with single quotes, OR escape with backslash. Never leave an unescaped " inside a string value.\n\n' +
    '# CHAPTER PROSE\n\n' +
    ch.content_text;

  items.push({
    json: {
      chapter_number: ch.chapter_number,
      chapter_id: ch.id,
      chapter_title: ch.title || '',
      extract_prompt: promptText,
    },
  });
}
return items;
"""

PARSE_PER_CHAPTER_CODE = r"""// S12-12.2 — parse each per-chapter Claude extraction. Defensive:
// strip code fences, attempt repair if the JSON has unescaped internal
// quotes (same trick as S12-11). Outputs one item per chapter with
// chapter_number + mentions[].

const llmOut = $input.all();
const orig = $('split_chapters').all();

function tryRepair(s) {
  let out = '', i = 0, inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (!inStr) { out += c; if (c === '"') inStr = true; i++; continue; }
    if (c === '\\') { out += c + (s[i+1] || ''); i += 2; continue; }
    if (c === '"') {
      let j = i + 1; while (j < s.length && /\s/.test(s[j])) j++;
      const next = s[j] || '';
      if (next === ',' || next === '}' || next === ']' || next === ':') { out += c; inStr = false; i++; continue; }
      out += '\\"'; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const results = [];
for (let i = 0; i < llmOut.length; i++) {
  const item = llmOut[i].json;
  const meta = orig[i] ? orig[i].json : {};
  const raw = (item.text || item.output || item.response || '').toString();
  let inner = raw.trim();
  const fence = inner.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  if (fence) inner = fence[1].trim();
  let parsed = null;
  try {
    parsed = JSON.parse(inner);
  } catch (e1) {
    try {
      parsed = JSON.parse(tryRepair(inner));
    } catch (e2) {
      const m = inner.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(tryRepair(m[0])); } catch (e3) {}
      }
    }
  }
  // Normalise compact {v,c} -> {variant,context} so downstream code keeps
  // the same shape it always read.
  let mentions = (parsed && Array.isArray(parsed.mentions)) ? parsed.mentions : [];
  mentions = mentions.map((m) => ({
    variant: m.v != null ? m.v : m.variant,
    context: m.c != null ? m.c : m.context,
  })).filter((m) => m.variant);
  results.push({
    json: {
      chapter_number: meta.chapter_number,
      chapter_id: meta.chapter_id,
      chapter_title: meta.chapter_title,
      mentions,
      _parse_failed: parsed === null,
    },
  });
}
return results;
"""

AGGREGATE_DRIFT_CODE = r"""// S12-12.2 — aggregate per-chapter mentions into per-character totals,
// match variants to canonical characters, compute drift flags.

const perChapter = $input.all().map((x) => x.json);
const ctx = $('load_project').first().json;
const roster = ctx.outline_characters || [];

// Build canonical lookup helpers.
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx',
  'dr', 'doctor',
  'agent', 'officer', 'detective', 'sergeant', 'sgt', 'captain', 'cpt',
  'lieutenant', 'lt', 'colonel', 'col', 'general', 'gen', 'major', 'maj',
  'father', 'mother', 'sister', 'brother', 'pastor', 'rev', 'reverend',
  'rabbi', 'imam', 'monsignor', 'bishop',
  'professor', 'prof',
  'judge', 'justice',
  'supervisor', 'director', 'manager', 'chief', 'commissioner', 'secretary',
]);

function tokens(s) {
  return (s || '').toLowerCase()
    .replace(/[.,;:"!?]/g, ' ')           // punctuation -> space
    .replace(/[^a-z0-9'\s-]/g, '')        // strip non-name chars
    .replace(/'s\b/g, '')                 // possessive: "lucia's" -> "lucia"
    .split(/\s+/)
    .filter(Boolean);
}

function stripHonorifics(toks) {
  // Drop leading honorifics so "Pastor Williams" matches "Williams" canonical.
  let i = 0;
  while (i < toks.length && HONORIFICS.has(toks[i])) i++;
  return toks.slice(i);
}

const canonicals = roster.map((c) => {
  const fullName = c.name_format || c.name || '';
  const toks = stripHonorifics(tokens(fullName));
  // Allowed variants from outline (S12-12 canon extension). Also include the
  // canonical name_format and the bare first-name as implicit allowed forms.
  const declared = Array.isArray(c.name_variants) ? c.name_variants : [];
  const allowedSet = new Set();
  for (const v of declared) {
    const vt = stripHonorifics(tokens(v));
    if (vt.length) allowedSet.add(vt.join(' '));
  }
  if (toks.length) allowedSet.add(toks.join(' '));
  if (toks[0]) allowedSet.add(toks[0]);
  return {
    name: c.name,
    name_format: c.name_format || c.name,
    role: c.role || null,
    age: c.age != null ? c.age : null,
    description: c.description || '',
    surname: toks.length > 1 ? toks[toks.length - 1] : null,
    first_name: toks.length > 0 ? toks[0] : null,
    full_tokens: toks,
    allowed_variants: [...allowedSet],
    declared_variants: declared,
  };
});

// Helper: does a variant token list match a canonical's full token set
// (first + last name, any order, allowing extra middle tokens)?
function fullNameMatch(vToks, canonical) {
  if (!canonical.first_name || !canonical.surname) return false;
  return vToks.includes(canonical.first_name) && vToks.includes(canonical.surname);
}

function matchToCanonical(variant) {
  const rawToks = tokens(variant);
  if (rawToks.length === 0) return null;
  const vToks = stripHonorifics(rawToks);
  if (vToks.length === 0) return null;

  // 1. Full name match (first + surname both present) — strongest, prevents
  //    "Craig Briggs" from being matched to Mason Briggs by surname collision.
  const fullMatches = canonicals.filter((c) => fullNameMatch(vToks, c));
  if (fullMatches.length === 1) return fullMatches[0];
  if (fullMatches.length > 1) return null; // ambiguous — leave as unknown

  // 2. Declared name_variants exact match (after honorific strip + possessive strip).
  const vKey = vToks.join(' ');
  for (const c of canonicals) {
    if (c.allowed_variants.includes(vKey)) return c;
  }

  // 3. Surname-only match — but ONLY if the surname is unique across canonicals.
  if (vToks.length === 1) {
    const tok = vToks[0];
    const surnameMatches = canonicals.filter((c) => c.surname === tok);
    if (surnameMatches.length === 1) return surnameMatches[0];
    if (surnameMatches.length > 1) return null; // ambiguous (Briggs ambiguity)
    const firstNameMatches = canonicals.filter((c) => c.first_name === tok);
    if (firstNameMatches.length === 1) return firstNameMatches[0];
    return null;
  }

  // 4. Multi-token variant whose surname is unique (e.g. "Maria Morales" if
  //    only one canonical has surname Morales — but this is risky if multiple).
  const lastTok = vToks[vToks.length - 1];
  const surnameMatches2 = canonicals.filter((c) => c.surname === lastTok);
  if (surnameMatches2.length === 1) return surnameMatches2[0];

  return null;
}

function isAllowedVariant(variant, canonical) {
  if (!canonical) return true; // unknown character handled separately
  const rawToks = tokens(variant);
  const vToks = stripHonorifics(rawToks);
  if (vToks.length === 0) return true;
  const vKey = vToks.join(' ');
  // Honorific-stripped exact match against declared/implicit allowed list
  if (canonical.allowed_variants.includes(vKey)) return true;
  // Bare-honorific match: "Mr." alone shouldn't pass; but if rawToks had honorifics
  // and vToks is empty, we already returned true above — fine.
  return false;
}

// Build per-character stats.
const perChar = canonicals.map((c) => ({
  name: c.name,
  name_format: c.name_format,
  role: c.role,
  age: c.age,
  total_mentions: 0,
  mentions_by_chapter: {},
  variants_used: {},
  variants_used_by_chapter: {},
  drift_flags: [],
}));
const charByName = new Map(perChar.map((c) => [c.name, c]));

const unknownCharacters = new Map(); // variant -> { variant, mentions_by_chapter, total }

for (const ch of perChapter) {
  const cn = ch.chapter_number;
  for (const m of (ch.mentions || [])) {
    const variant = (m.variant || '').trim();
    if (!variant || variant.length < 2) continue;
    const canonical = matchToCanonical(variant);
    if (canonical) {
      const c = charByName.get(canonical.name);
      c.total_mentions += 1;
      c.mentions_by_chapter[cn] = (c.mentions_by_chapter[cn] || 0) + 1;
      c.variants_used[variant] = (c.variants_used[variant] || 0) + 1;
      const vbc = (c.variants_used_by_chapter[cn] = c.variants_used_by_chapter[cn] || {});
      vbc[variant] = (vbc[variant] || 0) + 1;
      if (!isAllowedVariant(variant, canonical)) {
        c.drift_flags.push({
          type: 'forbidden_variant',
          variant,
          chapter_number: cn,
          chapter_title: ch.chapter_title,
          context: m.context || '',
          severity: 'high',
          suggested_action: 'rewrite_chapter_or_expand_canon',
        });
      }
    } else {
      const u = unknownCharacters.get(variant) || {
        variant,
        total: 0,
        mentions_by_chapter: {},
        sample_contexts: [],
      };
      u.total += 1;
      u.mentions_by_chapter[cn] = (u.mentions_by_chapter[cn] || 0) + 1;
      if (u.sample_contexts.length < 3) u.sample_contexts.push({ chapter_number: cn, context: m.context || '' });
      unknownCharacters.set(variant, u);
    }
  }
}

// Variant-inconsistency flag: if a single character has 3+ distinct variants
// AND any pair has different "surname tokens", flag for review.
for (const c of perChar) {
  const variantList = Object.keys(c.variants_used);
  if (variantList.length >= 2) {
    // Collect distinct non-bare-first-name variants
    const nonFirst = variantList.filter((v) => {
      const vt = tokens(v);
      return vt.length > 1;
    });
    const distinctSurnames = new Set();
    for (const v of nonFirst) {
      const vt = tokens(v);
      const sn = vt[vt.length - 1];
      if (sn) distinctSurnames.add(sn);
    }
    if (distinctSurnames.size > 1) {
      c.drift_flags.push({
        type: 'variant_inconsistency',
        variants: variantList,
        distinct_surnames: [...distinctSurnames],
        severity: 'medium',
        suggested_action: 'pick_canonical_surname',
      });
    }
  }
}

const unknown = [...unknownCharacters.values()].sort((a, b) => b.total - a.total);

const stats = {
  scanned_at: new Date().toISOString(),
  scanned_chapter_count: perChapter.length,
  parse_failures: perChapter.filter((c) => c._parse_failed).length,
  total_mentions_scanned: perChar.reduce((s, c) => s + c.total_mentions, 0)
    + unknown.reduce((s, u) => s + u.total, 0),
  characters_with_drift: perChar.filter((c) => c.drift_flags.length > 0).length,
  unknown_character_count: unknown.length,
  total_drift_flags: perChar.reduce((s, c) => s + c.drift_flags.length, 0),
};

return [{
  json: {
    user_id: ctx.user_id,
    project_title: ctx.project_title,
    project_id: ctx.project_id,
    character_drift_scan: {
      ...stats,
      characters: perChar,
      unknown_characters: unknown,
    },
  },
}];
"""

PERSIST_AND_RETURN_CODE = r"""// S12-12.2 — persist scan into writing_projects_v2.outline._character_drift_scan.
// (writing_projects_v2 is a base table with no metadata column — outline is
// the existing JSONB blob; underscore prefix signals "tool metadata, not
// narrative content" and Build Chapter Context skips underscore-prefixed keys.)

const ctx = $input.first().json;
const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = {
  apikey: apiKey,
  Authorization: 'Bearer ' + apiKey,
  'Content-Type': 'application/json',
};

try {
  const cur = await this.helpers.httpRequest({
    method: 'GET',
    url: supabaseUrl + '/rest/v1/writing_projects_v2?id=eq.' + encodeURIComponent(ctx.project_id) + '&select=outline',
    headers,
  });
  const curOutline = (Array.isArray(cur) && cur[0] && cur[0].outline) ? cur[0].outline : {};
  const newOutline = { ...curOutline, _character_drift_scan: ctx.character_drift_scan };
  await this.helpers.httpRequest({
    method: 'PATCH',
    url: supabaseUrl + '/rest/v1/writing_projects_v2?id=eq.' + encodeURIComponent(ctx.project_id),
    headers,
    body: JSON.stringify({ outline: newOutline }),
  });
} catch (e) {
  return [{ json: {
    error: 'persist_failed: ' + e.message,
    project_id: ctx.project_id,
    character_drift_scan: ctx.character_drift_scan,
  } }];
}

const s = ctx.character_drift_scan;
return [{
  json: {
    project_id: ctx.project_id,
    project_title: ctx.project_title,
    scanned_chapter_count: s.scanned_chapter_count,
    total_mentions_scanned: s.total_mentions_scanned,
    characters_with_drift: s.characters_with_drift,
    total_drift_flags: s.total_drift_flags,
    unknown_character_count: s.unknown_character_count,
    parse_failures: s.parse_failures,
  },
}];
"""


def build_workflow_body() -> dict:
    supabase_key = os.environ["DEV_SUPABASE_SERVICE_ROLE_KEY"]
    # anthropic_cred_id no longer used — deterministic algorithm has no LLM step.
    # Kept env-var-checking optional in main() for backward compatibility.

    nodes = [
        {
            "parameters": {
                "workflowInputs": {
                    "values": [
                        {"name": "user_id", "type": "string"},
                        {"name": "project_title", "type": "string"},
                    ],
                },
            },
            "id": "trig",
            "name": "workflow_trigger",
            "type": "n8n-nodes-base.executeWorkflowTrigger",
            "typeVersion": 1.1,
            "position": [0, 0],
        },
        {
            "parameters": {
                "assignments": {
                    "assignments": [
                        {"id": "u", "name": "SUPABASE_URL", "value": DEV_SUPABASE_URL, "type": "string"},
                        {"id": "k", "name": "SUPABASE_API_KEY", "value": supabase_key, "type": "string"},
                    ],
                },
                "options": {},
            },
            "id": "set",
            "name": "settings",
            "type": "n8n-nodes-base.set",
            "typeVersion": 3.4,
            "position": [220, 0],
        },
        {
            "parameters": {"jsCode": LOAD_PROJECT_CODE},
            "id": "load",
            "name": "load_project",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, 0],
        },
        {
            "parameters": {"jsCode": SCAN_CHAPTERS_DETERMINISTIC_CODE},
            "id": "scan",
            "name": "scan_chapters",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [660, 0],
        },
        {
            "parameters": {"jsCode": PERSIST_AND_RETURN_CODE},
            "id": "persist",
            "name": "persist_and_return",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [880, 0],
        },
    ]

    connections = {
        "workflow_trigger": {"main": [[{"node": "settings", "type": "main", "index": 0}]]},
        "settings": {"main": [[{"node": "load_project", "type": "main", "index": 0}]]},
        "load_project": {"main": [[{"node": "scan_chapters", "type": "main", "index": 0}]]},
        "scan_chapters": {"main": [[{"node": "persist_and_return", "type": "main", "index": 0}]]},
    }

    return {
        "name": WORKFLOW_NAME,
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }


def main() -> int:
    # Deterministic algorithm — Anthropic credential no longer required.
    for var in ("DEV_SUPABASE_SERVICE_ROLE_KEY",):
        if not os.environ.get(var):
            print(f"{var} not set", file=sys.stderr)
            return 2

    body = build_workflow_body()
    existing = find_existing_by_name(WORKFLOW_NAME)
    if existing:
        print(f"Updating existing workflow {existing}...")
        try:
            api("POST", f"/workflows/{existing}/deactivate")
        except HTTPError as e:
            print(f"  deactivate returned {e.code}, continuing with PUT")
        api("PUT", f"/workflows/{existing}", clean_put_body(body))
        try:
            api("POST", f"/workflows/{existing}/activate")
        except HTTPError as e:
            print(f"  activate returned {e.code}; may already be active")
        wf_id = existing
    else:
        print("Creating new workflow...")
        created = api("POST", "/workflows", body)
        wf_id = created["id"]
        api("POST", f"/workflows/{wf_id}/activate")

    print(f"{WORKFLOW_NAME}: {wf_id} (active)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
