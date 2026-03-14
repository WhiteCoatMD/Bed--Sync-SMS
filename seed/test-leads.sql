-- Sample dealer for testing
INSERT INTO dealers (id, business_name, twilio_phone, owner_name, owner_phone, owner_email, plan, messages_included, overage_rate, monthly_cost, settings)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'Sleep City Mattress',
  '+15551234567',
  'Mike Johnson',
  '+15559876543',
  'mike@sleepcity.com',
  'single_lot',
  1000,
  0.05,
  99.00,
  '{
    "auto_reply": true,
    "follow_up_enabled": true,
    "follow_up_delays": [30, 1440, 4320],
    "max_follow_ups": 3,
    "business_hours_start": "09:00",
    "business_hours_end": "20:00",
    "timezone": "America/Chicago",
    "greeting_style": "friendly",
    "store_address": "1234 Main St, Dallas, TX 75201",
    "financing_url": "https://example.com/apply",
    "deposit_url": "https://example.com/deposit",
    "handoff_phone": "+15559876543"
  }'::jsonb
);

-- Sample leads for testing
INSERT INTO leads (dealer_id, phone, customer_name, email, source, status, lead_score, qualification) VALUES
('a0000000-0000-0000-0000-000000000001', '+15551111111', 'Sarah Chen', 'sarah@example.com', 'website', 'qualifying', 35,
 '{"mattress_size": "queen", "budget_max": 800, "firmness": "medium"}'),
('a0000000-0000-0000-0000-000000000001', '+15552222222', 'James Wilson', NULL, 'facebook', 'new', 5, '{}'),
('a0000000-0000-0000-0000-000000000001', '+15553333333', 'Maria Garcia', 'maria@example.com', 'google', 'hot', 75,
 '{"mattress_size": "king", "budget_max": 1500, "firmness": "medium_firm", "urgency": "immediate", "financing_interest": true}');
