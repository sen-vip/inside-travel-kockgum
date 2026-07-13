const TMAP_BASE = 'https://apis.openapi.sk.com/tmap';

export function getAppKey() {
  return process.env.TMAP_APP_KEY || '';
}

export function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function tmapFetch(path, options = {}) {
  const appKey = getAppKey();
  if (!appKey) {
    const error = new Error('TMAP_APP_KEY 환경변수가 설정되지 않았습니다.');
    error.code = 'TMAP_APP_KEY_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${TMAP_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        appKey,
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }

    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || `TMAP API 오류 (${response.status})`);
      error.status = response.status;
      error.details = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function safeText(value, maxLength = 120) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, maxLength);
}

export function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
