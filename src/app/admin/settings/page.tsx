'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface DealerData {
  id: string;
  business_name: string;
  twilio_phone: string | null;
  plan: string;
  messages_used: number;
  messages_included: number;
  settings: Record<string, unknown>;
}

export default function SettingsPage() {
  const [dealer, setDealer] = useState<DealerData | null>(null);
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Settings form state
  const [autoReply, setAutoReply] = useState(true);
  const [showPricing, setShowPricing] = useState(true);
  const [followUpEnabled, setFollowUpEnabled] = useState(true);
  const [maxFollowUps, setMaxFollowUps] = useState(3);
  const [greetingStyle, setGreetingStyle] = useState('friendly');
  const [storeAddress, setStoreAddress] = useState('');
  const [financingUrl, setFinancingUrl] = useState('');
  const [depositUrl, setDepositUrl] = useState('');
  const [handoffPhone, setHandoffPhone] = useState('');
  const [currentPromotions, setCurrentPromotions] = useState('');
  type Promo = { text: string; starts: string; ends: string; inStoreOnly: boolean };
  const [promos, setPromos] = useState<Promo[]>([]);
  const [hoursStart, setHoursStart] = useState('09:00');
  const [hoursEnd, setHoursEnd] = useState('20:00');

  type DayHours = { open: boolean; start: string; end: string };
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const defaultDayHours = (): Record<string, DayHours> => ({
    '0': { open: false, start: '09:00', end: '18:00' },
    '1': { open: true,  start: '09:00', end: '18:00' },
    '2': { open: true,  start: '09:00', end: '18:00' },
    '3': { open: true,  start: '09:00', end: '18:00' },
    '4': { open: true,  start: '09:00', end: '18:00' },
    '5': { open: true,  start: '09:00', end: '18:00' },
    '6': { open: true,  start: '09:00', end: '20:00' },
  });
  const [dayHours, setDayHours] = useState<Record<string, DayHours>>(defaultDayHours());

  useEffect(() => {
    authenticate();
  }, []);

  async function authenticate() {
    const token = localStorage.getItem('sms_auth_token') || localStorage.getItem('auth_token');
    if (!token) {
      setAuthError('Not authenticated.');
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
        loadSettings(data.dealer_id);
      } else {
        setAuthError('SMS agent not enabled for this account.');
        setLoading(false);
      }
    } catch {
      setAuthError('Authentication failed.');
      setLoading(false);
    }
  }

  async function loadSettings(id: string) {
    try {
      const res = await fetch(`/api/dealers/settings?dealer_id=${id}`);
      const data = await res.json();
      if (data.success && data.dealer) {
        setDealer(data.dealer);
        const s = data.dealer.settings || {};
        setAutoReply(s.auto_reply !== false);
        setShowPricing(s.show_pricing !== false);
        setFollowUpEnabled(s.follow_up_enabled !== false);
        setMaxFollowUps(s.max_follow_ups || 3);
        setGreetingStyle(s.greeting_style || 'friendly');
        setStoreAddress(s.store_address || '');
        setFinancingUrl(s.financing_url || '');
        setDepositUrl(s.deposit_url || '');
        setHandoffPhone(s.handoff_phone || '');
        setCurrentPromotions(s.current_promotions || '');
        if (s.promotions && Array.isArray(s.promotions)) {
          setPromos(s.promotions as Promo[]);
        }
        setHoursStart(s.business_hours_start || '09:00');
        setHoursEnd(s.business_hours_end || '20:00');
        if (s.day_hours) {
          setDayHours(s.day_hours as Record<string, DayHours>);
        }
      }
    } catch (err) {
      console.error('Load settings error:', err);
    }
    setLoading(false);
  }

  async function saveSettings() {
    if (!dealerId) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch('/api/dealers/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealer_id: dealerId,
          settings: {
            auto_reply: autoReply,
            show_pricing: showPricing,
            follow_up_enabled: followUpEnabled,
            max_follow_ups: maxFollowUps,
            greeting_style: greetingStyle,
            store_address: storeAddress,
            financing_url: financingUrl,
            deposit_url: depositUrl,
            handoff_phone: handoffPhone,
            current_promotions: currentPromotions,
            promotions: promos.filter(p => p.text.trim()),
            business_hours_start: hoursStart,
            business_hours_end: hoursEnd,
            day_hours: dayHours,
          },
        }),
      });
      const data = await res.json();
      if (data.success) setSaved(true);
    } catch (err) {
      alert('Failed to save settings');
    }
    setSaving(false);
  }

  async function syncInventory() {
    if (!dealerId) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/inventory/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('sms_auth_token') || localStorage.getItem('auth_token') || ''}`,
          'x-api-key': process.env.NEXT_PUBLIC_BEDSYNC_API_KEY || '',
        },
        body: JSON.stringify({ dealer_id: dealerId }),
      });
      const data = await res.json();
      if (data.success) {
        setSyncResult(`Synced ${data.synced} items from inventory`);
      } else {
        setSyncResult('Sync failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      setSyncResult('Sync error');
    }
    setSyncing(false);
  }

  if (authError) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500">{authError}</p>
        <a href="https://www.bed-sync.com/admin.html" className="mt-4 inline-block text-brand-900 underline">
          Go to Bed Sync Admin
        </a>
      </div>
    );
  }

  if (loading) return <div className="text-center py-12 text-gray-400">Loading...</div>;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">SMS Agent Settings</h1>
        <Link href="/admin" className="text-sm text-brand-900 hover:underline">
          Back to Conversations
        </Link>
      </div>

      {dealer && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <div className="font-semibold">{dealer.business_name}</div>
          <div className="text-sm text-gray-600">
            {dealer.twilio_phone || 'No phone assigned'} | {dealer.plan} plan |{' '}
            {dealer.messages_used}/{dealer.messages_included} messages used
          </div>
        </div>
      )}

      <div className="space-y-6">
        {/* AI Behavior */}
        <Section title="AI Behavior">
          <Toggle label="Auto-reply to incoming messages" value={autoReply} onChange={setAutoReply} />
          <Toggle label="Share pricing in conversations" value={showPricing} onChange={setShowPricing} />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Greeting Style</label>
            <select
              value={greetingStyle}
              onChange={(e) => setGreetingStyle(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="casual">Casual</option>
            </select>
          </div>
        </Section>

        {/* Follow-ups */}
        <Section title="Follow-ups">
          <Toggle label="Enable automatic follow-ups" value={followUpEnabled} onChange={setFollowUpEnabled} />
          {followUpEnabled && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Max follow-up messages</label>
              <select
                value={maxFollowUps}
                onChange={(e) => setMaxFollowUps(parseInt(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={5}>5</option>
              </select>
            </div>
          )}
        </Section>

        {/* Store Info */}
        <Section title="Store Information">
          <Input label="Store Address" value={storeAddress} onChange={setStoreAddress} placeholder="1234 Main St, City, ST 12345" />
          <Input label="Handoff Phone" value={handoffPhone} onChange={setHandoffPhone} placeholder="+1234567890" />
          <Input label="Financing URL" value={financingUrl} onChange={setFinancingUrl} placeholder="https://..." />
          <Input label="Deposit/Payment URL" value={depositUrl} onChange={setDepositUrl} placeholder="https://..." />
        </Section>

        {/* Promotions */}
        <Section title="Current Specials & Promotions">
          <p className="text-sm text-gray-600 -mt-2 mb-3">
            Add your active sales and specials. The AI will mention them naturally when relevant. Remove old promos when they expire.
          </p>
          {promos.map((promo, idx) => (
            <div key={idx} className="bg-gray-50 rounded-lg p-3 mb-3 border border-gray-200">
              <div className="flex items-start gap-2 mb-2">
                <textarea
                  value={promo.text}
                  onChange={(e) => { const p = [...promos]; p[idx] = { ...p[idx], text: e.target.value }; setPromos(p); }}
                  placeholder="e.g., 20% off all hybrids — showroom only"
                  rows={2}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none"
                />
                <button
                  type="button"
                  onClick={() => setPromos(promos.filter((_, i) => i !== idx))}
                  className="text-red-400 hover:text-red-600 text-lg px-1"
                  title="Remove"
                >×</button>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-gray-500">Starts</label>
                  <input
                    type="date"
                    value={promo.starts}
                    onChange={(e) => { const p = [...promos]; p[idx] = { ...p[idx], starts: e.target.value }; setPromos(p); }}
                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-gray-500">Ends</label>
                  <input
                    type="date"
                    value={promo.ends}
                    onChange={(e) => { const p = [...promos]; p[idx] = { ...p[idx], ends: e.target.value }; setPromos(p); }}
                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                  />
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={promo.inStoreOnly}
                    onChange={(e) => { const p = [...promos]; p[idx] = { ...p[idx], inStoreOnly: e.target.checked }; setPromos(p); }}
                    className="w-4 h-4"
                  />
                  <span className="text-xs text-gray-600">In-store only</span>
                </label>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setPromos([...promos, { text: '', starts: '', ends: '', inStoreOnly: false }])}
            className="text-sm text-brand-900 font-medium hover:underline"
          >
            + Add Promotion
          </button>
        </Section>

        {/* Business Hours */}
        <Section title="Business Hours">
          <p className="text-xs text-gray-500 -mt-2 mb-2">The AI will only auto-reply during open hours. Toggle days closed for days your store is not open.</p>
          <div className="space-y-2">
            {DAY_NAMES.map((name, idx) => {
              const key = String(idx);
              const day = dayHours[key] || { open: true, start: '09:00', end: '18:00' };
              return (
                <div key={key} className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setDayHours(prev => ({ ...prev, [key]: { ...day, open: !day.open } }))}
                    className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${day.open ? 'bg-brand-900' : 'bg-gray-300'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.open ? 'translate-x-5' : ''}`} />
                  </button>
                  <span className={`text-sm w-24 ${day.open ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>{name}</span>
                  {day.open ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={day.start}
                        onChange={(e) => setDayHours(prev => ({ ...prev, [key]: { ...day, start: e.target.value } }))}
                        className="border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                      <span className="text-gray-400 text-sm">to</span>
                      <input
                        type="time"
                        value={day.end}
                        onChange={(e) => setDayHours(prev => ({ ...prev, [key]: { ...day, end: e.target.value } }))}
                        className="border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400 italic">Closed</span>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        {/* Inventory */}
        <Section title="Inventory">
          <p className="text-sm text-gray-600 mb-3">
            Sync your Bed Sync inventory so the AI can recommend real products with accurate pricing.
          </p>
          <button
            onClick={syncInventory}
            disabled={syncing}
            className="px-4 py-2 bg-brand-900 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            {syncing ? 'Syncing...' : 'Sync Inventory Now'}
          </button>
          {syncResult && (
            <p className={`text-sm mt-2 ${syncResult.includes('failed') || syncResult.includes('error') ? 'text-red-600' : 'text-green-600'}`}>
              {syncResult}
            </p>
          )}
        </Section>

        {/* Save */}
        <div className="flex items-center gap-4 pt-4 border-t">
          <button
            onClick={saveSettings}
            disabled={saving}
            className="px-6 py-2 bg-brand-900 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {saved && <span className="text-green-600 text-sm font-medium">Settings saved!</span>}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-sm text-gray-700">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative w-11 h-6 rounded-full transition-colors ${value ? 'bg-brand-900' : 'bg-gray-300'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            value ? 'translate-x-5' : ''
          }`}
        />
      </button>
    </label>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
      />
    </div>
  );
}
