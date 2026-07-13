import { getAppKey, json } from './_tmap.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'GET 요청만 지원합니다.' });
  return json(res, 200, { ok: true, configured: Boolean(getAppKey()) });
}
