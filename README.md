# DRIPLINE Backend

Handles everything the front-end app can't safely do itself: customer accounts, real persistent storage (bookings + daily sales stats), and payment processing via **both Stripe and PayPal**.

## What's here
- **Customer registration & login** (`/register`, `/login`) — passwords hashed with bcrypt, sessions via JWT
- **Real database** — a simple JSON-file store (`db.js`) for users, bookings, and daily stats. Survives restarts, works with zero setup, and every function is a clean swap point for Postgres/Mongo later if you outgrow it
- **Bookings** (`/bookings`) — every booking is saved server-side, tied to a logged-in user if one exists, or as a guest
- **Stripe checkout** — card, plus Apple Pay/Google Pay (automatic once enabled in your Stripe Dashboard, no code needed) and Cash App Pay
- **PayPal checkout** — a second, independent payment option using PayPal's own hosted approval flow
- A **webhook** that's the actual source of truth for "did this get paid" — not just the redirect, since a customer can close the tab mid-payment

## Setup

```bash
npm install
cp .env.example .env
# fill in Stripe keys, PayPal keys (optional — leave blank to hide that option), and a JWT_SECRET
npm start
```

## Get your keys
- **Stripe**: dashboard.stripe.com/apikeys → copy the secret key (`sk_test_...` while testing). Webhook secret: Developers → Webhooks → Add endpoint → point at `https://your-backend-url/webhook`, subscribe to `checkout.session.completed`.
- **PayPal**: developer.paypal.com/dashboard/applications → create a sandbox app → copy Client ID + Secret. Leave `PAYPAL_ENV=sandbox` until you've fully tested, then switch to `live` with your live app's credentials.
- **JWT_SECRET**: any long random string, used to sign customer login sessions. Generate one with `openssl rand -hex 32` if you want a quick one.

## Deploy this in ~5 minutes (Render, free tier)

This project includes `render.yaml`, so Render can set almost everything up automatically.

1. Push this `dripline-backend` folder to a new GitHub repo (Render deploys from GitHub).
   ```bash
   cd dripline-backend
   git init && git add . && git commit -m "initial commit"
   # create an empty repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/dripline-backend.git
   git push -u origin main
   ```
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint** → connect the GitHub repo you just pushed.
3. Render reads `render.yaml` and prompts for the values it can't guess: Stripe keys, PayPal keys, JWT secret, success/cancel URLs.
4. Click **Apply**. You get a live URL like `https://dripline-backend.onrender.com`.
5. Copy that URL into `BACKEND_URL` in `dripline_app.html`.

Note: Render's free tier spins down after inactivity (~30-60 sec cold start on the next request) — fine for testing, worth the $7/mo paid tier before real customers hit "Confirm booking" and wait.

## Connect it to the app
Open `dripline_app.html`, find this line near the top of the `<script>` tag, and point it at your live Render URL:
```js
const BACKEND_URL = "https://your-dripline-backend.example.com";
```
Until you do that, the app runs in demo mode automatically — bookings and the tracker still work locally in the browser, just without real accounts or real charges. That's intentional so the app stays testable while you finish setup.

## Honest limitations of this version
- The JSON-file database works fine at launch scale but isn't built for high concurrent write volume — if you're doing hundreds of simultaneous bookings a day, move to a real database (this is a clean, contained swap in `db.js`).
- No password reset flow yet (would need an email-sending service like Resend or SendGrid wired in).
- No refund handling — Stripe/PayPal refunds still need to be issued from their dashboards directly for now.
- No admin dashboard to view bookings/users yet — right now that means reading `db/bookings.json` and `db/users.json` directly on the server.

Want any of those built next? The admin dashboard is probably the highest-value one if you're actually going to run this day to day.
