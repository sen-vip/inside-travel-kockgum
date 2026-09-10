import assert from 'node:assert/strict';
import {
  getKstDate,
  getUsageSnapshot,
  reserveRouteCalls,
  resolveRedisConfig,
} from '../api/_usage.js';

const originalFetch = global.fetch;
const originalEnv = {
  STORAGE_URL: process.env.STORAGE_URL,
  STORAGE_TOKEN: process.env.STORAGE_TOKEN,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
};

try {
  process.env.STORAGE_URL = 'https://example.upstash.io';
  process.env.STORAGE_TOKEN = 'test-token';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const config = resolveRedisConfig();
  assert.equal(config?.url, 'https://example.upstash.io');
  assert.deepEqual(config?.envNames, ['STORAGE_URL', 'STORAGE_TOKEN']);
  assert.equal(getKstDate(new Date('2026-09-10T15:30:00Z')), '2026-09-11');

  let sentCommand = null;
  global.fetch = async (_url, options) => {
    sentCommand = JSON.parse(options.body);
    return { ok: true, json: async () => ({ result: [1, 2] }) };
  };
  const reserved = await reserveRouteCalls(2, new Date('2026-09-10T12:00:00Z'));
  assert.equal(reserved.allowed, true);
  assert.equal(reserved.used, 2);
  assert.equal(reserved.safeLimit, 900);
  assert.equal(sentCommand[0], 'EVAL');
  assert.match(sentCommand[3], /2026-09-10$/);

  global.fetch = async () => ({ ok: true, json: async () => ({ result: 812 }) });
  const snapshot = await getUsageSnapshot(new Date('2026-09-10T12:00:00Z'));
  assert.equal(snapshot.used, 812);
  assert.equal(snapshot.warning, true);
  assert.equal(snapshot.blocked, false);
  assert.equal(snapshot.remainingSafe, 88);

  global.fetch = async () => ({ ok: true, json: async () => ({ result: [0, 899] }) });
  const blocked = await reserveRouteCalls(2, new Date('2026-09-10T12:00:00Z'));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 899);
} finally {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log('TMAP usage guard test passed.');
