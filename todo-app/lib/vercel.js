// Glue between Vercel Serverless Functions (api/*.js) and the shared core.
import { createCore } from './core.js';
import { redisStore } from './redis-store.js';

let core = null;

function getCore() {
  if (core) return core;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw Object.assign(new Error('Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in the Vercel project settings'), { status: 503 });
  }
  core = createCore({
    store: redisStore,
    vapid: { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY },
    subject: process.env.VAPID_SUBJECT,
    recognizeUrl: process.env.RECOGNIZE_URL,
    pushHosts: process.env.PUSH_HOSTS,
  });
  return core;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  try {
    const { status, data } = await getCore().handle(req.method, pathname, body || {});
    res.status(status).json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'server error' });
  }
}
