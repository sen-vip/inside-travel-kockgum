const TMAP_BASE = 'https://apis.openapi.sk.com/tmap';

export function getAppKey() {
  let value = String(process.env.TMAP_APP_KEY || '').trim();
  if (value.startsWith('TMAP_APP_KEY=')) value = value.slice('TMAP_APP_KEY='.length).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

export function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function providerMessage(data, status) {
  return data?.error?.message
    || data?.error?.msg
    || data?.message
    || data?.msg
    || `TMAP API 오류 (${status})`;
}

function providerCode(data, status) {
  return data?.error?.code
    || data?.errorCode
    || data?.code
    || `TMAP_HTTP_${status}`;
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
      const error = new Error(providerMessage(data, response.status));
      error.status = response.status;
      error.code = providerCode(data, response.status);
      error.details = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('TMAP 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
      timeoutError.code = 'TMAP_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
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
