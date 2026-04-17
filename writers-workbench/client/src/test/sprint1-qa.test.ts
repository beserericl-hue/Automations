import { describe, it, expect } from 'vitest';
import type {
  WritingProject,
  PublishedContent,
  ResearchReport,
  StoryBibleEntry,
  StoryArc,
  TokenUsage,
  ContentVersion,
} from '../types/database';

/**
 * Sprint 1 QA Tests — S1-1: Schema & Type Validation
 *
 * These tests verify that TypeScript types match the expected schema changes
 * from migration 002_sprint1_data_integrity.sql.
 */
describe('S1-1: Schema & Type Validation', () => {
  it('QA: WritingProject has deleted_at field', () => {
    const project: WritingProject = {
      id: 'test-id',
      user_id: '+14105914612',
      project_type: 'novel',
      title: 'Test Project',
      genre_slug: 'scifi-romance',
      status: 'active',
      outline: null,
      chapter_count: 0,
      draft_path: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    expect(project.deleted_at).toBeNull();

    // Verify it accepts a timestamp value too
    const deletedProject: WritingProject = { ...project, deleted_at: new Date().toISOString() };
    expect(deletedProject.deleted_at).toBeTruthy();
  });

  it('QA: PublishedContent has deleted_at field', () => {
    const content: PublishedContent = {
      id: 'test-id',
      user_id: '+14105914612',
      title: 'Test Content',
      content_type: 'chapter',
      genre_slug: null,
      content_text: null,
      storage_path: null,
      cover_image_path: null,
      status: 'draft',
      project_id: null,
      chapter_number: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      published_at: null,
      deleted_at: null,
    };
    expect(content.deleted_at).toBeNull();
  });

  it('QA: ResearchReport has deleted_at field', () => {
    const report: ResearchReport = {
      id: 'test-id',
      user_id: '+14105914612',
      topic: 'Test Topic',
      genre_slug: null,
      content: null,
      status: 'complete',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    expect(report.deleted_at).toBeNull();
  });

  it('QA: StoryBibleEntry has deleted_at field', () => {
    const entry: StoryBibleEntry = {
      id: 'test-id',
      user_id: '+14105914612',
      project_id: 'project-1',
      entry_type: 'character',
      name: 'Test Character',
      description: 'A test character',
      metadata: {},
      chapter_introduced: 1,
      last_chapter_seen: 5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    expect(entry.deleted_at).toBeNull();
  });

  it('QA: StoryArc has discovery_question field', () => {
    const arc: StoryArc = {
      id: 'test-id',
      user_id: null,
      name: "Hero's Journey",
      description: 'The classic hero arc',
      prompt_text: 'Write a story following...',
      discovery_question: 'What call to adventure pulls your hero from their ordinary world?',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(arc.discovery_question).toBeTruthy();

    // Should also accept null
    const arcWithoutQuestion: StoryArc = { ...arc, discovery_question: null };
    expect(arcWithoutQuestion.discovery_question).toBeNull();
  });

  it('QA: TokenUsage type has all required fields', () => {
    const usage: TokenUsage = {
      id: 'test-id',
      user_id: '+14105914612',
      workflow_name: 'write_chapter',
      model: 'claude-sonnet-4-20250514',
      input_tokens: 1000,
      output_tokens: 5000,
      total_tokens: 6000,
      cost_usd: 0.045,
      metadata: { project_id: 'proj-1' },
      created_at: new Date().toISOString(),
    };
    expect(usage.workflow_name).toBe('write_chapter');
    expect(usage.cost_usd).toBe(0.045);
    expect(usage.total_tokens).toBe(6000);
  });

  it('QA: ContentVersion type has fields needed for version history viewer', () => {
    const version: ContentVersion = {
      id: 'test-id',
      user_id: '+14105914612',
      content_id: 'content-1',
      version_number: 3,
      content_text: '<p>Version 3 of the content</p>',
      changed_by: 'web_editor',
      change_note: 'Restored from version 1',
      created_at: new Date().toISOString(),
    };
    expect(version.version_number).toBe(3);
    expect(version.changed_by).toBe('web_editor');
    expect(version.change_note).toContain('Restored');
  });

  it('QA: soft-deleted items have a non-null deleted_at timestamp', () => {
    const deletedProject: WritingProject = {
      id: 'deleted-1',
      user_id: '+14105914612',
      project_type: 'novel',
      title: 'Deleted Project',
      genre_slug: null,
      status: 'active',
      outline: null,
      chapter_count: 5,
      draft_path: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-04-10T00:00:00Z',
      deleted_at: '2026-04-11T12:00:00Z',
    };
    expect(deletedProject.deleted_at).not.toBeNull();
    // A filter for `deleted_at IS NULL` would exclude this record
    const isActive = deletedProject.deleted_at === null;
    expect(isActive).toBe(false);
  });
});
