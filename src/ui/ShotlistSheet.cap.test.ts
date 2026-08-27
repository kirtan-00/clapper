// PROVES THE OWNER'S CORRECTION. His own words, verbatim: "shot division
// uplaod is gated." He was right, and the audit that missed it filed the
// old behaviour under "blocks a convenience import, not recording" - wrong,
// because on a set the shot division IS how you roll. This file pins the
// fix, and the one fact that matters most alongside it: getting to the
// point of rolling is never blocked, and the money wall (export) still is.
//
// Two things, pinned together:
//   1. An account over its free Script Mode project limit uploads a shot
//      division, and the upload SUCCEEDS - every scene and shot imports,
//      every take on it rolls. Only the AI-written key-moment chips are
//      missing.
//   2. That exact project - reached this way, never unlocked - still
//      refuses PDF and Premiere export. Ungating the upload must never
//      accidentally ungate the money.
//
// enrichShotMoments (breakdown.ts) is mocked at the module boundary. Its
// own job - turning the breakdown edge function's 402/quota_exceeded answer
// into Error('CAP') - is read straight off its source (src/ui/breakdown.ts,
// the `if (status === 402 || reason === 'quota_exceeded') throw new
// Error('CAP');` line) rather than re-executed here: exercising it for real
// needs a live Cloudflare Turnstile widget, which needs a DOM this suite
// does not have (see CONTEXT.md's own note on vitest running DOM-less).
// What THIS file pins is what ShotlistSheet.tsx does with a CAP once
// received, and separately, whether a project reached that way can still
// export - both fully reachable without a DOM.
//
// decideExport / decideProjectAccess (supabase/functions/_shared/gate.ts)
// are the SAME pure decision functions src/net/gate.test.ts already pins
// against every tier - not reimplemented here, reused, because they are the
// direct mirror of the live claim_project_access SQL and export-gate logic
// this fix never touches.

import { describe, expect, it, vi } from 'vitest';
import { store } from '../store';
import { EXAMPLE_PACKS, importScriptPack, type ScriptPack } from './scriptpack';
import { decideExport, decideProjectAccess, type ProAccess } from '../../supabase/functions/_shared/gate.ts';

vi.mock('./breakdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./breakdown')>();
  return { ...actual, enrichShotMoments: vi.fn() };
});

import { enrichShotMoments } from './breakdown';
import { enrichOrDegrade } from './ShotlistSheet';

const enrichMock = vi.mocked(enrichShotMoments);

// A free account, over its FREE_PROJECT_LIMIT, no credits spent on this
// project. Exactly the state the whole point of this file is about.
const OVER_LIMIT: ProAccess = { isPro: false, proUntil: null };

function samplePack(): ScriptPack {
  // Bundled: no server, no account, no network - the same fixture the "or
  // try an example" row in ShotlistSheet.tsx hands to onPack directly. A
  // real PDF parse would build the identical shape via shotlistToPack.
  return EXAMPLE_PACKS[0].pack;
}

describe('enrichOrDegrade: a CAP no longer blocks the upload', () => {
  it('hands back the ENRICHED pack when the server grants chips', async () => {
    const parsed = samplePack();
    const enriched: ScriptPack = { ...parsed, project: { ...parsed.project } };
    enrichMock.mockResolvedValueOnce(enriched);

    const result = await enrichOrDegrade(parsed, 'doc.pdf');

    expect(result).toEqual({ pack: enriched, note: null });
  });

  it('THE FIX: a CAP refusal still hands back the parsed pack, not an exception', async () => {
    const parsed = samplePack();
    enrichMock.mockRejectedValueOnce(new Error('CAP'));

    const result = await enrichOrDegrade(parsed, 'doc.pdf');

    // The upload SUCCEEDS. Same scenes and shots the on-device parser
    // already read - nothing about them changes because the server said no
    // to a bonus.
    expect(result.pack).toBe(parsed);
    expect(result.pack.scenes.length).toBeGreaterThan(0);
    // Informed, never stopped: a plain line naming what happens next, no
    // "upgrade now" marketing.
    expect(result.note).toContain('roll now');
    expect(result.note).toContain('Unlock this project');
  });

  it('any OTHER refusal (sign-in required, a genuine server error) is not swallowed - untouched by this fix', async () => {
    const parsed = samplePack();
    class Boom extends Error {}
    enrichMock.mockRejectedValueOnce(new Boom('not a CAP'));

    await expect(enrichOrDegrade(parsed, 'doc.pdf')).rejects.toThrow(Boom);
  });
});

describe('over the limit: the upload succeeds AND every take on it rolls', () => {
  it('imports a full project from an unenriched (CAP-degraded) pack and logs a take', async () => {
    // Stands in for exactly what enrichOrDegrade hands back on CAP: the
    // same on-device parse, no chips. importScriptPack never asks the
    // server anything - see its own source - so this proves the roll half
    // works without a network call of any kind.
    const degraded = samplePack();
    const project = await importScriptPack(degraded, { name: 'Over-limit shoot' });
    expect(project.id).toBeTruthy();

    const slates = await store.listSlates(project.id);
    expect(slates.length).toBe(degraded.scenes.length);

    const take = await store.createTake({
      slateId: slates[0].id,
      projectId: project.id,
      startedAt: Date.now(),
      durationMs: 4000,
    });
    expect(take.number).toBe(1);

    const second = await store.createTake({
      slateId: slates[0].id,
      projectId: project.id,
      startedAt: Date.now() + 10_000,
      durationMs: 1500,
    });
    expect(second.number).toBe(2);
  });
});

describe('THE ONE THAT MATTERS MOST: export still refuses a project reached this way', () => {
  it('a free account, over its project limit, whose upload succeeded, still cannot export PDF or Premiere', () => {
    // The exact state of a project created via the now-fixed CAP path: not
    // pro, never unlocked (this fix never calls unlock_project - see the
    // structural guard below), and this account's free grant is exhausted.
    const accessVerdict = decideProjectAccess({
      isSuspended: false,
      pro: OVER_LIMIT,
      projectUnlocked: false,
      projectFreeGranted: false,
      freeProjectsUsed: 2,
      freeProjectsLimit: 2,
    });
    // Confirms the CAP this account received was a REAL answer: this is
    // the same verdict the live claim_project_access RPC computes for this
    // exact state (see that function's own SQL in
    // supabase/migrations/20260827120000_project_metering.sql) - the
    // server-side cost gate in front of Groq is untouched by this fix.
    expect(accessVerdict).toEqual({ allow: false, reason: 'no_free_projects' });

    const pdf = decideExport({ format: 'pdf', isSuspended: false, pro: OVER_LIMIT, projectUnlocked: false });
    const premiere = decideExport({
      format: 'premiere',
      isSuspended: false,
      pro: OVER_LIMIT,
      projectUnlocked: false,
    });
    const csv = decideExport({ format: 'csv', isSuspended: false, pro: OVER_LIMIT, projectUnlocked: false });

    expect(pdf).toEqual({ allow: false, reason: 'project_locked' });
    expect(premiere).toEqual({ allow: false, reason: 'project_locked' });
    // CSV was always free and stays free - completely unaffected by any of
    // this, on the export side or the upload side.
    expect(csv).toEqual({ allow: true });
  });

  it('STRUCTURAL GUARD: ShotlistSheet.tsx never calls unlock_project or any credit-granting RPC', async () => {
    // A client-side ungate that the server still refuses is one failure
    // mode; a client-side ungate that ALSO quietly unlocks export is worse
    // - it gives the product away with nobody noticing until the money
    // stops. Reading the file's own source, not trusting the diff: this
    // fix touches only how a CAP answer is handled, never anything that
    // could grant an entitlement.
    // `claim_project_access` IS named here, but only in a comment (see
    // read()'s own header) explaining which server-side RPC produced the
    // CAP this file reacts to - never called. The three below are the ones
    // that actually grant an entitlement, and none of them appear at all,
    // comment or code: this file has no path to an unlock.
    const source = (await import('./ShotlistSheet.tsx?raw')).default;
    expect(source).not.toContain('unlock_project');
    expect(source).not.toContain('grant_project_credits');
    expect(source).not.toContain('grant_subscription_invoice_credits');
  });
});
