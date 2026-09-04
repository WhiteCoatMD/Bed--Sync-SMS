// ============================================
// Core Entity Types
// ============================================

export type Plan = 'single_lot' | 'multi_lot';

export type LeadSource = 'website' | 'facebook' | 'google' | 'manual' | 'referral' | 'walk_in' | 'other';
export type LeadStatus = 'new' | 'qualifying' | 'qualified' | 'hot' | 'converted' | 'lost' | 'handed_off';

export type ConversationStatus = 'active' | 'paused' | 'handed_off' | 'closed' | 'follow_up';
export type AgentState =
  | 'greeting'
  | 'qualifying'
  | 'recommending'
  | 'objection_handling'
  | 'closing'
  | 'follow_up'
  | 'handed_off'
  | 'converted'
  | 'lost';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageSender = 'customer' | 'agent' | 'human';

export type MattressSize = 'twin' | 'twin_xl' | 'full' | 'queen' | 'king' | 'cal_king' | 'split_king';
export type Firmness = 'soft' | 'medium_soft' | 'medium' | 'medium_firm' | 'firm' | 'extra_firm';
export type MattressType = 'innerspring' | 'memory_foam' | 'hybrid' | 'latex' | 'adjustable' | 'pillow_top' | 'gel_foam';

export type FollowUpStatus = 'pending' | 'sent' | 'cancelled' | 'failed';
export type AgentLogAction =
  | 'tool_call' | 'state_change' | 'handoff' | 'follow_up_scheduled'
  | 'follow_up_sent' | 'recommendation' | 'message_sent' | 'message_received'
  | 'error' | 'resume' | 'lead_scored';

// ============================================
// Database Row Types
// ============================================

export interface Dealer {
  id: string;
  business_name: string;
  twilio_phone: string | null;
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  plan: Plan;
  messages_used: number;
  messages_included: number;
  overage_rate: number;
  monthly_cost: number;
  billing_cycle_start: string;
  active: boolean;
  settings: DealerSettings;
  created_at: string;
  updated_at: string;
}

export interface Promotion {
  text: string;
  starts: string; // YYYY-MM-DD
  ends: string;   // YYYY-MM-DD
  inStoreOnly: boolean;
}

export interface DayHours {
  open: boolean;
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

export interface DealerSettings {
  auto_reply: boolean;
  follow_up_enabled: boolean;
  follow_up_delays: number[]; // minutes: [30, 1440, 4320]
  max_follow_ups: number;
  /** Legacy flat hours — used when day_hours is absent */
  business_hours_start: string;
  business_hours_end: string;
  /** Per-day hours. Keys: 0=Sun, 1=Mon, …, 6=Sat */
  day_hours?: Record<string, DayHours>;
  timezone: string;
  greeting_style: string;
  store_address: string;
  /**
   * Dealer will ship to a customer outside driving range. Off unless the dealer
   * says otherwise: shipping a mattress across the country is a commitment we
   * must never make on their behalf.
   */
  ships_nationwide?: boolean;
  /**
   * The store has no walk-in showroom — every visit is a booked appointment.
   * True for Mattress By Appointment dealers. The agent still invites people in
   * to lie on a mattress; it just has to say a time gets booked first, or we
   * send someone to a locked door.
   */
  appointment_only?: boolean;
  /**
   * A seeded storefront that must never send a real message. Its leads carry
   * placeholder numbers. Checked by routing, number provisioning and reminders;
   * declared here so the next sender does not have to rediscover it.
   */
  demo?: boolean;
  store_phone: string;
  store_website: string;
  current_promotions: string;
  promotions?: Promotion[];
  financing_url: string;
  deposit_url: string;
  handoff_phone: string;
  show_pricing: boolean;
  missed_call_text: boolean;
  after_hours_reply: boolean;
  after_hours_message: string;
}

export interface Lead {
  id: string;
  dealer_id: string;
  phone: string;
  customer_name: string | null;
  email: string | null;
  source: LeadSource;
  status: LeadStatus;
  lead_score: number;
  qualification: QualificationData;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface QualificationData {
  mattress_size?: MattressSize;
  budget_min?: number;
  budget_max?: number;
  firmness?: Firmness;
  sleeping_position?: string;
  mattress_type?: MattressType;
  urgency?: string;
  financing_interest?: boolean;
  delivery_zip?: string;
  store_location?: string;
  trade_in?: boolean;
  preferred_next_step?: string;
}

export interface Conversation {
  id: string;
  lead_id: string;
  dealer_id: string;
  status: ConversationStatus;
  agent_state: AgentState;
  context: ConversationContext;
  follow_up_count: number;
  next_follow_up_at: string | null;
  handed_off_at: string | null;
  handed_off_reason: string | null;
  handoff_acknowledged_at: string | null;
  outcome: 'won' | 'lost' | null;
  outcome_details: string | null;
  outcome_product: string | null;
  outcome_at: string | null;
  closed_at: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationContext {
  /** The mattress they clicked on the storefront before getting in touch. */
  interest_serial?: string;
  interest_title?: string;
  customer_name: string | null;
  mattress_size: MattressSize | null;
  budget_min: number | null;
  budget_max: number | null;
  firmness: Firmness | null;
  sleeping_position: string | null;
  mattress_type: MattressType | null;
  urgency: string | null;
  financing_interest: boolean | null;
  delivery_zip: string | null;
  /** Routed as a ship-to-customer conversation: there is no store in range. */
  ship_to_customer?: boolean | null;
  store_location: string | null;
  trade_in: boolean | null;
  preferred_next_step: string | null;
  objections: string[];
  recommendations_shown: string[];
  agent_notes: string[];
  /** Set when this conversation continues from an earlier one (see agent/returning.ts). */
  returning_summary?: string | null;
  /** Model names already presented. Tracked by model because each one exists once per size. */
  models_shown?: string[];
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  sender: MessageSender;
  body: string;
  twilio_sid: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface InventoryItem {
  id: string;
  dealer_id: string;
  brand: string;
  model: string;
  series: string | null;
  size: MattressSize;
  firmness: Firmness | null;
  type: MattressType | null;
  price: number;
  sale_price: number | null;
  msrp: number | null;
  in_stock: boolean;
  quantity: number;
  features: string[];
  description: string | null;
  financing_eligible: boolean;
  promotion: string | null;
  image_url: string | null;
  sku: string | null;
  building_serial: string | null;
  created_at: string;
  updated_at: string;
}

export interface Recommendation {
  id: string;
  conversation_id: string;
  inventory_id: string;
  rank: number;
  reason: string | null;
  customer_response: string | null;
  presented_at: string;
  // joined
  item?: InventoryItem;
}

export interface AgentLog {
  id: string;
  conversation_id: string;
  action: AgentLogAction;
  details: Record<string, unknown>;
  created_at: string;
}

export interface Appointment {
  id: string;
  conversation_id: string;
  dealer_id: string;
  lead_id: string;
  type: 'showroom_visit' | 'phone_call' | 'delivery' | 'other';
  scheduled_at: string;
  duration_minutes: number;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  notes: string | null;
  created_by: 'agent' | 'human';
  created_at: string;
  updated_at: string;
}

export interface FollowUp {
  id: string;
  conversation_id: string;
  scheduled_at: string;
  sent_at: string | null;
  follow_up_number: number;
  message: string | null;
  status: FollowUpStatus;
  created_at: string;
}

// ============================================
// Agent Tool Types
// ============================================

export interface InventorySearchParams {
  dealer_id: string;
  size?: MattressSize;
  firmness?: Firmness;
  type?: MattressType;
  brand?: string;
  min_price?: number;
  max_price?: number;
  in_stock_only?: boolean;
}

export interface ProductRecommendation {
  inventory_id: string;
  product_name: string;
  size: string;
  price: number;
  sale_price?: number;
  firmness: string;
  type: string;
  why_it_fits: string;
  call_to_action: string;
  promotion?: string;
  financing_eligible: boolean;
}

export interface AgentDecision {
  reply: string;
  media_urls?: string[];
  new_state?: AgentState;
  context_updates?: Partial<ConversationContext>;
  qualification_updates?: Partial<QualificationData>;
  tool_calls?: ToolCall[];
  should_handoff?: boolean;
  handoff_reason?: string;
  lead_score_delta?: number;
  schedule_follow_up?: boolean;
  agent_note?: string;
}

export interface ToolCall {
  tool: string;
  params: Record<string, unknown>;
  result?: unknown;
}

// ============================================
// API Request/Response Types
// ============================================

export interface CreateLeadRequest {
  dealer_id: string;
  phone: string;
  customer_name?: string;
  email?: string;
  source?: LeadSource;
  initial_message?: string;
}

export interface InboundSmsPayload {
  From: string;
  To: string;
  Body: string;
  MessageSid: string;
  NumMedia?: string;
}

export interface AgentProcessRequest {
  conversation_id: string;
  message: string;
  direction: MessageDirection;
}

export interface ConversationWithLead extends Conversation {
  lead: Lead;
  dealer: Pick<Dealer, 'id' | 'business_name' | 'settings'>;
}

export interface ConversationDetail extends ConversationWithLead {
  messages: Message[];
  recommendations: (Recommendation & { item: InventoryItem })[];
  logs: AgentLog[];
}
