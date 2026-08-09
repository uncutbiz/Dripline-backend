// retention.js
// DRIPLINE Retention & Referral Agent — Agent 5
//
// Run this daily. Two options:
//   1. Render Cron Job (recommended) — new Cron Job service, schedule "0 15 * * *" (3pm UTC daily),
//      command: node retention.js
//   2. node-cron inside your existing backend process — require('./retention').runDaily() on a schedule
//
// Env vars needed:
//   BACKEND_URL          - e.g. https://dripline-backend-1.onrender.com
//   ADMIN_KEY             - your existing admin key (BumpyShow2026 or whatever's current — move this to env, don't hardcode)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   GOOGLE_REVIEW_LINK    - your Google Business Profile review link
//
// npm installs: npm install twilio node-fetch

const twilio = require('twilio');
const fetch = require('node-fetch');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const BACKEND_URL = process.env.BACKEND_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

// ---------------------------------------------------------------------------
// TODO: point this at your real bookings endpoint. This assumes something like
// GET /api/admin/bookings returning [{ id, customerName, phone, market, package, createdAt }, ...]
// Adjust field names to match your actual JSON persistence schema.
// ---------------------------------------------------------------------------
async function fetchBookings() {
  const res = await fetch(`${BACKEND_URL}/api/admin/bookings`, {
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  if (!res.ok) throw new Error(`Failed to fetch bookings: ${res.status}`);
  return res.json();
}

function daysAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

function referralCode(customerId) {
  // simple deterministic short code — swap for your real customer id scheme
  return 'DL' + String(customerId).slice(-4).toUpperCase() + Math.floor(Math.random() * 90 + 10);
}

async function sendSMS(to, body) {
  if (!to) return;
  try {
    await client.messages.create({ to, from: process.env.TWILIO_FROM_NUMBER, body });
  } catch (err) {
    console.error(`[retention] SMS failed for ${to}:`, err.message);
  }
}

async function runDaily() {
  const bookings = await fetchBookings();
  let reviewsSent = 0;
  let reactivationsSent = 0;

  for (const b of bookings) {
    const age = daysAgo(b.createdAt);

    // 1-2 days post-booking: review request
    if (age >= 1 && age < 2 && !b.reviewRequestSent) {
      await sendSMS(
        b.phone,
        `Hey ${b.customerName?.split(' ')[0] || ''} — glad we could help you feel better. If you've got 20 seconds, a quick review means a lot: ${process.env.GOOGLE_REVIEW_LINK}`
      );
      reviewsSent++;
      // TODO: mark b.reviewRequestSent = true back in your backend so this doesn't repeat
    }

    // 14-21 days post-booking, no repeat since: reactivation + referral
    if (age >= 14 && age < 21 && !b.reactivationSent) {
      const code = referralCode(b.id);
      await sendSMS(
        b.phone,
        `It's been a couple weeks — due for a refresh? Book again with code ${code} for $20 off, and send it to a friend for $20 off their first drip too.`
      );
      reactivationsSent++;
      // TODO: mark b.reactivationSent = true back in your backend
    }
  }

  console.log(`[retention] Run complete: ${reviewsSent} review requests, ${reactivationsSent} reactivation/referral texts`);
}

if (require.main === module) {
  runDaily().catch((err) => {
    console.error('[retention] Run failed:', err);
    process.exit(1);
  });
}

module.exports = { runDaily };
