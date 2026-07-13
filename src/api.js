async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message || `요청에 실패했습니다. (${response.status})`);
    error.code = data.code || 'API_ERROR';
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function getApiHealth() {
  const response = await fetch('/api/tmap-health', { headers: { Accept: 'application/json' } });
  return parseResponse(response);
}

export async function searchPlaces(query) {
  const response = await fetch(`/api/tmap-search?q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json' },
  });
  return parseResponse(response);
}

export async function calculateRoundTrip(start, end) {
  const response = await fetch('/api/tmap-route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ start, end }),
  });
  return parseResponse(response);
}
