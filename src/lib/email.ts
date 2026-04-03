/**
 * Email sending via SendGrid REST API.
 * No SDK needed — plain fetch.
 * Set SENDGRID_API_KEY in env (same key used on main Bed Sync site).
 * Optionally set SENDGRID_FROM_EMAIL (defaults to noreply@bed-sync.com).
 */

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<boolean> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@bed-sync.com';
  const fromName = 'BedSync AI';

  if (!apiKey) {
    console.warn('[Email] SENDGRID_API_KEY not set — skipping email');
    return false;
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: fromEmail, name: fromName },
        subject: opts.subject,
        content: [
          ...(opts.text ? [{ type: 'text/plain', value: opts.text }] : []),
          { type: 'text/html', value: opts.html },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[Email] SendGrid error:', err);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[Email] Send error:', err);
    return false;
  }
}

export function buildHandoffEmailHtml(params: {
  businessName: string;
  customerName: string | null;
  customerPhone: string;
  leadScore: number;
  reason: string;
  lookingFor: string;
  budget: string;
  sleepPosition: string;
  urgency: string;
  financingInterest: boolean;
  productsShown: number;
  objections: string;
  dashboardUrl: string;
}): string {
  const {
    businessName, customerName, customerPhone, leadScore, reason,
    lookingFor, budget, sleepPosition, urgency, financingInterest,
    productsShown, objections, dashboardUrl,
  } = params;

  const rows = [
    ['Customer', customerName || 'Unknown'],
    ['Phone', customerPhone],
    ['Lead Score', `${leadScore}/100`],
    ['Handoff Reason', reason],
    lookingFor ? ['Looking For', lookingFor] : null,
    budget ? ['Budget', budget] : null,
    sleepPosition ? ['Sleep Position', sleepPosition] : null,
    urgency ? ['Timeline', urgency] : null,
    financingInterest ? ['Financing Interest', 'Yes'] : null,
    productsShown > 0 ? ['Products Shown', `${productsShown} items`] : null,
    objections ? ['Objections Raised', objections] : null,
  ]
    .filter(Boolean)
    .map(
      (row) =>
        `<tr>
          <td style="padding:8px 12px;font-weight:600;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;white-space:nowrap">${row![0]}</td>
          <td style="padding:8px 12px;color:#111827;border:1px solid #e5e7eb">${row![1]}</td>
        </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f3f4f6;margin:0;padding:20px">
  <div style="max-width:520px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
    <div style="background:#1a1a2e;padding:20px 24px">
      <p style="margin:0;color:#a5b4fc;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">BedSync AI</p>
      <h1 style="margin:4px 0 0;color:white;font-size:20px">Handoff Required</h1>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 16px;color:#374151">
        A conversation at <strong>${businessName}</strong> needs your attention.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
        ${rows}
      </table>
      <a href="${dashboardUrl}"
         style="display:inline-block;background:#1a1a2e;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        View Conversation &rarr;
      </a>
      <p style="margin:16px 0 0;font-size:12px;color:#9ca3af">
        Reply to this customer directly from your BedSync dashboard or call ${customerPhone}.
      </p>
    </div>
  </div>
</body>
</html>`;
}
