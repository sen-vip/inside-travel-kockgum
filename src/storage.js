const KEYS = {
  workplace: 'insideTravelKockgum.workplace.v1',
  destinations: 'insideTravelKockgum.destinations.v1',
  routes: 'insideTravelKockgum.routes.v1',
};

// TMAP API로 얻은 데이터는 24시간 이상 재사용하지 않도록 23시간에서 만료시킨다.
export const TMAP_DATA_TTL_MS = 23 * 60 * 60 * 1000;
export const ROUTE_CACHE_TTL_MS = TMAP_DATA_TTL_MS;

function load(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function isTmapDataFresh(timestampOrEntry, now = Date.now()) {
  const timestamp = typeof timestampOrEntry === 'string'
    ? Date.parse(timestampOrEntry)
    : Date.parse(timestampOrEntry?.savedAt || timestampOrEntry?.cachedAt || timestampOrEntry?.calculatedAt || '');
  return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp < TMAP_DATA_TTL_MS;
}

export function isRouteCacheFresh(entry, now = Date.now()) {
  return isTmapDataFresh(entry, now);
}

export function loadWorkplace() {
  const workplace = load(KEYS.workplace, null);
  if (!workplace) return null;
  if (isTmapDataFresh(workplace)) return workplace;
  localStorage.removeItem(KEYS.workplace);
  return null;
}

export function saveWorkplace(value) {
  if (value) save(KEYS.workplace, { ...value, savedAt: new Date().toISOString() });
  else localStorage.removeItem(KEYS.workplace);
}

export function loadDestinationMemory() {
  const stored = load(KEYS.destinations, {});
  const fresh = {};
  for (const [key, entry] of Object.entries(stored)) {
    if (!isTmapDataFresh(entry?.savedAt)) continue;
    fresh[key] = {
      ...entry,
      location: entry.location ? { ...entry.location, savedAt: entry.savedAt } : null,
    };
  }
  if (Object.keys(fresh).length !== Object.keys(stored).length) {
    if (Object.keys(fresh).length) save(KEYS.destinations, fresh);
    else localStorage.removeItem(KEYS.destinations);
  }
  return fresh;
}

export function saveDestinationMemory(value) {
  save(KEYS.destinations, value);
}

export function loadRouteCache() {
  const cached = load(KEYS.routes, {});
  const fresh = Object.fromEntries(Object.entries(cached).filter(([, entry]) => isRouteCacheFresh(entry)));
  if (Object.keys(fresh).length !== Object.keys(cached).length) {
    if (Object.keys(fresh).length) save(KEYS.routes, fresh);
    else localStorage.removeItem(KEYS.routes);
  }
  return fresh;
}

export function saveRouteCache(value) {
  save(KEYS.routes, value);
}

export function clearDestinationStorage() {
  localStorage.removeItem(KEYS.destinations);
  localStorage.removeItem(KEYS.routes);
}

export function clearAllStorage() {
  Object.values(KEYS).forEach((key) => localStorage.removeItem(key));
}

export function storageKeys() {
  return { ...KEYS };
}
