import { describe, it, expect } from 'vitest';
import { isUsable, configuredCampaignIds, resolveUsableCampaign } from './10dlc';

describe('isUsable', () => {
  it('rejects the real shape of our failed MIXED campaign', () => {
    // 4b3001a0 reports ACTIVE while being completely unable to accept numbers.
    expect(isUsable({
      status: 'ACTIVE',
      campaignStatus: 'TELNYX_FAILED',
      failureReasons: [{ description: 'Who is the perceived sender...' }],
    })).toBe(false);
  });

  it('rejects ACTIVE + TELNYX_FAILED even with no findings listed', () => {
    expect(isUsable({ status: 'ACTIVE', campaignStatus: 'TELNYX_FAILED', failureReasons: [] })).toBe(false);
  });

  it('rejects ACTIVE with open findings', () => {
    expect(isUsable({ status: 'ACTIVE', campaignStatus: 'ACTIVE', failureReasons: [{ description: 'x' }] })).toBe(false);
  });

  it('rejects EXPIRED', () => {
    expect(isUsable({ status: 'EXPIRED', campaignStatus: 'ACTIVE', failureReasons: [] })).toBe(false);
  });

  it('accepts ACTIVE, not failed, no findings', () => {
    expect(isUsable({ status: 'ACTIVE', campaignStatus: 'ACTIVE', failureReasons: [] })).toBe(true);
  });

  it('accepts when failureReasons is absent or null', () => {
    expect(isUsable({ status: 'ACTIVE', campaignStatus: 'ACTIVE' })).toBe(true);
    expect(isUsable({ status: 'ACTIVE', campaignStatus: 'ACTIVE', failureReasons: null })).toBe(true);
  });
});

describe('configuredCampaignIds', () => {
  it('reads the plural var in order, trimming blanks', () => {
    expect(configuredCampaignIds({ TELNYX_10DLC_CAMPAIGN_IDS: ' a , b ,, c ' } as NodeJS.ProcessEnv))
      .toEqual(['a', 'b', 'c']);
  });

  it('falls back to the singular var so nothing breaks if the new one is unset', () => {
    expect(configuredCampaignIds({ TELNYX_10DLC_CAMPAIGN_ID: 'solo' } as NodeJS.ProcessEnv)).toEqual(['solo']);
  });

  it('prefers the plural var when both are set', () => {
    expect(configuredCampaignIds({
      TELNYX_10DLC_CAMPAIGN_IDS: 'a,b',
      TELNYX_10DLC_CAMPAIGN_ID: 'solo',
    } as NodeJS.ProcessEnv)).toEqual(['a', 'b']);
  });

  it('returns nothing when neither is set', () => {
    expect(configuredCampaignIds({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('resolveUsableCampaign', () => {
  const usable = { status: 'ACTIVE', campaignStatus: 'ACTIVE', failureReasons: [] };
  const failed = { status: 'ACTIVE', campaignStatus: 'TELNYX_FAILED', failureReasons: [{ d: 1 }] };

  it('returns the first usable campaign, in configured order', async () => {
    const env = { TELNYX_10DLC_CAMPAIGN_IDS: 'bad,good' } as NodeJS.ProcessEnv;
    const fetchCampaign = async (id: string) => (id === 'good' ? usable : failed);
    expect(await resolveUsableCampaign(fetchCampaign, env)).toEqual({ ok: true, campaignId: 'good' });
  });

  it('explains itself when every campaign is unusable', async () => {
    const env = { TELNYX_10DLC_CAMPAIGN_IDS: 'one,two' } as NodeJS.ProcessEnv;
    const result = await resolveUsableCampaign(async () => failed, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('one');
      expect(result.reason).toContain('TELNYX_FAILED');
    }
  });

  it('explains itself when nothing is configured, rather than throwing', async () => {
    const result = await resolveUsableCampaign(async () => usable, {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no campaign configured');
  });

  it('treats a lookup error as unusable and keeps checking the rest', async () => {
    const env = { TELNYX_10DLC_CAMPAIGN_IDS: 'boom,good' } as NodeJS.ProcessEnv;
    const fetchCampaign = async (id: string) => {
      if (id === 'boom') throw new Error('network down');
      return usable;
    };
    expect(await resolveUsableCampaign(fetchCampaign, env)).toEqual({ ok: true, campaignId: 'good' });
  });
});
