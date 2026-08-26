import { NextRequest, NextResponse } from 'next/server';
import { isOptedOut, recordOptOut } from '@/lib/compliance';

/**
 * Suppression lookup for the main Bed Sync app.
 *
 * The opt-out list lives here, in the SMS agent's database, but the main app
 * sends too (review requests, nurture, delivery updates, lead alerts) from the
 * same numbers. Without this it had no way to know a number had texted STOP,
 * so someone who opted out kept receiving messages — while the 10DLC campaign
 * registration promises STOP suppresses "all further messages".
 *
 * Server-to-server only; gated on INTERNAL_API_SECRET.
 */

function authorised(req: NextRequest): boolean {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) return false;
    return req.headers.get('x-internal-secret') === secret;
}

export async function GET(req: NextRequest) {
    if (!authorised(req)) {
        return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
    }
    const phone = req.nextUrl.searchParams.get('phone');
    if (!phone) {
        return NextResponse.json({ error: 'phone required' }, { status: 400 });
    }
    try {
        return NextResponse.json({ phone, opted_out: await isOptedOut(phone) });
    } catch (e) {
        // The caller fails closed on an error, so say so plainly rather than
        // returning a cheerful false that would let a suppressed number through.
        console.error('[Compliance] lookup failed:', (e as Error).message);
        return NextResponse.json({ error: 'lookup failed' }, { status: 503 });
    }
}

/** Records an opt-out seen by the main app, so both sides share one list. */
export async function POST(req: NextRequest) {
    if (!authorised(req)) {
        return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
    }
    let body: { phone?: string; keyword?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'bad json' }, { status: 400 });
    }
    if (!body.phone) {
        return NextResponse.json({ error: 'phone required' }, { status: 400 });
    }
    try {
        await recordOptOut(body.phone, body.keyword || 'STOP');
        return NextResponse.json({ ok: true, phone: body.phone });
    } catch (e) {
        console.error('[Compliance] recordOptOut failed:', (e as Error).message);
        return NextResponse.json({ error: 'record failed' }, { status: 503 });
    }
}
