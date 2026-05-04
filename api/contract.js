// api/contract.js
// AfriCarryApp — Digital Contract Generator
// Generates a PDF contract for each confirmed booking
//
// Environment variables required (same as escrow.js):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(200).setHeader('Access-Control-Allow-Origin', '*').end();
    return;
  }

  const { booking_id, email } = req.query;

  if (!booking_id || !email) {
    return res.status(400).json({ error: 'booking_id and email are required' });
  }

  try {
    // Fetch booking and related post
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*, travel_posts(*)')
      .eq('id', booking_id)
      .single();

    if (error || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Verify the requester is involved in this booking
    const isAuthorized =
      booking.sender_email === email ||
      booking.travel_posts?.contact === email;

    if (!isAuthorized) {
      return res.status(403).json({ error: 'Not authorized to view this contract' });
    }

    const post     = booking.travel_posts;
    const amount   = (booking.subtotal_cents / 100).toFixed(2);
    const payout   = (booking.traveler_payout_cents / 100).toFixed(2);
    const commission = (booking.commission_cents / 100).toFixed(2);
    const bookedAt = new Date(booking.created_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    const travelDate = new Date(post.travel_date + 'T00:00:00').toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    // Return contract data as JSON (frontend renders it as a printable page)
    res.status(200).json({
      contract: {
        reference:           `ACA-${booking_id}-${Date.now().toString(36).toUpperCase()}`,
        booking_id,
        status:              booking.status,
        booked_at:           bookedAt,
        // Traveler
        traveler_name:       post.name,
        traveler_origin:     post.origin,
        traveler_destination:post.destination,
        travel_date:         travelDate,
        // Sender
        sender_name:         booking.sender_name,
        sender_email:        booking.sender_email,
        // Package
        weight_kg:           booking.weight_kg,
        package_description: booking.package_description || 'Not specified',
        // Financials
        fee_per_kg:          booking.fee_per_kg,
        total_amount:        amount,
        platform_commission: commission,
        traveler_payout:     payout,
        // Agreement terms
        terms: [
          'The Sender confirms that all items comply with US, Liberian, and international customs laws.',
          'The Traveler agrees to carry the package safely and deliver it to the specified recipient.',
          'Payment is held in escrow by AfriCarryApp until delivery is confirmed by the Sender.',
          'The Sender has 48 hours after the expected delivery date to raise a dispute.',
          'Neither party may transport prohibited items as listed in the AfriCarryApp Terms of Use.',
          'AfriCarryApp retains a 10% platform commission from the total shipment fee.',
          `The Traveler will receive $${payout} USD upon confirmed delivery.`,
          'This agreement is legally binding upon payment confirmation by Stripe.',
          'Governing law: United States of America.',
        ]
      }
    });

  } catch (e) {
    console.error('Contract error:', e);
    res.status(500).json({ error: e.message });
  }
};
