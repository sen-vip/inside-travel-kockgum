const KEYS = {
  workplace: 'insideTravelKockgum.workplace.v1',
  destinations: 'insideTravelKockgum.destinations.v1',
  routes: 'insideTravelKockgum.routes.v1',
};

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

export function loadWorkplace() {
  return load(KEYS.workplace, null);
}

export function saveWorkplace(value) {
  if (value) save(KEYS.workplace, value);
  else localStorage.removeItem(KEYS.workplace);
}

export function loadDestinationMemory() {
  return load(KEYS.destinations, {});
}

export function saveDestinationMemory(value) {
  save(KEYS.destinations, value);
}

export function loadRouteCache() {
  return load(KEYS.routes, {});
}

export function saveRouteCache(value) {
  save(KEYS.routes, value);
}

export function clearDestinationStorage() {
  localStorage.removeItem(KEYS.destinations);
  localStorage.removeItem(KEYS.routes);
}
