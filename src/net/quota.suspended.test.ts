// Pins the client-side contract for the new suspension gate reason introduced
// in supabase/functions/export-gate/index.ts. That function is Deno and lives
// outside this test runner, so this cannot exercise the server logic itself
// (see the migration's own local-Postgres RPC exercise for that side) - what
// this DOES pin is the one thing src/ needs to be true for a suspended
// refusal to ever reach a user correctly: export-gate answers with HTTP 200
// and `{ allow: false, reason: 'suspended' }`, exactly like the existing
// quota_exceeded/pro_only cases, and gateExport (src/net/quota.ts) must pass
// that reason through untouched rather than swallowing or rewriting it. This
// is a separate file rather than an addition to quota.test.ts, which belongs
// to whoever owns that test's existing branches.

import { describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from './supabase';
import { gateExport } from './quota';

const invoke = supabase.functions.invoke as unknown as Mock;

describe('gateExport: suspended accounts', () => {
  it('a clean allow:false, reason:"suspended" from the server passes through untouched', async () => {
    invoke.mockResolvedValueOnce({ data: { allow: false, reason: 'suspended' }, error: null });
    const result = await gateExport('pdf');
    expect(result).toEqual({ allow: false, reason: 'suspended' });
  });

  it('is distinct from quota_exceeded and auth, the two reasons the UI already special-cases', async () => {
    invoke.mockResolvedValueOnce({ data: { allow: false, reason: 'suspended' }, error: null });
    const result = await gateExport('csv');
    expect(result.reason).not.toBe('quota_exceeded');
    expect(result.reason).not.toBe('auth');
    expect(result.allow).toBe(false);
  });
});
