-- Helper RPC functions for atomic increments

CREATE OR REPLACE FUNCTION increment_messages_used(d_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE dealers SET messages_used = messages_used + 1 WHERE id = d_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION increment_message_count(conv_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE conversations SET message_count = message_count + 1 WHERE id = conv_id;
END;
$$ LANGUAGE plpgsql;

-- Helper view for conversation list with lead details
CREATE OR REPLACE VIEW conversation_overview AS
SELECT
  c.id,
  c.status,
  c.agent_state,
  c.message_count,
  c.follow_up_count,
  c.created_at,
  c.updated_at,
  l.phone,
  l.customer_name,
  l.lead_score,
  l.source,
  l.status as lead_status,
  d.business_name as dealer_name
FROM conversations c
JOIN leads l ON c.lead_id = l.id
JOIN dealers d ON c.dealer_id = d.id
ORDER BY c.updated_at DESC;
