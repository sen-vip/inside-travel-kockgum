const HEADER_ALIASES = {
  startDate: ['시작일', '출장시작일'],
  endDate: ['종료일', '출장종료일'],
  category: ['출장구분', '구분'],
  traveler: ['출장자', '성명'],
  destination: ['출장지', '출장장소'],
  purpose: ['출장목적', '목적'],
  unpaid: ['부지급'],
  travelAmount: ['여비금액', '여비'],
  paymentAmount: ['지급금액'],
};

const REQUIRED_HEADERS = ['startDate', 'endDate', 'category', 'traveler', 'destination'];
const EXCLUDE_WORDS = /^(합\s*계|총\s*계|소\s*계)$/;
const AMBIGUOUS_WORDS = /(인근|주변|일대|관내\s*일원|협의회\s*장소|학교\s*주변|산\s*주변|편의점\s*$)/;

export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[“”‘’]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeader(value) {
  return cleanText(value).replace(/[\s·:：()\[\]_-]/g, '');
}

export function normalizeDestination(value) {
  return cleanText(value)
    .replace(/[“”‘’]/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findHeaderMap(row) {
  const normalized = row.map(normalizeHeader);
  const map = {};

  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasSet = aliases.map(normalizeHeader);
    const index = normalized.findIndex((cell) => aliasSet.includes(cell));
    if (index >= 0) map[key] = index;
  }

  return REQUIRED_HEADERS.every((key) => Number.isInteger(map[key])) ? map : null;
}

function isDateLike(value, XLSX) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const decoded = XLSX?.SSF?.parse_date_code?.(value);
    return Boolean(decoded?.y && decoded?.m && decoded?.d);
  }
  const text = cleanText(value);
  if (!text) return false;
  return /^\d{4}[-./년]\s*\d{1,2}[-./월]\s*\d{1,2}/.test(text)
    || /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/.test(text);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatExcelDate(value, XLSX) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = XLSX?.SSF?.parse_date_code?.(value);
    if (d?.y) return `${d.y}-${pad(d.m)}-${pad(d.d)} ${pad(d.H || 0)}:${pad(d.M || 0)}`;
  }

  const text = cleanText(value)
    .replace(/년\s*/g, '-')
    .replace(/월\s*/g, '-')
    .replace(/일/g, '')
    .replace(/[./]/g, '-');

  const match = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+|T)?(\d{1,2})?:?(\d{1,2})?/);
  if (!match) return cleanText(value);
  return `${match[1]}-${pad(match[2])}-${pad(match[3])} ${pad(match[4] || 0)}:${pad(match[5] || 0)}`;
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const number = Number(cleanText(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function cell(row, map, key) {
  const index = map[key];
  return Number.isInteger(index) ? row[index] : '';
}

function isTripRow(row, map, XLSX) {
  const start = cell(row, map, 'startDate');
  const end = cell(row, map, 'endDate');
  const category = cleanText(cell(row, map, 'category'));
  const traveler = cleanText(cell(row, map, 'traveler'));
  const destination = cleanText(cell(row, map, 'destination'));

  if (!isDateLike(start, XLSX) || !isDateLike(end, XLSX)) return false;
  if (!category.includes('관내')) return false;
  if (!traveler || !destination) return false;
  if (EXCLUDE_WORDS.test(destination.replace(/\s+/g, ''))) return false;
  return true;
}

export function extractAddress(text) {
  const value = cleanText(text);
  if (!value) return '';

  const candidates = [];
  const parentheses = [...value.matchAll(/\(([^()]*)\)/g)].map((match) => cleanText(match[1]));
  candidates.push(...parentheses, value);

  for (const candidate of candidates) {
    if (!/(특별시|광역시|특별자치시|특별자치도|[가-힣]+구|[가-힣]+시)/.test(candidate)) continue;
    if (!/(로|길|대로|번길)\s*\d+/.test(candidate)) continue;
    const match = candidate.match(/((?:서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|[가-힣]+도)?\s*[가-힣]+(?:시|군|구)?\s*[가-힣0-9·.-]+(?:대로|로|길|번길)\s*\d+(?:-\d+)?(?:\s*\d+동)?)/);
    if (match) return cleanText(match[1]);
  }
  return '';
}

export function isAmbiguousDestination(text) {
  return AMBIGUOUS_WORDS.test(cleanText(text));
}

export function parseEdufineWorkbook(arrayBuffer, XLSX) {
  const workbook = XLSX.read(arrayBuffer, {
    type: 'array',
    cellDates: true,
    raw: true,
    dense: true,
    WTF: false,
  });

  if (!workbook.SheetNames?.length) {
    throw new Error('워크시트를 찾지 못했습니다.');
  }

  const trips = [];
  let foundHeader = false;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: true,
      blankrows: true,
    });

    let activeMap = null;
    rows.forEach((row, rowIndex) => {
      const headerMap = findHeaderMap(row);
      if (headerMap) {
        activeMap = headerMap;
        foundHeader = true;
        return;
      }
      if (!activeMap || !isTripRow(row, activeMap, XLSX)) return;

      const destination = cleanText(cell(row, activeMap, 'destination'));
      const normalizedDestination = normalizeDestination(destination);
      trips.push({
        id: `${sheetName}-${rowIndex + 1}-${trips.length + 1}`,
        sheetName,
        sourceRow: rowIndex + 1,
        startDate: formatExcelDate(cell(row, activeMap, 'startDate'), XLSX),
        endDate: formatExcelDate(cell(row, activeMap, 'endDate'), XLSX),
        category: cleanText(cell(row, activeMap, 'category')),
        traveler: cleanText(cell(row, activeMap, 'traveler')),
        destination,
        normalizedDestination,
        purpose: cleanText(cell(row, activeMap, 'purpose')),
        unpaid: cleanText(cell(row, activeMap, 'unpaid')),
        travelAmount: parseNumber(cell(row, activeMap, 'travelAmount')),
        paymentAmount: parseNumber(cell(row, activeMap, 'paymentAmount')),
      });
    });
  }

  if (!foundHeader) {
    const error = new Error('에듀파인 관내여비 내역의 표 머리글을 찾지 못했습니다.');
    error.code = 'HEADER_NOT_FOUND';
    throw error;
  }

  if (!trips.length) {
    const error = new Error('관내출장 내역을 찾지 못했습니다.');
    error.code = 'NO_TRIPS';
    throw error;
  }

  const destinationsByKey = new Map();
  trips.forEach((trip) => {
    const key = trip.normalizedDestination;
    if (!destinationsByKey.has(key)) {
      destinationsByKey.set(key, {
        key,
        originalName: trip.destination,
        searchQuery: extractAddress(trip.destination) || trip.destination,
        extractedAddress: extractAddress(trip.destination),
        ambiguous: isAmbiguousDestination(trip.destination),
        tripIds: [],
        travelers: new Set(),
        dates: new Set(),
      });
    }
    const destination = destinationsByKey.get(key);
    destination.tripIds.push(trip.id);
    destination.travelers.add(trip.traveler);
    destination.dates.add(trip.startDate.slice(0, 10));
  });

  const destinations = [...destinationsByKey.values()].map((destination) => ({
    ...destination,
    travelers: [...destination.travelers],
    dates: [...destination.dates].sort(),
    count: destination.tripIds.length,
  }));

  return {
    sheetNames: workbook.SheetNames,
    trips,
    destinations,
    summary: {
      tripCount: trips.length,
      travelerCount: new Set(trips.map((trip) => trip.traveler)).size,
      destinationCount: destinations.length,
    },
  };
}
