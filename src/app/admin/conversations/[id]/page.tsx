'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface Message {
  id: string;
  direction: string;
  sender: string;
  body: string;
  created_at: string;
}

interface ConversationDetail {
  id: string;
  status: string;
  agent_state: string;
  context: Record<string, unknown>;
  follow_up_count: number;
  handed_off_reason: string | null;
  outcome: 'won' | 'lost' | null;
  outcome_details: string | null;
  outcome_product: string | null;
  outcome_at: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  lead: {
    id: string;
    phone: string;
    customer_name: string | null;
    email: string | null;
    source: string;
    status: string;
    lead_score: number;
    qualification: Record<string, unknown>;
  };
  messages: Message[];
  recommendations: Array<{
    id: string;
    rank: number;
    reason: string;
    presented_at: string;
    item: {
      brand: string;
      model: string;
      size: string;
      price: number;
      sale_price: number | null;
      firmness: string;
    };
  }>;
  logs: Array<{
    id: string;
    action: string;
    details: Record<string, unknown>;
    created_at: string;
  }>;
}

const STATE_LABELS: Record<string, string> = {
  greeting: '👋 Greeting',
  qualifying: '❓ Qualifying',
  recommending: '🛏️ Recommending',
  objection_handling: '🤔 Handling Objections',
  closing: '🤝 Closing',
  follow_up: '📲 Follow-up',
  handed_off: '🙋 Handed Off',
  converted: '✅ Converted',
  lost: '❌ Lost',
};

export default function ConversationDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualMessage, setManualMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [outcomeDetails, setOutcomeDetails] = useState('');
  const [outcomeProduct, setOutcomeProduct] = useState('');
  const [savingOutcome, setSavingOutcome] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchDetail();
    const interval = setInterval(fetchDetail, 8000);
    return () => clearInterval(interval);
  }, [id]);

  // Scroll to the newest message only when one actually arrives.
  //
  // This used to depend on `data?.messages`, which is a brand new array on
  // every 8-second poll, so the effect re-fired constantly and dragged the page
  // down to the products panel while you were reading. Comparing the count
  // instead means an unchanged thread stays exactly where you left it.
  //
  // `block: 'nearest'` keeps the scroll inside the message list rather than
  // repositioning the whole window.
  const lastMessageCount = useRef<number | null>(null);
  useEffect(() => {
    const count = data?.messages.length ?? 0;
    const previous = lastMessageCount.current;
    lastMessageCount.current = count;
    // null means first render — land on the latest message without animating.
    if (previous === null) {
      messagesEndRef.current?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (count > previous) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [data?.messages.length]);

  async function fetchDetail() {
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const json = await res.json();
      if (json.success) setData(json.conversation);
    } catch (err) {
      console.error('Fetch error:', err);
    }
    setLoading(false);
  }

  async function handleHandoff() {
    const reason = prompt('Reason for handoff (optional):');
    if (reason === null) return; // cancelled
    await fetch(`/api/conversations/${id}/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || 'Manual takeover from dashboard' }),
    });
    fetchDetail();
  }

  async function handleResume() {
    await fetch(`/api/conversations/${id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    fetchDetail();
  }

  async function handleSendManual() {
    if (!manualMessage.trim()) return;
    setSending(true);
    await fetch(`/api/conversations/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: manualMessage }),
    });
    setManualMessage('');
    setSending(false);
    fetchDetail();
    inputRef.current?.focus();
  }

  async function handleOutcome(outcome: 'won' | 'lost') {
    setSavingOutcome(true);
    await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome,
        outcome_details: outcomeDetails || null,
        outcome_product: outcome === 'won' ? (outcomeProduct || null) : null,
        status: 'closed',
      }),
    });
    setSavingOutcome(false);
    fetchDetail();
  }

  async function handleClearOutcome() {
    setSavingOutcome(true);
    await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: null, outcome_details: null, outcome_product: null }),
    });
    setOutcomeDetails('');
    setOutcomeProduct('');
    setSavingOutcome(false);
    fetchDetail();
  }

  if (loading) return <div className="text-center py-12 text-gray-400">Loading...</div>;
  if (!data) return <div className="text-center py-12 text-red-500">Conversation not found.</div>;

  const ctx = data.context;
  const score = data.lead.lead_score;
  const isHot = score >= 70;
  const isWarm = score >= 40;

  // Build a timeline of qualification progress
  const qualFields = [
    { key: 'mattress_size', label: 'Size', value: ctx.mattress_size as string },
    { key: 'budget', label: 'Budget', value: (ctx.budget_min || ctx.budget_max) ? `$${ctx.budget_min || '?'} - $${ctx.budget_max || '?'}` : null },
    { key: 'firmness', label: 'Firmness', value: ctx.firmness as string },
    { key: 'mattress_type', label: 'Type', value: ctx.mattress_type as string },
    { key: 'sleeping_position', label: 'Sleep', value: ctx.sleeping_position as string },
    { key: 'urgency', label: 'Urgency', value: ctx.urgency as string },
    { key: 'financing', label: 'Financing', value: ctx.financing_interest === true ? 'Yes' : ctx.financing_interest === false ? 'No' : null },
    { key: 'delivery_zip', label: 'ZIP', value: ctx.delivery_zip as string },
    { key: 'trade_in', label: 'Trade-in', value: ctx.trade_in === true ? 'Yes' : null },
  ];
  const filledFields = qualFields.filter((f) => f.value);
  const qualProgress = Math.round((filledFields.length / qualFields.length) * 100);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Link href="/admin" className="text-brand-900 hover:text-brand-700 text-sm font-medium">
            ← Back
          </Link>
          <div className="h-5 w-px bg-gray-300" />
          <h1 className="text-xl font-bold text-gray-900">
            {data.lead.customer_name || data.lead.phone}
          </h1>

          {/* Score badge */}
          <div
            className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${
              isHot ? 'bg-red-100 text-red-700 ring-2 ring-red-300' :
              isWarm ? 'bg-yellow-100 text-yellow-700' :
              'bg-gray-100 text-gray-500'
            }`}
            title={`Lead Score: ${score}`}
          >
            {score}
          </div>

          {isHot && (
            <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold animate-pulse">
              🔥 HOT LEAD
            </span>
          )}

          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            data.status === 'active' ? 'bg-green-100 text-green-800' :
            data.status === 'handed_off' ? 'bg-red-100 text-red-800' :
            data.status === 'follow_up' ? 'bg-yellow-100 text-yellow-800' :
            'bg-gray-100 text-gray-600'
          }`}>
            {data.status === 'handed_off' ? 'Needs You' : data.status.replace('_', ' ')}
          </span>

          <span className="text-xs text-gray-500 bg-gray-50 px-2 py-1 rounded">
            {STATE_LABELS[data.agent_state] || data.agent_state}
          </span>
        </div>

        <div className="flex gap-2">
          {data.status !== 'handed_off' ? (
            <button
              onClick={handleHandoff}
              className="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition"
            >
              Take Over
            </button>
          ) : (
            <button
              onClick={handleResume}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition"
            >
              Resume AI
            </button>
          )}
        </div>
      </div>

      {/* Handed off alert */}
      {data.status === 'handed_off' && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 mb-4 flex items-center gap-3">
          <span className="text-2xl">🙋</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-orange-800">AI is paused — you're in control</p>
            <p className="text-xs text-orange-600">
              {data.handed_off_reason || 'Use the message box below to reply manually. Click "Resume AI" when done.'}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        {/* Messages - Main Column */}
        <div className="col-span-2">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            {/* Message Thread */}
            <div className="h-[520px] overflow-y-auto p-4 space-y-3 bg-gray-50">
              {/* Conversation start marker */}
              <div className="text-center">
                <span className="text-[10px] text-gray-400 bg-gray-100 px-3 py-1 rounded-full">
                  Started {new Date(data.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {data.messages.map((m, i) => {
                // Show date separator if day changes
                const prevMsg = i > 0 ? data.messages[i - 1] : null;
                const showDate = prevMsg && new Date(m.created_at).toDateString() !== new Date(prevMsg.created_at).toDateString();

                return (
                  <div key={m.id}>
                    {showDate && (
                      <div className="text-center my-2">
                        <span className="text-[10px] text-gray-400 bg-gray-100 px-3 py-1 rounded-full">
                          {new Date(m.created_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                    )}
                    <div className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                          m.direction === 'outbound'
                            ? m.sender === 'human'
                              ? 'bg-orange-500 text-white'
                              : 'bg-brand-900 text-white'
                            : 'bg-white border border-gray-200 text-gray-800 shadow-sm'
                        }`}
                      >
                        <div className="whitespace-pre-wrap">{m.body}</div>
                        <div
                          className={`text-[10px] mt-1 flex items-center gap-1 ${
                            m.direction === 'outbound' ? 'text-white/50' : 'text-gray-400'
                          }`}
                        >
                          {m.sender === 'human' ? '👤 You' : m.sender === 'agent' ? '🤖 AI' : '💬 Customer'}
                          {' · '}
                          {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Manual Send */}
            <div className="p-3 border-t border-gray-200 bg-white">
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={manualMessage}
                  onChange={(e) => setManualMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendManual()}
                  placeholder={data.status === 'handed_off' ? 'Type your reply...' : 'Send a manual message...'}
                  className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
                <button
                  onClick={handleSendManual}
                  disabled={sending || !manualMessage.trim()}
                  className="px-5 py-2.5 bg-brand-900 text-white rounded-lg text-sm font-medium hover:bg-brand-800 disabled:opacity-40 transition"
                >
                  {sending ? '...' : 'Send'}
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5 ml-1">
                {manualMessage.length}/160 characters
                {manualMessage.length > 160 && <span className="text-orange-500 ml-1">(will be multi-segment)</span>}
              </p>
            </div>
          </div>

          {/* Recommendations */}
          {data.recommendations.length > 0 && (
            <details className="mt-4 bg-white rounded-xl shadow-sm border border-gray-200 p-4 group">
              {/* Collapsed by default: a long conversation can show a dozen
                  products, and that pushed everything else off the screen. */}
              <summary className="font-semibold text-sm cursor-pointer list-none flex items-center justify-between">
                <span>🛏️ Products Shown ({data.recommendations.length})</span>
                <span className="text-xs font-normal text-gray-400 group-open:hidden">show</span>
                <span className="text-xs font-normal text-gray-400 hidden group-open:inline">hide</span>
              </summary>
              <div className="space-y-2 mt-3">
                {data.recommendations.map((r) => (
                  <div key={r.id} className="flex justify-between items-center p-3 bg-blue-50 rounded-lg text-sm">
                    <div>
                      <span className="font-bold text-brand-900">#{r.rank}</span>{' '}
                      <span className="font-medium">{r.item.brand} {r.item.model}</span>
                      <span className="text-gray-500 ml-2">{r.item.size} · {r.item.firmness}</span>
                    </div>
                    <div className="text-right">
                      {r.item.sale_price ? (
                        <>
                          <span className="font-bold text-green-700">${r.item.sale_price}</span>
                          <span className="text-gray-400 line-through ml-2 text-xs">${r.item.price}</span>
                          <span className="text-green-600 text-xs ml-1">
                            (-${r.item.price - r.item.sale_price})
                          </span>
                        </>
                      ) : (
                        <span className="font-bold">${r.item.price}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        {/* Right Sidebar */}
        <div className="space-y-4">
          {/* Lead Summary Card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">Customer</h3>
              <a
                href={`tel:${data.lead.phone}`}
                className="text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-medium hover:bg-green-200 transition"
              >
                📞 Call
              </a>
            </div>
            <dl className="space-y-2 text-sm">
              <InfoRow label="Phone" value={data.lead.phone} />
              <InfoRow label="Name" value={data.lead.customer_name} />
              <InfoRow label="Email" value={data.lead.email} />
              <InfoRow label="Source" value={data.lead.source} />
              <InfoRow label="Messages" value={String(data.message_count)} />
              <InfoRow label="Follow-ups" value={data.follow_up_count > 0 ? `${data.follow_up_count} sent` : null} />
              <InfoRow label="Started" value={new Date(data.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })} />
            </dl>
          </div>

          {/* Qualification Progress */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">Qualification</h3>
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                qualProgress >= 70 ? 'bg-green-100 text-green-700' :
                qualProgress >= 40 ? 'bg-yellow-100 text-yellow-700' :
                'bg-gray-100 text-gray-500'
              }`}>
                {qualProgress}%
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-gray-100 rounded-full h-1.5 mb-3">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  qualProgress >= 70 ? 'bg-green-500' :
                  qualProgress >= 40 ? 'bg-yellow-500' :
                  'bg-gray-300'
                }`}
                style={{ width: `${qualProgress}%` }}
              />
            </div>

            <div className="space-y-1.5">
              {qualFields.map((f) => (
                <div key={f.key} className="flex items-center justify-between text-sm">
                  <span className={f.value ? 'text-gray-700' : 'text-gray-300'}>{f.label}</span>
                  {f.value ? (
                    <span className="font-medium text-gray-900 bg-brand-50 px-2 py-0.5 rounded text-xs">
                      {f.value.replace(/_/g, ' ')}
                    </span>
                  ) : (
                    <span className="text-gray-300 text-xs">—</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Lead Score Breakdown */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <h3 className="font-semibold text-sm mb-3">Lead Score</h3>
            <div className="flex items-center gap-3 mb-3">
              <div
                className={`w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold ${
                  isHot ? 'bg-red-100 text-red-700 ring-2 ring-red-200' :
                  isWarm ? 'bg-yellow-100 text-yellow-700' :
                  'bg-gray-100 text-gray-500'
                }`}
              >
                {score}
              </div>
              <div>
                <div className={`text-sm font-semibold ${isHot ? 'text-red-700' : isWarm ? 'text-yellow-700' : 'text-gray-500'}`}>
                  {isHot ? '🔥 Hot — Ready to buy' : isWarm ? '🌡️ Warm — Engaged' : '❄️ Cold — Early stage'}
                </div>
                <div className="text-xs text-gray-400">
                  {isHot ? 'Consider calling this customer directly' : isWarm ? 'Keep the conversation going' : 'Needs more qualification'}
                </div>
              </div>
            </div>
          </div>

          {/* Outcome Tracking */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <h3 className="font-semibold text-sm mb-3">Outcome</h3>
            {data.outcome ? (
              <div>
                <div className={`flex items-center gap-2 mb-2 ${data.outcome === 'won' ? 'text-green-700' : 'text-red-600'}`}>
                  <span className="text-lg">{data.outcome === 'won' ? '🎉' : '😔'}</span>
                  <span className="font-bold text-sm">{data.outcome === 'won' ? 'Won — Purchased!' : 'Lost'}</span>
                </div>
                {data.outcome_product && (
                  <p className="text-xs text-gray-600 mb-1">Product: <span className="font-medium">{data.outcome_product}</span></p>
                )}
                {data.outcome_details && (
                  <p className="text-xs text-gray-500 mb-2">{data.outcome_details}</p>
                )}
                {data.outcome_at && (
                  <p className="text-[10px] text-gray-400 mb-2">
                    {new Date(data.outcome_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                )}
                <button
                  onClick={handleClearOutcome}
                  disabled={savingOutcome}
                  className="text-xs text-gray-400 hover:text-gray-600 underline"
                >
                  Clear outcome
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  value={outcomeProduct}
                  onChange={(e) => setOutcomeProduct(e.target.value)}
                  placeholder="What did they buy? (optional)"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs"
                />
                <input
                  type="text"
                  value={outcomeDetails}
                  onChange={(e) => setOutcomeDetails(e.target.value)}
                  placeholder="Notes (optional)"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleOutcome('won')}
                    disabled={savingOutcome}
                    className="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50 transition"
                  >
                    Won
                  </button>
                  <button
                    onClick={() => handleOutcome('lost')}
                    disabled={savingOutcome}
                    className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg text-xs font-medium hover:bg-red-600 disabled:opacity-50 transition"
                  >
                    Lost
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Agent Log (collapsible) */}
          {data.logs.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="w-full p-4 flex items-center justify-between text-sm font-semibold hover:bg-gray-50 transition"
              >
                <span>Agent Log ({data.logs.length})</span>
                <span className="text-gray-400">{showLogs ? '▼' : '▶'}</span>
              </button>
              {showLogs && (
                <div className="px-4 pb-4 space-y-2 max-h-60 overflow-y-auto border-t border-gray-100">
                  {data.logs.slice(0, 20).map((log) => (
                    <div key={log.id} className="text-xs border-b border-gray-50 pb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-brand-900">{log.action.replace(/_/g, ' ')}</span>
                        <span className="text-gray-300">
                          {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      {log.details && Object.keys(log.details).length > 0 && (
                        <div className="text-gray-400 mt-0.5 truncate">
                          {JSON.stringify(log.details).slice(0, 120)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <div className="flex justify-between">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-900">{value}</dd>
    </div>
  );
}
