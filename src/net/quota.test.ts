// gateExport branch tests. The bug this pins: every failure used to collapse
// into `reason: 'network'`, which the UI then read as "You're offline" even
// when the export-gate function was up and answering with a real error. Each
// branch here is one distinct fact gateExport must NOT flatten: a 401 is
// 'auth', an unreached function is 'unreachable', a function that answered
// with a bad status is 'http_error' (status carried through), and a clean
// allow:false from the server (e.g. quota_exceeded) passes through untouched.
//
// supabase.functions.invoke never throws — it resolves with an `error` field
// — so these mock the resolved value rather than a rejection.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

vi.mock('./supabase', () => ({
  supabase: {
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from './supabase';
import { gateExport } from './quota';

const invoke = supabase.functions.invoke as unknown as Mock;

describe('gateExport', () => {
  it('quota exceeded: a clean allow:false from the server passes through untouched', async () => {
    invoke.mockResolvedValueOnce({ data: { allow: false, reason: 'quota_exceeded', remaining: 0 }, error: null });
    const result = await gateExport('pdf');
    expect(result).toEqual({ allow: false, reason: 'quota_exceeded', remaining: 0 });
  });

  it('auth: a 401 FunctionsHttpError becomes reason "auth", not a network failure', async () => {
    const error = new FunctionsHttpError({ status: 401 });
    invoke.mockResolvedValueOnce({ data: null, error });
    const result = await gateExport('pdf');
    expect(result).toEqual({ allow: false, reason: 'auth' });
  });

  it('HTTP error: a non-401 FunctionsHttpError becomes "http_error" with the status carried through', async () => {
    const error = new FunctionsHttpError({ status: 500 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockResolvedValueOnce({ data: null, error });
    const result = await gateExport('pdf');
    expect(result).toEqual({ allow: false, reason: 'http_error', status: 500 });
    // The real error must reach the console — that's what makes the next
    // report diagnosable without another round trip.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('unreachable: a FunctionsFetchError (request never sent) becomes "unreachable"', async () => {
    const error = new FunctionsFetchError({ requestId: 'r1' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockResolvedValueOnce({ data: null, error });
    const result = await gateExport('csv');
    expect(result).toEqual({ allow: false, reason: 'unreachable' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('unreachable: a FunctionsRelayError (relay could not reach the function) also becomes "unreachable"', async () => {
    const error = new FunctionsRelayError({ region: 'us-east-1' });
    invoke.mockResolvedValueOnce({ data: null, error });
    const result = await gateExport('premiere');
    expect(result).toEqual({ allow: false, reason: 'unreachable' });
  });
});
