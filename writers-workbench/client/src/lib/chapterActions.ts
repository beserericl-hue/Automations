import { apiFetch } from './api';

export type ChapterAction = 'outline' | 'write' | 'rewrite';

/**
 * Outline, write or rewrite one chapter by its ids. The engine job id comes back for the job queue
 * to track. (These used to be chat sentences the router had to reparse, which lost the author's
 * instructions on the way.)
 */
export async function startChapterAction(
  projectId: string,
  chapterNumber: number,
  action: ChapterAction,
  notes: string,
): Promise<string | undefined> {
  const res = await apiFetch<{ jobId?: string }>(`/api/projects/${projectId}/chapters/${chapterNumber}/engine`, {
    method: 'POST',
    body: JSON.stringify({ action, ...(notes.trim() ? { notes: notes.trim() } : {}) }),
  });
  return res.jobId;
}
