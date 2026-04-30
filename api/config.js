// api/config.js
// Serves Supabase public credentials securely via environment variables
// The credentials never appear in your HTML or GitHub code
//
// ── SETUP (do this once in Vercel) ──────────────────────
// Go to: Vercel → Your Project → Settings → Environment Variables
// Add these two variables:
//
//   SUPABASE_URL       = https://dnqruxabikiwoqoqyrmv.supabase.co
//   SUPABASE_ANON_KEY  = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
//
// That's it. Your credentials stay in Vercel — never in your code.
// ─────────────────────────────────────────────────────────

module.exports = (req, res) => {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  // If env vars not set, return empty (app falls back to demo mode)
  if (!url || !key) {
    return res.status(200).json({
      url: null,
      key: null,
      message: 'Environment variables not configured'
    });
  }

  // Return credentials to the frontend
  // Safe to return the anon key — it is designed to be public
  // It is protected by Supabase Row Level Security policies
  res.status(200).json({ url, key });
};
