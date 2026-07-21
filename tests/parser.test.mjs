import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildDestinationSearchQuery, parseEdufineWorkbook, stripIndoorLocation } from '../src/parser.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const args = process.argv.slice(2);
const targets = args.length ? args : [
  new URL('./fixtures/edufine-sample.xls', import.meta.url).pathname,
  new URL('./fixtures/edufine-sample.xlsx', import.meta.url).pathname,
  new URL('./fixtures/edufine-target-list-sample.xlsx', import.meta.url).pathname,
];


assert.equal(stripIndoorLocation('서울특별시교육청 1층 시청각실'), '서울특별시교육청');
assert.equal(stripIndoorLocation('서울특별시교육청 별관 3층 회의실'), '서울특별시교육청 별관');
assert.equal(stripIndoorLocation('강남서초교육지원청 대강당'), '강남서초교육지원청');
assert.equal(stripIndoorLocation('동작구 장승배기로30길 6-1'), '동작구 장승배기로30길 6-1');
assert.equal(stripIndoorLocation('관악구 행운1길 62, 1층 3호'), '관악구 행운1길 62');
assert.equal(buildDestinationSearchQuery('서울 종로구 송월길 48, 3층 회의실').query, '서울 종로구 송월길 48');
assert.equal(buildDestinationSearchQuery('서울특별시교육청(1층 시청각실)').indoorAdjusted, true);

const results = targets.map((file) => {
  const buffer = fs.readFileSync(file);
  const parsed = parseEdufineWorkbook(buffer, XLSX);
  console.log(file, parsed.summary);
  console.log(parsed.destinations.map((item) => `${item.originalName}:${item.count}`).join(' | '));
  assert.ok(parsed.summary.tripCount > 0, '출장 데이터가 있어야 합니다.');
  return parsed;
});

if (!args.length) {
  assert.deepEqual(results[0].summary, { tripCount: 4, travelerCount: 4, destinationCount: 3 });
  assert.equal(results[0].destinations.find((item) => item.originalName === '새봄중학교')?.count, 2);
  assert.equal(results[0].destinations.find((item) => item.originalName === '인근 편의점')?.ambiguous, true);
  assert.equal(results[0].destinations.find((item) => item.originalName.includes('한국예시기관'))?.extractedAddress, '성동구 아차산로17길 49');

  assert.deepEqual(results[2].summary, { tripCount: 3, travelerCount: 3, destinationCount: 2 });
  assert.equal(results[2].trips[1].category, '관내-반일');
  assert.equal(results[2].trips[0].paymentAmount, 10000);
  assert.equal(results[2].destinations.find((item) => item.originalName === '새봄초, 하늘중')?.ambiguous, true);
}

if (results.length > 1) {
  assert.deepEqual(results[0].summary, results[1].summary);
  assert.deepEqual(
    results[0].trips.map(({ startDate, endDate, category, traveler, destination, purpose, unpaid, travelAmount, paymentAmount }) => ({ startDate, endDate, category, traveler, destination, purpose, unpaid, travelAmount, paymentAmount })),
    results[1].trips.map(({ startDate, endDate, category, traveler, destination, purpose, unpaid, travelAmount, paymentAmount }) => ({ startDate, endDate, category, traveler, destination, purpose, unpaid, travelAmount, paymentAmount })),
  );
}

console.log('Parser test passed.');
