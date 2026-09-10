import { json } from './_tmap.js';
import { getUsageSnapshot, resolveRedisConfig } from './_usage.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'GET 요청만 지원합니다.' });

  if (!resolveRedisConfig()) {
    return json(res, 503, {
      ok: false,
      configured: false,
      code: 'TMAP_USAGE_STORAGE_NOT_CONFIGURED',
      message: 'TMAP 사용량 저장소가 연결되지 않았습니다. Vercel의 Upstash Redis 연결을 확인해 주세요.',
    });
  }

  try {
    const usage = await getUsageSnapshot();
    return json(res, 200, { ok: true, configured: true, usage });
  } catch (error) {
    return json(res, error.status || 503, {
      ok: false,
      configured: true,
      code: error.code || 'TMAP_USAGE_STORAGE_FAILED',
      message: error.message || 'TMAP 사용량을 확인하지 못했습니다.',
    });
  }
}
