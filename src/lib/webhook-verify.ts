import crypto from 'crypto';

/**
 * Telnyx webhook signature verification.
 *
 * Telnyx signs with Ed25519. The signed message is the timestamp, a pipe, and
 * the RAW request body — so the body must be verified before it is parsed;
 * re-serialising parsed JSON will not reproduce the same bytes.
 *
 *   headers: telnyx-signature-ed25519 (base64), telnyx-timestamp (unix seconds)
 *   message: `${timestamp}|${rawBody}`
 *   key:     base64 Ed25519 public key from portal.telnyx.com/#/api-keys/public-key
 *
 * Rollout is deliberately opt-in: with TELNYX_PUBLIC_KEY unset this returns
 * `skipped` and the caller proceeds. Enforcing before the key is configured
 * would silently drop every inbound customer text.
 */
export type VerifyResult =
  | { ok: true; reason: 'verified' | 'skipped' }
  | { ok: false; reason: string };

/** Reject replays of a captured request. Telnyx suggests a small window. */
const TOLERANCE_SECONDS = 5 * 60;

export function verifyTelnyxSignature(
  rawBody: string,
  signatureB64: string | null,
  timestamp: string | null,
  publicKeyB64 = process.env.TELNYX_PUBLIC_KEY
): VerifyResult {
  if (!publicKeyB64) return { ok: true, reason: 'skipped' };
  if (!signatureB64 || !timestamp) return { ok: false, reason: 'missing signature headers' };

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: 'bad timestamp' };
  if (age > TOLERANCE_SECONDS) return { ok: false, reason: `timestamp outside tolerance (${Math.round(age)}s)` };

  try {
    // Node needs the raw 32-byte Ed25519 key wrapped in a DER SubjectPublicKeyInfo.
    const raw = Buffer.from(publicKeyB64, 'base64');
    if (raw.length !== 32) return { ok: false, reason: `public key is ${raw.length} bytes, expected 32` };
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      raw,
    ]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });

    const signed = Buffer.from(`${timestamp}|${rawBody}`, 'utf8');
    const sig = Buffer.from(signatureB64, 'base64');
    const ok = crypto.verify(null, signed, key, sig);
    return ok ? { ok: true, reason: 'verified' } : { ok: false, reason: 'signature mismatch' };
  } catch (err) {
    return { ok: false, reason: `verification error: ${(err as Error).message}` };
  }
}
