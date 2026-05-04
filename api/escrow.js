// api/escrow.js
// AfriCarryApp — Escrow Payment Backend
// Deploy this file to Vercel at /api/escrow.js
//
// Required environment variables in Vercel dashboard:
//   STRIPE_SECRET_KEY        = sk_live_xxxx  (from stripe.com → Developers → API Keys)
//   STRIPE_WEBHOOK_SECRET    = whsec_xxxx    (from stripe.com → Webhooks)
//   SUPABASE_URL             = https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY     = eyJ...        (service role key — NOT anon key)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CORS HEADERS ──────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
  'Content-Type': 'application/json',
};

function ok(data) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
}
function err(msg, code = 400) {
  return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) };
}

// ── MAIN HANDLER ──────────────────────────────────────────
module.exports = async (req, res) => {
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).setHeader('Access-Control-Allow-Origin', '*')
       .setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
       .setHeader('Access-Control-Allow-Headers', 'Content-Type, stripe-signature')
       .end();
    return;
  }

  const { action } = req.query;

  try {
    switch (action) {

      // ── 1. ONBOARD TRAVELER (Stripe Connect) ────────────
      case 'onboard': {
        const { post_id, traveler_name, traveler_email } = req.body;

        // Create Stripe Express account for traveler
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'LR',         // Liberia
          email: traveler_email,
          capabilities: {
            transfers: { requested: true },
          },
          business_type: 'individual',
          metadata: { post_id: String(post_id), traveler_name },
        });

        // Save to Supabase
        await supabase.from('stripe_accounts').upsert({
          post_id,
          traveler_name,
          traveler_email,
          stripe_account_id: account.id,
        });

        // Create onboarding link
        const accountLink = await stripe.accountLinks.create({
          account: account.id,
          refresh_url: `${req.headers.origin}?onboard=refresh&post_id=${post_id}`,
          return_url:  `${req.headers.origin}?onboard=complete&post_id=${post_id}`,
          type: 'account_onboarding',
        });

        res.status(200).json({ url: accountLink.url });
        break;
      }

      // ── 2. CHECK TRAVELER PAYOUT STATUS ─────────────────
      case 'account_status': {
        const { post_id } = req.query;
        const { data } = await supabase
          .from('stripe_accounts')
          .select('*')
          .eq('post_id', post_id)
          .single();

        if (!data) return res.status(200).json({ connected: false });

        // Fetch live status from Stripe
        const account = await stripe.accounts.retrieve(data.stripe_account_id);
        const charges_enabled = account.charges_enabled;
        const payouts_enabled = account.payouts_enabled;

        // Update Supabase
        await supabase.from('stripe_accounts').update({
          charges_enabled,
          payouts_enabled,
          onboarding_complete: charges_enabled && payouts_enabled,
        }).eq('post_id', post_id);

        res.status(200).json({ connected: true, charges_enabled, payouts_enabled });
        break;
      }

      // ── 3. CREATE PAYMENT INTENT (sender pays) ──────────
      case 'create_payment': {
        const {
          post_id, sender_name, sender_email, sender_phone,
          package_description, weight_kg
        } = req.body;

        // Get traveler's listing and stripe account
        const { data: post } = await supabase
          .from('travel_posts')
          .select('*, stripe_accounts(*)')
          .eq('id', post_id)
          .single();

        if (!post) return res.status(404).json({ error: 'Listing not found' });

        const stripeAcct = post.stripe_accounts;
        if (!stripeAcct?.charges_enabled) {
          return res.status(400).json({ error: 'Traveler has not completed payout setup' });
        }

        // Calculate amounts (all in cents)
        const subtotal_cents       = Math.round(weight_kg * post.fee_per_kg * 100);
        const commission_cents     = Math.round(subtotal_cents * 0.10);      // 10%
        const traveler_payout_cents = subtotal_cents - commission_cents;      // 90%
        const stripe_fee_cents     = Math.round(subtotal_cents * 0.029 + 30); // 2.9% + 30¢

        // Create Payment Intent with application fee (our commission)
        const paymentIntent = await stripe.paymentIntents.create({
          amount: subtotal_cents,
          currency: 'usd',
          application_fee_amount: commission_cents,
          transfer_data: {
            destination: stripeAcct.stripe_account_id,
          },
          metadata: {
            post_id: String(post_id),
            sender_email,
            sender_name,
            weight_kg: String(weight_kg),
          },
          receipt_email: sender_email,
          description: `AfriCarryApp — Shipment to Liberia via ${post.name}`,
        });

        // Create booking record in Supabase
        const { data: booking } = await supabase.from('bookings').insert({
          post_id,
          sender_name,
          sender_email,
          sender_phone,
          package_description,
          weight_kg,
          fee_per_kg: post.fee_per_kg,
          subtotal_cents,
          commission_cents,
          traveler_payout_cents,
          stripe_fee_cents,
          stripe_payment_intent_id: paymentIntent.id,
          stripe_connected_acct: stripeAcct.stripe_account_id,
          status: 'pending',
          auto_release_at: new Date(
            new Date(post.travel_date).getTime() + 7 * 24 * 60 * 60 * 1000
          ).toISOString(),
        }).select().single();

        res.status(200).json({
          client_secret: paymentIntent.client_secret,
          booking_id: booking.id,
          amount: subtotal_cents,
          traveler_name: post.name,
          traveler_payout: traveler_payout_cents,
          commission: commission_cents,
        });
        break;
      }

      // ── 4. CONFIRM DELIVERY (dual — sender AND traveler required) ──────────
      case 'confirm_delivery': {
        const { booking_id, sender_email, role } = req.body;
        // role = 'sender' or 'traveler'

        const { data: booking } = await supabase
          .from('bookings')
          .select('*')
          .eq('id', booking_id)
          .single();

        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        if (booking.status === 'completed') return res.status(400).json({ error: 'Already completed' });
        if (booking.status === 'disputed')  return res.status(400).json({ error: 'Booking is disputed' });

        // Record this party's confirmation
        const updateData = {};
        if (role === 'sender') {
          if (booking.sender_confirmed) return res.status(400).json({ error: 'You have already confirmed' });
          updateData.sender_confirmed = true;
          updateData.sender_confirmed_at = new Date().toISOString();
        } else if (role === 'traveler') {
          if (booking.traveler_confirmed) return res.status(400).json({ error: 'You have already confirmed' });
          updateData.traveler_confirmed = true;
          updateData.traveler_confirmed_at = new Date().toISOString();
        } else {
          return res.status(400).json({ error: 'Invalid role — must be sender or traveler' });
        }

        await supabase.from('bookings').update(updateData).eq('id', booking_id);

        // Check if BOTH have now confirmed
        const senderOk   = role === 'sender'   ? true : booking.sender_confirmed;
        const travelerOk = role === 'traveler' ? true : booking.traveler_confirmed;

        if (senderOk && travelerOk) {
          // Both confirmed — release payout
          const transfer = await stripe.transfers.create({
            amount: booking.traveler_payout_cents,
            currency: 'usd',
            destination: booking.stripe_connected_acct,
            metadata: { booking_id: String(booking_id) },
          });

          // Mark booking completed
          await supabase.from('bookings').update({
            status: 'completed',
            delivery_confirmed: true,
            delivery_confirmed_at: new Date().toISOString(),
            stripe_transfer_id: transfer.id,
            completed_at: new Date().toISOString(),
          }).eq('id', booking_id);

          // Mark the travel post as completed — removes it from listings
          await supabase.from('travel_posts')
            .update({ status: 'completed' })
            .eq('id', booking.post_id);

          res.status(200).json({
            success: true,
            status: 'completed',
            post_id: booking.post_id,
            message: 'Both parties confirmed. Traveler payout released. Trip listing removed.',
            transfer_id: transfer.id,
            amount_released: booking.traveler_payout_cents,
          });
        } else {
          // Only one confirmed so far
          res.status(200).json({
            success: true,
            status: 'pending_other_confirmation',
            message: `Your confirmation recorded. Waiting for the ${role === 'sender' ? 'traveler' : 'sender'} to also confirm.`,
          });
        }
        break;
      }

      // ── 5. RAISE DISPUTE ────────────────────────────────
      case 'raise_dispute': {
        const { booking_id, sender_email, reason, details } = req.body;

        const { data: booking } = await supabase
          .from('bookings')
          .select('*')
          .eq('id', booking_id)
          .eq('sender_email', sender_email)
          .single();

        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        if (booking.status === 'completed') return res.status(400).json({ error: 'Already completed — cannot dispute' });

        // Create dispute record
        await supabase.from('disputes').insert({
          booking_id,
          raised_by: sender_email,
          reason,
          details,
          status: 'open',
        });

        // Freeze the booking
        await supabase.from('bookings').update({ status: 'disputed' }).eq('id', booking_id);

        res.status(200).json({
          success: true,
          message: 'Dispute raised. Our team will review within 48 hours.',
        });
        break;
      }

      // ── 6. GET BOOKINGS FOR A TRAVELER ──────────────────
      case 'get_bookings': {
        const { post_id } = req.query;

        const { data: bookings } = await supabase
          .from('bookings')
          .select('*')
          .eq('post_id', post_id)
          .order('created_at', { ascending: false });

        // Mask sender contact for privacy (show first 3 chars only)
        const masked = (bookings || []).map(b => ({
          ...b,
          sender_email: b.sender_email.substring(0, 3) + '***',
          sender_phone: b.sender_phone ? b.sender_phone.substring(0, 4) + '***' : null,
        }));

        res.status(200).json({ bookings: masked });
        break;
      }

      // ── 7. STRIPE WEBHOOK (auto-release after 7 days) ───
      case 'webhook': {
        const sig = req.headers['stripe-signature'];
        let event;

        try {
          event = stripe.webhooks.constructEvent(
            req.rawBody,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
          );
        } catch (e) {
          return res.status(400).json({ error: `Webhook error: ${e.message}` });
        }

        if (event.type === 'payment_intent.succeeded') {
          const pi = event.data.object;
          await supabase.from('bookings').update({
            status: 'paid',
            paid_at: new Date().toISOString(),
          }).eq('stripe_payment_intent_id', pi.id);
        }

        res.status(200).json({ received: true });
        break;
      }

      default:
        res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    console.error('Escrow error:', e);
    res.status(500).json({ error: e.message });
  }
};
