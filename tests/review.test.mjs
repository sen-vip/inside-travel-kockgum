import assert from 'node:assert/strict';
import { buildReviewGroups, durationMinutes, formatDuration } from '../src/review.js';
assert.equal(durationMinutes('2026-07-13 09:00', '2026-07-13 11:30'), 150);
assert.equal(formatDuration(150), '2시간 30분');
const trips = [
  { id: '1', startDate: '2026-07-13 09:00', endDate: '2026-07-13 11:00', traveler: '김○○', normalizedDestination: 'a', paymentAmount: 10000 },
  { id: '2', startDate: '2026-07-13 14:00', endDate: '2026-07-13 17:20', traveler: '김○○', normalizedDestination: 'b', paymentAmount: 10000 },
  { id: '3', startDate: '2026-07-14 09:00', endDate: '2026-07-14 10:00', traveler: '이○○', normalizedDestination: 'b', paymentAmount: 0 },
];
const destinations = [
  { key: 'a', location: { name: 'A' }, route: { totalDistance: 1700 }, routeStatus: 'complete' },
  { key: 'b', location: { name: 'B' }, route: { totalDistance: 4200 }, routeStatus: 'complete' },
];
const groups = buildReviewGroups({ trips, destinations, reviewMemory: {} });
assert.equal(groups.length, 2);
const kim = groups.find((group) => group.traveler === '김○○');
assert.equal(kim.trips.length, 2);
assert.equal(kim.totalDuration, 320);
assert.ok(kim.issues.includes('당일 여러 건'));
assert.ok(kim.issues.includes('왕복 2km 이내'));
assert.equal(kim.status, 'pending');
assert.equal(groups.find((group) => group.traveler === '이○○').status, 'clear');
console.log('review tests passed');
