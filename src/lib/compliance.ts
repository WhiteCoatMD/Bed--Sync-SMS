/**
 * Carrier-required keyword handling for SMS.
 *
 * Every dealer's lead form promises the customer: "Reply STOP to opt out, HELP
 * for help." That promise is also what a toll-free verification is granted on,
 * so it has to be true in code, not just in the consent text.
 *
 * These are handled before anything else looks at the message: a STOP must not
 * depend on routing finding the right dealer, and it must never reach the AI,
 * which would treat it as conversation and reply.
 */
import { getServiceClient } from '@/lib/supabase';

/** CTIA standard opt-out set. Carriers test these. */
const OPT_OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
/**
 * Standard resubscribe set. YES is deliberately excluded: carriers only
 * require START and UNSTOP, and in a mattress conversation a bare "yes" is
 * almost always the answer to "can you come in Saturday?" — treating it as a
 * compliance keyword would hijack bookings.
 */
const OPT_IN = new Set(['START', 'UNSTOP']);
/** Standard help set. */
const HELP = new Set(['HELP', 'INFO']);

export type KeywordAction = 'opt_out' | 'opt_in' | 'help' | null;

/**
 * Classify a message as a compliance keyword.
 *
 * Matches the keyword alone, ignoring case, surrounding whitespace and trailing
 * punctuation ("Stop." and "STOP!" are opt-outs). It deliberately does NOT match
 * a keyword buried in a sentence — "please don't stop texting me" is not an
 * opt-out, and treating it as one would silence a live conversation.
 */
export function classifyKeyword(body: string): KeywordAction {
    const word = (body || '').trim().replace(/[.!,;:?]+$/, '').toUpperCase();
    if (OPT_OUT.has(word)) return 'opt_out';
    if (OPT_IN.has(word)) return 'opt_in';
    if (HELP.has(word)) return 'help';
    return null;
}

/** Normalise to digits so lookups match regardless of formatting. */
function normalise(phone: string): string {
    const digits = (phone || '').replace(/\D/g, '');
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export async function isOptedOut(phone: string): Promise<boolean> {
    try {
        const { data } = await getServiceClient()
            .from('sms_opt_outs')
            .select('phone')
            .eq('phone', normalise(phone))
            .maybeSingle();
        return !!data;
    } catch (e) {
        // Fail OPEN on a lookup error: silently dropping every message because
        // the opt-out table is unreachable would take the whole product down.
        // The inbound handler still catches an explicit STOP either way.
        console.error('[Compliance] opt-out lookup failed:', (e as Error).message);
        return false;
    }
}

export async function recordOptOut(phone: string, keyword: string, dealerId?: string | null) {
    await getServiceClient().from('sms_opt_outs').upsert({
        phone: normalise(phone),
        keyword,
        dealer_id: dealerId || null,
        opted_out_at: new Date().toISOString(),
    }, { onConflict: 'phone' });
}

export async function recordOptIn(phone: string) {
    await getServiceClient().from('sms_opt_outs').delete().eq('phone', normalise(phone));
}

/**
 * The reply carriers expect for each keyword. Kept short and specific: the HELP
 * reply must name the sender and give a way to reach a human.
 */
export function complianceReply(action: Exclude<KeywordAction, null>, businessName?: string): string {
    const who = businessName && businessName.trim() ? businessName.trim() : 'BedSync';
    if (action === 'opt_out') {
        return `You have been unsubscribed from ${who} and will not receive further messages. Reply START to resubscribe.`;
    }
    if (action === 'opt_in') {
        return `You are resubscribed to ${who}. Reply STOP to opt out, HELP for help.`;
    }
    return `${who}: we text about your mattress inquiry — follow-ups, appointment confirmations and delivery updates. Msg & data rates may apply. Reply STOP to opt out. Support: (318) 372-7140`;
}

export { normalise as normalisePhone };
