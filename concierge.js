// concierge.js
// DRIPLINE Booking Concierge Agent — Agent 1 (Inbound Booking Concierge)
//
// Mount this in your existing backend (uncutbiz/Dripline-backend):
//   const concierge = require('./concierge');
//   app.use('/api/concierge', concierge);
//
// Env vars needed:
//   ANTHROPIC_API_KEY        - your Claude API key
//   STRIPE_SECRET_KEY        - already in use for existing checkout
//   CONCIERGE_SUCCESS_URL    - e.g. https://www.dripline.live/booking-confirmed
//   CONCIERGE_CANCEL_URL     - e.g. https://www.dripline.live
//
// npm installs needed:
//   npm install @anthropic-ai/sdk stripe

const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---------------------------------------------------------------------------
// PLACEHOLDER CATALOG — replace prices/priceIds with your real Stripe Price IDs
// ---------------------------------------------------------------------------
const PACKAGES = {
  hangover_hero: {
    name: 'Hangover Hero',
    desc: 'Rehydration + anti-nausea + electrolytes',
    price: 149,
    stripePriceId: 'price_REPLACE_ME_HANGOVER'
  },
  recovery: {
    name: 'Recovery Drip',
    desc: 'General hydration + vitamin B-complex',
    price: 129,
    stripePriceId: 'price_REPLACE_ME_RECOVERY'
  },
  athletic: {
    name: 'Athletic Performance',
    desc: 'Amino acids + electrolytes + magnesium',
    price: 179,
    stripePriceId: 'price_REPLACE_ME_ATHLETIC'
  },
  glow: {
    name: 'Beauty & Glow',
    desc: 'Biotin + glutathione + hydration',
    price: 189,
    stripePriceId: 'price_REPLACE_ME_GLOW'
  },
  immunity: {
    name: 'Immunity Boost',
    desc: 'High-dose vitamin C + zinc',
    price: 159,
    stripePriceId: 'price_REPLACE_ME_IMMUNITY'
  }
};

const ADDONS = {
  b12: { name: 'B12 Shot', price: 25, stripePriceId: 'price_REPLACE_ME_B12' },
  antinausea: { name: 'Extra Anti-Nausea', price: 20, stripePriceId: 'price_REPLACE_ME_ANTINAUSEA' },
  extra_fluid: { name: 'Extra Liter of Fluid', price: 30, stripePriceId: 'price_REPLACE_ME_FLUID' }
};

// Markets you currently serve — keep this in sync with your dispatch config
const MARKETS = ['las vegas', 'miami', 'nashville', 'scottsdale', 'austin', 'new york', 'los angeles'];

// Service hours per your ops — adjust to your real hours
const SERVICE_HOURS = { startHour: 8, endHour: 23 }; // 8am–11pm local

// ---------------------------------------------------------------------------
// In-memory session store. This resets on redeploy — that's fine here,
// it only holds the *conversation*, not the booking. Real bookings only
// exist once Stripe checkout succeeds, which goes through your existing
// persisted booking flow. (Separate from the Render Persistent Disk issue
// on your main data store — no action needed here for that.)
// ---------------------------------------------------------------------------
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { history: [] });
  }
  return sessions.get(sessionId);
}

function isMarketCovered(marketRaw) {
  const market = (marketRaw || '').toLowerCase().trim();
  return MARKETS.some((m) => market.includes(m));
}

function isWithinServiceHours(tzOffsetHours = 0) {
  const now = new Date();
  const localHour = (now.getUTCHours() + tzOffsetHours + 24) % 24;
  return localHour >= SERVICE_HOURS.startHour && localHour < SERVICE_HOURS.endHour;
}

// ---------------------------------------------------------------------------
// Tool implementations the model can call mid-conversation
// ---------------------------------------------------------------------------
async function tool_check_market_coverage({ market }) {
  const covered = isMarketCovered(market);
  const withinHours = isWithinServiceHours();
  return {
    covered,
    within_service_hours: withinHours,
    message: covered
      ? withinHours
        ? `We serve ${market}. A nurse will be dispatched once payment is confirmed.`
        : `We serve ${market}, but we're currently outside service hours (${SERVICE_HOURS.startHour}:00–${SERVICE_HOURS.endHour}:00). Bookings can still be placed for the next available window.`
      : `We don't currently operate in ${market}. We're live in Las Vegas, Miami, Nashville, Scottsdale, Austin, New York, and Los Angeles.`
  };
}

async function tool_create_checkout_link({ package_id, addon_ids = [], market, contact_name, contact_phone }) {
  const pkg = PACKAGES[package_id];
  if (!pkg) return { error: `Unknown package: ${package_id}` };

  const line_items = [
    {
      price: pkg.stripePriceId,
      quantity: 1
    }
  ];

  for (const addonId of addon_ids) {
    const addon = ADDONS[addonId];
    if (addon) line_items.push({ price: addon.stripePriceId, quantity: 1 });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: process.env.CONCIERGE_SUCCESS_URL || 'https://www.dripline.live/booking-confirmed',
      cancel_url: process.env.CONCIERGE_CANCEL_URL || 'https://www.dripline.live',
      metadata: {
        source: 'concierge_agent',
        market: market || '',
        contact_name: contact_name || '',
        contact_phone: contact_phone || '',
        package_id
      }
    });
    return { checkout_url: session.url };
  } catch (err) {
    console.error('[concierge] Stripe checkout error:', err.message);
    return { error: 'Could not create checkout link right now. Please try again shortly.' };
  }
}

const TOOL_IMPLS = {
  check_market_coverage: tool_check_market_coverage,
  create_checkout_link: tool_create_checkout_link
};

const TOOLS = [
  {
    name: 'check_market_coverage',
    description: 'Check whether DRIPLINE serves a given city/market and whether we are currently within service hours.',
    input_schema: {
      type: 'object',
      properties: { market: { type: 'string', description: 'City the customer is in, e.g. "Miami"' } },
      required: ['market']
    }
  },
  {
    name: 'create_checkout_link',
    description: 'Create a Stripe checkout link once the customer has picked a package and confirmed their market and contact info.',
    input_schema: {
      type: 'object',
      properties: {
        package_id: { type: 'string', enum: Object.keys(PACKAGES) },
        addon_ids: { type: 'array', items: { type: 'string', enum: Object.keys(ADDONS) } },
        market: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' }
      },
      required: ['package_id', 'market']
    }
  }
];

const SYSTEM_PROMPT = `You are the DRIPLINE booking concierge — a warm, fast, no-fluff assistant for a mobile IV hydration service.

Your job in every conversation:
1. Figure out what the person needs (hangover, workout recovery, general wellness, event/bachelorette, immunity, beauty) in 1-2 questions max.
2. Recommend ONE package from this catalog, briefly explain why, and offer relevant add-ons:
${Object.entries(PACKAGES).map(([id, p]) => `   - ${id}: ${p.name} ($${p.price}) — ${p.desc}`).join('\n')}
   Add-ons: ${Object.entries(ADDONS).map(([id, a]) => `${id} ($${a.price})`).join(', ')}
3. Confirm their market using check_market_coverage before booking.
4. Once they confirm a package and market, call create_checkout_link and give them the link directly — don't make them ask twice.

Tone: direct, confident, a little energetic — like a friend who knows exactly what you need, not a corporate chatbot. Keep messages short (2-4 sentences). Never invent packages, prices, or markets outside the catalog above.`;

router.post('/message', async (req, res) => {
  try {
    const { sessionId: incomingSessionId, message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const sessionId = incomingSessionId || crypto.randomUUID();
    const session = getSession(sessionId);
    session.history.push({ role: 'user', content: message });

    let finalText = '';
    let checkoutUrl = null;

    // Tool-use loop — usually resolves in 1-2 round trips
    for (let i = 0; i < 4; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: session.history
      });

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const textBlocks = response.content.filter((b) => b.type === 'text');
      finalText = textBlocks.map((b) => b.text).join('\n').trim();

      session.history.push({ role: 'assistant', content: response.content });

      if (toolUseBlocks.length === 0) break;

      const toolResults = [];
      for (const block of toolUseBlocks) {
        const impl = TOOL_IMPLS[block.name];
        const result = impl ? await impl(block.input) : { error: 'Unknown tool' };
        if (result.checkout_url) checkoutUrl = result.checkout_url;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result)
        });
      }
      session.history.push({ role: 'user', content: toolResults });
    }

    res.json({ sessionId, reply: finalText, checkoutUrl });
  } catch (err) {
    console.error('[concierge] error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
