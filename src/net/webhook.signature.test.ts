import { describe, it, expect } from 'vitest';
import {
  hmacSha256Hex,
  parsePaddleSignature,
  timingSafeEqualHex,
  verifyPaddleWebhook,
} from '../../supabase/functions/_shared/webhook.ts';

// The signature check is the ONLY authentication on the payment webhook: that
// function runs with verify_jwt off, because Paddle is not a Supabase user.
// So these tests are not about a helper being tidy. If this check is wrong in
// the permissive direction, anybody who finds the URL can grant themselves
// credits by POSTing JSON.
//
// THE FIXTURE IS HAND COMPUTED, OUTSIDE THE CODE UNDER TEST. The digest below
// came from node's own crypto:
//
//   crypto.createHmac('sha256', SECRET).update(TS + ':' + RAW_BODY).digest('hex')
//
// Deriving "expected" from the same crypto.subtle helper that
// verifyPaddleWebhook uses would be circular: the pair would agree with each
// other while both being wrong about what Paddle actually sends.

const SECRET = 'pdl_ntfset_fixture_secret_do_not_use';
const TS = 1767225600;

// Deliberately not canonical JSON. There is one space after the first colon
// and the note carries a é escape, so parsing and re-serialising this
// body produces DIFFERENT BYTES. That is the whole point of the fixture: the
// classic way this check is written wrong is to JSON.parse the body and hash a
// re-serialised copy, which fails on every real delivery.
const RAW_BODY =
  '{"event_id":"evt_01hq", "event_type":"transaction.completed","data":{"id":"txn_01hq","custom_data":{"user_id":"11111111-1111-4111-8111-111111111111"},"note":"caf\\u00e9 five projects"}}';

/** HMAC-SHA256 of `${TS}:${RAW_BODY}` under SECRET, per node crypto. */
const H1 = 'dff8eb6c6d7497f624f2d482424f74a6250ecf575983537626399103e377ce77';
/** The digest a naive implementation gets when it hashes JSON.stringify(JSON.parse(body)). */
const H1_RESERIALISED = '3cc8ec8877777bee326717229a2f4e8b0c9f7aca2bac483b207b00ba6e24e3d5';

const bytes = (s: string) => new TextEncoder().encode(s);
const NOW_MS = TS * 1000;

describe('hmacSha256Hex', () => {
  it('matches a digest computed outside this code', async () => {
    expect(await hmacSha256Hex(`${TS}:${RAW_BODY}`, SECRET)).toBe(H1);
  });

  it('gives the same answer for bytes as for the equivalent string', async () => {
    expect(await hmacSha256Hex(bytes(`${TS}:${RAW_BODY}`), SECRET)).toBe(H1);
  });

  it('signs only the bytes it was given, not the whole backing buffer', async () => {
    // A Uint8Array view over a larger buffer is the shape a body arrives in
    // when it is sliced out of something else. Signing the backing buffer
    // instead of the view would be a silent, total failure.
    const full = bytes(`XXXX${TS}:${RAW_BODY}`);
    const view = full.subarray(4);
    expect(await hmacSha256Hex(view, SECRET)).toBe(H1);
  });
});

describe('timingSafeEqualHex', () => {
  it('accepts an exact match and rejects a one character difference', () => {
    expect(timingSafeEqualHex(H1, H1)).toBe(true);
    expect(timingSafeEqualHex(H1, H1.slice(0, 63) + '0')).toBe(false);
  });

  it('rejects a prefix, which a length-blind compare would accept', () => {
    expect(timingSafeEqualHex(H1, H1.slice(0, 32))).toBe(false);
    expect(timingSafeEqualHex('', H1)).toBe(false);
  });
});

describe('parsePaddleSignature', () => {
  it('reads the documented header shape', () => {
    const p = parsePaddleSignature(`ts=${TS};h1=${H1}`);
    expect(p).toEqual({ ts: TS, h1: [H1] });
  });

  it('keeps every h1 so a secret rotation does not drop a real event', () => {
    const other = 'a'.repeat(64);
    const p = parsePaddleSignature(`ts=${TS};h1=${other};h1=${H1}`);
    expect(p?.h1).toEqual([other, H1]);
  });

  it('refuses anything malformed rather than half reading it', () => {
    expect(parsePaddleSignature(null)).toBeNull();
    expect(parsePaddleSignature('')).toBeNull();
    expect(parsePaddleSignature(`h1=${H1}`)).toBeNull();            // no ts
    expect(parsePaddleSignature(`ts=${TS}`)).toBeNull();            // no h1
    expect(parsePaddleSignature(`ts=nope;h1=${H1}`)).toBeNull();    // ts not a number
    expect(parsePaddleSignature(`ts=${TS};h1=zz`)).toBeNull();      // h1 not hex
    expect(parsePaddleSignature(`ts=${TS};h1=${'a'.repeat(63)}`)).toBeNull(); // wrong length
  });
});

describe('verifyPaddleWebhook', () => {
  const header = `ts=${TS};h1=${H1}`;

  it('accepts the fixture', async () => {
    const v = await verifyPaddleWebhook(bytes(RAW_BODY), header, SECRET, { nowMs: NOW_MS });
    expect(v).toEqual({ ok: true, ts: TS });
  });

  it('REJECTS the re-serialised body, proving the raw bytes are what is hashed', async () => {
    // This is the assertion that catches the classic bug. If verify ever
    // starts parsing and re-serialising, this passes when it must not.
    const reserialised = JSON.stringify(JSON.parse(RAW_BODY));
    expect(reserialised).not.toBe(RAW_BODY);
    const v = await verifyPaddleWebhook(bytes(reserialised), header, SECRET, { nowMs: NOW_MS });
    expect(v).toEqual({ ok: false, reason: 'mismatch' });

    // ...and the digest of that re-serialised form is a real digest, just the
    // wrong one. A check that hashed it would have "worked" in a test.
    const wrongHeader = `ts=${TS};h1=${H1_RESERIALISED}`;
    const v2 = await verifyPaddleWebhook(bytes(reserialised), wrongHeader, SECRET, { nowMs: NOW_MS });
    expect(v2.ok).toBe(true);
  });

  it('rejects a body with one byte changed', async () => {
    const tampered = RAW_BODY.replace('five projects', 'nine projects');
    const v = await verifyPaddleWebhook(bytes(tampered), header, SECRET, { nowMs: NOW_MS });
    expect(v).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects the right body signed with the wrong secret', async () => {
    const v = await verifyPaddleWebhook(bytes(RAW_BODY), header, SECRET + 'x', { nowMs: NOW_MS });
    expect(v).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a replayed timestamp with an otherwise valid digest', async () => {
    // Same header, same body, an hour later than the tolerance allows.
    const v = await verifyPaddleWebhook(bytes(RAW_BODY), header, SECRET, {
      nowMs: NOW_MS + 3600_000,
      toleranceSecs: 300,
    });
    expect(v).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects a timestamp far in the future, not only an old one', async () => {
    const v = await verifyPaddleWebhook(bytes(RAW_BODY), header, SECRET, {
      nowMs: NOW_MS - 3600_000,
      toleranceSecs: 300,
    });
    expect(v).toEqual({ ok: false, reason: 'stale' });
  });

  it('will not verify anything at all when the secret is missing', async () => {
    // The failure mode that matters: an unset secret must never read as "no
    // check needed". A deploy without PADDLE_WEBHOOK_SECRET refuses every
    // delivery rather than accepting every delivery.
    for (const missing of [undefined, null, '']) {
      const v = await verifyPaddleWebhook(bytes(RAW_BODY), header, missing, { nowMs: NOW_MS });
      expect(v).toEqual({ ok: false, reason: 'no_secret' });
    }
  });

  it('rejects a missing or malformed header', async () => {
    const v = await verifyPaddleWebhook(bytes(RAW_BODY), null, SECRET, { nowMs: NOW_MS });
    expect(v).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('accepts when one of several rotated h1 values matches', async () => {
    const rotating = `ts=${TS};h1=${'b'.repeat(64)};h1=${H1}`;
    const v = await verifyPaddleWebhook(bytes(RAW_BODY), rotating, SECRET, { nowMs: NOW_MS });
    expect(v.ok).toBe(true);
  });
});
