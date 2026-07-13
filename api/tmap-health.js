import { getAppKey, json, tmapFetch } from './_tmap.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'GET 요청만 지원합니다.' });

  if (!getAppKey()) {
    return json(res, 200, { ok: true, configured: false, connected: false, code: 'TMAP_APP_KEY_NOT_CONFIGURED' });
  }

  try {
    // 환경변수 존재 여부뿐 아니라 실제 TMAP 인증·상품 사용 가능 여부까지 확인한다.
    await tmapFetch('/pois?version=1&format=json&searchKeyword=%EC%84%9C%EC%9A%B8%EC%8B%9C%EC%B2%AD&searchType=all&resCoordType=WGS84GEO&reqCoordType=WGS84GEO&count=1&page=1&multiPoint=N');
    return json(res, 200, { ok: true, configured: true, connected: true });
  } catch (error) {
    const authFailed = error.status === 401 || error.status === 403 || /AUTH|APPKEY|ACCESS|UNAUTHORIZED|FORBIDDEN/i.test(String(error.code || ''));
    return json(res, 200, {
      ok: true,
      configured: true,
      connected: false,
      code: authFailed ? 'TMAP_AUTH_FAILED' : (error.code || 'TMAP_CONNECTION_FAILED'),
      message: authFailed
        ? 'TMAP 앱 키 또는 상품 사용 설정을 확인해 주세요.'
        : (error.message || 'TMAP 연결을 확인하지 못했습니다.'),
    });
  }
}
