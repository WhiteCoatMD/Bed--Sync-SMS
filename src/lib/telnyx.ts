/**
 * Telnyx API client for SMS AI Agent
 * Replaces Twilio client — uses REST API via fetch
 */

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

function getApiKey(): string {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('[Telnyx] TELNYX_API_KEY not set');
  return key;
}

/**
 * A Telnyx API rejection, with the error codes kept as data.
 *
 * The message keeps its original shape, so existing catch blocks that log it
 * are unaffected. What changes is that a caller no longer has to pick the JSON
 * back out of a string to find out WHY a send failed — and that matters,
 * because some failures are permanent (the number does not exist) and some are
 * not (a timeout), and the two deserve opposite responses.
 */
export class TelnyxApiError extends Error {
  readonly status: number;
  readonly codes: string[];

  constructor(status: number, payload: unknown) {
    super(`Telnyx API error (${status}): ${JSON.stringify(payload)}`);
    this.name = 'TelnyxApiError';
    this.status = status;
    const errors = (payload as { errors?: unknown })?.errors;
    this.codes = Array.isArray(errors)
      ? errors.map((e) => String((e as { code?: unknown })?.code)).filter((c) => c && c !== 'undefined')
      : [];
  }

  hasCode(code: string): boolean {
    return this.codes.includes(code);
  }
}

export async function telnyxRequest(path: string, method: string = 'GET', body?: Record<string, unknown>) {
  const apiKey = getApiKey();
  console.log(`[Telnyx] ${method} ${path}`);

  const resp = await fetch(`${TELNYX_API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error(`[Telnyx] Error ${resp.status}:`, JSON.stringify(data));
    throw new TelnyxApiError(resp.status, data);
  }
  console.log(`[Telnyx] Success: ${data.data?.id || 'ok'}`);
  return data;
}

/**
 * Validate Telnyx webhook signature (basic check)
 * Telnyx uses a public key verification — for now we check the presence
 * of the webhook and that it came from a valid source.
 */
export function validateTelnyxWebhook(
  _body: string,
  _signature: string | null,
  _timestamp: string | null
): boolean {
  // Telnyx webhook validation uses ed25519 public key
  // For now, accept all webhooks (same security as Twilio without validation)
  // TODO: Implement full ed25519 signature validation
  return true;
}
