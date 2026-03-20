import Anthropic from '@anthropic-ai/sdk';
import { getServiceClient } from '../supabase';
import { buildSystemPrompt } from './system-prompt';
import { canTransition, shouldAutoHandoff, checkHotLeadAlert } from './state-machine';
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

  // 2. Check for automatic handoff triggers
  const handoffCheck = shouldAutoHandoff(updatedContext, lead.lead_score, inboundMessage);
  if (handoffCheck.handoff) {
    return {
      reply: getHandoffMessage(dealer.business_name, handoffCheck.reason!),
      new_state: 'handed_off',
      context_updates: signals as Partial<ConversationContext>,
      qualification_updates: signals,
      should_handoff: true,
      handoff_reason: handoffCheck.reason!,
      lead_score_delta: 15,
      agent_note: `Auto-handoff: ${handoffCheck.reason}`,
    };
  }

  // 3. If in recommending state and we have search criteria, search inventory
  let inventoryContext = '';
  let recommendations: ReturnType<typeof generateRecommendations> = [];

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

    inventoryContext = formatInventoryForAgent(items);
    recommendations = generateRecommendations(items, updatedContext);

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
    needsInventory && recommendations.length > 0 ? 'recommending' : currentState
  );

  const userContent = buildUserMessage(inboundMessage, inventoryContext, recommendations);

  try {
    const anthropic = getAnthropic();
    const anthropicMessages: Anthropic.MessageParam[] = [
      ...chatHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: userContent },
    ];

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      system: systemPrompt,
      messages: anthropicMessages,
      temperature: 0.7,
      max_tokens: 500,
    });

    const rawBlock = completion.content[0];
    const rawText = rawBlock?.type === 'text' ? rawBlock.text : null;
    if (!rawText) {
      return fallbackDecision(updatedContext, signals);
    }

    // Extract JSON from response (Claude may wrap in markdown code blocks)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const raw = jsonMatch ? jsonMatch[0] : rawText;
    if (!raw) {
      return fallbackDecision(updatedContext, signals);
    }

    const parsed = JSON.parse(raw) as {
      reply: string;
      context_updates?: Partial<ConversationContext>;
      qualification_updates?: Record<string, unknown>;
      suggested_state?: AgentState;
      should_handoff?: boolean;
      handoff_reason?: string;
      lead_score_delta?: number;
      agent_note?: string;
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

    // Log agent action
    await db.from('agent_logs').insert({
      conversation_id: conversation.id,
      action: 'tool_call',
      details: {
        tool: 'llm_response',
        model: 'claude-sonnet-4-5-20250514',
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
      new_state: newState,
      context_updates: allContextUpdates,
      qualification_updates: {
        ...signals,
        ...(parsed.qualification_updates || {}),
      },
      should_handoff: parsed.should_handoff || false,
      handoff_reason: parsed.handoff_reason || undefined,
      lead_score_delta: parsed.lead_score_delta || 0,
      agent_note: parsed.agent_note || undefined,
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
  recommendations: ReturnType<typeof generateRecommendations>
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
          `${i + 1}. ${r.product_name} - ${r.size} - $${r.price}${r.sale_price ? ` (sale)` : ''} - ${r.firmness} - ${r.why_it_fits}`
      )
      .join('\n');
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
  signals: Record<string, unknown>
): AgentDecision {
  return {
    reply: "Thanks for your message! I'm having a moment - let me get back to you shortly, or feel free to call us directly.",
    context_updates: signals as Partial<ConversationContext>,
    qualification_updates: signals,
    agent_note: 'Fallback response due to LLM error',
  };
}
