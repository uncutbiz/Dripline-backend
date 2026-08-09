// social-webhook.js
// DRIPLINE Social + DM Conversion Agent — Agent 4
//
// This needs real setup before it does anything (can't skip this part):
//   1. A Meta Developer App (developers.facebook.com) linked to your DRIPLINE
//      Instagram/Facebook Page
//   2. Meta App Review approval for the `instagram_manage_messages` /
//      `pages_messaging` permissions — this takes real review time (days),
//      not instant. Until approved, this only works in your own test mode.
//   3. A Page Access Token + webhook subscription pointed at this route
//
// Mount in your backend:
//   app.use('/api/social', require('./social-webhook'));
// Then set the webhook URL in Meta's dashboard to:
//   https://dripline-backend-1.onrender.com/api/social/webhook
//
// Env vars needed:
//   META_VERIFY_TOKEN     - a string you make up, used during webhook setup handshake
//   META_PAGE_ACCESS_TOKEN
//   ANTHROPIC_API_KEY     - reuses the same concierge conversation logic

const express = require('express');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Webhook verification handshake — Meta calls this once when you save the webhook URL
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming DMs / comments land here
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately, Meta expects a fast response

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        if (!senderId || !text) continue;
        await handleIncomingMessage(senderId, text);
      }
    }
  } catch (err) {
    console.error('[social-webhook] error processing event:', err);
  }
});

// Simple keyword triage — full conversation is short here, deep booking flow
// hands off to the same concierge logic as the on-site widget (see concierge.js).
// For a production build, extract SYSTEM_PROMPT + TOOLS from concierge.js into
// a shared module both routers import, rather than duplicating.
async function handleIncomingMessage(senderId, text) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: `You are the DRIPLINE Instagram/Facebook DM assistant. Someone messaged the DRIPLINE page. Be warm, brief (2-3 sentences, this is a DM not an email), and steer them to book at www.dripline.live or ask what they need (hangover, workout recovery, event) and which city they're in so you can confirm we serve them. We're live in Las Vegas, Miami, Nashville, Scottsdale, Austin, New York, and Los Angeles.`,
    messages: [{ role: 'user', content: text }]
  });

  const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  await sendDM(senderId, reply);
}

async function sendDM(recipientId, text) {
  try {
    await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text }
      })
    });
  } catch (err) {
    console.error('[social-webhook] failed to send DM:', err.message);
  }
}

module.exports = router;
