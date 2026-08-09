// b2b-outreach-autosend.js
// DRIPLINE B2B Outreach Agent — fully autonomous version
//
// Drafts AND sends without a review step. Two things stay hard-coded rather
// than configurable-to-zero, because turning them off doesn't get you more
// sales, it gets your sending domain blacklisted:
//   - DAILY_SEND_CAP: volume limit per run
//   - suppression.json: permanent opt-out list, checked before every send
// Everything else — which accounts, what pitch, when it runs — is autonomous.
//
// Usage:
//   node b2b-outreach-autosend.js accounts.csv     (run manually or via cron)
//
// Env vars: ANTHROPIC_API_KEY, SENDGRID_API_KEY, FROM_EMAIL
// npm installs: npm install @anthropic-ai/sdk csv-parse @sendgrid/mail

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const Anthropic = require('@anthropic-ai/sdk');
const sgMail = require('@sendgrid/mail');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const DAILY_SEND_CAP = 40; // per-run ceiling — deliverability, not approval
const SUPPRESSION_FILE = path.join(__dirname, 'suppression.json');
const LOG_FILE = path.join(__dirname, 'outreach-log.json');

const PITCH_BY_TYPE = {
  hotel: 'positioning DRIPLINE as an on-call recovery/wellness amenity for guests — concierge desk referral or in-room menu placement',
  gym: 'positioning DRIPLINE as a post-workout recovery add-on members can book same-day',
  event_venue: 'positioning DRIPLINE as on-site recovery support for bachelorette parties, sports events, or late-night events',
  corporate: 'positioning DRIPLINE as an employee wellness perk — on-site or on-demand for benefits programs',
  sports_team: 'positioning DRIPLINE as recovery support for athletes post-training or post-event'
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isSuppressed(email, suppressionList) {
  return suppressionList.includes(email.toLowerCase());
}

function alreadyContacted(email, log) {
  return log.some((entry) => entry.to === email);
}

async function draftEmail(account) {
  const pitchAngle = PITCH_BY_TYPE[account.type] || PITCH_BY_TYPE.hotel;
  const prompt = `Write a short, direct cold outreach email from DRIPLINE (mobile IV hydration, live in Las Vegas, Miami, Nashville, Scottsdale, Austin, New York, Los Angeles) to a potential B2B partner.

Recipient: ${account.contact_name || 'the team'} at ${account.name}, a ${account.type} in ${account.city}.
Angle: ${pitchAngle}.

Rules:
- Under 120 words
- No corporate filler, no "I hope this finds you well"
- One clear, low-friction ask: a 15-minute call
- Reference something specific and plausible about their business type, not generic flattery
- Sign off as "The DRIPLINE Partnerships Team"
- Output ONLY the email body, no subject line, no preamble`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function sendEmail(account, body) {
  const msg = {
    to: account.email,
    from: process.env.FROM_EMAIL,
    subject: `Recovery IV service for ${account.name}?`,
    text: body + `\n\n---\nDRIPLINE Partnerships | dripline.live\nDon't want to hear from us? Reply STOP or unsubscribe: https://www.dripline.live/unsubscribe?email=${encodeURIComponent(account.email)}`
  };
  await sgMail.send(msg);
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node b2b-outreach-autosend.js accounts.csv');
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const accounts = parse(raw, { columns: true, skip_empty_lines: true });
  const suppression = loadJson(SUPPRESSION_FILE, []);
  const log = loadJson(LOG_FILE, []);

  let sentCount = 0;
  for (const account of accounts) {
    if (sentCount >= DAILY_SEND_CAP) {
      console.log(`Hit daily cap of ${DAILY_SEND_CAP}, stopping run. Remaining accounts carry to next run.`);
      break;
    }
    if (!account.email) continue;
    if (isSuppressed(account.email, suppression)) {
      console.log(`Skipping ${account.email} — on suppression list.`);
      continue;
    }
    if (alreadyContacted(account.email, log)) {
      console.log(`Skipping ${account.email} — already contacted.`);
      continue;
    }

    try {
      const body = await draftEmail(account);
      await sendEmail(account, body);
      log.push({ to: account.email, account: account.name, sentAt: new Date().toISOString() });
      sentCount++;
      console.log(`Sent to ${account.email} (${account.name})`);
    } catch (err) {
      console.error(`Failed to send to ${account.email}:`, err.message);
    }

    // small delay between sends — protects deliverability, not a review gate
    await new Promise((r) => setTimeout(r, 2000));
  }

  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  console.log(`Run complete: ${sentCount} sent.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
