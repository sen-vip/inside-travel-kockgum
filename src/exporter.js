import { buildReviewGroups, formatDuration, transportLabel } from './review.js';

function statusFor(destination) {
  if (!destination?.location) {
    if (destination?.searchStatus === 'error') return { label: '검색 실패', note: destination.searchError || '출장지 주소 확인' };
    return { label: '위치 확인 필요', note: '출장지 주소 확인' };
  }
  if (destination.routeStatus === 'error') return { label: '거리 계산 실패', note: destination.searchError || '출발·도착 위치 확인' };
  if (!destination.route || !Number.isFinite(destination.route.totalDistance)) return { label: '거리 계산 전', note: '보행 왕복거리 계산 필요' };
  const distance = destination.route.totalDistance;
  const boundary = distance >= 1900 && distance <= 2100;
  const within = distance <= 2000;
  return {
    label: `${within ? '왕복 2km 이내' : '왕복 2km 초과'}${boundary ? '·경계' : ''}`,
    note: boundary
      ? (within ? '출발·도착 위치 확인 · 실제 교통비 발생 여부 확인' : '출발·도착 위치 확인')
      : (within ? '실제 교통비 발생 여부 확인' : '일반 관내출장 기준 검토'),
  };
}

function width(value, min = 10, max = 36) {
  return Math.min(max, Math.max(min, String(value || '').length + 2));
}

function setWidths(sheet, rows, keys) {
  sheet['!cols'] = keys.map((key) => ({ wch: Math.min(42, Math.max(10, ...rows.map((row) => width(row[key])))) }));
  if (sheet['!ref']) sheet['!autofilter'] = { ref: sheet['!ref'] };
}

function reviewStatusLabel(status) {
  return { pending: '확인 필요', hold: '보류', complete: '검토 완료', clear: '일반' }[status] || '확인 필요';
}

export function exportResults({ XLSX, trips, destinations, workplace, reviewMemory = {} }) {
  const destinationMap = new Map(destinations.map((destination) => [destination.key, destination]));
  const groups = buildReviewGroups({ trips, destinations, reviewMemory });
  const groupMap = new Map(groups.map((group) => [group.key, group]));

  const tripRows = trips.map((trip) => {
    const destination = destinationMap.get(trip.normalizedDestination);
    const distanceStatus = statusFor(destination || {});
    const groupKey = `${String(trip.startDate || '').slice(0, 10)}|${trip.traveler}`;
    const group = groupMap.get(groupKey);
    const entry = group?.trips.find((item) => item.trip.id === trip.id);
    return {
      출장시작일: trip.startDate,
      출장종료일: trip.endDate,
      출장시간: entry ? formatDuration(entry.review.duration) : '',
      출장자: trip.traveler,
      출장지: trip.destination,
      출장목적: trip.purpose,
      확인된출장지: destination?.location?.name || '',
      출장지주소: destination?.location?.address || '',
      가는거리_m: destination?.route?.outbound?.distance ?? '',
      오는거리_m: destination?.route?.inbound?.distance ?? '',
      왕복거리_m: destination?.route?.totalDistance ?? '',
      거리판정: distanceStatus.label,
      이동수단: entry ? transportLabel(entry.review.transport) : '확인 못함',
      기존부지급: trip.unpaid,
      여비금액: trip.travelAmount,
      지급금액: trip.paymentAmount,
      지급검토상태: group ? reviewStatusLabel(group.status) : '',
      자동확인사항: entry?.review?.headline || '',
      검토안내: entry?.review?.note || distanceStatus.note,
      검토메모: group?.note || '',
    };
  });

  const groupRows = groups.map((group) => ({
    출장일: group.date,
    출장자: group.traveler,
    출장건수: group.trips.length,
    총출장시간: formatDuration(group.totalDuration),
    기존지급합계: group.paidTotal,
    왕복2km이내건수: group.withinCount,
    경계구간건수: group.boundaryCount,
    위치거리미확인건수: group.unresolvedCount,
    이동수단미확인건수: group.transportMissingCount,
    확인사항: group.issues.join(', '),
    검토상태: reviewStatusLabel(group.status),
    검토메모: group.note,
    마지막검토일: group.updatedAt,
  }));

  const destinationRows = destinations.map((destination) => {
    const status = statusFor(destination);
    const total = destination.route?.totalDistance;
    return {
      원본출장지: destination.originalName,
      출장건수: destination.count,
      확인된장소: destination.location?.name || '',
      주소: destination.location?.address || '',
      위치확인방식: destination.locationSource === 'auto' ? '자동 확인' : destination.locationSource === 'saved' ? '저장 위치' : destination.location ? '직접 선택' : '',
      위도: destination.location?.lat ?? '',
      경도: destination.location?.lon ?? '',
      가는거리_m: destination.route?.outbound?.distance ?? '',
      오는거리_m: destination.route?.inbound?.distance ?? '',
      왕복거리_m: total ?? '',
      상태: status.label,
      확인사항: status.note,
      마지막확인일: destination.lastCheckedAt || destination.route?.calculatedAt || '',
    };
  });

  const needsRows = groupRows.filter((row) => row.검토상태 === '확인 필요' || row.검토상태 === '보류');
  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    ['관내여비 콕검 v0.3 지급 검토 결과'],
    ['근무지', workplace?.name || ''],
    ['근무지 주소', workplace?.address || ''],
    ['생성일시', new Date().toLocaleString('ko-KR')],
    ['안내', '최종 지급 판단은 관련 지침과 기관 기준을 확인해 주세요.'],
    [],
  ];

  const groupSheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.sheet_add_json(groupSheet, groupRows, { origin: 'A7', skipHeader: false });
  setWidths(groupSheet, groupRows, Object.keys(groupRows[0] || {}));
  const tripSheet = XLSX.utils.json_to_sheet(tripRows.length ? tripRows : [{ 안내: '출장 결과가 없습니다.' }]);
  setWidths(tripSheet, tripRows, Object.keys(tripRows[0] || { 안내: '' }));
  const destinationSheet = XLSX.utils.json_to_sheet(destinationRows.length ? destinationRows : [{ 안내: '출장지 결과가 없습니다.' }]);
  setWidths(destinationSheet, destinationRows, Object.keys(destinationRows[0] || { 안내: '' }));
  const needsSheet = XLSX.utils.json_to_sheet(needsRows.length ? needsRows : [{ 안내: '확인 또는 보류 중인 검토 묶음이 없습니다.' }]);
  setWidths(needsSheet, needsRows, Object.keys(needsRows[0] || { 안내: '' }));

  XLSX.utils.book_append_sheet(workbook, groupSheet, '사람날짜별 지급검토');
  XLSX.utils.book_append_sheet(workbook, tripSheet, '출장별 검토결과');
  XLSX.utils.book_append_sheet(workbook, destinationSheet, '출장지별 거리');
  XLSX.utils.book_append_sheet(workbook, needsSheet, '확인 필요');

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  XLSX.writeFile(workbook, `관내여비콕검_지급검토결과_${stamp}.xlsx`, { compression: true });
}

export { statusFor };
