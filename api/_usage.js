const OFFICIAL_LIMIT = 1000;
const SAFE_LIMIT = 900;
const WARNING_AT = 800;
const ROUTE_CALLS_PER_ROUND_TRIP = 2;
const KEY_PREFIX = 'inside-travel-kockgum:tmap-route';

function clean(value) {
  return String(value || '').trim();
}

export function getUsageLimits() {
  return {
    officialLimit: OFFICIAL_LIMIT,
    safeLimit: SAFE_LIMIT,
    warningAt: WARNING_AT,
    routeCallsPerRoundTrip: ROUTE_CALLS_PER_ROUND_TRIP,
  };
}

export function getKstDate(now = new Date()) {
  const shifted = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getUsageKey(now = new Date()) {
  return `${KEY_PREFIX}:${getKstDate(now)}`;
}

function secondsUntilKstDateCleanup(now = new Date()) {
  const shifted = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const nextKstMidnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
    0, 0, 0,
  ) - (9 * 60 * 60 * 1000);
  const untilMidnight = Math.max(1, Math.ceil((nextKstMidnightUtc - now.getTime()) / 1000));
  // 날짜가 바뀌면 새 키를 쓰므로, 이전 키는 확인 여유를 두고 자동 정리한다.
  return untilMidnight + (36 * 60 * 60);
}

function envPair(urlName, tokenName) {
  const url = clean(process.env[urlName]);
  const token = clean(process.env[tokenName]);
  if (!url || !token || !/^https:\/\//i.test(url)) return null;
  return { url, token, envNames: [urlName, tokenName] };
}

export function resolveRedisConfig() {
  const explicitPairs = [
    // Vercel Marketplace에서 Custom Prefix를 STORAGE로 연결한 현재 프로젝트 형태.
    ['STORAGE_URL', 'STORAGE_TOKEN'],
    ['STORAGE_KV_REST_API_URL', 'STORAGE_KV_REST_API_TOKEN'],
    ['STORAGE_REDIS_REST_URL', 'STORAGE_REDIS_REST_TOKEN'],
    // Vercel/Upstash의 일반적인 이름도 함께 지원한다.
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ];

  for (const [urlName, tokenName] of explicitPairs) {
    const pair = envPair(urlName, tokenName);
    if (pair) return pair;
  }

  // 다른 Custom Prefix를 사용해도 Upstash REST URL + 짝 토큰을 안전하게 찾는다.
  for (const [name, rawValue] of Object.entries(process.env)) {
    const value = clean(rawValue);
    if (!name.endsWith('_URL') || !/^https:\/\//i.test(value) || !/upstash\.io/i.test(value)) continue;
    const tokenName = name.replace(/_URL$/, '_TOKEN');
    const token = clean(process.env[tokenName]);
    if (token) return { url: value, token, envNames: [name, tokenName] };
  }

  return null;
}

async function redisCommand(command) {
  const config = resolveRedisConfig();
  if (!config) {
    const error = new Error('TMAP 사용량 저장소가 연결되지 않았습니다. Vercel의 Upstash Redis 연결을 확인해 주세요.');
    error.code = 'TMAP_USAGE_STORAGE_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }

  let response;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(command),
    });
  } catch {
    const error = new Error('TMAP 사용량 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    error.code = 'TMAP_USAGE_STORAGE_UNAVAILABLE';
    error.status = 503;
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error('TMAP 사용량 저장소 응답을 확인하지 못했습니다.');
    error.code = response.status === 401 ? 'TMAP_USAGE_STORAGE_AUTH_FAILED' : 'TMAP_USAGE_STORAGE_FAILED';
    error.status = response.status || 503;
    throw error;
  }
  return data.result;
}

function snapshot(used, now = new Date()) {
  const count = Math.max(0, Number(used) || 0);
  return {
    date: getKstDate(now),
    used: count,
    officialLimit: OFFICIAL_LIMIT,
    safeLimit: SAFE_LIMIT,
    warningAt: WARNING_AT,
    remainingOfficial: Math.max(0, OFFICIAL_LIMIT - count),
    remainingSafe: Math.max(0, SAFE_LIMIT - count),
    warning: count >= WARNING_AT && count < SAFE_LIMIT,
    blocked: count >= SAFE_LIMIT,
    routeCallsPerRoundTrip: ROUTE_CALLS_PER_ROUND_TRIP,
  };
}

export async function getUsageSnapshot(now = new Date()) {
  const result = await redisCommand(['GET', getUsageKey(now)]);
  return snapshot(result, now);
}

export async function reserveRouteCalls(amount = ROUTE_CALLS_PER_ROUND_TRIP, now = new Date()) {
  const requested = Math.max(1, Math.floor(Number(amount) || ROUTE_CALLS_PER_ROUND_TRIP));
  const script = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if current + amount > limit then
  return {0, current}
end
local nextValue = redis.call('INCRBY', KEYS[1], amount)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, nextValue}
`;
  const result = await redisCommand([
    'EVAL',
    script,
    1,
    getUsageKey(now),
    requested,
    SAFE_LIMIT,
    secondsUntilKstDateCleanup(now),
  ]);

  const allowed = Array.isArray(result) && Number(result[0]) === 1;
  const used = Array.isArray(result) ? Number(result[1]) || 0 : 0;
  return {
    allowed,
    requested,
    ...snapshot(used, now),
  };
}
