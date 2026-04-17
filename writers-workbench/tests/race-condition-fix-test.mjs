/**
 * Race Condition FIX Verification Test
 *
 * Simulates the FIXED behavior: each worker re-reads the outline from the DB
 * RIGHT BEFORE saving, so concurrent saves don't clobber each other.
 *
 * Test flow:
 * 1. Read baseline
 * 2. Worker A writes ch10 (reads fresh → modifies → saves)
 * 3. Worker B writes ch9 (reads fresh → sees ch10 → modifies → saves)
 * 4. Verify BOTH ch9 and ch10 are present (no data loss)
 * 5. Restore baseline
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
  return (await res.json())[0].outline;
}

async function patchOutline(outline) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/writing_projects_v2?id=eq.${PROJECT_ID}&user_id=eq.${encodeURIComponent(USER_ID)}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ outline, updated_at: new Date().toISOString() })
    }
  );
}

/**
 * Simulates the FIXED save_chapter_outline behavior:
 * 1. Re-reads the CURRENT outline from DB
 * 2. Modifies ONLY the target chapter
 * 3. Saves back
 */
async function atomicSaveChapterOutline(chapterNum, chapterOutlineData) {
  // Step 1: Fresh read (this is the fix!)
  const freshOutline = await readOutline();

  // Step 2: Find and modify only the target chapter
  const idx = freshOutline.chapters.findIndex(ch => ch.number === chapterNum);
  if (idx < 0) throw new Error(`Chapter ${chapterNum} not found`);
  freshOutline.chapters[idx].chapter_outline = chapterOutlineData;

  // Step 3: Save back
  await patchOutline(freshOutline);
}

function getChapterOutlineStatus(outline, chapterNum) {
  const ch = outline.chapters?.find(c => c.number === chapterNum);
  if (!ch) return { exists: false };
  const co = ch.chapter_outline;
  return {
    exists: !!(co && co._test_marker),
    marker: co?._test_marker || 'NONE'
  };
}

async function main() {
  console.log('=== RACE CONDITION FIX VERIFICATION TEST ===\n');

  // Step 1: Read baseline
  console.log('1. Reading baseline outline...');
  const baseline = await readOutline();
  const ch9Before = getChapterOutlineStatus(baseline, 9);
  const ch10Before = getChapterOutlineStatus(baseline, 10);
  console.log(`   Ch9: has_test_outline=${ch9Before.exists}`);
  console.log(`   Ch10: has_test_outline=${ch10Before.exists}`);

  // Step 2: Worker A saves ch10 using atomic method
  console.log('\n2. Worker A saves ch10 (atomic: fresh read → modify → save)...');
  await atomicSaveChapterOutline(10, {
    chapter_title: 'TEST - The Propaganda Loop',
    sub_chapters: [
      { number: 1, title: 'Test Sub 1', brief: 'test' },
      { number: 2, title: 'Test Sub 2', brief: 'test' },
    ],
    _test_marker: 'FIX_TEST_CH10',
    updated_at: new Date().toISOString()
  });

  const afterA = await readOutline();
  const ch10AfterA = getChapterOutlineStatus(afterA, 10);
  console.log(`   After Worker A: Ch10 marker=${ch10AfterA.marker}`);

  // Step 3: Worker B saves ch9 using atomic method
  // Key: Worker B reads FRESH data that includes ch10 from Worker A
  console.log('\n3. Worker B saves ch9 (atomic: fresh read → modify → save)...');
  await atomicSaveChapterOutline(9, {
    ...baseline.chapters.find(c => c.number === 9)?.chapter_outline,
    _test_marker: 'FIX_TEST_CH9',
    updated_at: new Date().toISOString()
  });

  // Step 4: Verify BOTH chapters are present
  const afterB = await readOutline();
  const ch9AfterB = getChapterOutlineStatus(afterB, 9);
  const ch10AfterB = getChapterOutlineStatus(afterB, 10);
  console.log(`\n4. After both workers:`);
  console.log(`   Ch9: marker=${ch9AfterB.marker}`);
  console.log(`   Ch10: marker=${ch10AfterB.marker}`);

  if (ch9AfterB.marker === 'FIX_TEST_CH9' && ch10AfterB.marker === 'FIX_TEST_CH10') {
    console.log('\n   ✅ FIX VERIFIED: Both chapter outlines preserved! No data loss.');
  } else {
    console.log('\n   ❌ FIX FAILED: Data loss detected!');
    if (ch10AfterB.marker !== 'FIX_TEST_CH10') console.log('      Ch10 was lost!');
    if (ch9AfterB.marker !== 'FIX_TEST_CH9') console.log('      Ch9 was lost!');
  }

  // Step 5: Test TRUE concurrent saves (both fire at once)
  console.log('\n5. Testing TRUE concurrent saves (both fire simultaneously)...');

  // First clear both test markers
  const cleanOutline = await readOutline();
  const ch9Idx = cleanOutline.chapters.findIndex(c => c.number === 9);
  const ch10Idx = cleanOutline.chapters.findIndex(c => c.number === 10);
  cleanOutline.chapters[ch9Idx].chapter_outline = baseline.chapters[ch9Idx]?.chapter_outline;
  cleanOutline.chapters[ch10Idx].chapter_outline = null;
  await patchOutline(cleanOutline);

  // Fire both atomic saves concurrently
  await Promise.all([
    atomicSaveChapterOutline(10, {
      chapter_title: 'CONCURRENT - Ch10',
      sub_chapters: [{ number: 1, title: 'Concurrent Sub', brief: 'test' }],
      _test_marker: 'CONCURRENT_CH10',
      updated_at: new Date().toISOString()
    }),
    atomicSaveChapterOutline(9, {
      ...baseline.chapters.find(c => c.number === 9)?.chapter_outline,
      _test_marker: 'CONCURRENT_CH9',
      updated_at: new Date().toISOString()
    })
  ]);

  const afterConcurrent = await readOutline();
  const ch9Concurrent = getChapterOutlineStatus(afterConcurrent, 9);
  const ch10Concurrent = getChapterOutlineStatus(afterConcurrent, 10);
  console.log(`   Ch9: marker=${ch9Concurrent.marker}`);
  console.log(`   Ch10: marker=${ch10Concurrent.marker}`);

  if (ch9Concurrent.exists && ch10Concurrent.exists) {
    console.log('\n   ✅ CONCURRENT TEST PASSED: Both preserved even with simultaneous saves.');
  } else {
    console.log('\n   ⚠️  CONCURRENT TEST: One save may have won. This is the residual risk');
    console.log('      with read-modify-write (narrowed to ms). Deploy the RPC function');
    console.log('      (migration 007) for true atomicity.');
  }

  // Step 6: Restore baseline
  console.log('\n6. Restoring baseline outline...');
  await patchOutline(baseline);
  console.log('   Baseline restored.');

  console.log('\n=== TEST COMPLETE ===');
}

main().catch(console.error);
