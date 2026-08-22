// PODCAST FLOW. The staged sheet's podcast road, exercised through the real
// store rather than mounting the component. See restore.test.ts's own header
// for why this runs fine under Node/vitest: no browser, no mock of the
// storage layer itself, just the localStorage-fallback backend store/index.ts
// picks when IndexedDB is not present.
//
// NewProjectSheet.tsx's create() does exactly two calls when `flow` is
// 'podcast':
//   store.createProject(buildPodcastProjectConfig(draft))
//   store.createSlate(project.id, PODCAST_SLATE_NAME)
// This test runs that same sequence directly and reads the result back,
// pinning the two guarantees the podcast road has to keep from
// startPodcastRoll: mode 'podcast' and a slate named "Recording".

import { describe, expect, it } from 'vitest';
import { store } from '../store';
import { PODCAST_SLATE_NAME } from './newRoll';
import { buildPodcastProjectConfig, emptyDraft, newSoundDraft, setUnit, type ProjectDraft } from './projectdraft';
import { getDefaultTags } from './tagdefaults';

function podcastDraft(over: Partial<ProjectDraft> = {}): ProjectDraft {
  return { ...emptyDraft(getDefaultTags('podcast')), name: 'Podcast 23 Aug 09.14', ...over };
}

describe('a Podcast project made through the staged flow', () => {
  it('carries mode: podcast, podcast tags, and a slate named Recording', async () => {
    const config = buildPodcastProjectConfig(podcastDraft({ sound: newSoundDraft() }));
    const project = await store.createProject(config);
    const slate = await store.createSlate(project.id, PODCAST_SLATE_NAME);

    expect(project.mode).toBe('podcast');
    expect(project.tags).toEqual(getDefaultTags('podcast'));
    expect(slate.name).toBe('Recording');
    expect(slate.projectId).toBe(project.id);

    // Every recording piles onto this one slate. A fresh podcast project
    // should never quietly need a scene picker to start rolling.
    const slates = await store.listSlates(project.id);
    expect(slates).toHaveLength(1);
    expect(slates[0].id).toBe(slate.id);
  });

  it('carries the cameras and sound the flow actually decided, not hardcoded defaults', async () => {
    let draft = podcastDraft();
    draft = setUnit(draft, 0, { camera: 'red', operator: 'Priya', startNumber: '12' });
    draft = { ...draft, sound: { recorder: 'MixPre-6', operator: 'Kirtan', filePrefix: 'ZOOM_' } };

    const project = await store.createProject(buildPodcastProjectConfig(draft));

    expect(project.mode).toBe('podcast');
    expect(project.camera).toBe('red');
    expect(project.nextClipNumber).toBe(12);
    expect(project.sound).toMatchObject({ recorder: 'MixPre-6', operator: 'Kirtan', filePrefix: 'ZOOM_' });
  });

  it('is a video project (mode absent) when built without buildPodcastProjectConfig', async () => {
    // The control: the same draft shape, run through the plain build, must
    // NOT carry a podcast marker. Otherwise this whole test proves nothing.
    const { buildProjectConfig } = await import('./projectdraft');
    const project = await store.createProject(buildProjectConfig(podcastDraft()));
    expect(project.mode).toBeUndefined();
  });
});
