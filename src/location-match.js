function canonical(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s·:：()\[\]{}'"“”‘’.,/_-]+/g, '')
    .trim();
}

function topLevelRegion(address) {
  const text = String(address || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const aliases = [
    ['서울', /(?:^|\s)서울(?:특별시)?(?:\s|$)/],
    ['부산', /(?:^|\s)부산(?:광역시)?(?:\s|$)/],
    ['대구', /(?:^|\s)대구(?:광역시)?(?:\s|$)/],
    ['인천', /(?:^|\s)인천(?:광역시)?(?:\s|$)/],
    ['광주', /(?:^|\s)광주(?:광역시)?(?:\s|$)/],
    ['대전', /(?:^|\s)대전(?:광역시)?(?:\s|$)/],
    ['울산', /(?:^|\s)울산(?:광역시)?(?:\s|$)/],
    ['세종', /(?:^|\s)세종(?:특별자치시)?(?:\s|$)/],
    ['경기', /(?:^|\s)경기(?:도)?(?:\s|$)/],
    ['강원', /(?:^|\s)강원(?:특별자치도|도)?(?:\s|$)/],
    ['충북', /(?:^|\s)(?:충북|충청북도)(?:\s|$)/],
    ['충남', /(?:^|\s)(?:충남|충청남도)(?:\s|$)/],
    ['전북', /(?:^|\s)(?:전북|전북특별자치도|전라북도)(?:\s|$)/],
    ['전남', /(?:^|\s)(?:전남|전라남도)(?:\s|$)/],
    ['경북', /(?:^|\s)(?:경북|경상북도)(?:\s|$)/],
    ['경남', /(?:^|\s)(?:경남|경상남도)(?:\s|$)/],
    ['제주', /(?:^|\s)제주(?:특별자치도|도)?(?:\s|$)/],
  ];
  return aliases.find(([, pattern]) => pattern.test(text))?.[0] || '';
}

function sameRegion(candidate, workplace) {
  if (!workplace?.address || !candidate?.address) return true;
  const workRegion = topLevelRegion(workplace.address);
  const candidateRegion = topLevelRegion(candidate.address);
  if (!workRegion || !candidateRegion) return true;
  return workRegion === candidateRegion;
}

function primaryFacilityScore(target, candidate, workplace) {
  const name = canonical(candidate?.name);
  if (!name || !target || !name.startsWith(target) || name === target) return null;

  const suffix = name.slice(target.length);
  // 본관·본원은 같은 기관의 대표 장소로 간주한다. 주차장·분원·별관 등은 여기서 자동 선택하지 않는다.
  if (!/(?:본관|본원)$/.test(suffix)) return null;
  if (/(?:주차장|주차|분원|별관|지점|후문|정문|출입구)/.test(suffix)) return null;

  const exactMainSuffix = /^(?:본관|본원)$/.test(suffix);
  let score = exactMainSuffix ? 100 : 80;
  if (sameRegion(candidate, workplace)) score += 10;
  // '남산본원'처럼 지명이 붙은 대표시설보다 단순 '본원'/'본관'을 우선하되,
  // 대표시설이 하나뿐이면 지명+본원/본관도 자동 확정한다.
  score -= Math.min(suffix.length, 20) / 100;
  return score;
}

function samePlaceCluster(candidates) {
  if (candidates.length < 2) return true;
  const first = candidates[0];
  const firstAddress = canonical(first?.address);
  if (firstAddress && candidates.every((candidate) => canonical(candidate?.address) === firstAddress)) return true;

  const points = candidates
    .map((candidate) => ({ lat: Number(candidate?.lat), lon: Number(candidate?.lon) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  if (points.length !== candidates.length) return false;
  const toRad = (value) => value * Math.PI / 180;
  const distance = (a, b) => {
    const earth = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  return points.every((point) => distance(points[0], point) <= 150);
}

export function pickConfidenceCandidate(destination, candidates = [], workplace = null) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  if (destination?.extractedAddress) {
    const geocodes = candidates.filter((candidate) => candidate.source === 'geocode');
    if (geocodes.length === 1) return geocodes[0];
    if (candidates.length === 1) return candidates[0];
    return null;
  }

  const target = canonical(destination?.searchQuery || destination?.originalName);
  if (!target) return null;

  // 띄어쓰기·기호를 제외한 장소명이 정확히 일치하는 결과가 하나면 바로 사용한다.
  const exactByName = candidates.filter((candidate) => canonical(candidate.name) === target);
  if (exactByName.length === 1) return exactByName[0];
  if (exactByName.length > 1) {
    const exactSameRegion = exactByName.filter((candidate) => sameRegion(candidate, workplace));
    if (exactSameRegion.length === 1) return exactSameRegion[0];
  }

  // 기관명 그대로 검색했을 때 '본관' 또는 '본원'이 붙은 대표 장소가 명확하면
  // 주차장·분원 같은 부속 결과가 함께 있어도 사용자에게 다시 판단을 넘기지 않는다.
  const primaryRanked = candidates
    .map((candidate) => ({ candidate, score: primaryFacilityScore(target, candidate, workplace) }))
    .filter((item) => item.score !== null)
    .sort((a, b) => b.score - a.score);

  if (primaryRanked.length) {
    const bestScore = primaryRanked[0].score;
    const best = primaryRanked.filter((item) => Math.abs(item.score - bestScore) < 0.0001);
    if (best.length === 1) return best[0].candidate;
    if (samePlaceCluster(best.map((item) => item.candidate))) {
      return [...best]
        .sort((a, b) => canonical(a.candidate.name).length - canonical(b.candidate.name).length)[0]
        .candidate;
    }
  }

  const strong = candidates.filter((candidate) => {
    const name = canonical(candidate.name);
    return name && target && (name.startsWith(target) || target.startsWith(name)) && Math.min(name.length, target.length) >= 4;
  });
  if (strong.length === 1) return strong[0];
  if (candidates.length === 1 && target.length >= 4) {
    const onlyName = canonical(candidates[0].name);
    if (onlyName.includes(target) || target.includes(onlyName)) return candidates[0];
  }
  return null;
}
