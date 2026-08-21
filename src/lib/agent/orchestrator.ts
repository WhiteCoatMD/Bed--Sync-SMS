import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getServiceClient } from '../supabase';
import { buildSystemPrompt } from './system-prompt';
import { canTransition, shouldAutoHandoff, checkHotLeadAlert } from './state-machine';
import { isDatetimeWithinHours, zonedWallClockToUtcIso } from '../business-hours';
import { searchInventory, formatInventoryForAgent } from './tools/inventory-search';
import { generateRecommendations, formatRecommendationsForSms } from './tools/recommendation';
import { extractQualificationSignals, mergeContext } from './tools/qualification';
import type {
  Conversation,
  ConversationContext,
  Dealer,
  Lead,
  Message,
  AgentDecision,
  AgentState,
} from '../types';

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

interface OrchestratorInput {
  conversation: Conversation;
  lead: Lead;
  dealer: Dealer;
  inboundMessage: string;
  recentMessages: Message[];
}

/**
 * Main agent orchestration loop.
 * Takes an inbound message and produces a reply + state updates.
 */
export async function processMessage(
  input: OrchestratorInput
): Promise<AgentDecision> {
  const { conversation, lead, dealer, inboundMessage, recentMessages } = input;
  const db = getServiceClient();
  const context = conversation.context as ConversationContext;
  const currentState = conversation.agent_state as AgentState;

  // 1. Extract structured signals from the customer message
  const signals = extractQualificationSignals(inboundMessage);
  const updatedContext = mergeContext(context, signals as Partial<ConversationContext>);

  // 2. Check for automatic handoff triggers — but don't return early.
  // Always let the LLM answer the customer's question first, then hand off.
  const handoffCheck = shouldAutoHandoff(updatedContext, lead.lead_score, inboundMessage);

  // 3. If in recommending state and we have search criteria, search inventory
  let inventoryContext = '';
  let recommendations: ReturnType<typeof generateRecommendations> = [];
  let hasRealPricing = true;
  let recommendationImageUrls: string[] = [];

  const needsInventory =
    currentState === 'recommending' ||
    (currentState === 'qualifying' && hasEnoughToRecommend(updatedContext));

  if (needsInventory) {
    const items = await searchInventory({
      dealer_id: dealer.id,
      size: updatedContext.mattress_size || undefined,
      firmness: updatedContext.firmness || undefined,
      type: updatedContext.mattress_type || undefined,
      min_price: updatedContext.budget_min || undefined,
      max_price: updatedContext.budget_max || undefined,
      in_stock_only: true,
    });

    // Check if dealer has real pricing — if all items are $0/null, flag it.
    // Either way we still surface the matching products (and photos) to the
    // agent; the flag just switches the prompt into "no pricing" mode (describe
    // the options, never quote a price, drive them to come in). This is how MBA
    // dealers run it — pricing happens in-store / with a rep.
    hasRealPricing = items.some((item) => (item.sale_price || item.price) > 0);

    inventoryContext = formatInventoryForAgent(items);
    recommendations = generateRecommendations(items, updatedContext);

    // Collect image URLs from recommended items for MMS
    if (recommendations.length > 0) {
      const recIds = new Set(recommendations.map(r => r.inventory_id));
      recommendationImageUrls = items
        .filter(item => recIds.has(item.id) && item.image_url)
        .map(item => item.image_url!)
        .slice(0, 3); // Telnyx MMS limit
    }

    // Log inventory search
    await db.from('agent_logs').insert({
      conversation_id: conversation.id,
      action: 'tool_call',
      details: {
        tool: 'inventory_search',
        params: { size: updatedContext.mattress_size, budget_max: updatedContext.budget_max, firmness: updatedContext.firmness },
        results_count: items.length,
      },
    });
  }

  // 4. Build conversation history for the LLM
  const chatHistory = buildChatHistory(recentMessages);

  // 5. Call the LLM
  const systemPrompt = buildSystemPrompt(
    dealer.business_name,
    dealer.settings,
    updatedContext,
    needsInventory && recommendations.length > 0 ? 'recommending' : currentState,
    { phone: dealer.owner_phone, website: dealer.settings.store_website }
  );

  const noPricingBusiness = (needsInventory && !hasRealPricing) ? dealer.business_name : undefined;
  const userContent = buildUserMessage(inboundMessage, inventoryContext, recommendations, handoffCheck.handoff ? dealer.business_name : undefined, noPricingBusiness);

  try {
    let rawText: string | null = null;
    let modelUsed = 'unknown';

    const llmMessages = [
      ...chatHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: userContent },
    ];

    // Try Anthropic first, fall back to OpenAI
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const anthropic = getAnthropic();
        const completion = await anthropic.messages.create({
          model: 'claude-sonnet-4-6-20250514',
          system: systemPrompt,
          messages: llmMessages as Anthropic.MessageParam[],
          temperature: 0.7,
          max_tokens: 500,
        });
        const rawBlock = completion.content[0];
        rawText = rawBlock?.type === 'text' ? rawBlock.text : null;
        modelUsed = 'claude-sonnet-4-5-20250514';
      } catch (anthropicErr) {
        console.error('[Agent] Anthropic error, falling back to OpenAI:', anthropicErr);
      }
    }

    // Fallback to OpenAI if Anthropic failed or unavailable
    if (!rawText && process.env.OPENAI_API_KEY) {
      try {
        const openai = getOpenAI();
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: systemPrompt },
            ...llmMessages,
          ],
          temperature: 0.7,
          max_tokens: 500,
        });
        rawText = completion.choices[0]?.message?.content || null;
        modelUsed = 'gpt-4o';
      } catch (openaiErr) {
        console.error('[Agent] OpenAI fallback error:', openaiErr);
      }
    }

    if (!rawText) {
      return fallbackDecision(updatedContext, signals, handoffCheck);
    }

    // Extract JSON from response (Claude may wrap in markdown code blocks)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    let raw = jsonMatch ? jsonMatch[0] : rawText;
    if (!raw) {
      return fallbackDecision(updatedContext, signals);
    }

    // Fix common LLM JSON issues: +5 → 5, trailing commas
    raw = raw.replace(/:\s*\+(\d)/g, ': $1').replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(raw) as {
      reply: string;
      context_updates?: Partial<ConversationContext>;
      qualification_updates?: Record<string, unknown>;
      suggested_state?: AgentState;
      should_handoff?: boolean;
      handoff_reason?: string;
      lead_score_delta?: number;
      agent_note?: string;
      schedule_appointment?: {
        type?: 'showroom_visit' | 'phone_call';
        datetime?: string; // ISO datetime for book/reschedule
        notes?: string;
        cancel?: boolean; // true to cancel the existing appointment
      };
    };

    // Merge LLM context updates with our extracted signals
    const allContextUpdates = {
      ...(signals as Partial<ConversationContext>),
      ...(parsed.context_updates || {}),
    };

    // Validate state transition
    let newState = parsed.suggested_state || undefined;
    if (newState && !canTransition(currentState, newState)) {
      newState = undefined; // ignore invalid transition
    }

    // If we just showed recommendations, auto-transition to recommending
    if (recommendations.length > 0 && currentState === 'qualifying') {
      newState = 'recommending';
    }

    // Record recommendations
    if (recommendations.length > 0) {
      for (const rec of recommendations) {
        await db.from('recommendations').insert({
          conversation_id: conversation.id,
          inventory_id: rec.inventory_id,
          rank: recommendations.indexOf(rec) + 1,
          reason: rec.why_it_fits,
        });
      }

      allContextUpdates.recommendations_shown = [
        ...(updatedContext.recommendations_shown || []),
        ...recommendations.map((r) => r.inventory_id),
      ];
    }

    // Book / reschedule / cancel an appointment based on the AI's output.
    if (parsed.schedule_appointment) {
      try {
        const appt = parsed.schedule_appointment;
        const nowIso = new Date().toISOString();

        // Existing upcoming appointment for this conversation (if any)
        const { data: existingRows } = await db
          .from('appointments')
          .select('id, scheduled_at, type')
          .eq('conversation_id', conversation.id)
          .in('status', ['scheduled', 'confirmed'])
          .gt('scheduled_at', nowIso)
          .order('scheduled_at', { ascending: true })
          .limit(1);
        const current = existingRows && existingRows[0];

        if (appt.cancel) {
          // Cancel their existing appointment
          if (current) {
            await db.from('appointments').update({ status: 'cancelled', updated_at: nowIso }).eq('id', current.id);
            await db.from('agent_logs').insert({
              conversation_id: conversation.id, action: 'tool_call',
              details: { tool: 'cancel_appointment', appointment_id: current.id },
            });
          }
        } else if (appt.datetime) {
          // The LLM emits store-local wall-clock time with no offset; convert it
          // to a true UTC instant using the dealer's timezone before checking
          // hours or storing it (a no-offset timestamp would otherwise be read
          // as UTC and land hours off).
          const scheduledIso = zonedWallClockToUtcIso(
            appt.datetime,
            dealer.settings.timezone || 'America/Chicago'
          );
          const withinHours = isDatetimeWithinHours(scheduledIso, dealer.settings);
          if (!withinHours) {
            console.warn('[Agent] Appointment rejected — outside business hours:', appt.datetime, '->', scheduledIso);
            await db.from('agent_logs').insert({
              conversation_id: conversation.id, action: 'tool_call',
              details: { tool: 'schedule_appointment', ...appt, rejected: 'outside_business_hours' },
            });
          } else if (current) {
            // Reschedule: update the existing appointment. The new scheduled_at
            // means the reminder job will send a fresh reminder for the new time.
            const upd: Record<string, unknown> = {
              scheduled_at: scheduledIso,
              type: appt.type || current.type,
              duration_minutes: appt.type === 'phone_call' ? 15 : 30,
              status: 'scheduled',
              updated_at: nowIso,
            };
            if (appt.notes) upd.notes = appt.notes;
            await db.from('appointments').update(upd).eq('id', current.id);
            await db.from('agent_logs').insert({
              conversation_id: conversation.id, action: 'tool_call',
              details: { tool: 'reschedule_appointment', appointment_id: current.id, ...appt, scheduled_at: scheduledIso },
            });
          } else {
            // New booking
            await db.from('appointments').insert({
              dealer_id: dealer.id,
              conversation_id: conversation.id,
              lead_id: lead.id,
              type: appt.type || 'showroom_visit',
              scheduled_at: scheduledIso,
              duration_minutes: appt.type === 'phone_call' ? 15 : 30,
              status: 'scheduled',
              notes: appt.notes || null,
              created_by: 'agent',
            });
            await db.from('agent_logs').insert({
              conversation_id: conversation.id, action: 'tool_call',
              details: { tool: 'schedule_appointment', ...appt, validated: true },
            });
          }
        }
      } catch (apptErr) {
        console.error('[Agent] Appointment op error:', apptErr);
      }
    }

    // Log agent action
    await db.from('agent_logs').insert({
      conversation_id: conversation.id,
      action: 'tool_call',
      details: {
        tool: 'llm_response',
        model: modelUsed,
        suggested_state: newState,
        handoff: parsed.should_handoff,
        score_delta: parsed.lead_score_delta,
      },
    });

    // Check for hot lead alert (score >= 60 heads-up to dealer)
    const newScore = lead.lead_score + (parsed.lead_score_delta || 0);
    const hotLeadAlert = checkHotLeadAlert(lead.lead_score, newScore, updatedContext);
    if (hotLeadAlert && (dealer.settings.handoff_phone || dealer.owner_phone)) {
      const alertPhone = dealer.settings.handoff_phone || dealer.owner_phone;
      try {
        const { sendSms } = await import('../sms');
        await sendSms(
          alertPhone!,
          hotLeadAlert,
          dealer.twilio_phone || undefined
        );
        await db.from('agent_logs').insert({
          conversation_id: conversation.id,
          action: 'tool_call',
          details: { tool: 'hot_lead_alert', score: newScore },
        });
      } catch (err) {
        console.error('[Agent] Hot lead alert error:', err);
      }
    }

    return {
      reply: parsed.reply || "I'm sorry, could you say that again?",
      media_urls: recommendationImageUrls.length > 0 ? recommendationImageUrls : undefined,
      new_state: handoffCheck.handoff ? 'handed_off' : newState,
      context_updates: allContextUpdates,
      qualification_updates: {
        ...signals,
        ...(parsed.qualification_updates || {}),
      },
      should_handoff: handoffCheck.handoff || parsed.should_handoff || false,
      handoff_reason: handoffCheck.reason || parsed.handoff_reason || undefined,
      lead_score_delta: parsed.lead_score_delta || (handoffCheck.handoff ? 15 : 0),
      agent_note: handoffCheck.handoff ? `Auto-handoff: ${handoffCheck.reason}` : parsed.agent_note || undefined,
    };
  } catch (err) {
    console.error('[Agent] LLM error:', err);

    // Log error
    await db.from('agent_logs').insert({
      conversation_id: conversation.id,
      action: 'error',
      details: { error: String(err), stage: 'llm_call' },
    });

    return fallbackDecision(updatedContext, signals);
  }
}

function hasEnoughToRecommend(ctx: ConversationContext): boolean {
  return !!(ctx.mattress_size && (ctx.budget_max || ctx.firmness));
}

function buildChatHistory(
  messages: Message[]
): { role: 'user' | 'assistant'; content: string }[] {
  // Last 10 messages for context window management
  return messages.slice(-10).map((m) => ({
    role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
    content: m.body,
  }));
}

function buildUserMessage(
  message: string,
  inventoryContext: string,
  recommendations: ReturnType<typeof generateRecommendations>,
  pendingHandoffBusiness?: string,
  noPricingBusiness?: string
): string {
  let content = `Customer says: "${message}"`;

  if (inventoryContext) {
    content += `\n\nINVENTORY SEARCH RESULTS:\n${inventoryContext}`;
  }

  if (recommendations.length > 0) {
    content += `\n\nPRE-SCORED RECOMMENDATIONS (use these for your response):\n`;
    content += recommendations
      .map(
        (r, i) =>
          `${i + 1}. ${r.product_name} - ${r.size}${r.price > 0 ? ` - $${r.price}${r.sale_price ? ` (sale)` : ''}` : ''} - ${r.firmness} - ${r.why_it_fits}`
      )
      .join('\n');
  }

  if (noPricingBusiness) {
    content += `\n\nPRICING POLICY (important): ${noPricingBusiness} does not quote prices over text — pricing is given in person so customers come in or talk to a rep. You MAY describe the specific options above (name, feel, type, standout features) and why they'd fit, but NEVER state, quote, estimate, or hint at any price, and never say "$0", "contact us", or "call for price". For pricing, warmly steer them to come in and try the mattresses (or talk to a rep), and offer to set up a showroom visit — e.g. "The best way to get real pricing and actually feel the difference is to come try them — want me to set up a time for you to come in?" Sound confident; never apologize or suggest info is missing.`;
  }

  if (pendingHandoffBusiness) {
    content += `\n\nIMPORTANT: Answer the customer's question fully and naturally, then in the same message let them know you're connecting them with someone from ${pendingHandoffBusiness} who can help further. Keep it warm and brief — one reply that does both.`;
  }

  content += '\n\nRespond with JSON as specified in your system prompt.';

  return content;
}

function getHandoffMessage(businessName: string, reason: string): string {
  if (reason.includes('ready to purchase') || reason.includes('hot lead')) {
    return `Great news! Let me connect you with one of our team members who can help you get this taken care of right away. Someone from ${businessName} will reach out to you shortly!`;
  }
  if (reason.includes('frustrated') || reason.includes('angry')) {
    return `I understand your frustration, and I want to make sure you get the help you need. Let me connect you with a team member at ${businessName} who can assist you personally.`;
  }
  return `Let me connect you with someone from our team at ${businessName} who can help you with that. They'll reach out shortly!`;
}

function fallbackDecision(
  context: ConversationContext,
  signals: Record<string, unknown>,
  handoffCheck?: { handoff: boolean; reason: string | null }
): AgentDecision {
  return {
    reply: "Thanks for your message! I'm having a moment - let me get back to you shortly, or feel free to call us directly.",
    context_updates: signals as Partial<ConversationContext>,
    qualification_updates: signals,
    should_handoff: handoffCheck?.handoff || false,
    handoff_reason: handoffCheck?.reason || undefined,
    new_state: handoffCheck?.handoff ? 'handed_off' : undefined,
    agent_note: 'Fallback response due to LLM error',
  };
}
