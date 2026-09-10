import assert from 'node:assert/strict';
import health from '../api/tmap-health.js';
import search from '../api/tmap-search.js';
import route from '../api/tmap-route.js';
import usage from '../api/tmap-usage.js';

function makeRes() {
  return {
    code: 0,
    headers: {},
    body: '',
    status(code) { this.code = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    end(value) { this.body = value; },
  };
}

delete process.env.TMAP_APP_KEY;

for (const key of [
  'STORAGE_URL', 'STORAGE_TOKEN',
  'STORAGE_KV_REST_API_URL', 'STORAGE_KV_REST_API_TOKEN',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
]) delete process.env[key];

let res = makeRes();
await health({ method: 'GET' }, res);
assert.equal(res.code, 200);
assert.equal(JSON.parse(res.body).configured, false);

res = makeRes();
await search({ method: 'GET', query: { q: '예시중학교' } }, res);
assert.equal(res.code, 405);

res = makeRes();
await search({ method: 'POST', body: { query: '예시중학교' } }, res);
assert.equal(res.code, 503);
assert.equal(JSON.parse(res.body).code, 'TMAP_APP_KEY_NOT_CONFIGURED');

res = makeRes();
await search({ method: 'POST', body: JSON.stringify({ query: '예시중학교' }) }, res);
assert.equal(res.code, 503);
assert.equal(JSON.parse(res.body).code, 'TMAP_APP_KEY_NOT_CONFIGURED');

res = makeRes();
await route({ method: 'POST', body: { start: { lat: 37.5, lon: 127 }, end: { lat: 37.51, lon: 127.01 } } }, res);
assert.equal(res.code, 503);
assert.equal(JSON.parse(res.body).code, 'TMAP_APP_KEY_NOT_CONFIGURED');

res = makeRes();
await usage({ method: 'GET' }, res);
assert.equal(res.code, 503);
assert.equal(JSON.parse(res.body).code, 'TMAP_USAGE_STORAGE_NOT_CONFIGURED');

console.log('API fallback test passed.');
