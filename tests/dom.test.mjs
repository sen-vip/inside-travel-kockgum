import fs from 'node:fs';
import assert from 'node:assert/strict';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const block = main.match(/Object\.fromEntries\(\[\n([\s\S]*?)\n\]\.map/);
assert.ok(block, 'DOM ID 목록을 찾지 못했습니다.');
const required = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
const missing = required.filter((id) => !htmlIds.includes(id));
assert.deepEqual(missing, [], `index.html에 없는 DOM ID: ${missing.join(', ')}`);
const duplicates = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicates)], [], `중복 DOM ID: ${duplicates.join(', ')}`);

assert.match(main, /async function confirmPendingLocation\(\)/, '위치 확정 후 비동기 거리 재계산 흐름이 필요합니다.');
assert.match(main, /await calculateDestination\(destination\)/, '수동 위치 확정 후 왕복거리 자동 계산 호출이 필요합니다.');

console.log(`DOM test passed: ${required.length} required IDs`);
