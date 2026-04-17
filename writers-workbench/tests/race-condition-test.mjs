/**
 * Race Condition Test for Brainstorm Chapter Outline Saves
 *
 * Proves that concurrent PATCH operations on the outline JSONB column
 * cause last-writer-wins data loss when the entire outline is replaced.
 *
 * Test flow:
 * 1. Read current outline state (baseline)
 * 2. Simulate two concurrent saves: one for ch9, one for ch10
 *    - Both read the outline at "roughly the same time" (before either writes)
 *    - Both write back their modified version
 * 3. Verify that the second write clobbered the first (proving the bug)
 * 4. Restore the outline to baseline
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_ID = process.env.TEST_PROJECT_ID;
const USER_ID = process.env.TEST_USER_ID;

if (!SUPABASE_URL || !SUPABASE_KEY || !PROJECT_ID || !USER_ID) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_PROJECT_ID, TEST_USER_ID');
  process.exit(1);
}

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

const readHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

async function readOutline() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/writing_projects_v2?id=eq.${PROJECT_ID}&user_id=eq.${encodeURIComponent(USER_ID)}&select=outline`,
    { headers: readHeaders }
  );
  const data = await res.json();
  return data[0].outline;
}

async function patchOutline(outline) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/writing_projects_v2?id=eq.${PROJECT_ID}&user_id=eq.${encodeURIComponent(USER_ID)}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ outline, updated_at: new Date().toISOString() })
    }
  );
  return res.ok;
}

function getChapterOutlineStatus(outline, chapterNum) {
  const ch = outline.chapters?.find(c => c.number === chapterNum);
  if (!ch) return { exists: false };
  const co = ch.chapter_outline;
  return {
    exists: !!(co && co.sub_chapters && co.sub_chapters.length > 0),
    subChapterCount: co?.sub_chapters?.length || 0,
    version: co?.version || 'N/A',
    updatedAt: co?.updated_at || 'N/A'
  };
}

async function main() {
  console.log('=== RACE CONDITION TEST ===\n');

  // Step 1: Read baseline
  console.log('1. Reading baseline outline...');
  const baseline = await readOutline();
  const ch9Status = getChapterOutlineStatus(baseline, 9);
  const ch10Status = getChapterOutlineStatus(baseline, 10);
  console.log(`   Ch9: has_outline=${ch9Status.exists}, subs=${ch9Status.subChapterCount}, ver=${ch9Status.version}`);
  console.log(`   Ch10: has_outline=${ch10Status.exists}, subs=${ch10Status.subChapterCount}, ver=${ch10Status.version}`);

  // Step 2: Simulate concurrent reads (both read BEFORE either writes)
  console.log('\n2. Simulating concurrent reads (both workers read stale data)...');
  const workerA_outline = JSON.parse(JSON.stringify(baseline)); // Worker A reads
  const workerB_outline = JSON.parse(JSON.stringify(baseline)); // Worker B reads

  // Worker A modifies ch10 (adds a test outline)
  const ch10Idx = workerA_outline.chapters.findIndex(c => c.number === 10);
  workerA_outline.chapters[ch10Idx].chapter_outline = {
    chapter_title: 'TEST - The Propaganda Loop',
    sub_chapters: [
      { number: 1, title: 'Test Sub 1', brief: 'test' },
      { number: 2, title: 'Test Sub 2', brief: 'test' },
      { number: 3, title: 'Test Sub 3', brief: 'test' }
    ],
    version: 1,
    updated_at: new Date().toISOString(),
    _test_marker: 'RACE_CONDITION_TEST_CH10'
  };

  // Worker B modifies ch9 (re-saves existing outline with a test marker)
  const ch9Idx = workerB_outline.chapters.findIndex(c => c.number === 9);
  const existingCh9 = workerB_outline.chapters[ch9Idx].chapter_outline || {};
  workerB_outline.chapters[ch9Idx].chapter_outline = {
    ...existingCh9,
    version: (existingCh9.version || 0) + 1,
    updated_at: new Date().toISOString(),
    _test_marker: 'RACE_CONDITION_TEST_CH9'
  };

  // Step 3: Worker A saves first (ch10), then Worker B saves (ch9) — B overwrites A
  console.log('\n3. Worker A saves ch10 outline...');
  await patchOutline(workerA_outline);

  // Verify ch10 was saved
  const afterA = await readOutline();
  const ch10AfterA = getChapterOutlineStatus(afterA, 10);
  console.log(`   After Worker A: Ch10 has_outline=${ch10AfterA.exists}, subs=${ch10AfterA.subChapterCount}`);
  console.log(`   Ch10 test marker: ${afterA.chapters[ch10Idx].chapter_outline?._test_marker || 'MISSING'}`);

  console.log('\n4. Worker B saves ch9 outline (with STALE data — no ch10)...');
  await patchOutline(workerB_outline);

  // Step 4: Verify ch10 is GONE (proving the race condition)
  const afterB = await readOutline();
  const ch10AfterB = getChapterOutlineStatus(afterB, 10);
  const ch9AfterB = getChapterOutlineStatus(afterB, 9);
  console.log(`   After Worker B: Ch9 has_outline=${ch9AfterB.exists}, marker=${afterB.chapters[ch9Idx].chapter_outline?._test_marker || 'MISSING'}`);
  console.log(`   After Worker B: Ch10 has_outline=${ch10AfterB.exists}, marker=${afterB.chapters[ch10Idx].chapter_outline?._test_marker || 'MISSING'}`);

  if (!ch10AfterB.exists) {
    console.log('\n   ❌ RACE CONDITION CONFIRMED: Ch10 outline was LOST when Worker B overwrote with stale data!');
  } else {
    console.log('\n   ✅ No race condition detected (unexpected)');
  }

  // Step 5: Restore baseline
  console.log('\n5. Restoring baseline outline...');
  await patchOutline(baseline);
  const restored = await readOutline();
  const ch9Restored = getChapterOutlineStatus(restored, 9);
  const ch10Restored = getChapterOutlineStatus(restored, 10);
  console.log(`   Restored — Ch9: has_outline=${ch9Restored.exists}, Ch10: has_outline=${ch10Restored.exists}`);

  console.log('\n=== TEST COMPLETE ===');
}

main().catch(console.error);
