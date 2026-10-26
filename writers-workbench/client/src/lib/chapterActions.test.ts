import { describe, it, expect, vi } from 'vitest';
import { startChapterAction } from './chapterActions';
import { apiFetch } from './api';

vi.mock('./api', () => ({ apiFetch: vi.fn(async () => ({ success: true, jobId: 'job-9' })) }));

describe('startChapterAction', () => {
  it('posts the action and the notes by id, and returns the engine job id', async () => {
    expect(await startChapterAction('p1', 4, 'outline', '  Open on the spring. ')).toBe('job-9');
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/projects/p1/chapters/4/engine', {
      method: 'POST',
      body: JSON.stringify({ action: 'outline', notes: 'Open on the spring.' }),
    });
  });

  it('sends no notes field when there are none', async () => {
    await startChapterAction('p1', 0, 'write', '   ');
    expect(vi.mocked(apiFetch).mock.calls.at(-1)![1]).toEqual({ method: 'POST', body: JSON.stringify({ action: 'write' }) });
  });
});
