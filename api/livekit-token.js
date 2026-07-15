// /api/livekit-token.js — Vercel serverless function (Node.js runtime).
//
// Issues short-lived, signed access tokens for LiveKit calls. The browser can never hold
// your LiveKit API secret directly (same reasoning as soil-ai.js and the Anthropic key) —
// anyone could open dev tools, copy it, and join/hijack any room on your project. So the
// front end asks this endpoint for a token, and this endpoint (on Vercel's servers) signs
// it with the real secret, which lives only in an environment variable.
//
// SETUP (one-time):
//   1. Make a free account at https://cloud.livekit.io -> create a project
//   2. Settings -> Keys -> copy the API Key and API Secret, and the WebSocket URL
//      (looks like wss://your-project.livekit.cloud)
//   3. In Vercel: Settings -> Environment Variables, add:
//        LIVEKIT_API_KEY    = ...
//        LIVEKIT_API_SECRET = ...
//   4. In index.html, set LIVEKIT_URL near the top of the script to your wss:// URL
//      (this one is not secret, it's fine to ship in client code).
//   5. Redeploy.
//
// This builds the JWT by hand (HMAC-SHA256, matching LiveKit's documented token format)
// instead of pulling in the livekit-server-sdk package, so — like soil-ai.js — this file
// needs no dependencies and no build step.

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signLiveKitToken({ apiKey, apiSecret, identity, name, room, canPublish, canSubscribe, ttlSeconds }) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: apiKey,
    sub: identity,
    name: name || identity,
    nbf: now - 5,
    exp: now + ttlSeconds,
    video: {
      room,
      roomJoin: true,
      canPublish,
      canSubscribe,
      canPublishData: true,
    },
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(signingInput).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    res.status(500).json({
      error: 'LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set on the server. Add them in Vercel -> Project Settings -> Environment Variables, then redeploy.',
    });
    return;
  }

  const { room, identity, name } = req.body || {};
  if (!room || typeof room !== 'string' || !identity || typeof identity !== 'string') {
    res.status(400).json({ error: 'Missing "room" or "identity" string in request body.' });
    return;
  }
  // Keep room names/identities from being used to inject unexpected JWT structure —
  // usernames in this app are already alphanumeric, this just enforces that server-side too.
  if (!/^[a-zA-Z0-9_\-|]{1,100}$/.test(room) || !/^[a-zA-Z0-9_\-]{1,60}$/.test(identity)) {
    res.status(400).json({ error: 'Invalid room or identity format.' });
    return;
  }

  try {
    const token = signLiveKitToken({
      apiKey,
      apiSecret,
      identity,
      name,
      room,
      canPublish: true,
      canSubscribe: true,
      ttlSeconds: 60 * 60, // 1 hour — plenty for a call session; token only gates the initial connect, not the whole call
    });
    res.status(200).json({ token });
  } catch (err) {
    console.error('livekit-token error', err);
    res.status(500).json({ error: 'Could not generate a call token.' });
  }
};
