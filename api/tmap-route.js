import { getAppKey, json, safeText, tmapFetch, toNumber } from './_tmap.js';
import { getUsageLimits, reserveRouteCalls } from './_usage.js';

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
  if (!getAppKey()) return json(res, 503, { ok: false, code: 'TMAP_APP_KEY_NOT_CONFIGURED', message: 'TMAP_APP_KEY 환경변수가 설정되지 않았습니다.' });

  let reservation;
  try {
    reservation = await reserveRouteCalls(getUsageLimits().routeCallsPerRoundTrip);
    if (!reservation.allowed) {
      return json(res, 429, {
        ok: false,
        code: 'TMAP_DAILY_SAFE_LIMIT_REACHED',
        message: `오늘 TMAP 거리조회 안전한도 ${reservation.safeLimit.toLocaleString('ko-KR')}회에 도달할 수 있어 거리 계산을 중단했습니다.`,
        usage: reservation,
      });
    }
  } catch (error) {
    // 사용량을 확인할 수 없으면 TMAP 호출을 진행하지 않는다.
    return json(res, error.status || 503, {
      ok: false,
      code: error.code || 'TMAP_USAGE_STORAGE_FAILED',
      message: error.message || 'TMAP 사용량을 확인하지 못해 거리 계산을 중단했습니다.',
    });
  }

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
      usage: reservation,
    });
  } catch (error) {
    return json(res, error.status || 500, {
      ok: false,
      code: error.code || 'TMAP_ROUTE_FAILED',
      message: error.message || '보행경로 계산에 실패했습니다.',
      usage: reservation,
    });
  }
}
