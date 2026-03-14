import { NextRequest, NextResponse } from 'next/server';
import { resumeAi } from '@/lib/agent/handoff';

/**
 * POST /api/conversations/[id]/resume
 * Resume AI control of a handed-off conversation.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const resumeState = body.state || 'qualifying';

    await resumeAi(id, resumeState);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Resume] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
