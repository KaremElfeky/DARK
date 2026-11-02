// Store backed by Upstash Redis (REST API, no SDK needed). Used on Vercel.
// Works with the env vars set by Vercel's Upstash integration:
//   KV_REST_API_URL + KV_REST_API_TOKEN   or   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SET = 'mahami:devices';
const key = (id) => `mahami:dev:${id}`;

export const redisConfigured = () => !!(URL_ && TOKEN);

async function call(path, body) {
  if (!redisConfigured()) throw Object.assign(new Error('Redis is not configured (add Upstash from the Vercel Marketplace)'), { status: 503 });
  const res = await fetch(`${URL_.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`Redis error ${res.status}`);
  return json;
}

const cmd = async (...args) => {
  const json = await call('', args);
  if (json.error) throw new Error(json.error);
  return json.result;
};
const pipeline = (cmds) => call('/pipeline', cmds);

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export const redisStore = {
  async get(id) { return parse(await cmd('GET', key(id))); },
  async put(id, dev) { await pipeline([['SET', key(id), JSON.stringify(dev)], ['SADD', SET, id]]); },
  async remove(id) { await pipeline([['DEL', key(id)], ['SREM', SET, id]]); },
  async all() {
    const ids = await cmd('SMEMBERS', SET);
    if (!ids?.length) return [];
    const vals = await cmd('MGET', ...ids.map(key));
    return ids.map((id, i) => [id, parse(vals[i])]).filter(([, d]) => d);
  },
};
