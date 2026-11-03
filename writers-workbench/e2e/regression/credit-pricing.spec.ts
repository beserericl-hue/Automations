import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';
import { HAS_DEV_KEYS, balanceOf, cleanupFreshUsers, makeFreshUser, seedChapter, setBalance, userApi, type FreshUser } from '../pages/fresh-user';

/**
 * Credit pricing (owner decisions 2026-11-03) — RESULT-asserting, against DEV, as a NON-admin user
 * (a fresh trial user, so credits are really checked). Heavy (Pass B): starts real engine jobs, which
 * are aborted as soon as the charge is asserted.
 *
 * PASS
 *   - Q/A, repair and humanize charge their price (4; humanize per started 100 words) and the balance
 *     drops by exactly that, with one ledger row each;
 *   - chat is charged by the op the engine ROUTED to: a plain answer costs the chat rate, a revise
 *     costs a revise — the response names the op(s) and the balance moves by their price, once;
 *   - a brainstorm from chat costs the same as one from the Brainstorm screen;
 *   - short of credits: Q/A answers 402 and nothing starts; a routed chat op that is unaffordable is
 *     answered 402 and its job aborted.
 */
const DEFAULTS: Record<string, number> = {
  qa_chapter: 4, repair_chapter: 4, humanize_passage: 4, chat_generic: 0, revise_outline: 3, brainstorm_story: 3, brainstorm: 3,
  research: 2, write_chapter: 5, create_project: 0, list_outlines: 0, retrieve_content: 0,
};
const ALIAS: Record<string, string> = {
  'chapter.qa': 'qa_chapter', 'chapter.repair': 'repair_chapter', 'brainstorm.revise-outline': 'revise_outline', 'brainstorm.edit-outline': 'revise_outline',
  'brainstorm.story': 'brainstorm_story', 'brainstorm.short-story': 'brainstorm', 'brainstorm.create-project': 'create_project', 'research.run': 'research',
  'chapter.write': 'write_chapter', chat_generic: 'chat_generic', 'library.list-outlines': 'list_outlines', 'library.retrieve': 'retrieve_content',
};

/** Prices as DEV is configured (a superuser override, else the code default). */
async function prices(): Promise<(key: string) => number> {
  const rows = await supaGet<{ value: string }>('app_config_global_v2', 'key=eq.sprint8_superuser_config&select=value');
  let overrides: Record<string, number> = {};
  try {
    const v = rows[0]?.value;
    overrides = ((typeof v === 'string' ? JSON.parse(v) : v)?.credit_costs ?? {}) as Record<string, number>;
  } catch { /* defaults */ }
  return (op: string) => {
    const key = ALIAS[op] ?? op;
    return overrides[key] ?? DEFAULTS[key] ?? 0;
  };
}

const jobs: Array<{ user: FreshUser; id: string }> = [];
async function abortLater(user: FreshUser, id: unknown) {
  if (id) jobs.push({ user, id: String(id) });
}

test.describe('Credit pricing on DEV (non-admin user)', () => {
  test.skip(!HAS_DEV_KEYS, 'needs the DEV service and anon keys');
  test.setTimeout(10 * 60_000);

  test('Q/A, repair and humanize are charged their price, once', async () => {
    const price = await prices();
    const user = await makeFreshUser('pricing');
    const { contentId } = await seedChapter(user);

    let before = await balanceOf(user.userId);
    const qa = await userApi(user, 'POST', `/api/content/${contentId}/run-qa`);
    expect(qa.status, JSON.stringify(qa.json)).toBe(202);
    await abortLater(user, qa.json.jobId);
    expect(qa.json.creditsCharged).toBe(price('qa_chapter'));
    expect(await balanceOf(user.userId)).toBe(before - price('qa_chapter'));

    before = await balanceOf(user.userId);
    const repair = await userApi(user, 'POST', `/api/content/${contentId}/repair`);
    expect(repair.status, JSON.stringify(repair.json)).toBe(202);
    await abortLater(user, repair.json.jobId);
    expect(repair.json.creditsCharged).toBe(price('repair_chapter'));
    expect(await balanceOf(user.userId)).toBe(before - price('repair_chapter'));

    before = await balanceOf(user.userId);
    const passage = 'Behind her the town burned low. Ahead the flats shone white and empty.';
    const hum = await userApi(user, 'POST', `/api/content/${contentId}/humanize`, { text: passage });
    expect(hum.status, JSON.stringify(hum.json)).toBe(200);
    const expected = hum.json.data.skipped ? 0 : price('humanize_passage'); // one unit: under 100 words
    expect(hum.json.data.credits_charged).toBe(expected);
    expect(await balanceOf(user.userId)).toBe(before - expected);

    const usage = await supaGet<{ amount: number; description: string }>('credit_transactions',
      `user_id=eq.${encodeURIComponent(user.userId)}&transaction_type=eq.usage&select=amount,description&order=created_at.asc`);
    expect(usage.map((u) => u.description)).toEqual([
      'content.run-qa:qa_chapter', 'content.repair:repair_chapter',
      ...(expected ? ['content.humanize:humanize_passage x1'] : []),
    ]);
  });

  test('chat is charged by the routed op: a plain answer vs a revise', async () => {
    const price = await prices();
    const user = await makeFreshUser('pricing-chat');
    const { projectId } = await seedChapter(user);
    const [project] = await supaGet<{ title: string }>('writing_projects_v2', `id=eq.${projectId}&select=title`);

    let before = await balanceOf(user.userId);
    const plain = await userApi(user, 'POST', '/api/chat/proxy', { user_message_request: 'In one sentence, what is a story arc?', user_id: user.userId });
    expect(plain.status, JSON.stringify(plain.json).slice(0, 300)).toBe(200);
    expect(plain.json.chargedOps).toEqual(['chat_generic']);
    expect(plain.json.creditsCharged).toBe(price('chat_generic'));
    expect(await balanceOf(user.userId)).toBe(before - price('chat_generic'));

    before = await balanceOf(user.userId);
    const revise = await userApi(user, 'POST', '/api/chat/proxy', {
      user_message_request: `Revise the outline of "${project.title}": make chapter 1 end on a cliffhanger at the river.`,
      user_id: user.userId, project_id: projectId, project_title: project.title,
    });
    expect(revise.status, JSON.stringify(revise.json).slice(0, 300)).toBe(200);
    await abortLater(user, revise.json.jobId);
    const ops = revise.json.chargedOps as string[];
    expect(ops.some((o) => /revise-outline|edit-outline/.test(o)), `routed to ${ops.join(',')}`).toBe(true);
    const cost = ops.reduce((n, o) => n + price(o), 0);
    expect(revise.json.creditsCharged).toBe(cost);
    expect(await balanceOf(user.userId)).toBe(before - cost);
    expect(cost).toBeGreaterThan(price('chat_generic'));
  });

  test('a brainstorm from chat costs what the Brainstorm screen costs', async () => {
    const price = await prices();
    const user = await makeFreshUser('pricing-brainstorm');

    let before = await balanceOf(user.userId);
    const screen = await userApi(user, 'POST', '/api/brainstorm/submit', {
      title: `Parity Screen ${Date.now().toString(36)}`, genre_slug: 'post-apocalyptic', story_arc: 'Three-Act Structure',
      content_text: 'A salt-flat courier carries the last clean water between two dying towns.', target_chapter_count: 3,
    });
    expect(screen.status, JSON.stringify(screen.json)).toBe(200);
    await abortLater(user, screen.json.jobId);
    expect(screen.json.creditsCharged).toBe(price('brainstorm_story'));
    expect(await balanceOf(user.userId)).toBe(before - price('brainstorm_story'));

    before = await balanceOf(user.userId);
    const chat = await userApi(user, 'POST', '/api/chat/proxy', {
      user_message_request: 'Brainstorm a new post-apocalyptic book called "Parity Chat" about a courier carrying water across salt flats.',
      user_id: user.userId,
    });
    expect(chat.status).toBe(200);
    await abortLater(user, chat.json.jobId);
    for (const id of (chat.json.jobIds ?? []) as string[]) await abortLater(user, id);
    const ops = chat.json.chargedOps as string[];
    expect(ops, `routed to ${ops.join(',')}`).toContain('brainstorm.story');
    expect(chat.json.creditsCharged).toBe(screen.json.creditsCharged);
    expect(await balanceOf(user.userId)).toBe(before - chat.json.creditsCharged);
  });

  test('short of credits: 402 before anything starts; an unaffordable routed chat op is aborted', async () => {
    const price = await prices();
    const user = await makeFreshUser('pricing-402');
    const { contentId, projectId } = await seedChapter(user);
    await setBalance(user.userId, price('qa_chapter') - 1);

    const qa = await userApi(user, 'POST', `/api/content/${contentId}/run-qa`);
    expect(qa.status).toBe(402);
    expect(qa.json.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', creditsRequired: price('qa_chapter') });
    expect(await balanceOf(user.userId)).toBe(price('qa_chapter') - 1);

    const write = await userApi(user, 'POST', '/api/chat/proxy', { user_message_request: 'Write chapter 1 of this book now.', user_id: user.userId, project_id: projectId });
    if (write.status === 402) {
      expect(write.json.error.code).toBe('INSUFFICIENT_CREDITS');
      expect(await balanceOf(user.userId)).toBe(price('qa_chapter') - 1);
    } else {
      // The router chose an op that fits the balance: it must have been charged what it costs.
      const ops = write.json.chargedOps as string[];
      await abortLater(user, write.json.jobId);
      expect(write.json.creditsCharged).toBe(ops.reduce((n, o) => n + price(o), 0));
      expect(write.json.creditsCharged).toBeLessThanOrEqual(price('qa_chapter') - 1);
    }
  });
});

test.afterAll(async () => {
  test.setTimeout(3 * 60_000);
  for (const j of jobs) await userApi(j.user, 'POST', `/api/jobs/engine/${j.id}/abort`).catch(() => undefined);
  // Give aborted jobs a moment to stop before their user is deleted.
  await new Promise((r) => setTimeout(r, 15_000));
  await cleanupFreshUsers();
});
