import assert from 'node:assert/strict';
import health from '../api/tmap-health.js';
import search from '../api/tmap-search.js';
import route from '../api/tmap-route.js';

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
let res = makeRes();
await health({ method: 'GET' }, res);
assert.equal(res.code, 200);
assert.equal(JSON.parse(res.body).configured, false);

res = makeRes();
await search({ method: 'GET', query: { q: '예시중학교' } }, res);
assert.equal(res.code, 503);
assert.equal(JSON.parse(res.body).code, 'TMAP_APP_KEY_NOT_CONFIGURED');

res = makeRes();
await route({ method: 'POST', body: { start: { lat: 37.5, lon: 127, name: '출발' }, end: { lat: 37.51, lon: 127.01, name: '도착' } } }, res);
assert.equal(res.code, 503);
assert.equal(JSON.parse(res.body).code, 'TMAP_APP_KEY_NOT_CONFIGURED');
console.log('API fallback test passed.');
