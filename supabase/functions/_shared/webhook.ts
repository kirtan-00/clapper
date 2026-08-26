// Webhook signature primitives. Gateway-agnostic on purpose: every payment
// provider worth taking money from signs the same way, and this file is the
// one place that arithmetic lives.
//
// THE RULE THAT BREAKS EVERY NAIVE IMPLEMENTATION: hash the EXACT RAW BYTES of
// the request body. Not `JSON.parse` then `JSON.stringify`, not a decoded and
// re-encoded string. Key order, whitespace and unicode escaping all survive
// the round trip only by luck, and when they do not, the check fails on every
// live delivery while passing in your own test. Read the body once, as bytes,
// hash those bytes, and parse the SAME bytes afterwards.
//
// NO DENO API, NO IMPORTS. Everything here is Web Crypto and plain strings, so
// the vitest suite in src/ can import it directly and test the check against a
// hand computed fixture rather than against itself.

/** Constant-time compare for two hex digests. A plain `===` leaks, one byte at
 *  a time, how much of a guess was right. Length is compared first because two
 *  different lengths are not a secret, and because the loop below needs equal
 *  lengths to mean anything. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const enc = new TextEncoder();

function toBytes(m: Uint8Array | string): Uint8Array {
  return typeof m === "string" ? enc.encode(m) : m;
}

/** HMAC-SHA256, hex. Takes bytes OR a string; the byte form is the one the
 *  webhook path uses, because the string form would mean decoding the body. */
export async function hmacSha256Hex(
  message: Uint8Array | string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = toBytes(message);
  // A fresh copy into a plain ArrayBuffer: a Uint8Array view over a larger
  // buffer would otherwise sign the wrong slice.
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const sig = await crypto.subtle.sign("HMAC", key, buf);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Join `<ts>:` and the raw body WITHOUT decoding the body. */
export function prefixedBody(prefix: string, rawBody: Uint8Array): Uint8Array {
  const head = enc.encode(prefix);
  const out = new Uint8Array(head.length + rawBody.length);
  out.set(head, 0);
  out.set(rawBody, head.length);
  return out;
}

// ---------------------------------------------------------------------------
// Paddle
//
// Documented shape (developer.paddle.com, "Verify webhook signatures", read
// 2026-08-26, not written from memory):
//
//   Paddle-Signature: ts=1671552777;h1=eb4d0dc8853be92b7f063b9f3ba5233e...
//
//   signed payload = `${ts}:${rawRequestBody}`
//   signature      = HMAC-SHA256(signed payload, endpoint secret key)
//   compare        = timing safe, against h1
//
// The secret is per notification destination and is prefixed `pdl_ntfset_`.
// Paddle shows it once, at creation. It is NOT the API key.
//
// MULTIPLE h1 VALUES. During a secret rotation a delivery can carry more than
// one h1. Every one is checked, and any match is a pass, so a rotation does
// not drop a real event on the floor.
// ---------------------------------------------------------------------------

export interface PaddleSignature {
  ts: number;
  /** Every h1 in the header, in order. Usually one. */
  h1: string[];
}

/** Parse `ts=...;h1=...`. Returns null for anything malformed, which is a
 *  rejection, not a warning. */
export function parsePaddleSignature(header: string | null | undefined): PaddleSignature | null {
  if (typeof header !== "string" || header.length === 0 || header.length > 2000) return null;
  let ts: number | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "ts") {
      if (!/^[0-9]{1,15}$/.test(v)) return null;
      ts = Number(v);
    } else if (k === "h1") {
      // Hex only. Anything else cannot be a digest, and letting it through
      // would only give the compare below a string it can never match.
      if (!/^[0-9a-f]{64}$/i.test(v)) return null;
      h1.push(v.toLowerCase());
    }
  }
  if (ts === null || h1.length === 0) return null;
  return { ts, h1 };
}

export type VerifyResult =
  | { ok: true; ts: number }
  | { ok: false; reason: "no_secret" | "malformed_header" | "stale" | "mismatch" };

/**
 * The whole check, over raw bytes.
 *
 * TOLERANCE. Paddle's own SDK defaults to five seconds. That is a number
 * written for a warm server on NTP, and this is a Supabase edge function that
 * can spend most of that budget on a cold start. Five seconds would turn a
 * genuine event into a rejection, Paddle would retry it, and the retry would
 * cold start too. The default here is five MINUTES, and the reason that is not
 * a weakening of the check is that replay protection does not live in the
 * timestamp at all: it lives in the `event_id` claim in _shared/entitlements.ts,
 * which lets any given event grant exactly once, forever. The timestamp window
 * is a cheap outer fence, not the lock.
 */
export async function verifyPaddleWebhook(
  rawBody: Uint8Array,
  header: string | null | undefined,
  secret: string | null | undefined,
  opts?: { nowMs?: number; toleranceSecs?: number },
): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: "no_secret" };
  const parsed = parsePaddleSignature(header);
  if (!parsed) return { ok: false, reason: "malformed_header" };

  const nowMs = opts?.nowMs ?? Date.now();
  const tolerance = opts?.toleranceSecs ?? 300;
  // Absolute skew: a timestamp far in the FUTURE is as wrong as an old one.
  if (Math.abs(nowMs / 1000 - parsed.ts) > tolerance) return { ok: false, reason: "stale" };

  const expected = await hmacSha256Hex(prefixedBody(`${parsed.ts}:`, rawBody), secret);
  for (const candidate of parsed.h1) {
    if (timingSafeEqualHex(expected, candidate)) return { ok: true, ts: parsed.ts };
  }
  return { ok: false, reason: "mismatch" };
}
