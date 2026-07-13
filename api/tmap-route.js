import { json, safeText, tmapFetch, toNumber } from './_tmap.js';

function validatePoint(point) {
  const lat = toNumber(point?.lat);
  const lon = toNumber(point?.lon);
  if (lat === null || lon === null || lat < 32 || lat > 39.5 || lon < 123 || lon > 133) return null;
  return { lat, lon, name: safeText(point?.name || '지점', 60) };
}

function parseRoute(data) {
  const features = Array.isArray(data?.features) ? data.features : [];
  let totalDistance = null;
  let totalTime = null;
  const path = [];

  for (const feature of features) {
    const props = feature?.properties || {};
    if (totalDistance === null && Number.isFinite(Number(props.totalDistance))) totalDistance = Number(props.totalDistance);
    if (totalTime === null && Number.isFinite(Number(props.totalTime))) totalTime = Number(props.totalTime);

    const geometry = feature?.geometry;
    if (geometry?.type === 'LineString' && Array.isArray(geometry.coordinates)) {
      geometry.coordinates.forEach(([lon, lat]) => {
        if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) path.push([Number(lat), Number(lon)]);
      });
    }
  }

  if (totalDistance === null) {
    const sum = features.reduce((acc, feature) => acc + (Number(feature?.properties?.distance) || 0), 0);
    totalDistance = sum || null;
  }

  if (totalDistance === null) throw new Error('보행경로 거리 값을 찾지 못했습니다.');
  return { distance: Math.round(totalDistance), time: totalTime ? Math.round(totalTime) : null, path };
}

async function requestRoute(start, end) {
  const data = await tmapFetch('/routes/pedestrian?version=1&format=json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startX: String(start.lon),
      startY: String(start.lat),
      endX: String(end.lon),
      endY: String(end.lat),
      startName: start.name,
      endName: end.name,
      reqCoordType: 'WGS84GEO',
      resCoordType: 'WGS84GEO',
      searchOption: '0',
    }),
  });
  return parseRoute(data);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'POST 요청만 지원합니다.' });

  const start = validatePoint(req.body?.start);
  const end = validatePoint(req.body?.end);
  if (!start || !end) return json(res, 400, { ok: false, message: '출발지와 도착지 좌표를 확인해 주세요.' });

  try {
    const [outbound, inbound] = await Promise.all([
      requestRoute(start, end),
      requestRoute(end, start),
    ]);

    return json(res, 200, {
      ok: true,
      outbound,
      inbound,
      totalDistance: outbound.distance + inbound.distance,
      calculatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return json(res, error.status || 500, {
      ok: false,
      code: error.code || 'TMAP_ROUTE_FAILED',
      message: error.message || '보행경로 계산에 실패했습니다.',
    });
  }
}
