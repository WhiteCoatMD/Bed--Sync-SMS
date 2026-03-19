'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ConversationRow {
  id: string;
  status: string;
  agent_state: string;
  message_count: number;
  follow_up_count: number;
  updated_at: string;
  created_at: string;
  lead: {
    id: string;
    phone: string;
    customer_name: string | null;
    source: string;
    status: string;
    lead_score: number;
    qualification: Record<string, unknown>;
  };
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  follow_up: 'bg-yellow-100 text-yellow-800',
  handed_off: 'bg-red-100 text-red-800',
  closed: 'bg-gray-100 text-gray-600',
  paused: 'bg-blue-100 text-blue-800',
};

const STATE_LABELS: Record<string, string> = {
  greeting: 'Greeting',
  qualifying: 'Qualifying',
  recommending: 'Recommending',
  objection_handling: 'Objections',
  closing: 'Closing',
  follow_up: 'Follow-up',
  handed_off: 'Handed Off',
  converted: 'Converted',
  lost: 'Lost',
};

export default function AdminDashboard() {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>('');
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    authenticateDealer();
  }, []);

  useEffect(() => {
    if (dealerId) {
      fetchConversations();
    }
  }, [filter, dealerId]);

  async function authenticateDealer() {
    // Get auth token from URL param (passed from main Bed Sync app) or localStorage
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');

    if (tokenParam) {
      localStorage.setItem('sms_auth_token', tokenParam);
      // Clean URL
      window.history.replaceState({}, '', '/admin');
    }

    const token = localStorage.getItem('sms_auth_token') || localStorage.getItem('auth_token');
    if (!token) {
      setAuthError('Not authenticated. Please access this page from your Bed Sync admin panel.');
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();

      if (data.success && data.dealer_id) {
        setDealerId(data.dealer_id);
        setBusinessName(data.business_name || '');
      } else {
        setAuthError(data.error || 'SMS agent not enabled for this account.');
      }
    } catch (err) {
      setAuthError('Authentication failed. Please try again from Bed Sync.');
    }
    setLoading(false);
  }

  async function fetchConversations() {
    if (!dealerId) return;
    setLoading(true);
    try {
      let url = `/api/conversations?dealer_id=${dealerId}`;
      if (filter) url += `&status=${filter}`;
      const res = await fetch(url);
      const data = await res.json();
      setConversations(data.conversations || []);
    } catch (err) {
      console.error('Fetch error:', err);
    }
    setLoading(false);
  }

  if (authError) {
    return (
      <div className="text-center py-20">
        <div className="text-6xl mb-4">🔒</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Access Required</h1>
        <p className="text-gray-500 max-w-md mx-auto">{authError}</p>
        <a
          href="https://www.bed-sync.com/admin.html"
          className="inline-block mt-6 px-6 py-2 bg-brand-900 text-white rounded-lg hover:bg-brand-700 transition"
        >
          Go to Bed Sync Admin
        </a>
      </div>
    );
  }

  const counts = {
    all: conversations.length,
    active: conversations.filter((c) => c.status === 'active').length,
    handed_off: conversations.filter((c) => c.status === 'handed_off').length,
    follow_up: conversations.filter((c) => c.status === 'follow_up').length,
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Conversations</h1>
          {businessName && <p className="text-sm text-gray-500">{businessName}</p>}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">Filter:</span>
          {['', 'active', 'handed_off', 'follow_up', 'closed'].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1 rounded-full transition-colors ${
                filter === s
                  ? 'bg-brand-900 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              {s || 'All'} {s === '' ? `(${counts.all})` : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Active" value={counts.active} color="text-green-600" />
        <StatCard label="Needs Attention" value={counts.handed_off} color="text-red-600" />
        <StatCard label="Following Up" value={counts.follow_up} color="text-yellow-600" />
        <StatCard label="Total" value={counts.all} color="text-brand-900" />
      </div>

      {/* Conversation List */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : conversations.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          No conversations yet. Send a test lead to get started.
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">Messages</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Last Activity</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="font-semibold text-sm">
                      {c.lead.customer_name || 'Unknown'}
                    </div>
                    <div className="text-xs text-gray-500">{c.lead.phone}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-medium px-2 py-1 rounded-full ${
                        STATUS_COLORS[c.status] || 'bg-gray-100'
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {STATE_LABELS[c.agent_state] || c.agent_state}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-sm font-bold ${
                        c.lead.lead_score >= 70
                          ? 'text-red-600'
                          : c.lead.lead_score >= 40
                          ? 'text-yellow-600'
                          : 'text-gray-500'
                      }`}
                    >
                      {c.lead.lead_score}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {c.message_count}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {c.lead.source}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {timeAgo(c.updated_at)}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/conversations/${c.id}`}
                      className="text-sm text-brand-900 hover:text-brand-700 font-medium"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-white rounded-lg p-4 border border-gray-200 shadow-sm">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-sm text-gray-500">{label}</div>
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
