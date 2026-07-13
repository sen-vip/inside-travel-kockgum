import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseEdufineWorkbook } from '../src/parser.js';
import { exportResults } from '../src/exporter.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const fixture = new URL('./fixtures/edufine-sample.xlsx', import.meta.url).pathname;
const parsed = parseEdufineWorkbook(fs.readFileSync(fixture), XLSX);
const destinations = parsed.destinations.map((item, index) => ({
  ...item,
  location: index === 1 ? null : { name: item.originalName, address: '서울특별시 예시구 예시로 1', lat: 37.5 + index / 100, lon: 127 + index / 100 },
  routeStatus: index === 1 ? 'pending' : 'complete',
  route: index === 1 ? null : {
    outbound: { distance: index === 0 ? 850 : 1300, path: [] },
    inbound: { distance: index === 0 ? 900 : 1350, path: [] },
    totalDistance: index === 0 ? 1750 : 2650,
  },
}));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'inside-travel-export-'));
const previous = process.cwd();
process.chdir(temp);
try {
  exportResults({ XLSX, trips: parsed.trips, destinations, workplace: { name: '예시중학교', address: '서울특별시 예시구', lat: 37.5, lon: 127 } });
  const files = fs.readdirSync(temp).filter((name) => name.endsWith('.xlsx'));
  assert.equal(files.length, 1);
  const workbook = XLSX.readFile(path.join(temp, files[0]));
  assert.deepEqual(workbook.SheetNames, ['출장별 결과', '출장지별 거리', '확인 필요']);
  const resultRows = XLSX.utils.sheet_to_json(workbook.Sheets['출장지별 거리']);
  assert.equal(resultRows.length, 3);
  console.log('Exporter test passed:', files[0]);
} finally {
  process.chdir(previous);
  fs.rmSync(temp, { recursive: true, force: true });
}
