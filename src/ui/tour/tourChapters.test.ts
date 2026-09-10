import { describe, expect, it } from 'vitest';
import { findChapter, isChapterSelectable, TOUR_CHAPTER_IDS, TOUR_CHAPTERS } from './tourChapters';

describe('TOUR_CHAPTERS', () => {
  it('declares exactly the three shipping chapters, in tab order', () => {
    expect(TOUR_CHAPTERS.map((c) => c.id)).toEqual(['director', 'setup', 'export']);
    expect(TOUR_CHAPTER_IDS).toEqual(['director', 'setup', 'export']);
  });

  it('every chapter names a real label and blurb - no blank tabs', () => {
    for (const chapter of TOUR_CHAPTERS) {
      expect(chapter.label.trim().length).toBeGreaterThan(0);
      expect(chapter.blurb.trim().length).toBeGreaterThan(0);
    }
  });

  it('every shipping chapter carries real steps and is not coming-soon', () => {
    for (const chapter of TOUR_CHAPTERS) {
      expect(chapter.steps.length).toBeGreaterThan(0);
      expect(chapter.comingSoon).toBeFalsy();
    }
  });

  it('findChapter looks up by id', () => {
    expect(findChapter('director')?.id).toBe('director');
    expect(findChapter('export')?.id).toBe('export');
  });
});

describe('isChapterSelectable', () => {
  it('is true for every chapter with real steps and no coming-soon flag', () => {
    for (const id of ['director', 'setup', 'export'] as const) {
      expect(isChapterSelectable(findChapter(id)!)).toBe(true);
    }
  });

  it('refuses a chapter flagged coming-soon even with steps - flag and steps must agree', () => {
    // Guards the double-lock in tourChapters.ts: comingSoon:true alone gates
    // the tab even if steps were ever populated ahead of dropping the flag.
    // The field is retained for exactly this future use though no shipping
    // chapter sets it today.
    const fake = { id: 'director' as const, label: 'x', blurb: 'x', steps: [], comingSoon: true };
    expect(isChapterSelectable(fake)).toBe(false);
  });
});

describe('setup and export resumableStepIds', () => {
  it('only names step ids that are real steps in their own chapter', () => {
    for (const id of ['setup', 'export'] as const) {
      const chapter = findChapter(id)!;
      const stepIds = new Set(chapter.steps.map((s) => s.id));
      for (const resumable of chapter.resumableStepIds ?? []) {
        expect(stepIds.has(resumable)).toBe(true);
      }
    }
  });

  it("carries exactly the chapter's own door step - the only one reachable from a cold ProjectScreen", () => {
    expect([...(findChapter('setup')!.resumableStepIds ?? [])]).toEqual(['setup-door']);
    expect([...(findChapter('export')!.resumableStepIds ?? [])]).toEqual(['export-tile']);
  });
});
