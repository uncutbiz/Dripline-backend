// ad-campaign-agent.js
// DRIPLINE Demand-Gen Agent — fully autonomous version
//
// Generates copy AND creates/manages live Meta ad campaigns via the
// Marketing API. One thing stays hard-coded: MAX_DAILY_BUDGET_PER_MARKET.
// Not a review gate — a runaway-spend circuit breaker. An agent with your
// Meta Ads token and zero ceiling can spend your whole month's budget
// overnight if it misjudges a campaign; this caps the blast radius while
// still running with no human in the loop day to day.
//
// Requires: a Meta Business Manager account + Marketing API access token
// with ads_management permission, and an existing Ad Account ID. This is
// a real prerequisite from Meta, not something this script can create for you.
//
// Usage:
//   node ad-campaign-agent.js launch      — generate copy + create campaigns
//   node ad-campaign-agent.js optimize    — check performance, pause underperformers
//
// Env vars: ANTHROPIC_API_KEY, META_ACCESS_TOKEN, META_AD_ACCOUNT_ID
// npm installs: npm install @anthropic-ai/sdk node-fetch

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const GRAPH = 'https://graph.facebook.com/v19.0';
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;

const MAX_DAILY_BUDGET_PER_MARKET = 25; // USD — circuit breaker, not a review step
const MIN_CTR_BEFORE_PAUSE = 0.01; // 1%
const MIN_IMPRESSIONS_BEFORE_JUDGING = 1000;

const MARKETS = [
  { name: 'Las Vegas', lat: 36.1699, lng: -115.1398 },
  { name: 'Miami', lat: 25.7617, lng: -80.1918 },
  { name: 'Nashville', lat: 36.1627, lng: -86.7816 },
  { name: 'Scottsdale', lat: 33.4942, lng: -111.9261 },
  { name: 'Austin', lat: 30.2672, lng: -97.7431 },
  { name: 'New York', lat: 40.7128, lng: -74.006 },
  { name: 'Los Angeles', lat: 34.0522, lng: -118.2437 }
];
const HOOKS = [
  { id: 'hangover', angle: 'hangover recovery, urgent/immediate need, nightlife crowd' },
  { id: 'athletic', angle: 'post-workout recovery for gym-goers and athletes' },
  { id: 'event', angle: 'bachelorette parties, birthdays, group events wanting on-site IV drips' },
  { id: 'wellness', angle: 'general wellness, busy professionals wanting convenience' }
];

const STATE_FILE = path.join(__dirname, 'campaign-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { campaigns: [] };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function generateVariants(market, hook) {
  const prompt = `Write 3 short ad variants for DRIPLINE, a mobile IV hydration service, targeting ${market.name} for this angle: ${hook.angle}.

Each needs: headline (under 40 chars), primary_text (under 125 chars), cta ("Book now", "Get started", or "Learn more").
Respond ONLY as a JSON array of 3 objects with keys headline, primary_text, cta. No markdown.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function metaFetch(pathSuffix, options = {}) {
  const url = `${GRAPH}/${pathSuffix}${pathSuffix.includes('?') ? '&' : '?'}access_token=${TOKEN}`;
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API error: ${data.error.message}`);
  return data;
}

async function createCampaign(market, hook) {
  const campaign = await metaFetch(`act_${AD_ACCOUNT}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `DRIPLINE - ${market.name} - ${hook.id}`,
      objective: 'OUTCOME_LEADS',
      status: 'ACTIVE',
      special_ad_categories: []
    })
  });

  const adSet = await metaFetch(`act_${AD_ACCOUNT}/adsets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${market.name} - ${hook.id} - adset`,
      campaign_id: campaign.id,
      daily_budget: MAX_DAILY_BUDGET_PER_MARKET * 100, // Meta expects cents
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      targeting: {
        geo_locations: { custom_locations: [{ latitude: market.lat, longitude: market.lng, radius: 15, distance_unit: 'mile' }] },
        age_min: 21,
        age_max: 45
      },
      status: 'ACTIVE'
    })
  });

  return { campaignId: campaign.id, adSetId: adSet.id };
}

async function launch() {
  const state = loadState();
  for (const market of MARKETS) {
    for (const hook of HOOKS) {
      console.log(`Launching: ${market.name} / ${hook.id}`);
      try {
        const variants = await generateVariants(market, hook);
        const { campaignId, adSetId } = await createCampaign(market, hook);
        state.campaigns.push({
          market: market.name,
          hook: hook.id,
          campaignId,
          adSetId,
          variants,
          launchedAt: new Date().toISOString(),
          status: 'active'
        });
        console.log(`  Created campaign ${campaignId}, daily budget $${MAX_DAILY_BUDGET_PER_MARKET}`);
      } catch (err) {
        console.error(`  Failed for ${market.name}/${hook.id}:`, err.message);
      }
    }
  }
  saveState(state);
  const totalDaily = state.campaigns.filter((c) => c.status === 'active').length * MAX_DAILY_BUDGET_PER_MARKET;
  console.log(`\nLaunch complete. ${state.campaigns.length} campaigns. Combined daily spend ceiling: $${totalDaily}`);
}

async function optimize() {
  const state = loadState();
  for (const c of state.campaigns) {
    if (c.status !== 'active') continue;
    try {
      const insights = await metaFetch(`${c.adSetId}/insights?fields=impressions,clicks,ctr`);
      const row = insights.data?.[0];
      if (!row) continue;
      const impressions = Number(row.impressions || 0);
      const ctr = Number(row.ctr || 0) / 100;

      if (impressions >= MIN_IMPRESSIONS_BEFORE_JUDGING && ctr < MIN_CTR_BEFORE_PAUSE) {
        await metaFetch(c.adSetId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'PAUSED' })
        });
        c.status = 'paused';
        console.log(`Paused ${c.market}/${c.hook} — CTR ${(ctr * 100).toFixed(2)}% under ${MIN_CTR_BEFORE_PAUSE * 100}% threshold after ${impressions} impressions`);
      } else {
        console.log(`${c.market}/${c.hook}: ${impressions} impressions, ${(ctr * 100).toFixed(2)}% CTR — holding`);
      }
    } catch (err) {
      console.error(`Failed to check ${c.market}/${c.hook}:`, err.message);
    }
  }
  saveState(state);
}

const mode = process.argv[2];
if (mode === 'launch') {
  launch().catch((err) => { console.error(err); process.exit(1); });
} else if (mode === 'optimize') {
  optimize().catch((err) => { console.error(err); process.exit(1); });
} else {
  console.error('Usage: node ad-campaign-agent.js [launch|optimize]');
  process.exit(1);
}
