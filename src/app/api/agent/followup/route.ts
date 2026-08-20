import { NextRequest, NextResponse } from 'next/server';
import { processPendingFollowUps } from '@/lib/agent/followup';
import { processPendingReminders } from '@/lib/agent/reminders';

/**
 * POST /api/agent/followup
 * Cron endpoint to process pending follow-ups.
 * Should be called every 5-10 minutes by Vercel Cron or external scheduler.
 */
export async function POST(req: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const processed = await processPendingFollowUps();
    const reminders = await processPendingReminders();

    return NextResponse.json({
      success: true,
      processed,
      reminders,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[FollowUp Cron] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Also support GET for Vercel Cron
export async function GET(req: NextRequest) {
  return POST(req);
}
