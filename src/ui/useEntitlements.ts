// A shared, refreshable read of the caller's entitlements - one fetch shared
// by every mounted screen, instead of AccountScreen's private copy from
// before 2026-08-27.
//
// WHY THIS EXISTS. A purchase (ProCta, or the Account pricing table) can be
// made from a screen that is NOT the Account screen - a locked export on
// ProjectScreen, a capped shotlist import. Once the payment verifies, the
// balance has to become visible without asking anyone to pull-to-refresh or
// reload the app. A private `useState` per screen cannot do that: only the
// screen that happened to run the purchase would ever see the new number.
// This module is the fix - one in-memory store, one `refreshEntitlements()`
// any buyer calls after a verified purchase, and every mounted
// `useEntitlements()` re-renders with the new read.
//
// STILL DISPLAY ONLY. This never invents a number - `refreshEntitlements()`
// always re-asks the server via `getEntitlements()` (net/quota.ts). Nothing
// here is a cache of what the client THINKS it bought; it is a cache of what
// the server LAST SAID, invalidated on demand. See pricing.ts's own note on
// why a successful checkout does not synthesize a balance either.
//
// One account at a time, so a single module-level store is enough - the app
// has no concept of two signed-in identities live simultaneously.

import { useEffect, useState } from 'react';
import { getEntitlements, type Entitlements } from '../net/quota';

type Listener = () => void;

let current: Entitlements | null = null;
let hasFetched = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l();
}

async function fetchNow(): Promise<void> {
  // Collapse concurrent callers (a purchase resolving on two screens at
  // once should not fire the same read twice) into the one request already
  // running.
  if (inFlight) return inFlight;
  inFlight = getEntitlements()
    .then((e) => {
      current = e;
      hasFetched = true;
      notify();
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Force a re-read of the signed-in caller's entitlements from the server and
 * update every mounted `useEntitlements()` hook. Call this once a purchase's
 * `PayResult` comes back `ok: true` - see pricing.ts's `usePurchase`.
 */
export function refreshEntitlements(): Promise<void> {
  return fetchNow();
}

/** Drop the cached read, e.g. on sign-out, so a next sign-in never shows a
 *  stale account's numbers for a frame. */
export function clearEntitlements(): void {
  current = null;
  hasFetched = false;
  notify();
}

export interface EntitlementsState {
  entitlements: Entitlements | null;
  /** False until the first read (for this mount of `signedIn`) has settled -
   *  distinct from `entitlements === null`, which is also the honest state
   *  for "signed out" or "the row could not be read". */
  loaded: boolean;
}

/**
 * Read the shared entitlements store. Re-fetches on every mount while
 * signed in - the same "never show stale data as fresh" posture the old
 * per-screen `useEffect` had, rather than trusting a cached read that could
 * be outdated by something this client never triggered (another device, a
 * webhook that landed while nobody was looking). While mounted it ALSO
 * reacts to `refreshEntitlements()` calls from anywhere else in the app -
 * a purchase made on ProjectScreen's paywall shows up here without this
 * component having to remount.
 */
export function useEntitlements(signedIn: boolean): EntitlementsState {
  const [, tick] = useState(0);

  useEffect(() => {
    if (!signedIn) {
      clearEntitlements();
      return;
    }
    const listener = () => tick((n) => n + 1);
    listeners.add(listener);
    void fetchNow();
    return () => {
      listeners.delete(listener);
    };
  }, [signedIn]);

  return { entitlements: signedIn ? current : null, loaded: signedIn ? hasFetched : false };
}
