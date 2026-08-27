// PINS THE OWNER'S RULE, VERBATIM: "we never stop a paid user from rolling" -
// and, read the other way round, nothing on set may ever stop ANY user from
// rolling. Not a free-tier counter, not a time limit, not an unresolved
// entitlements read. The wall is at export (gateExport, net/quota.ts), never
// at record.
//
// Two different kinds of proof, because the rule under test is an ABSENCE:
//
//   1. BEHAVIOUR: a take starts and finishes with ZERO account state - no
//      session, no entitlements fetch, no Supabase call of any kind - because
//      the store layer this test drives is exactly what RollingScreen.tsx
//      calls at ROLL and CUT (store.createTake). Same pattern as
//      podcastFlow.test.ts's own header: the real store under Node, no mock
//      of the storage layer, because store/local.ts's `persist()` already
//      guards `if (!ls) return` (see that file) rather than needing a
//      MemoryStorage shim here.
//
//   2. STRUCTURE: RollingScreen.tsx's own import list never names the export
//      wall. A predicate test can only pin logic that exists; there IS no
//      blocking logic on the roll path to extract one from - the regression
//      this guards against is someone adding one. Reading the source and
//      asserting the import never appears is the direct way to make that
//      change fail a test instead of shipping silently.

import { describe, expect, it } from 'vitest';
import { store } from '../store';
import { buildProjectConfig, emptyDraft } from './projectdraft';
import { getDefaultTags } from './tagdefaults';
// Vite's `?raw` suffix (declared by the `vite/client` triple-slash reference
// in vite-env.d.ts) hands back the file's own source text as a string - no
// node:fs, which this project carries no @types/node for (see tsconfig.json:
// no "types" entry, no node builtin used anywhere else in src/). Reading the
// SOURCE rather than importing the component also means this file never
// pulls in React or a DOM, which vitest here deliberately never sets up.
import rollingScreenSource from './RollingScreen.tsx?raw';

describe('a take starts and finishes with zero account state', () => {
  it('rolls and cuts on a fresh project with no session, no entitlements read, ever', async () => {
    // Nothing here touches supabase, quota.ts or useEntitlements - this is the
    // exact shape ROLL (openMultiTake/soloRoll) and CUT (closeMultiTake) drive
    // in RollingScreen.tsx, minus the React state around it.
    const config = buildProjectConfig(emptyDraft(getDefaultTags('video')));
    const project = await store.createProject(config);
    const slate = await store.createSlate(project.id, 'Scene 1');

    const startedAt = Date.now();
    const take = await store.createTake({
      slateId: slate.id,
      projectId: project.id,
      startedAt,
      durationMs: 4200,
    });

    expect(take.slateId).toBe(slate.id);
    expect(take.durationMs).toBe(4200);
    expect(take.number).toBe(1);

    // A SECOND take on the same scene, same story: still nothing to consult,
    // still nothing to refuse. This is what "never blocked, however many
    // takes" actually means in code.
    const second = await store.createTake({
      slateId: slate.id,
      projectId: project.id,
      startedAt: startedAt + 10_000,
      durationMs: 1500,
    });
    expect(second.number).toBe(2);

    const logged = await store.listTakes(slate.id);
    expect(logged.map((t) => t.number)).toEqual([1, 2]);
  });
});

describe('RollingScreen.tsx never imports the export wall', () => {
  it('names none of net/quota, useEntitlements, or gateExport in its own imports', () => {
    expect(rollingScreenSource).not.toMatch(/from ['"]\.\.\/net\/quota['"]/);
    expect(rollingScreenSource).not.toMatch(/from ['"]\.\/useEntitlements['"]/);
    expect(rollingScreenSource).not.toContain('gateExport');
    expect(rollingScreenSource).not.toContain('getEntitlements');
  });
});
