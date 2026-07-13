import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseEdufineWorkbook } from '../src/parser.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const args = process.argv.slice(2);
const targets = args.length ? args : [
  new URL('./fixtures/edufine-sample.xls', import.meta.url).pathname,
  new URL('./fixtures/edufine-sample.xlsx', import.meta.url).pathname,
];

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
}

if (results.length > 1) {
  assert.deepEqual(results[0].summary, results[1].summary);
  assert.deepEqual(
    results[0].trips.map(({ startDate, endDate, category, traveler, destination, purpose, unpaid, travelAmount, paymentAmount }) => ({ startDate, endDate, category, traveler, destination, purpose, unpaid, travelAmount, paymentAmount })),
    results[1].trips.map(({ startDate, endDate, category, traveler, destination, purpose, unpaid, travelAmount, paymentAmount }) => ({ startDate, endDate, category, traveler, destination, purpose, unpaid, travelAmount, paymentAmount })),
  );
}

console.log('Parser test passed.');
