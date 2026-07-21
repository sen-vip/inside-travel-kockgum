const HEADER_ALIASES = {
  startDate: ['시작일', '시작일자', '출장시작일'],
  endDate: ['종료일', '종료일자', '출장종료일'],
  category: ['출장구분', '구분'],
  traveler: ['출장자', '성명'],
  destination: ['출장지', '출장장소'],
  purpose: ['출장목적', '목적'],
  unpaid: ['부지급'],
  travelAmount: ['여비금액', '여비'],
  paymentAmount: ['지급금액', '지급액'],
};

const REQUIRED_HEADERS = ['startDate', 'endDate', 'category', 'traveler', 'destination'];
const EXCLUDE_WORDS = /^(합\s*계|총\s*계|소\s*계)$/;
const AMBIGUOUS_WORDS = /(인근|주변|일대|관내\s*일원|협의회(?:\s*장소)?|학교\s*주변|산\s*주변|카페|커피|편의점|식당|음식점|본청)/;

const INDOOR_ROOM_WORDS = [
  '시청각실', '대회의실', '소회의실', '회의실', '대강당', '강당', '교육장', '연수실',
  '세미나실', '상황실', '회의장', '체육관', '도서실', '행정실', '교장실', '교무실',
  '상담실', '다목적실', '컴퓨터실', '정보실', '방송실', '급식실',
];
const INDOOR_ROOM_PATTERN = `(?:제\\s*\\d+\\s*)?(?:${INDOOR_ROOM_WORDS.join('|')})`;
const FLOOR_PATTERN = '(?:지하\\s*\\d+\\s*층?|B\\s*\\d+\\s*층?|\\d+\\s*층)';
const BUILDING_PATTERN = '(?:본관|별관|신관|구관|후관|제\\s*\\d+\\s*관)';

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


function preserveBuildingName(fragment) {
  const match = cleanText(fragment).match(new RegExp(BUILDING_PATTERN, 'i'));
  return match ? cleanText(match[0]) : '';
}

export function stripIndoorLocation(value) {
  let text = cleanText(value);
  if (!text) return '';

  // 괄호 전체가 층·실 정보인 경우 제거하되, 본관·별관 같은 건물 구분은 남긴다.
  text = text.replace(/\(([^()]*)\)/g, (full, inner) => {
    const content = cleanText(inner);
    const hasFloor = new RegExp(FLOOR_PATTERN, 'i').test(content);
    const hasRoom = new RegExp(INDOOR_ROOM_PATTERN, 'i').test(content);
    const hasRoadAddress = /(?:대로|로|길|번길)\s*\d+/.test(content);
    if ((!hasFloor && !hasRoom) || hasRoadAddress) return full;
    const building = preserveBuildingName(content);
    return building ? ` ${building}` : '';
  });

  // 문자열 끝에 붙은 층·실 정보를 제거한다. 도로명 숫자와 번지는 건드리지 않는다.
  const floorAndTail = new RegExp(`\\s*(?:[,·/|-]\\s*)?${FLOOR_PATTERN}(?:\\s*\\d+\\s*호)?(?:\\s+${INDOOR_ROOM_PATTERN})?\\s*$`, 'i');
  const roomOnly = new RegExp(`\\s*(?:[,·/|-]\\s*)?${INDOOR_ROOM_PATTERN}\\s*$`, 'i');
  let previous = '';
  while (text && text !== previous) {
    previous = text;
    text = text.replace(floorAndTail, '').replace(roomOnly, '');
    text = cleanText(text).replace(/[,·/|-]+\s*$/, '').trim();
  }

  return cleanText(text);
}

export function buildDestinationSearchQuery(value) {
  const original = cleanText(value);
  const originalWithoutIndoor = stripIndoorLocation(original);
  const extractedAddress = extractAddress(originalWithoutIndoor || original);
  const base = extractedAddress || originalWithoutIndoor || original;
  const query = stripIndoorLocation(base) || base || original;
  return {
    query,
    extractedAddress,
    changed: normalizeDestination(query) !== normalizeDestination(original),
    indoorAdjusted: normalizeDestination(originalWithoutIndoor) !== normalizeDestination(original),
  };
}

function findHeaderMap(...headerRows) {
  const rows = headerRows.filter(Array.isArray);
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const map = {};

  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasSet = aliases.map(normalizeHeader);
    for (let column = 0; column < columnCount; column += 1) {
      const matched = rows.some((row) => aliasSet.includes(normalizeHeader(row[column])));
      if (matched) {
        map[key] = column;
        break;
      }
    }
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

function isTripRow(row, map, XLSX, effectiveCategory = '') {
  const start = cell(row, map, 'startDate');
  const end = cell(row, map, 'endDate');
  const category = cleanText(effectiveCategory || cell(row, map, 'category'));
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
    const match = candidate.match(/((?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|[가-힣]+도)?\s*[가-힣]+(?:시|군|구)?\s*[가-힣0-9·.-]+(?:대로|로|길|번길)\s*\d+(?:-\d+)?(?:\s*\d+동)?)/);
    if (match) return cleanText(match[1]);
  }
  return '';
}

export function isAmbiguousDestination(text) {
  const value = cleanText(text);
  if (!value) return true;
  if (AMBIGUOUS_WORDS.test(value)) return true;
  if (/\(\s*(?:[2-9]|\d{2,})\s*곳\s*\)|외\s*\d+\s*곳/.test(value)) return true;

  const parts = value.split(',').map(cleanText).filter(Boolean);
  if (parts.length <= 1) return false;

  const locationLikeCount = parts.filter((part) => {
    if (/(?:초|중|고|유|학교|교육청|연수원|도서관|복지관)$/.test(part)) return true;
    if (/(?:[가-힣]+(?:시|군|구|동)\s*)?[가-힣0-9·.-]+(?:대로|로|길|번길)\s*\d+(?:-\d+)?/.test(part)) return true;
    if (/[가-힣]+동\s*\d+(?:-\d+)?/.test(part)) return true;
    return false;
  }).length;

  return locationLikeCount >= 2;
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
    let inheritedCategory = '';
    rows.forEach((row, rowIndex) => {
      const headerMap = findHeaderMap(row) || findHeaderMap(row, rows[rowIndex + 1]);
      if (headerMap) {
        activeMap = headerMap;
        inheritedCategory = '';
        foundHeader = true;
        return;
      }
      if (!activeMap) return;

      const rowCategory = cleanText(cell(row, activeMap, 'category'));
      if (rowCategory) inheritedCategory = rowCategory;
      const effectiveCategory = rowCategory || inheritedCategory;
      if (!isTripRow(row, activeMap, XLSX, effectiveCategory)) return;

      const destination = cleanText(cell(row, activeMap, 'destination'));
      const normalizedDestination = normalizeDestination(destination);
      trips.push({
        id: `${sheetName}-${rowIndex + 1}-${trips.length + 1}`,
        sheetName,
        sourceRow: rowIndex + 1,
        startDate: formatExcelDate(cell(row, activeMap, 'startDate'), XLSX),
        endDate: formatExcelDate(cell(row, activeMap, 'endDate'), XLSX),
        category: effectiveCategory,
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
    const error = new Error('에듀파인 관내여비 내역 또는 대상목록의 표 머리글을 찾지 못했습니다.');
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
      const search = buildDestinationSearchQuery(trip.destination);
      destinationsByKey.set(key, {
        key,
        originalName: trip.destination,
        searchQuery: search.query,
        searchQueryChanged: search.changed,
        searchQueryIndoorAdjusted: search.indoorAdjusted,
        extractedAddress: search.extractedAddress,
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
