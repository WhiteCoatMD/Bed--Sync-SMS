import { telnyxRequest } from './telnyx';

/**
 * Picking the campaign that can actually send.
 *
 * A campaign reports two different statuses and they disagree. Campaign
 * 4b3001a0 has said `status: ACTIVE` for weeks while `campaignStatus` is
 * TELNYX_FAILED and every number assignment returns 10036 -- it is billed,
 * renewing, and completely unusable. Trusting `status` alone is how numbers got
 * bought that could not send.
 *
 * With two filings in flight at once, a single hardcoded id is also wrong: the
 * one that clears first should win without anyone editing code.
 */

export interface CampaignSnapshot {
  status?: string;
  campaignStatus?: string;
  failureReasons?: unknown[] | null;
}

export type CampaignResolution =
  | { ok: true; campaignId: string }
  | { ok: false; reason: string };

export type CampaignFetcher = (campaignId: string) => Promise<CampaignSnapshot>;

/**
 * All three conditions must hold. Any one of them alone will mislead you.
 *
 * campaignStatus is matched against /fail|reject/i rather than a fixed list of
 * known-bad values: Telnyx has more than one failure/rejection flavour of
 * campaignStatus, and a campaign sitting in one we hadn't enumerated -- with
 * status: ACTIVE and no failureReasons yet -- would otherwise sail through and
 * open the spend gate. A missing/undefined campaignStatus is still acceptable,
 * same as before: that's a legitimate in-review state, not a failure.
 */
export function isUsable(c: CampaignSnapshot): boolean {
  if (c.status !== 'ACTIVE') return false;
  if (c.campaignStatus && /fail|reject/i.test(c.campaignStatus)) return false;
  return !(Array.isArray(c.failureReasons) && c.failureReasons.length > 0);
}

/**
 * Campaign ids in preference order. TELNYX_10DLC_CAMPAIGN_IDS is the plural
 * form used while more than one filing is pending; the singular var is still
 * honoured so an unset plural var changes nothing.
 *
 * env is typed as Record<string, string | undefined>, not NodeJS.ProcessEnv:
 * Next.js augments NodeJS.ProcessEnv with a required `NODE_ENV` literal, which
 * makes the plain env-var fixtures used in tests uncastable to that type. Do
 * not tighten this back to NodeJS.ProcessEnv — process.env still satisfies
 * this type, so nothing about real callers changes.
 */
export function configuredCampaignIds(env: Record<string, string | undefined> = process.env): string[] {
  const plural = (env.TELNYX_10DLC_CAMPAIGN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (plural.length > 0) return plural;

  const single = (env.TELNYX_10DLC_CAMPAIGN_ID || '').trim();
  return single ? [single] : [];
}

const defaultFetcher: CampaignFetcher = (campaignId) =>
  telnyxRequest(`/10dlc/campaign/${campaignId}`);

export async function resolveUsableCampaign(
  fetchCampaign: CampaignFetcher = defaultFetcher,
  env: Record<string, string | undefined> = process.env
): Promise<CampaignResolution> {
  const ids = configuredCampaignIds(env);
  if (ids.length === 0) {
    return { ok: false, reason: 'no campaign configured (set TELNYX_10DLC_CAMPAIGN_IDS)' };
  }

  const notes: string[] = [];
  for (const campaignId of ids) {
    try {
      const snapshot = await fetchCampaign(campaignId);
      if (isUsable(snapshot)) return { ok: true, campaignId };
      const findings = Array.isArray(snapshot.failureReasons) ? snapshot.failureReasons.length : 0;
      notes.push(
        `${campaignId}: status=${snapshot.status ?? 'unknown'} ` +
          `campaignStatus=${snapshot.campaignStatus ?? 'unknown'} findings=${findings}`
      );
    } catch (err) {
      // A campaign we cannot read is not a campaign we may spend money against,
      // but it must not hide a healthy one later in the list.
      notes.push(`${campaignId}: lookup failed (${(err as Error).message})`);
    }
  }

  return { ok: false, reason: `no usable campaign — ${notes.join('; ')}` };
}
