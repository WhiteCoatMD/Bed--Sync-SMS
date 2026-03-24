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

const STATE_ICONS: Record<string, string> = {
  greeting: '👋',
  qualifying: '❓',
  recommending: '🛏️',
  objection_handling: '🤔',
  closing: '🤝',
  follow_up: '📲',
  handed_off: '🙋',
  converted: '✅',
  lost: '❌',
};

export default function AdminDashboard() {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [allConversations, setAllConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'updated' | 'score' | 'messages'>('updated');

  useEffect(() => {
    authenticateDealer();
  }, []);

  useEffect(() => {
    if (dealerId) {
      fetchConversations();
      // Auto-refresh every 15 seconds
      const interval = setInterval(fetchConversations, 15000);
      return () => clearInterval(interval);
    }
  }, [dealerId]);

  // Client-side filter and search
  useEffect(() => {
    let filtered = [...allConversations];

    // Status filter
    if (filter) {
      filtered = filtered.filter((c) => c.status === filter);
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (c) =>
          (c.lead.customer_name || '').toLowerCase().includes(q) ||
          c.lead.phone.includes(q) ||
          c.lead.source.toLowerCase().includes(q)
      );
    }

    // Sort
    if (sortBy === 'score') {
      filtered.sort((a, b) => b.lead.lead_score - a.lead.lead_score);
    } else if (sortBy === 'messages') {
      filtered.sort((a, b) => b.message_count - a.message_count);
    } else {
      filtered.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    }

    setConversations(filtered);
  }, [allConversations, filter, searchQuery, sortBy]);

  async function authenticateDealer() {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');

    if (tokenParam) {
      localStorage.setItem('sms_auth_token', tokenParam);
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
    } catch {
      setAuthError('Authentication failed. Please try again from Bed Sync.');
    }
    setLoading(false);
  }

  async function fetchConversations() {
    if (!dealerId) return;
    try {
      const res = await fetch(`/api/conversations?dealer_id=${dealerId}&limit=200`);
      const data = await res.json();
      setAllConversations(data.conversations || []);
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

  const allCounts = {
    all: allConversations.length,
    active: allConversations.filter((c) => c.status === 'active').length,
    handed_off: allConversations.filter((c) => c.status === 'handed_off').length,
    follow_up: allConversations.filter((c) => c.status === 'follow_up').length,
    closed: allConversations.filter((c) => c.status === 'closed').length,
    converted: allConversations.filter((c) => c.agent_state === 'converted').length,
    hot: allConversations.filter((c) => c.lead.lead_score >= 70).length,
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Conversations</h1>
          {businessName && <p className="text-sm text-gray-500">{businessName}</p>}
        </div>
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name or phone..."
              className="pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 w-56"
            />
            <svg className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          {/* Sort */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'updated' | 'score' | 'messages')}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="updated">Recent Activity</option>
            <option value="score">Highest Score</option>
            <option value="messages">Most Messages</option>
          </select>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-6 gap-3 mb-6">
        <StatCard label="Active" value={allCounts.active} color="text-green-600" icon="💬" />
        <StatCard label="Hot Leads" value={allCounts.hot} color="text-red-600" icon="🔥" />
        <StatCard label="Needs You" value={allCounts.handed_off} color="text-orange-600" icon="🙋" />
        <StatCard label="Following Up" value={allCounts.follow_up} color="text-yellow-600" icon="📲" />
        <StatCard label="Converted" value={allCounts.converted} color="text-emerald-600" icon="✅" />
        <StatCard label="Total" value={allCounts.all} color="text-brand-900" icon="📊" />
      </div>

      {/* Status Filters */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-gray-500 font-medium">Filter:</span>
        {[
          { key: '', label: 'All', count: allCounts.all },
          { key: 'active', label: 'Active', count: allCounts.active },
          { key: 'handed_off', label: 'Handed Off', count: allCounts.handed_off },
          { key: 'follow_up', label: 'Follow-up', count: allCounts.follow_up },
          { key: 'closed', label: 'Closed', count: allCounts.closed },
        ].map((s) => (
          <button
            key={s.key}
            onClick={() => setFilter(s.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === s.key
                ? 'bg-brand-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s.label} ({s.count})
          </button>
        ))}
      </div>

      {/* Conversation List */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : conversations.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">📱</div>
          <p className="text-gray-400">
            {searchQuery ? 'No conversations match your search.' : 'No conversations yet. Send a test lead to get started.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {conversations.map((c) => (
            <Link
              key={c.id}
              href={`/admin/conversations/${c.id}`}
              className="block bg-white rounded-xl border border-gray-200 hover:border-brand-300 hover:shadow-md transition-all p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  {/* Score Circle */}
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                      c.lead.lead_score >= 70
                        ? 'bg-red-100 text-red-700 ring-2 ring-red-300'
                        : c.lead.lead_score >= 40
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {c.lead.lead_score}
                  </div>

                  {/* Customer Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900 truncate">
                        {c.lead.customer_name || 'Unknown'}
                      </span>
                      {c.lead.lead_score >= 70 && (
                        <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">
                          HOT
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                      <span>{c.lead.phone}</span>
                      <span>·</span>
                      <span>{c.message_count} msgs</span>
                      <span>·</span>
                      <span>{c.lead.source}</span>
                    </div>
                  </div>
                </div>

                {/* Right side: status + stage + time */}
                <div className="flex items-center gap-3 shrink-0">
                  {/* Qualification preview */}
                  <div className="hidden md:flex items-center gap-1.5 text-xs text-gray-400">
                    {getQualTag(c.lead.qualification, 'mattress_size')}
                    {getQualTag(c.lead.qualification, 'budget_max', true)}
                    {getQualTag(c.lead.qualification, 'firmness')}
                  </div>

                  {/* Stage */}
                  <span className="text-xs bg-gray-50 px-2 py-1 rounded text-gray-600 whitespace-nowrap">
                    {STATE_ICONS[c.agent_state] || ''} {STATE_LABELS[c.agent_state] || c.agent_state}
                  </span>

                  {/* Status badge */}
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap ${
                      STATUS_COLORS[c.status] || 'bg-gray-100'
                    }`}
                  >
                    {c.status === 'handed_off' ? 'Needs You' : c.status.replace('_', ' ')}
                  </span>

                  {/* Time */}
                  <span className="text-xs text-gray-400 w-14 text-right">{timeAgo(c.updated_at)}</span>

                  {/* Arrow */}
                  <svg className="h-4 w-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Results count */}
      {!loading && conversations.length > 0 && (
        <p className="text-xs text-gray-400 mt-4 text-center">
          Showing {conversations.length} of {allCounts.all} conversations
        </p>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number;
  color: string;
  icon: string;
}) {
  return (
    <div className="bg-white rounded-lg p-4 border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="text-lg">{icon}</span>
        <span className={`text-2xl font-bold ${color}`}>{value}</span>
      </div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function getQualTag(qual: Record<string, unknown>, key: string, isBudget = false) {
  const val = qual?.[key];
  if (!val) return null;
  const display = isBudget ? `$${String(val)}` : String(val).replace(/_/g, ' ');
  return <span className="bg-gray-100 px-2 py-0.5 rounded">{display}</span>;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
