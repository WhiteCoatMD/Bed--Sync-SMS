import twilio from 'twilio';

let client: twilio.Twilio | null = null;

export function getTwilioClient(): twilio.Twilio {
  if (!client) {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const token = process.env.TWILIO_AUTH_TOKEN!;
    client = twilio(sid, token);
  }
  return client;
}

export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN!;
  return twilio.validateRequest(token, signature, url, params);
}
