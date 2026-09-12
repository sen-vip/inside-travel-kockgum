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
assert.match(html, /id="back-to-top"/, '맨 위로 버튼이 필요합니다.');
assert.match(main, /window\.scrollTo\(\{ top: 0, behavior: 'smooth' \}\)/, '맨 위로 버튼은 부드러운 최상단 이동을 사용해야 합니다.');


const overviewIndex = html.indexOf('id="result-overview"');
const destinationIndex = html.indexOf('id="destination-section"');
const detailIndex = html.indexOf('id="result-section"');
assert.ok(overviewIndex !== -1 && destinationIndex !== -1 && detailIndex !== -1, '결과 요약/출장지별 거리/출장별 결과 영역이 필요합니다.');
assert.ok(overviewIndex < destinationIndex && destinationIndex < detailIndex, '결과 흐름은 요약 → 출장지별 거리 → 출장별 결과 순서여야 합니다.');
assert.match(main, /completionPulsePending = true/, '거리점검 완료 시 결과 요약 1회 강조 트리거가 필요합니다.');
assert.match(main, /destination_title\.textContent = '출장지별 거리를 확인하세요'/, '점검 완료 뒤 출장지별 거리를 대표 결과로 안내해야 합니다.');

console.log(`DOM test passed: ${required.length} required IDs`);
