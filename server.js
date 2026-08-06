require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const SUCCESS_URL = process.env.SUCCESS_URL || 'https://your-site.com/booking-confirmed';
const CANCEL_URL = process.env.CANCEL_URL || 'https://your-site.com/booking-cancelled';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

// FREE SMS option: every major US carrier lets you text a phone by emailing
// number@their-gateway-domain. No per-message cost, just needs an email account
// to send from (a free Gmail account + "app password" works fine).
const CARRIER_GATEWAYS = {
  att: 'txt.att.net',
  verizon: 'vtext.com',
  tmobile: 'tmomail.net',
  sprint: 'messaging.sprintpcs.com',
  boost: 'sms.myboostmobile.com',
  cricket: 'sms.cricketwireless.net',
  metropcs: 'mymetropcs.com',
  uscellular: 'email.uscc.net',
  googlefi: 'msg.fi.google.com',
};

const emailTransporter = (process.env.SMS_EMAIL_USER && process.env.SMS_EMAIL_PASS)
  ? nodemailer.createTransport({
      service: process.env.SMS_EMAIL_SERVICE || 'gmail',
      auth: { user: process.env.SMS_EMAIL_USER, pass: process.env.SMS_EMAIL_PASS },
    })
  : null;

function sendFreeSms(nurse, message) {
  if (!emailTransporter) return false;
  if (!nurse.carrier || !CARRIER_GATEWAYS[nurse.carrier]) {
    console.warn(`Nurse ${nurse.name} has no valid carrier set — can't send free SMS. Set nurse.carrier to one of: ${Object.keys(CARRIER_GATEWAYS).join(', ')}`);
    return false;
  }
  const digits = nurse.phone.replace(/\D/g, '').slice(-10); // last 10 digits, gateways don't want +1
  const to = `${digits}@${CARRIER_GATEWAYS[nurse.carrier]}`;

  emailTransporter.sendMail({
    from: process.env.SMS_EMAIL_USER,
    to,
    subject: '', // carrier gateways generally ignore/strip the subject
    text: message,
  }).then(() => console.log(`Free SMS sent to ${nurse.name} via ${nurse.carrier} gateway`))
    .catch((err) => console.error('Free SMS send failed:', err.message));

  return true;
}

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com'; // sandbox by default until you flip PAYPAL_ENV=live

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- AUTH ----------

app.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }

  const users = db.getUsers();
  if (users.find((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: 'u_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    name,
    email,
    phone: phone || '',
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  db.saveUsers(users);

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const users = db.getUsers();
  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

// Optional auth: attaches req.user if a valid token is present, but doesn't block guest checkout
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET);
    } catch (err) {
      // invalid/expired token — proceed as a guest rather than blocking checkout
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}

// Picks the next nurse for a city using simple round-robin (whoever was dispatched longest ago).
// Real dispatch logic (live location, shift hours, current load) is a natural upgrade path —
// this is a working MVP, not a full logistics engine.
function dispatchNurse(booking) {
  const nurses = db.getNurses();
  const eligible = nurses
    .filter((n) => n.active && n.city === booking.city)
    .sort((a, b) => (a.lastDispatchedAt || '').localeCompare(b.lastDispatchedAt || ''));

  if (eligible.length === 0) {
    console.warn(`No active nurse available in ${booking.city} for booking ${booking.id}`);
    return null;
  }

  const nurse = eligible[0];
  nurse.lastDispatchedAt = new Date().toISOString();
  db.saveNurses(nurses);

  const bookings = db.getBookings();
  const b = bookings.find((x) => x.id === booking.id);
  if (b) {
    b.nurseId = nurse.id;
    b.status = 'assigned';
    db.saveBookings(bookings);
  }

  const message = `DRIPLINE dispatch: ${booking.package} for ${booking.name} in ${booking.city}. Total paid: $${booking.total}. Check the admin dashboard for address/contact details.`;

  const sentFree = sendFreeSms(nurse, message);

  if (!sentFree && twilioClient && TWILIO_FROM) {
    twilioClient.messages
      .create({ to: nurse.phone, from: TWILIO_FROM, body: message })
      .then(() => console.log(`Dispatch SMS sent via Twilio to ${nurse.name} for booking ${booking.id}`))
      .catch((err) => console.error('Failed to send dispatch SMS via Twilio:', err.message));
  } else if (!sentFree) {
    console.log(`[No SMS method configured] Would have texted ${nurse.name} (${nurse.phone}) about booking ${booking.id}`);
  }

  return nurse;
}

// ---------- NURSES (admin only) ----------

app.get('/nurses', requireAdmin, (req, res) => {
  res.json({ nurses: db.getNurses() });
});

app.post('/nurses', requireAdmin, (req, res) => {
  const { name, phone, city, carrier } = req.body;
  if (!name || !phone || !city) return res.status(400).json({ error: 'name, phone, and city are required' });

  const nurses = db.getNurses();
  const nurse = {
    id: 'n_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    name, phone, city,
    carrier: carrier || null, // needed for free SMS — e.g. "verizon", "att", "tmobile"
    active: true,
    lastDispatchedAt: null,
    createdAt: new Date().toISOString(),
  };
  nurses.push(nurse);
  db.saveNurses(nurses);
  res.json({ nurse });
});

app.patch('/nurses/:id', requireAdmin, (req, res) => {
  const nurses = db.getNurses();
  const nurse = nurses.find((n) => n.id === req.params.id);
  if (!nurse) return res.status(404).json({ error: 'Nurse not found' });

  if (typeof req.body.active === 'boolean') nurse.active = req.body.active;
  if (req.body.city) nurse.city = req.body.city;
  db.saveNurses(nurses);
  res.json({ nurse });
});

// ---------- BOOKINGS ADMIN VIEW ----------

app.get('/admin/bookings', requireAdmin, (req, res) => {
  const bookings = db.getBookings().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ bookings });
});

app.patch('/admin/bookings/:id', requireAdmin, (req, res) => {
  const bookings = db.getBookings();
  const booking = bookings.find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (req.body.status) booking.status = req.body.status;
  db.saveBookings(bookings);
  res.json({ booking });
});

// ---------- STATS (real persistence — replaces the earlier artifact-only storage) ----------

app.get('/stats', (req, res) => {
  const stats = db.getStats();
  if (stats.date !== todayKey()) {
    const reset = { total: 0, count: 0, date: todayKey() };
    db.saveStats(reset);
    return res.json(reset);
  }
  res.json(stats);
});

function incrementStats(amount) {
  const stats = db.getStats();
  const current = stats.date === todayKey() ? stats : { total: 0, count: 0, date: todayKey() };
  current.total += amount;
  current.count += 1;
  db.saveStats(current);
  return current;
}

// ---------- BOOKINGS ----------

app.post('/bookings', optionalAuth, (req, res) => {
  const { name, email, phone, city, package: pkg, total, paymentMethod } = req.body;
  if (!name || !total) return res.status(400).json({ error: 'name and total are required' });

  const bookings = db.getBookings();
  const booking = {
    id: 'b_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    userId: req.user ? req.user.id : null,
    name, email, phone, city,
    package: pkg,
    total,
    paymentMethod: paymentMethod || 'unspecified',
    paid: false,
    createdAt: new Date().toISOString(),
  };
  bookings.push(booking);
  db.saveBookings(bookings);

  res.json({ booking });
});

function markBookingPaid(bookingId) {
  const bookings = db.getBookings();
  const booking = bookings.find((b) => b.id === bookingId);
  if (booking && !booking.paid) {
    booking.paid = true;
    booking.status = 'paid';
    db.saveBookings(bookings);
    incrementStats(booking.total);
    dispatchNurse(booking); // this is the line that actually texts a nurse
  }
  return booking;
}

// ---------- STRIPE ----------

app.post('/create-checkout-session', async (req, res) => {
  const { description, amount, customerName, customerEmail, bookingId } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Card + Cash App Pay explicitly. Apple Pay / Google Pay appear automatically
      // for eligible browsers/devices once you enable them in the Stripe Dashboard —
      // no extra code needed here for those two.
      payment_method_types: ['card', 'cashapp'],
      customer_email: customerEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: description || 'DRIPLINE IV Service' },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: CANCEL_URL,
      metadata: { customerName: customerName || 'unknown', bookingId: bookingId || '' },
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('Stripe error creating session:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata && session.metadata.bookingId;
    if (bookingId) markBookingPaid(bookingId);
    console.log(`Stripe payment confirmed: ${session.id} — $${session.amount_total / 100}`);
  }

  res.sendStatus(200);
});

// ---------- PAYPAL ----------

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json();
  return data.access_token;
}

app.post('/create-paypal-order', async (req, res) => {
  const { amount, bookingId, returnUrl, cancelUrl } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'PayPal is not configured on this server yet' });
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: bookingId || 'dripline-booking',
            amount: { currency_code: 'USD', value: amount.toFixed(2) },
          },
        ],
        application_context: {
          return_url: returnUrl || SUCCESS_URL,
          cancel_url: cancelUrl || CANCEL_URL,
          user_action: 'PAY_NOW',
        },
      }),
    });
    const order = await resp.json();
    const approveLink = (order.links || []).find((l) => l.rel === 'approve');
    res.json({ id: order.id, approveUrl: approveLink ? approveLink.href : null });
  } catch (err) {
    console.error('PayPal order error:', err);
    res.status(500).json({ error: 'Failed to create PayPal order' });
  }
});

app.post('/capture-paypal-order/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { bookingId } = req.body;
  try {
    const accessToken = await getPayPalAccessToken();
    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    const capture = await resp.json();

    if (capture.status === 'COMPLETED' && bookingId) {
      markBookingPaid(bookingId);
    }
    res.json(capture);
  } catch (err) {
    console.error('PayPal capture error:', err);
    res.status(500).json({ error: 'Failed to capture PayPal payment' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`DRIPLINE backend running on port ${PORT}`));
