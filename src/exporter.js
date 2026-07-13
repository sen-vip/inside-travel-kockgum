function statusFor(destination) {
  if (!destination.location) return { label: '위치 확인 필요', note: '출장지 주소 확인' };
  if (destination.routeStatus === 'error') return { label: '거리 계산 실패', note: '출발·도착 위치 확인' };
  if (!destination.route || !Number.isFinite(destination.route.totalDistance)) return { label: '거리 계산 전', note: '보행 왕복거리 계산 필요' };

  const distance = destination.route.totalDistance;
  const boundary = distance >= 1900 && distance <= 2100;
  const within = distance <= 2000;
  return {
    label: `${within ? '왕복 2km 이내' : '왕복 2km 초과'}${boundary ? '·경계' : ''}`,
    note: within ? '실제 교통비 발생 여부 확인' : (boundary ? '출발·도착 위치 확인' : '일반 관내출장 기준 검토'),
  };
}

function width(value, min = 10, max = 36) {
  return Math.min(max, Math.max(min, String(value || '').length + 2));
}

function setWidths(sheet, rows, keys) {
  sheet['!cols'] = keys.map((key) => ({
    wch: Math.min(40, Math.max(10, ...rows.map((row) => width(row[key])))),
  }));
  if (sheet['!ref']) sheet['!autofilter'] = { ref: sheet['!ref'] };
}

export function exportResults({ XLSX, trips, destinations, workplace }) {
  const destinationMap = new Map(destinations.map((destination) => [destination.key, destination]));

  const tripRows = trips.map((trip) => {
    const destination = destinationMap.get(trip.normalizedDestination);
    const status = statusFor(destination || {});
    return {
      출장시작일: trip.startDate,
      출장종료일: trip.endDate,
      출장구분: trip.category,
      출장자: trip.traveler,
      출장지: trip.destination,
      출장목적: trip.purpose,
      검색장소: destination?.location?.name || '',
      검색주소: destination?.location?.address || '',
      가는거리_m: destination?.route?.outbound?.distance ?? '',
      오는거리_m: destination?.route?.inbound?.distance ?? '',
      왕복거리_m: destination?.route?.totalDistance ?? '',
      거리판정: status.label,
      기존부지급: trip.unpaid,
      여비금액: trip.travelAmount,
      지급금액: trip.paymentAmount,
      확인사항: status.note,
    };
  });

  const destinationRows = destinations.map((destination) => {
    const status = statusFor(destination);
    return {
      원본출장지: destination.originalName,
      출장건수: destination.count,
      검색장소: destination.location?.name || '',
      주소: destination.location?.address || '',
      위도: destination.location?.lat ?? '',
      경도: destination.location?.lon ?? '',
      가는거리_m: destination.route?.outbound?.distance ?? '',
      오는거리_m: destination.route?.inbound?.distance ?? '',
      왕복거리_m: destination.route?.totalDistance ?? '',
      상태: status.label,
      확인사항: status.note,
    };
  });

  const needsRows = tripRows.filter((row) => !['왕복 2km 초과'].includes(row.거리판정));
  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    ['관내여비 콕검 결과'],
    ['근무지', workplace?.name || ''],
    ['근무지 주소', workplace?.address || ''],
    ['생성일시', new Date().toLocaleString('ko-KR')],
    [],
  ];

  const tripSheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.sheet_add_json(tripSheet, tripRows, { origin: 'A6', skipHeader: false });
  setWidths(tripSheet, tripRows, Object.keys(tripRows[0] || {}));
  const destinationSheet = XLSX.utils.json_to_sheet(destinationRows);
  setWidths(destinationSheet, destinationRows, Object.keys(destinationRows[0] || {}));
  const needsSheet = XLSX.utils.json_to_sheet(needsRows.length ? needsRows : [{ 안내: '확인이 필요한 출장 건이 없습니다.' }]);
  setWidths(needsSheet, needsRows, Object.keys(needsRows[0] || { 안내: '' }));

  XLSX.utils.book_append_sheet(workbook, tripSheet, '출장별 결과');
  XLSX.utils.book_append_sheet(workbook, destinationSheet, '출장지별 거리');
  XLSX.utils.book_append_sheet(workbook, needsSheet, '확인 필요');

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  XLSX.writeFile(workbook, `관내여비콕검_${stamp}.xlsx`, { compression: true });
}

export { statusFor };
