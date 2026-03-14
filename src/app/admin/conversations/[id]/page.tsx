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
  message_count: number;
  created_at: string;
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

export default function ConversationDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualMessage, setManualMessage] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchDetail();
    const interval = setInterval(fetchDetail, 10000); // poll every 10s
    return () => clearInterval(interval);
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.messages]);

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
    const reason = prompt('Reason for handoff:');
    if (!reason) return;
    await fetch(`/api/conversations/${id}/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
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
  }

  if (loading) return <div className="text-center py-12 text-gray-400">Loading...</div>;
  if (!data) return <div className="text-center py-12 text-red-500">Conversation not found.</div>;

  const ctx = data.context;
  const qual = data.lead.qualification;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-brand-900 hover:text-brand-700 text-sm">
            &larr; Back
          </Link>
          <h1 className="text-xl font-bold">
            {data.lead.customer_name || data.lead.phone}
          </h1>
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${
            data.status === 'active' ? 'bg-green-100 text-green-800' :
            data.status === 'handed_off' ? 'bg-red-100 text-red-800' :
            'bg-gray-100 text-gray-600'
          }`}>
            {data.status}
          </span>
          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
            {data.agent_state}
          </span>
        </div>
        <div className="flex gap-2">
          {data.status !== 'handed_off' ? (
            <button
              onClick={handleHandoff}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
            >
              Hand Off to Human
            </button>
          ) : (
            <button
              onClick={handleResume}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
            >
              Resume AI
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Messages - Main Column */}
        <div className="col-span-2">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            {/* Message Thread */}
            <div className="h-[500px] overflow-y-auto p-4 space-y-3 bg-gray-50">
              {data.messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                      m.direction === 'outbound'
                        ? m.sender === 'human'
                          ? 'bg-orange-500 text-white'
                          : 'bg-brand-900 text-white'
                        : 'bg-white border border-gray-200 text-gray-800'
                    }`}
                  >
                    <div>{m.body}</div>
                    <div
                      className={`text-[10px] mt-1 ${
                        m.direction === 'outbound' ? 'text-white/60' : 'text-gray-400'
                      }`}
                    >
                      {m.sender === 'human' ? 'You' : m.sender === 'agent' ? 'AI' : 'Customer'}
                      {' '}
                      {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Manual Send */}
            <div className="p-3 border-t border-gray-200 bg-white">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualMessage}
                  onChange={(e) => setManualMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendManual()}
                  placeholder="Type a message to send manually..."
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  onClick={handleSendManual}
                  disabled={sending || !manualMessage.trim()}
                  className="px-4 py-2 bg-brand-900 text-white rounded-lg text-sm font-medium hover:bg-brand-800 disabled:opacity-50"
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          </div>

          {/* Recommendations */}
          {data.recommendations.length > 0 && (
            <div className="mt-4 bg-white rounded-xl shadow-sm border border-gray-200 p-4">
              <h3 className="font-semibold text-sm mb-3">Recommendations Shown</h3>
              <div className="space-y-2">
                {data.recommendations.map((r) => (
                  <div key={r.id} className="flex justify-between items-center p-3 bg-blue-50 rounded-lg text-sm">
                    <div>
                      <span className="font-medium">#{r.rank}</span>{' '}
                      {r.item.brand} {r.item.model} - {r.item.size}
                    </div>
                    <div className="text-right">
                      <span className="font-bold">
                        ${r.item.sale_price || r.item.price}
                      </span>
                      {r.item.sale_price && (
                        <span className="text-gray-400 line-through ml-2 text-xs">
                          ${r.item.price}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Sidebar */}
        <div className="space-y-4">
          {/* Lead Info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <h3 className="font-semibold text-sm mb-3">Lead Info</h3>
            <dl className="space-y-2 text-sm">
              <InfoRow label="Phone" value={data.lead.phone} />
              <InfoRow label="Name" value={data.lead.customer_name} />
              <InfoRow label="Email" value={data.lead.email} />
              <InfoRow label="Source" value={data.lead.source} />
              <InfoRow label="Score" value={String(data.lead.lead_score)} highlight={data.lead.lead_score >= 70} />
              <InfoRow label="Messages" value={String(data.message_count)} />
              <InfoRow label="Follow-ups" value={String(data.follow_up_count)} />
            </dl>
          </div>

          {/* Qualification */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <h3 className="font-semibold text-sm mb-3">Qualification</h3>
            <dl className="space-y-2 text-sm">
              <InfoRow label="Size" value={ctx.mattress_size as string} />
              <InfoRow label="Budget" value={
                (ctx.budget_min || ctx.budget_max)
                  ? `$${ctx.budget_min || '?'} - $${ctx.budget_max || '?'}`
                  : null
              } />
              <InfoRow label="Firmness" value={ctx.firmness as string} />
              <InfoRow label="Type" value={ctx.mattress_type as string} />
              <InfoRow label="Sleep Position" value={ctx.sleeping_position as string} />
              <InfoRow label="Urgency" value={ctx.urgency as string} />
              <InfoRow label="Financing" value={
                ctx.financing_interest === true ? 'Interested' :
                ctx.financing_interest === false ? 'Not interested' : null
              } />
              <InfoRow label="Delivery ZIP" value={ctx.delivery_zip as string} />
              <InfoRow label="Trade-in" value={ctx.trade_in === true ? 'Yes' : null} />
            </dl>
          </div>

          {/* Agent Notes */}
          {data.logs.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
              <h3 className="font-semibold text-sm mb-3">Agent Log</h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {data.logs.slice(0, 15).map((log) => (
                  <div key={log.id} className="text-xs border-b border-gray-100 pb-2">
                    <span className="font-medium text-brand-900">{log.action}</span>
                    <span className="text-gray-400 ml-2">
                      {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {log.details && Object.keys(log.details).length > 0 && (
                      <div className="text-gray-500 mt-1 truncate">
                        {JSON.stringify(log.details).slice(0, 100)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Handoff Info */}
          {data.status === 'handed_off' && data.handed_off_reason && (
            <div className="bg-red-50 rounded-xl border border-red-200 p-4">
              <h3 className="font-semibold text-sm text-red-800 mb-2">Handed Off</h3>
              <p className="text-sm text-red-700">{data.handed_off_reason}</p>
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
  highlight,
}: {
  label: string;
  value: string | null | undefined;
  highlight?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex justify-between">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`font-medium ${highlight ? 'text-red-600' : 'text-gray-900'}`}>
        {value}
      </dd>
    </div>
  );
}
