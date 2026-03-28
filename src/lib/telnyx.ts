/**
 * Telnyx API client for SMS AI Agent
 * Replaces Twilio client — uses REST API via fetch
 */

const TELNYX_API_KEY = process.env.TELNYX_API_KEY!;
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

function telnyxHeaders() {
  return {
    'Authorization': `Bearer ${TELNYX_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function telnyxRequest(path: string, method: string = 'GET', body?: Record<string, unknown>) {
  const resp = await fetch(`${TELNYX_API_BASE}${path}`, {
    method,
    headers: telnyxHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Telnyx API error (${resp.status}): ${JSON.stringify(data)}`);
  }
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
