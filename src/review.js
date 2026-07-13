export const TRANSPORT_OPTIONS = [
  { value: 'unknown', label: '확인 못함' },
  { value: 'walk', label: '도보' },
  { value: 'official', label: '공용차량' },
  { value: 'private', label: '자가용' },
  { value: 'transit', label: '대중교통' },
  { value: 'taxi', label: '택시' },
];

export function parseDateTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function durationMinutes(startDate, endDate) {
  const start = parseDateTime(startDate);
  const end = parseDateTime(endDate);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

export function formatDuration(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (!hours) return `${rest}분`;
  if (!rest) return `${hours}시간`;
  return `${hours}시간 ${rest}분`;
}

export function paidAmount(trip) {
  return Number(trip?.paymentAmount || trip?.travelAmount || 0);
}

export function transportLabel(value) {
  return TRANSPORT_OPTIONS.find((item) => item.value === value)?.label || '확인 못함';
}

export function deriveTripReview(trip, destination, transport = 'unknown') {
  const distance = destination?.route?.totalDistance;
  const failed = destination?.searchStatus === 'error' || destination?.routeStatus === 'error';
  const routeReady = Boolean(destination?.location) && Number.isFinite(distance) && !failed;
  const within = routeReady && distance <= 2000;
  const over = routeReady && distance > 2000;
  const boundary = routeReady && distance >= 1900 && distance <= 2100;
  const paid = paidAmount(trip);
  const issues = [];

  if (!routeReady) issues.push('위치·거리 확인');
  if (within) issues.push('왕복 2km 이내');
  if (boundary) issues.push('경계 구간');
  if (within && paid > 0) issues.push('지급내역 확인');
  if (within && transport === 'unknown') issues.push('이동수단 확인');

  let headline = '일반 관내출장 기준 검토';
  let note = '거리 결과와 출장시간을 함께 확인해 주세요.';
  if (!routeReady) {
    headline = '거리 판단 보류';
    note = '출장지 위치 또는 보행 왕복거리를 먼저 확인해 주세요.';
  } else if (within) {
    if (transport === 'walk') {
      headline = '실제 교통비 확인';
      note = '왕복 2km 이내이며 이동수단이 도보로 입력되었습니다.';
    } else if (transport === 'official') {
      headline = '공용차량 이용 기준 확인';
      note = '왕복 2km 이내이며 공용차량 이용으로 입력되었습니다.';
    } else if (transport === 'transit' || transport === 'taxi') {
      headline = '실비 확인 필요';
      note = '왕복 2km 이내이므로 실제 발생한 운임을 확인해 주세요.';
    } else if (transport === 'private') {
      headline = '기관 기준 확인';
      note = '왕복 2km 이내 자가용 이용 건의 실제 비용과 기관 기준을 확인해 주세요.';
    } else {
      headline = '이동수단 확인';
      note = '왕복 2km 이내입니다. 실제 이동수단과 교통비 발생 여부를 확인해 주세요.';
    }
  } else if (over) {
    headline = '일반 관내출장 기준 검토';
    note = '왕복 2km를 초과합니다. 출장시간과 차량 이용 여부를 확인해 주세요.';
  }
  if (boundary) note = `경계 구간입니다. 실제 출입구 위치를 확인한 뒤 ${note}`;

  return { distance, routeReady, within, over, boundary, paid, issues, headline, note, transport, duration: durationMinutes(trip?.startDate, trip?.endDate) };
}

export function buildReviewGroups({ trips = [], destinations = [], reviewMemory = {} }) {
  const destinationMap = new Map(destinations.map((destination) => [destination.key, destination]));
  const groups = new Map();
  trips.forEach((trip) => {
    const date = String(trip.startDate || '').slice(0, 10);
    const key = `${date}|${trip.traveler}`;
    if (!groups.has(key)) groups.set(key, { key, date, traveler: trip.traveler, trips: [] });
    groups.get(key).trips.push(trip);
  });
  const priority = { pending: 0, hold: 1, complete: 2, clear: 3 };
  return [...groups.values()].map((group) => {
    const rawMemory = reviewMemory[group.key] || {};
    const signature = group.trips.map((trip) => `${trip.startDate}|${trip.endDate}|${trip.destination}|${trip.purpose}`).sort().join('¦');
    const memory = !rawMemory.signature || rawMemory.signature === signature ? rawMemory : {};
    const transports = memory.transports || {};
    const tripEntries = group.trips.map((trip) => {
      const destination = destinationMap.get(trip.normalizedDestination);
      const transport = transports[trip.id] || 'unknown';
      return { trip, destination, review: deriveTripReview(trip, destination, transport) };
    }).sort((a, b) => String(a.trip.startDate).localeCompare(String(b.trip.startDate)));
    const issueSet = new Set();
    if (tripEntries.length > 1) issueSet.add('당일 여러 건');
    tripEntries.forEach((entry) => entry.review.issues.forEach((issue) => issueSet.add(issue)));
    const requiresReview = issueSet.size > 0;
    const storedStatus = ['complete', 'hold', 'pending'].includes(memory.status) ? memory.status : null;
    const status = storedStatus || (requiresReview ? 'pending' : 'clear');
    return {
      ...group,
      trips: tripEntries,
      issues: [...issueSet],
      requiresReview,
      status,
      note: String(memory.note || ''),
      updatedAt: memory.updatedAt || '',
      signature,
      totalDuration: tripEntries.reduce((sum, entry) => sum + entry.review.duration, 0),
      paidTotal: tripEntries.reduce((sum, entry) => sum + entry.review.paid, 0),
      withinCount: tripEntries.filter((entry) => entry.review.within).length,
      boundaryCount: tripEntries.filter((entry) => entry.review.boundary).length,
      unresolvedCount: tripEntries.filter((entry) => !entry.review.routeReady).length,
      transportMissingCount: tripEntries.filter((entry) => entry.review.within && entry.review.transport === 'unknown').length,
    };
  }).sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || String(b.date).localeCompare(String(a.date)) || String(a.traveler).localeCompare(String(b.traveler)));
}
