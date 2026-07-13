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
      ? (within ? '출입구 위치 확인 · 이동수단 확인 필요' : '출입구 위치 확인')
      : (within ? '이동수단 확인 필요' : ''),
  };
}

function width(value, min = 10, max = 36) {
  return Math.min(max, Math.max(min, String(value || '').length + 2));
}

function setWidths(sheet, rows, keys) {
  sheet['!cols'] = keys.map((key) => ({
    wch: Math.min(42, Math.max(10, ...rows.map((row) => width(row[key])))),
  }));
  if (sheet['!ref']) sheet['!autofilter'] = { ref: sheet['!ref'] };
}

export function exportResults({ XLSX, trips, destinations, workplace }) {
  const destinationMap = new Map(destinations.map((destination) => [destination.key, destination]));

  const tripRows = trips.map((trip) => {
    const destination = destinationMap.get(trip.normalizedDestination);
    const status = statusFor(destination || {});
    const total = destination?.route?.totalDistance;
    const within = Number.isFinite(total) && total <= 2000;
    const boundary = Number.isFinite(total) && total >= 1900 && total <= 2100;
    return {
      출장시작일: trip.startDate,
      출장종료일: trip.endDate,
      출장구분: trip.category,
      출장자: trip.traveler,
      출장지: trip.destination,
      출장목적: trip.purpose,
      확인된출장지: destination?.location?.name || '',
      출장지주소: destination?.location?.address || '',
      위치확인방식: destination?.locationSource === 'auto' ? '자동 확인' : destination?.locationSource === 'saved' ? '저장 위치' : destination?.location ? '직접 선택' : '',
      가는거리_m: destination?.route?.outbound?.distance ?? '',
      오는거리_m: destination?.route?.inbound?.distance ?? '',
      왕복거리_m: total ?? '',
      거리판정: status.label,
      경계구간여부: boundary ? 'Y' : '',
      기존부지급: trip.unpaid,
      여비금액: trip.travelAmount,
      지급금액: trip.paymentAmount,
      확인사항: status.note,
    };
  });

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
      경계구간여부: Number.isFinite(total) && total >= 1900 && total <= 2100 ? 'Y' : '',
      확인사항: status.note,
      마지막확인일: destination.lastCheckedAt || destination.route?.calculatedAt || '',
    };
  });

  const needsRows = tripRows.filter((row) => (
    row.거리판정 !== '왕복 2km 초과'
    || row.경계구간여부 === 'Y'
  ));
  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    ['관내여비 콕검 v0.2.5 일괄검사 결과'],
    ['근무지', workplace?.name || ''],
    ['근무지 주소', workplace?.address || ''],
    ['생성일시', new Date().toLocaleString('ko-KR')],
    [],
  ];

  const tripSheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.sheet_add_json(tripSheet, tripRows, { origin: 'A6', skipHeader: false });
  setWidths(tripSheet, tripRows, Object.keys(tripRows[0] || {}));
  const destinationSheet = XLSX.utils.json_to_sheet(destinationRows.length ? destinationRows : [{ 안내: '출장지 결과가 없습니다.' }]);
  setWidths(destinationSheet, destinationRows, Object.keys(destinationRows[0] || { 안내: '' }));
  const needsSheet = XLSX.utils.json_to_sheet(needsRows.length ? needsRows : [{ 안내: '확인이 필요한 출장 건이 없습니다.' }]);
  setWidths(needsSheet, needsRows, Object.keys(needsRows[0] || { 안내: '' }));

  XLSX.utils.book_append_sheet(workbook, tripSheet, '출장별 검사결과');
  XLSX.utils.book_append_sheet(workbook, destinationSheet, '출장지별 거리');
  XLSX.utils.book_append_sheet(workbook, needsSheet, '확인 필요');

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  XLSX.writeFile(workbook, `관내여비콕검_일괄검사결과_${stamp}.xlsx`, { compression: true });
}

export { statusFor };
