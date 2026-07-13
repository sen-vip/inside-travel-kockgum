import * as XLSX from 'xlsx';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { parseEdufineWorkbook } from './parser.js';
import { calculateRoundTrip, getApiHealth, searchPlaces } from './api.js';
import {
  clearDestinationStorage,
  loadDestinationMemory,
  loadRouteCache,
  loadWorkplace,
  saveDestinationMemory,
  saveRouteCache,
  saveWorkplace,
} from './storage.js';
import { exportResults, statusFor } from './exporter.js';

const dom = Object.fromEntries([
  'api-status', 'reset-all', 'drop-zone', 'file-input', 'upload-error', 'analysis-section',
  'file-name', 'file-detail', 'metric-trips', 'metric-travelers', 'metric-destinations',
  'set-workplace', 'workplace-empty', 'workplace-card', 'workplace-name', 'workplace-address',
  'view-workplace', 'change-workplace', 'clear-workplace-storage', 'clear-destination-storage', 'auto-search', 'calculate-all', 'progress-panel',
  'progress-title', 'progress-count', 'progress-bar', 'progress-detail', 'destination-filters',
  'destination-search', 'destination-body', 'destination-empty', 'filter-all-count',
  'filter-needs-count', 'filter-resolved-count', 'filter-within-count', 'filter-boundary-count',
  'result-section', 'export-results', 'result-metrics', 'show-needs-only', 'result-filters',
  'result-search', 'result-body', 'result-empty', 'location-modal', 'modal-kicker', 'modal-title',
  'close-modal', 'place-search-form', 'place-search-input', 'candidate-loading', 'candidate-list',
  'candidate-empty', 'pending-location', 'pending-name', 'pending-address', 'confirm-location',
  'toast',
].map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]));

const state = {
  parsed: null,
  fileName: '',
  workplace: loadWorkplace(),
  destinationMemory: loadDestinationMemory(),
  routeCache: loadRouteCache(),
  destinations: [],
  destinationFilter: 'all',
  destinationQuery: '',
  resultFilter: 'all',
  resultQuery: '',
  expanded: new Set(),
  busy: false,
  apiConfigured: false,
  modal: {
    mode: null,
    key: null,
    candidates: [],
    pending: null,
    map: null,
    marker: null,
    workplaceMarker: null,
    routeLayers: [],
  },
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function canonical(value) {
  return String(value || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^가-힣a-z0-9]/g, '');
}

function formatDistance(meters) {
  if (!Number.isFinite(Number(meters))) return '-';
  const value = Number(meters);
  if (value < 1000) return `${Math.round(value).toLocaleString('ko-KR')}m`;
  return `${(value / 1000).toFixed(2)}km`;
}

function formatDateOnly(value) {
  const text = String(value || '');
  const date = text.slice(0, 10);
  return date.replaceAll('-', '.');
}

function routeCacheKey(workplace, location) {
  if (!workplace || !location) return '';
  return [workplace.lat, workplace.lon, location.lat, location.lon]
    .map((value) => Number(value).toFixed(6)).join('|');
}

function simplifyPath(path, maxPoints = 320) {
  if (!Array.isArray(path) || path.length <= maxPoints) return path || [];
  const step = Math.ceil(path.length / maxPoints);
  const sampled = path.filter((_, index) => index % step === 0);
  const last = path[path.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function compactRoute(route) {
  return {
    ...route,
    outbound: { ...route.outbound, path: simplifyPath(route.outbound?.path) },
    inbound: { ...route.inbound, path: simplifyPath(route.inbound?.path) },
  };
}

function showToast(message, type = 'success') {
  dom.toast.textContent = message;
  dom.toast.style.background = type === 'error' ? '#b94a48' : '#1f7a54';
  dom.toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => dom.toast.classList.add('hidden'), 2600);
}

function showUploadError(message = '') {
  dom.upload_error.textContent = message;
  dom.upload_error.classList.toggle('hidden', !message);
}

function setStep(step) {
  document.querySelectorAll('.step').forEach((element) => {
    const value = Number(element.dataset.step);
    element.classList.toggle('active', value === step);
    element.classList.toggle('done', value < step);
  });
}

function setProgress({ visible, title = '', current = 0, total = 0, detail = '' }) {
  dom.progress_panel.classList.toggle('hidden', !visible);
  if (!visible) return;
  dom.progress_title.textContent = title;
  dom.progress_count.textContent = `${current} / ${total}`;
  dom.progress_bar.style.width = total ? `${Math.round((current / total) * 100)}%` : '0%';
  dom.progress_detail.textContent = detail;
}

function destinationStatus(destination) {
  if (!destination.location) return { label: '위치 확인 필요', kind: 'coral', group: 'needs' };
  if (destination.routeStatus === 'calculating') return { label: '거리 계산 중', kind: 'blue', group: 'resolved' };
  if (destination.routeStatus === 'error') return { label: '거리 계산 실패', kind: 'coral', group: 'needs' };
  if (!destination.route) return { label: '위치 확인 완료', kind: 'green', group: 'resolved' };

  const total = destination.route.totalDistance;
  const boundary = total >= 1900 && total <= 2100;
  const within = total <= 2000;
  return {
    label: `${within ? '왕복 2km 이내' : '왕복 2km 초과'}${boundary ? ' · 경계' : ''}`,
    kind: boundary ? 'purple' : (within ? 'amber' : 'blue'),
    group: boundary ? 'boundary' : (within ? 'within' : 'over'),
  };
}

function resultStatus(destination) {
  const base = statusFor(destination || {});
  const total = destination?.route?.totalDistance;
  return {
    ...base,
    total,
    within: Number.isFinite(total) && total <= 2000,
    over: Number.isFinite(total) && total > 2000,
    boundary: Number.isFinite(total) && total >= 1900 && total <= 2100,
    needs: !destination?.location || destination?.routeStatus === 'error' || !destination?.route,
  };
}

function initializeDestinations(parsed) {
  state.destinations = parsed.destinations.map((item) => {
    const remembered = state.destinationMemory[item.key]?.location || null;
    const destination = {
      ...item,
      location: remembered,
      locationStatus: remembered ? 'resolved' : 'needs',
      route: null,
      routeStatus: 'pending',
      searchError: '',
    };
    const key = routeCacheKey(state.workplace, remembered);
    if (key && state.routeCache[key]) {
      destination.route = state.routeCache[key];
      destination.routeStatus = 'complete';
    }
    return destination;
  });
}

function invalidateRoutes() {
  state.destinations.forEach((destination) => {
    destination.route = null;
    destination.routeStatus = 'pending';
    const key = routeCacheKey(state.workplace, destination.location);
    if (key && state.routeCache[key]) {
      destination.route = state.routeCache[key];
      destination.routeStatus = 'complete';
    }
  });
}

function renderWorkplace() {
  const hasWorkplace = Boolean(state.workplace);
  dom.workplace_empty.classList.toggle('hidden', hasWorkplace);
  dom.workplace_card.classList.toggle('hidden', !hasWorkplace);
  dom.set_workplace.textContent = hasWorkplace ? '근무지 변경' : '근무지 검색';
  if (hasWorkplace) {
    dom.workplace_name.textContent = state.workplace.name;
    dom.workplace_address.textContent = state.workplace.address || `${state.workplace.lat.toFixed(6)}, ${state.workplace.lon.toFixed(6)}`;
  }
}

function renderDestinationCounts() {
  const counts = { all: state.destinations.length, needs: 0, resolved: 0, within: 0, boundary: 0 };
  state.destinations.forEach((destination) => {
    const status = destinationStatus(destination);
    if (!destination.location || destination.routeStatus === 'error') counts.needs += 1;
    if (destination.location) counts.resolved += 1;
    if (destination.route?.totalDistance <= 2000) counts.within += 1;
    if (status.group === 'boundary') counts.boundary += 1;
  });
  dom.filter_all_count.textContent = counts.all;
  dom.filter_needs_count.textContent = counts.needs;
  dom.filter_resolved_count.textContent = counts.resolved;
  dom.filter_within_count.textContent = counts.within;
  dom.filter_boundary_count.textContent = counts.boundary;
}

function matchesDestinationFilter(destination) {
  const filter = state.destinationFilter;
  const status = destinationStatus(destination);
  if (filter === 'needs' && destination.location && destination.routeStatus !== 'error') return false;
  if (filter === 'resolved' && !destination.location) return false;
  if (filter === 'within' && !(destination.route?.totalDistance <= 2000)) return false;
  if (filter === 'boundary' && status.group !== 'boundary') return false;
  const query = canonical(state.destinationQuery);
  if (query && !canonical(`${destination.originalName} ${destination.location?.name || ''} ${destination.location?.address || ''}`).includes(query)) return false;
  return true;
}

function renderDestinations() {
  renderDestinationCounts();
  const rows = state.destinations.filter(matchesDestinationFilter);
  dom.destination_empty.classList.toggle('hidden', rows.length > 0);
  dom.destination_body.innerHTML = rows.map((destination) => {
    const status = destinationStatus(destination);
    const expanded = state.expanded.has(destination.key);
    const locationName = destination.location?.name || '아직 확인하지 않음';
    const locationAddress = destination.location?.address || (destination.ambiguous ? '정확한 장소를 선택해 주세요.' : '자동 검색 또는 직접 선택');
    const distance = destination.route ? formatDistance(destination.route.totalDistance) : '-';
    const distanceSub = destination.route ? `갈 때 ${formatDistance(destination.route.outbound?.distance)} · 올 때 ${formatDistance(destination.route.inbound?.distance)}` : '보행 왕복거리';
    const actions = [
      `<button class="row-button ${destination.location ? '' : 'primary'}" data-action="select-location" data-key="${escapeHtml(destination.key)}" type="button">${destination.location ? '위치 변경' : '장소 선택'}</button>`,
    ];
    if (destination.location && state.workplace && !destination.route) {
      actions.push(`<button class="row-button primary" data-action="calculate-one" data-key="${escapeHtml(destination.key)}" type="button">거리 계산</button>`);
    }
    if (destination.location) {
      actions.push(`<button class="row-button" data-action="view-map" data-key="${escapeHtml(destination.key)}" type="button">지도 보기</button>`);
    }
    if (destination.routeStatus === 'error') {
      actions.push(`<button class="row-button primary" data-action="calculate-one" data-key="${escapeHtml(destination.key)}" type="button">다시 계산</button>`);
    }

    return `
      <tr>
        <td>
          <div class="cell-title">
            <button data-action="toggle-details" data-key="${escapeHtml(destination.key)}" type="button" aria-label="출장 상세 ${expanded ? '접기' : '펼치기'}">${expanded ? '−' : '+'}</button>
            <div><strong>${escapeHtml(destination.originalName)}</strong><span class="cell-sub">${escapeHtml(destination.searchQuery)}</span>${destination.ambiguous ? '<span class="ambiguous-tag">자동 확정 안 함</span>' : ''}</div>
          </div>
        </td>
        <td><strong>${destination.count}</strong>건</td>
        <td><div class="place-cell"><strong>${escapeHtml(locationName)}</strong><span title="${escapeHtml(locationAddress)}">${escapeHtml(locationAddress)}</span></div></td>
        <td><div class="distance-cell"><strong>${distance}</strong><span>${distanceSub}</span></div></td>
        <td><span class="pill ${status.kind}">${escapeHtml(status.label)}</span>${destination.searchError ? `<span class="cell-sub">${escapeHtml(destination.searchError)}</span>` : ''}</td>
        <td><div class="row-actions">${actions.join('')}</div></td>
      </tr>
      ${expanded ? `<tr class="detail-row"><td colspan="6"><div class="detail-box"><span><strong>출장자</strong> ${escapeHtml(destination.travelers.join(', '))}</span><span><strong>출장일</strong> ${escapeHtml(destination.dates.join(', '))}</span></div></td></tr>` : ''}
    `;
  }).join('');

  dom.auto_search.disabled = state.busy || !state.parsed;
  dom.calculate_all.disabled = state.busy || !state.workplace || !state.destinations.some((item) => item.location && !item.route);
}

function allResultRows() {
  if (!state.parsed) return [];
  const destinationMap = new Map(state.destinations.map((destination) => [destination.key, destination]));
  const priority = (entry) => {
    if (entry.status.needs) return 0;
    if (entry.status.within) return entry.status.boundary ? 1 : 2;
    if (entry.status.boundary) return 3;
    return 4;
  };
  return state.parsed.trips.map((trip) => {
    const destination = destinationMap.get(trip.normalizedDestination);
    return { trip, destination, status: resultStatus(destination) };
  }).sort((a, b) => priority(a) - priority(b) || b.trip.startDate.localeCompare(a.trip.startDate));
}

function matchesResultFilter(entry) {
  if (state.resultFilter === 'needs' && !(entry.status.needs || entry.status.within)) return false;
  if (state.resultFilter === 'within' && !entry.status.within) return false;
  if (state.resultFilter === 'over' && !entry.status.over) return false;
  const query = canonical(state.resultQuery);
  if (query && !canonical(`${entry.trip.traveler} ${entry.trip.destination} ${entry.trip.purpose}`).includes(query)) return false;
  return true;
}

function renderResultMetrics(rows) {
  const total = rows.length;
  const within = rows.filter((row) => row.status.within).length;
  const over = rows.filter((row) => row.status.over).length;
  const boundary = rows.filter((row) => row.status.boundary).length;
  const needs = rows.filter((row) => row.status.needs).length;
  dom.result_metrics.innerHTML = [
    ['총 출장', total, ''],
    ['왕복 2km 이내', within, 'emphasis'],
    ['왕복 2km 초과', over, ''],
    ['경계 구간', boundary, ''],
    ['위치·거리 확인', needs, 'alert'],
  ].map(([label, value, className]) => `<div class="result-metric ${className}"><span>${label}</span><strong>${value}건</strong></div>`).join('');
}

function renderResults() {
  const allRows = allResultRows();
  renderResultMetrics(allRows);
  const rows = allRows.filter(matchesResultFilter);
  dom.result_empty.classList.toggle('hidden', rows.length > 0);
  dom.result_body.innerHTML = rows.map(({ trip, destination, status }) => {
    const pillKind = status.boundary ? 'purple' : (status.within ? 'amber' : (status.over ? 'blue' : 'coral'));
    return `<tr>
      <td>${escapeHtml(formatDateOnly(trip.startDate))}</td>
      <td><strong>${escapeHtml(trip.traveler)}</strong></td>
      <td><div class="ellipsis" title="${escapeHtml(trip.destination)}">${escapeHtml(trip.destination)}</div></td>
      <td><div class="ellipsis purpose" title="${escapeHtml(trip.purpose)}">${escapeHtml(trip.purpose)}</div></td>
      <td><strong>${destination?.route ? formatDistance(destination.route.totalDistance) : '-'}</strong></td>
      <td><span class="pill ${pillKind}">${escapeHtml(status.label)}</span></td>
      <td>${escapeHtml(status.note)}</td>
      <td><button class="copy-button" data-action="copy-result" data-trip-id="${escapeHtml(trip.id)}" type="button" aria-label="결과 복사">⧉</button></td>
    </tr>`;
  }).join('');
  dom.export_results.disabled = !state.parsed;
}

function renderAll() {
  renderWorkplace();
  if (!state.parsed) return;
  dom.analysis_section.classList.remove('hidden');
  dom.file_name.textContent = state.fileName;
  dom.file_detail.textContent = `${state.parsed.sheetNames.join(', ')} · 분석 완료`;
  dom.metric_trips.textContent = state.parsed.summary.tripCount;
  dom.metric_travelers.textContent = state.parsed.summary.travelerCount;
  dom.metric_destinations.textContent = state.parsed.summary.destinationCount;
  renderDestinations();
  renderResults();
  const completed = state.destinations.some((destination) => destination.routeStatus === 'complete');
  setStep(completed ? 3 : 2);
}

async function handleFile(file) {
  showUploadError('');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['xls', 'xlsx'].includes(extension)) {
    showUploadError('지원하지 않는 파일이에요. .xls 또는 .xlsx 파일을 선택해 주세요.');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showUploadError('파일이 너무 커요. 20MB 이하의 에듀파인 출력 파일을 선택해 주세요.');
    return;
  }

  dom.drop_zone.classList.add('dragover');
  try {
    const arrayBuffer = await file.arrayBuffer();
    const parsed = parseEdufineWorkbook(arrayBuffer, XLSX);
    state.parsed = parsed;
    state.fileName = file.name;
    state.destinationFilter = 'all';
    state.resultFilter = 'all';
    state.destinationQuery = '';
    state.resultQuery = '';
    state.expanded.clear();
    initializeDestinations(parsed);
    renderAll();
    dom.analysis_section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(`관내출장 ${parsed.summary.tripCount}건을 불러왔어요.`);
  } catch (error) {
    const message = error.code === 'HEADER_NOT_FOUND'
      ? '에듀파인 관내여비 내역 형식을 찾지 못했어요. 파일의 열 이름을 확인해 주세요.'
      : error.code === 'NO_TRIPS'
        ? '관내출장 내역을 찾지 못했어요. 조회기간과 출장구분을 확인해 주세요.'
        : `파일을 읽지 못했어요. ${error.message || ''}`;
    showUploadError(message);
  } finally {
    dom.drop_zone.classList.remove('dragover');
    dom.file_input.value = '';
  }
}

async function checkApi() {
  try {
    const health = await getApiHealth();
    state.apiConfigured = Boolean(health.connected);
    if (health.connected) {
      dom.api_status.className = 'status-chip success';
      dom.api_status.innerHTML = '<span class="status-dot"></span>지도 API 연결됨';
      dom.api_status.title = '';
    } else if (health.configured) {
      dom.api_status.className = 'status-chip warning';
      dom.api_status.innerHTML = '<span class="status-dot"></span>TMAP 사용 설정 확인';
      dom.api_status.title = health.message || '앱 키 또는 상품 사용 신청을 확인해 주세요.';
    } else {
      dom.api_status.className = 'status-chip warning';
      dom.api_status.innerHTML = '<span class="status-dot"></span>지도 API 키 필요';
      dom.api_status.title = '';
    }
  } catch {
    state.apiConfigured = false;
    dom.api_status.className = 'status-chip warning';
    dom.api_status.innerHTML = '<span class="status-dot"></span>지도 API 연결 전';
    dom.api_status.title = '';
  }
}

function getDestination(key) {
  return state.destinations.find((destination) => destination.key === key);
}

function saveDestinationLocation(destination, location) {
  destination.location = location;
  destination.locationStatus = 'resolved';
  destination.route = null;
  destination.routeStatus = 'pending';
  destination.searchError = '';
  state.destinationMemory[destination.key] = { location, savedAt: new Date().toISOString() };
  saveDestinationMemory(state.destinationMemory);
  const key = routeCacheKey(state.workplace, location);
  if (key && state.routeCache[key]) {
    destination.route = state.routeCache[key];
    destination.routeStatus = 'complete';
  }
}

function confidenceCandidate(destination, candidates) {
  if (!candidates.length) return null;
  if (destination.extractedAddress) {
    return candidates.find((candidate) => candidate.source === 'geocode') || (candidates.length === 1 ? candidates[0] : null);
  }
  const target = canonical(destination.originalName);
  const exact = candidates.filter((candidate) => canonical(candidate.name) === target);
  if (exact.length === 1) return exact[0];
  if (candidates.length === 1) return candidates[0];
  return null;
}

async function autoSearchDestinations() {
  if (state.busy) return;
  const targets = state.destinations.filter((destination) => !destination.location && !destination.ambiguous);
  if (!targets.length) {
    showToast('자동으로 찾을 출장지가 없어요.');
    return;
  }

  state.busy = true;
  let resolved = 0;
  setProgress({ visible: true, title: '출장지 위치를 찾고 있어요', current: 0, total: targets.length, detail: '' });
  renderDestinations();

  for (let index = 0; index < targets.length; index += 1) {
    const destination = targets[index];
    setProgress({ visible: true, title: '출장지 위치를 찾고 있어요', current: index, total: targets.length, detail: destination.originalName });
    try {
      const data = await searchPlaces(destination.searchQuery);
      const candidate = confidenceCandidate(destination, data.candidates || []);
      if (candidate) {
        saveDestinationLocation(destination, candidate);
        resolved += 1;
      } else {
        destination.searchError = data.candidates?.length ? '검색 결과 선택 필요' : '검색 결과 없음';
      }
    } catch (error) {
      destination.searchError = error.code === 'TMAP_APP_KEY_NOT_CONFIGURED' ? '지도 API 키 필요' : '자동 검색 실패';
      if (error.code === 'TMAP_APP_KEY_NOT_CONFIGURED') break;
    }
    setProgress({ visible: true, title: '출장지 위치를 찾고 있어요', current: index + 1, total: targets.length, detail: destination.originalName });
    renderDestinations();
  }

  state.busy = false;
  setProgress({ visible: false });
  renderAll();
  showToast(`${resolved}곳을 자동 확인했어요. 나머지는 직접 선택해 주세요.`);
}

async function calculateDestination(destination, updateProgress = null) {
  if (!state.workplace || !destination.location) return false;
  const key = routeCacheKey(state.workplace, destination.location);
  if (state.routeCache[key]) {
    destination.route = state.routeCache[key];
    destination.routeStatus = 'complete';
    return true;
  }

  destination.routeStatus = 'calculating';
  renderDestinations();
  try {
    const route = compactRoute(await calculateRoundTrip(
      { ...state.workplace, name: state.workplace.name || '근무지' },
      { ...destination.location, name: destination.location.name || destination.originalName },
    ));
    destination.route = route;
    destination.routeStatus = 'complete';
    destination.searchError = '';
    state.routeCache[key] = route;
    saveRouteCache(state.routeCache);
    return true;
  } catch (error) {
    destination.routeStatus = 'error';
    destination.searchError = error.code === 'TMAP_APP_KEY_NOT_CONFIGURED' ? '지도 API 키 필요' : (error.message || '거리 계산 실패');
    return false;
  } finally {
    updateProgress?.();
  }
}

async function calculateAllDestinations() {
  if (state.busy) return;
  if (!state.workplace) {
    showToast('거리 계산을 위해 근무지를 먼저 설정해 주세요.', 'error');
    openLocationModal('workplace');
    return;
  }
  const targets = state.destinations.filter((destination) => destination.location && (!destination.route || destination.routeStatus === 'error'));
  if (!targets.length) {
    showToast('계산할 출장지가 없어요.');
    return;
  }

  state.busy = true;
  let completed = 0;
  let success = 0;
  setProgress({ visible: true, title: '보행 왕복거리를 계산하고 있어요', current: 0, total: targets.length, detail: '' });
  renderDestinations();

  for (let index = 0; index < targets.length; index += 2) {
    const batch = targets.slice(index, index + 2);
    await Promise.all(batch.map(async (destination) => {
      const ok = await calculateDestination(destination, () => {
        completed += 1;
        setProgress({ visible: true, title: '보행 왕복거리를 계산하고 있어요', current: completed, total: targets.length, detail: destination.originalName });
      });
      if (ok) success += 1;
    }));
    renderAll();
  }

  state.busy = false;
  setProgress({ visible: false });
  renderAll();
  dom.result_section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast(`${success}곳의 왕복거리 계산을 마쳤어요.`);
}

function ensureMap() {
  if (state.modal.map) {
    window.setTimeout(() => state.modal.map.invalidateSize(), 30);
    return;
  }
  state.modal.map = L.map('map', { zoomControl: true }).setView([37.5665, 126.978], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.modal.map);
  state.modal.map.on('click', (event) => {
    const currentName = state.modal.pending?.name || (state.modal.mode === 'workplace' ? '지도에서 선택한 근무지' : '지도에서 선택한 출장지');
    setPendingLocation({
      name: currentName,
      address: `지도 선택 위치 · ${event.latlng.lat.toFixed(6)}, ${event.latlng.lng.toFixed(6)}`,
      lat: event.latlng.lat,
      lon: event.latlng.lng,
      source: 'manual',
    });
  });
}

function markerIcon(type = 'destination') {
  return L.divIcon({
    className: '',
    html: `<div class="map-pin ${type === 'workplace' ? 'workplace' : ''}"></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 31],
  });
}

function clearMapLayers() {
  const map = state.modal.map;
  if (!map) return;
  if (state.modal.marker) map.removeLayer(state.modal.marker);
  if (state.modal.workplaceMarker) map.removeLayer(state.modal.workplaceMarker);
  state.modal.routeLayers.forEach((layer) => map.removeLayer(layer));
  state.modal.marker = null;
  state.modal.workplaceMarker = null;
  state.modal.routeLayers = [];
}

function setPendingLocation(location, { fit = true } = {}) {
  state.modal.pending = location;
  dom.pending_location.classList.remove('hidden');
  dom.pending_name.textContent = location.name || '선택한 위치';
  dom.pending_address.textContent = location.address || `${location.lat}, ${location.lon}`;
  if (!state.modal.map) return;
  if (state.modal.marker) state.modal.map.removeLayer(state.modal.marker);
  state.modal.marker = L.marker([location.lat, location.lon], {
    icon: markerIcon(state.modal.mode === 'workplace' ? 'workplace' : 'destination'),
  }).addTo(state.modal.map);
  if (fit) state.modal.map.setView([location.lat, location.lon], 16);
}

function drawCurrentRoute(destination) {
  if (!state.modal.map || !state.workplace || !destination?.location) return;
  state.modal.workplaceMarker = L.marker([state.workplace.lat, state.workplace.lon], { icon: markerIcon('workplace') }).addTo(state.modal.map);
  const bounds = L.latLngBounds([
    [state.workplace.lat, state.workplace.lon],
    [destination.location.lat, destination.location.lon],
  ]);
  if (destination.route?.outbound?.path?.length) {
    const line = L.polyline(destination.route.outbound.path, { color: '#3159d8', weight: 5, opacity: .8 }).addTo(state.modal.map);
    state.modal.routeLayers.push(line);
    bounds.extend(line.getBounds());
  }
  if (destination.route?.inbound?.path?.length) {
    const line = L.polyline(destination.route.inbound.path, { color: '#8b6fc2', weight: 4, opacity: .6, dashArray: '7 7' }).addTo(state.modal.map);
    state.modal.routeLayers.push(line);
    bounds.extend(line.getBounds());
  }
  state.modal.map.fitBounds(bounds.pad(.16));
}

async function openLocationModal(mode, key = null) {
  state.modal.mode = mode;
  state.modal.key = key;
  state.modal.candidates = [];
  state.modal.pending = null;
  dom.candidate_list.innerHTML = '';
  dom.candidate_empty.classList.remove('hidden');
  dom.pending_location.classList.add('hidden');

  let query = '';
  let current = null;
  if (mode === 'workplace') {
    dom.modal_kicker.textContent = '근무지 설정';
    dom.modal_title.textContent = state.workplace ? '근무지 위치를 확인하세요' : '근무지를 검색하세요';
    query = state.workplace?.name || '';
    current = state.workplace;
  } else {
    const destination = getDestination(key);
    if (!destination) return;
    dom.modal_kicker.textContent = `${destination.count}건의 출장에 함께 적용`;
    dom.modal_title.textContent = destination.originalName;
    query = destination.searchQuery;
    current = destination.location;
  }

  dom.place_search_input.value = query;
  dom.location_modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  window.setTimeout(() => {
    ensureMap();
    clearMapLayers();
    if (current) setPendingLocation(current);
    else state.modal.map.setView([37.5665, 126.978], 11);
    if (mode === 'destination') drawCurrentRoute(getDestination(key));
  }, 20);

  if (query) await performPlaceSearch(query);
}

function closeLocationModal() {
  dom.location_modal.classList.add('hidden');
  document.body.style.overflow = '';
  state.modal.mode = null;
  state.modal.key = null;
}

function renderCandidates() {
  const candidates = state.modal.candidates;
  dom.candidate_empty.classList.toggle('hidden', candidates.length > 0);
  dom.candidate_list.innerHTML = candidates.map((candidate, index) => `
    <button class="candidate-card" data-candidate-index="${index}" type="button">
      <span class="candidate-source">${candidate.source === 'geocode' ? '주소' : '장소'}</span>
      <strong>${escapeHtml(candidate.name)}</strong>
      <span>${escapeHtml(candidate.roadAddress || candidate.address || '')}</span>
      ${candidate.jibunAddress && candidate.jibunAddress !== candidate.roadAddress ? `<small>${escapeHtml(candidate.jibunAddress)}</small>` : ''}
    </button>
  `).join('');
}

async function performPlaceSearch(query) {
  const value = String(query || '').trim();
  if (value.length < 2) return;
  dom.candidate_loading.classList.remove('hidden');
  dom.candidate_empty.classList.add('hidden');
  dom.candidate_list.innerHTML = '';
  try {
    const data = await searchPlaces(value);
    state.modal.candidates = data.candidates || [];
    renderCandidates();
    if (!state.modal.candidates.length) {
      dom.candidate_empty.innerHTML = '<strong>검색 결과가 없어요.</strong><span>도로명주소를 더 정확하게 입력하거나 지도에서 직접 선택해 주세요.</span>';
      dom.candidate_empty.classList.remove('hidden');
    }
  } catch (error) {
    state.modal.candidates = [];
    const authFailed = error.code === 'TMAP_AUTH_FAILED' || error.status === 401 || error.status === 403;
    const title = error.code === 'TMAP_APP_KEY_NOT_CONFIGURED'
      ? '지도 API 키가 필요해요.'
      : authFailed
        ? 'TMAP 사용 설정을 확인해 주세요.'
        : '장소 검색에 실패했어요.';
    const message = authFailed
      ? 'Vercel의 TMAP_APP_KEY 값과 SK open API 앱의 TMAP 상품 사용 신청 상태를 확인해 주세요.'
      : (error.message || '잠시 후 다시 시도해 주세요.');
    dom.candidate_empty.innerHTML = `<strong>${title}</strong><span>${escapeHtml(message)}</span>`;
    dom.candidate_empty.classList.remove('hidden');
  } finally {
    dom.candidate_loading.classList.add('hidden');
  }
}

function confirmPendingLocation() {
  const location = state.modal.pending;
  if (!location) return;
  if (state.modal.mode === 'workplace') {
    state.workplace = location;
    saveWorkplace(location);
    invalidateRoutes();
    showToast('근무지를 저장했어요.');
  } else {
    const destination = getDestination(state.modal.key);
    if (destination) {
      saveDestinationLocation(destination, location);
      showToast(`${destination.originalName} 위치를 저장했어요.`);
    }
  }
  closeLocationModal();
  renderAll();
}

function resetCurrent() {
  if (!state.parsed) return;
  if (!window.confirm('현재 불러온 파일과 계산 결과를 초기화할까요? 저장된 근무지와 출장지 위치는 유지됩니다.')) return;
  state.parsed = null;
  state.fileName = '';
  state.destinations = [];
  state.expanded.clear();
  dom.analysis_section.classList.add('hidden');
  showUploadError('');
  setStep(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function copyTripResult(tripId) {
  const entry = allResultRows().find((row) => row.trip.id === tripId);
  if (!entry) return;
  const text = [
    `출장자: ${entry.trip.traveler}`,
    `출장지: ${entry.trip.destination}`,
    `왕복 보행거리: ${entry.destination?.route ? formatDistance(entry.destination.route.totalDistance) : '미확인'}`,
    `판정: ${entry.status.label}`,
    `확인사항: ${entry.status.note}`,
  ].join('\n');
  navigator.clipboard.writeText(text).then(() => showToast('결과가 복사됐어요.')).catch(() => showToast('복사하지 못했어요.', 'error'));
}

function bindEvents() {
  dom.drop_zone.addEventListener('click', () => dom.file_input.click());
  dom.drop_zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') dom.file_input.click();
  });
  dom.file_input.addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) handleFile(file);
  });
  ['dragenter', 'dragover'].forEach((name) => dom.drop_zone.addEventListener(name, (event) => {
    event.preventDefault();
    dom.drop_zone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((name) => dom.drop_zone.addEventListener(name, (event) => {
    event.preventDefault();
    dom.drop_zone.classList.remove('dragover');
  }));
  dom.drop_zone.addEventListener('drop', (event) => {
    const [file] = event.dataTransfer.files;
    if (file) handleFile(file);
  });

  dom.reset_all.addEventListener('click', resetCurrent);
  [dom.set_workplace, dom.change_workplace].forEach((button) => button.addEventListener('click', () => openLocationModal('workplace')));
  dom.view_workplace.addEventListener('click', () => openLocationModal('workplace'));
  dom.clear_workplace_storage.addEventListener('click', () => {
    if (!state.workplace) return showToast('저장된 근무지가 없어요.');
    if (!window.confirm('저장된 근무지를 초기화할까요? 현재 거리 결과도 다시 계산해야 합니다.')) return;
    state.workplace = null;
    saveWorkplace(null);
    state.destinations.forEach((destination) => {
      destination.route = null;
      destination.routeStatus = 'pending';
    });
    renderAll();
    showToast('저장된 근무지를 초기화했어요.');
  });
  dom.clear_destination_storage.addEventListener('click', () => {
    if (!window.confirm('저장된 출장지 위치와 거리 캐시를 모두 초기화할까요?')) return;
    clearDestinationStorage();
    state.destinationMemory = {};
    state.routeCache = {};
    state.destinations.forEach((destination) => {
      destination.location = null;
      destination.locationStatus = 'needs';
      destination.route = null;
      destination.routeStatus = 'pending';
      destination.searchError = '';
    });
    renderAll();
    showToast('저장된 출장지 정보를 초기화했어요.');
  });
  dom.auto_search.addEventListener('click', autoSearchDestinations);
  dom.calculate_all.addEventListener('click', calculateAllDestinations);

  dom.destination_filters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.destinationFilter = button.dataset.filter;
    dom.destination_filters.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
    renderDestinations();
  });
  dom.destination_search.addEventListener('input', (event) => {
    state.destinationQuery = event.target.value;
    renderDestinations();
  });
  dom.destination_body.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const key = button.dataset.key;
    const destination = getDestination(key);
    if (button.dataset.action === 'toggle-details') {
      state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
      renderDestinations();
    } else if (button.dataset.action === 'select-location' || button.dataset.action === 'view-map') {
      openLocationModal('destination', key);
    } else if (button.dataset.action === 'calculate-one' && destination) {
      if (!state.workplace) return openLocationModal('workplace');
      state.busy = true;
      await calculateDestination(destination);
      state.busy = false;
      renderAll();
      showToast(destination.routeStatus === 'complete' ? '왕복거리를 계산했어요.' : '거리 계산에 실패했어요.', destination.routeStatus === 'complete' ? 'success' : 'error');
    }
  });

  dom.result_filters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.resultFilter = button.dataset.filter;
    dom.result_filters.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
    renderResults();
  });
  dom.result_search.addEventListener('input', (event) => {
    state.resultQuery = event.target.value;
    renderResults();
  });
  dom.show_needs_only.addEventListener('click', () => {
    state.resultFilter = 'needs';
    dom.result_filters.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.filter === 'needs'));
    renderResults();
    dom.result_section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  dom.result_body.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="copy-result"]');
    if (button) copyTripResult(button.dataset.tripId);
  });
  dom.export_results.addEventListener('click', () => {
    if (!state.parsed) return;
    exportResults({ XLSX, trips: state.parsed.trips, destinations: state.destinations, workplace: state.workplace });
    showToast('결과 엑셀을 만들었어요.');
  });

  dom.close_modal.addEventListener('click', closeLocationModal);
  dom.location_modal.addEventListener('click', (event) => {
    if (event.target === dom.location_modal) closeLocationModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.location_modal.classList.contains('hidden')) closeLocationModal();
  });
  dom.place_search_form.addEventListener('submit', (event) => {
    event.preventDefault();
    performPlaceSearch(dom.place_search_input.value);
  });
  dom.candidate_list.addEventListener('click', (event) => {
    const card = event.target.closest('[data-candidate-index]');
    if (!card) return;
    const candidate = state.modal.candidates[Number(card.dataset.candidateIndex)];
    if (!candidate) return;
    dom.candidate_list.querySelectorAll('.candidate-card').forEach((item) => item.classList.toggle('selected', item === card));
    setPendingLocation(candidate);
  });
  dom.confirm_location.addEventListener('click', confirmPendingLocation);
}

bindEvents();
renderWorkplace();
setStep(1);
checkApi();
