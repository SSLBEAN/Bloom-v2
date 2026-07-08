// /api/soil-ai.js — Vercel serverless function (Node.js runtime).
//
// This is what makes SOIL Analyze / Mastering Notes / Trend Search actually work in
// production. The browser can NEVER hold your Anthropic API key directly — anyone could
// open dev tools, copy it, and run up your bill. So the front end calls this endpoint,
// and this endpoint (running on Vercel's servers, not the visitor's phone) calls Anthropic
// with the real key, which lives only in an environment variable.
//
// SETUP (one-time):
//   1. Get an API key at https://console.anthropic.com  (Settings → API Keys)
//   2. In your Vercel project: Settings → Environment Variables
//      → Add ANTHROPIC_API_KEY = sk-ant-...   (all environments)
//   3. Redeploy. That's it — no other code changes needed.
//
// This file needs no dependencies (uses the Node 18+ global fetch), so there's no
// package.json/build step required for it to work on Vercel.

// Very small in-memory per-IP rate limit so one visitor can't accidentally (or on purpose)
// burn through your Anthropic quota. Resets whenever the serverless function cold-starts —
// good enough for a small/medium app; swap for Upstash Redis or similar if Bloom grows.
const hits = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 8;
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length <= maxRequests;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set on the server. Add it in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').toString().split(',')[0].trim();
  if (!rateLimitOk(ip)) {
    res.status(429).json({ error: 'Too many AI requests from this device in the last minute — wait a bit and try again.' });
    return;
  }

  const { prompt, useSearch } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Missing "prompt" string in request body.' });
    return;
  }

  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt.slice(0, 4000) }],
  };
  if (useSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      res.status(anthropicRes.status).json({ error: data?.error?.message || 'Anthropic API error.' });
      return;
    }
    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    res.status(200).json({ text });
  } catch (err) {
    console.error('soil-ai proxy error', err);
    res.status(500).json({ error: 'Could not reach the AI service.' });
  }
}

