import { getAppKey, json, safeText, tmapFetch, toNumber } from './_tmap.js';

function looksLikeAddress(query) {
  return /(특별시|광역시|특별자치시|특별자치도|[가-힣]+구|[가-힣]+시|[가-힣]+군).*(대로|로|길|번길|동|리)\s*\d*/.test(query)
    || /(대로|로|길|번길)\s*\d+/.test(query);
}

function makeRoadAddress(poi) {
  const parts = [poi.upperAddrName, poi.middleAddrName, poi.roadName];
  const building = [poi.firstBuildNo, poi.secondBuildNo].filter(Boolean).join('-');
  if (building) parts.push(building);
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function makeJibunAddress(poi) {
  const detail = [poi.firstNo, poi.secondNo].filter(Boolean).join('-');
  return [poi.upperAddrName, poi.middleAddrName, poi.lowerAddrName, poi.detailAddrName, detail]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function parsePoi(data) {
  const list = data?.searchPoiInfo?.pois?.poi || [];
  return list.map((poi) => {
    const lat = toNumber(poi.frontLat ?? poi.noorLat);
    const lon = toNumber(poi.frontLon ?? poi.noorLon);
    return {
      id: `poi:${poi.id || `${lat},${lon}`}`,
      source: 'poi',
      poiId: poi.id || '',
      name: poi.name || '검색 장소',
      roadAddress: makeRoadAddress(poi),
      jibunAddress: makeJibunAddress(poi),
      address: makeRoadAddress(poi) || makeJibunAddress(poi),
      lat,
      lon,
    };
  }).filter((item) => item.lat !== null && item.lon !== null);
}

function parseGeocode(data, query) {
  const list = data?.coordinateInfo?.coordinate || [];
  return list.map((item, index) => {
    const lat = toNumber(item.newLat ?? item.lat);
    const lon = toNumber(item.newLon ?? item.lon);
    const roadAddress = [
      item.city_do,
      item.gu_gun,
      item.newRoadName,
      [item.newBuildingIndex, item.newBuildingName].filter(Boolean).join(' '),
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const jibunAddress = [item.city_do, item.gu_gun, item.legalDong, item.bunji].filter(Boolean).join(' ').trim();
    return {
      id: `geo:${index}:${lat},${lon}`,
      source: 'geocode',
      name: item.newBuildingName || item.buildingName || query,
      roadAddress,
      jibunAddress,
      address: roadAddress || jibunAddress || query,
      lat,
      lon,
    };
  }).filter((item) => item.lat !== null && item.lon !== null);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.lat.toFixed(6)},${item.lon.toFixed(6)}:${item.name.replace(/\s+/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'GET 요청만 지원합니다.' });

  const query = safeText(req.query?.q, 100);
  if (query.length < 2) return json(res, 400, { ok: false, message: '검색어를 두 글자 이상 입력해 주세요.' });
  if (!getAppKey()) return json(res, 503, { ok: false, code: 'TMAP_APP_KEY_NOT_CONFIGURED', message: 'TMAP_APP_KEY 환경변수가 설정되지 않았습니다.' });

  try {
    const poiPath = `/pois?version=1&format=json&searchKeyword=${encodeURIComponent(query)}&resCoordType=WGS84GEO&reqCoordType=WGS84GEO&count=10&page=1&multiPoint=N`;
    const requests = [tmapFetch(poiPath)];

    if (looksLikeAddress(query)) {
      requests.push(tmapFetch(`/geo/fullAddrGeo?version=1&format=json&coordType=WGS84GEO&fullAddr=${encodeURIComponent(query)}`));
    }

    const settled = await Promise.allSettled(requests);
    const poi = settled[0].status === 'fulfilled' ? parsePoi(settled[0].value) : [];
    const geocode = settled[1]?.status === 'fulfilled' ? parseGeocode(settled[1].value, query) : [];
    const candidates = dedupe([...geocode, ...poi]).slice(0, 12);

    return json(res, 200, { ok: true, query, candidates });
  } catch (error) {
    return json(res, error.status || 500, {
      ok: false,
      code: error.code || 'TMAP_SEARCH_FAILED',
      message: error.message || '장소 검색에 실패했습니다.',
    });
  }
}
