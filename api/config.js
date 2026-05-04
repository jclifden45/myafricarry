// api/config.js
// Vercel Serverless Function — serves Supabase credentials securely

export default function handler(req, res) {
  // Set CORS and content type headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return res.status(200).json({
      url: null,
      key: null,
      message: 'Environment variables not set in Vercel'
    });
  }

  return res.status(200).json({ url, key });
}
