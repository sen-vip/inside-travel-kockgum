import * as XLSX from 'xlsx';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { parseEdufineWorkbook } from './parser.js';
import { calculateRoundTrip, getApiHealth, getTmapUsage, searchPlaces } from './api.js';
import {
  clearAllStorage,
  clearDestinationStorage,
  loadDestinationMemory,
  loadRouteCache,
  loadWorkplace,
  isRouteCacheFresh,
  isTmapDataFresh,
  saveDestinationMemory,
  saveRouteCache,
  saveWorkplace,
} from './storage.js';
import { exportResults, statusFor } from './exporter.js';

const dom = Object.fromEntries([
  'api-status', 'help-button', 'reset-all', 'drop-zone', 'file-input', 'upload-error', 'analysis-section',
  'file-name', 'file-detail', 'metric-trips', 'metric-travelers', 'metric-destinations',
  'set-workplace', 'workplace-empty', 'workplace-card', 'workplace-name', 'workplace-address',
  'view-workplace', 'change-workplace', 'clear-all-storage', 'clear-workplace-storage', 'clear-destination-storage',
  'batch-destination-count', 'bulk-inspect', 'stop-inspect', 'batch-readiness',
  'tmap-usage-panel', 'tmap-usage-count', 'tmap-usage-bar', 'tmap-usage-status', 'tmap-usage-estimate',
  'batch-complete-actions', 'retry-incomplete', 'recalculate-all',
  'auto-search', 'calculate-all', 'progress-panel', 'progress-title', 'progress-count',
  'progress-bar', 'progress-detail', 'progress-subcounts', 'destination-filters',
  'destination-search', 'destination-body', 'destination-empty', 'filter-all-count',
  'filter-needs-count', 'filter-resolved-count', 'filter-within-count', 'filter-boundary-count',
  'filter-failed-count', 'result-section', 'export-results', 'result-metrics', 'show-needs-only',
  'result-filters', 'result-search', 'result-body', 'result-empty',
  'location-modal', 'modal-kicker', 'modal-title', 'close-modal', 'place-search-form',
  'place-search-input', 'candidate-loading', 'candidate-list', 'candidate-empty',
  'pending-location', 'pending-name', 'pending-address', 'confirm-location',
  'help-modal', 'close-help', 'privacy-details', 'clear-all-storage-upload', 'toast',
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
  stopRequested: false,
  apiConfigured: false,
  tmapUsage: { loading: true, configured: null, used: 0, officialLimit: 1000, safeLimit: 900, warningAt: 800, remainingSafe: 900, blocked: false, error: '' },
  batchStarted: false,
  lastBatchSummary: null,
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

function formatMoney(value) {
  const number = Number(value) || 0;
  return number ? `${number.toLocaleString('ko-KR')}원` : '-';
}

function formatDateOnly(value) {
  return String(value || '').slice(0, 10).replaceAll('-', '.');
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function routeCacheKey(workplace, location) {
  if (!workplace || !location) return '';
  return [workplace.lat, workplace.lon, location.lat, location.lon]
    .map((value) => Number(value).toFixed(6)).join('|');
}

function getFreshRouteCache(key) {
  if (!key) return null;
  const cached = state.routeCache[key];
  if (isRouteCacheFresh(cached)) return cached;
  if (cached) {
    delete state.routeCache[key];
    saveRouteCache(state.routeCache);
  }
  return null;
}

function expireStaleTmapData() {
  const now = Date.now();
  let changed = false;
  let destinationMemoryChanged = false;
  let routeCacheChanged = false;

  if (state.workplace && !isTmapDataFresh(state.workplace, now)) {
    state.workplace = null;
    saveWorkplace(null);
    changed = true;
  }

  for (const destination of state.destinations) {
    const locationTimestamp = destination.location?.savedAt || destination.lastCheckedAt;
    if (destination.location && !isTmapDataFresh(locationTimestamp, now)) {
      destination.location = null;
      destination.locationSource = null;
      destination.locationStatus = 'needs';
      destination.searchStatus = 'pending';
      destination.route = null;
      destination.routeStatus = 'pending';
      destination.searchError = '';
      delete state.destinationMemory[destination.key];
      destinationMemoryChanged = true;
      changed = true;
      continue;
    }
    if (destination.route && !isRouteCacheFresh(destination.route, now)) {
      destination.route = null;
      destination.routeStatus = 'pending';
      changed = true;
    }
  }

  for (const [key, route] of Object.entries(state.routeCache)) {
    if (!isRouteCacheFresh(route, now)) {
      delete state.routeCache[key];
      routeCacheChanged = true;
      changed = true;
    }
  }

  if (destinationMemoryChanged) saveDestinationMemory(state.destinationMemory);
  if (routeCacheChanged) saveRouteCache(state.routeCache);
  return changed;
}

function applyUsageSnapshot(usage = {}) {
  if (!usage || typeof usage !== 'object') return;
  state.tmapUsage = {
    ...state.tmapUsage,
    ...usage,
    loading: false,
    configured: true,
    error: '',
  };
}

function estimateRouteCalls({ forceRoutes = false, routeOnly = false } = {}) {
  if (!state.parsed || !state.workplace) return 0;
  let destinations = state.destinations;
  if (routeOnly) destinations = destinations.filter((destination) => destination.location);

  return destinations.reduce((sum, destination) => {
    if (!destination.location) return routeOnly ? sum : sum + 2;
    const key = routeCacheKey(state.workplace, destination.location);
    const hasFreshCache = Boolean(getFreshRouteCache(key));
    const alreadyComplete = destination.routeStatus === 'complete' && destination.route && hasFreshCache;
    if (!forceRoutes && alreadyComplete) return sum;
    if (!forceRoutes && hasFreshCache) return sum;
    return sum + 2;
  }, 0);
}

function usageAllows(calls = 0) {
  if (state.tmapUsage.configured !== true || state.tmapUsage.error) return false;
  return (Number(state.tmapUsage.used) || 0) + Math.max(0, Number(calls) || 0) <= Number(state.tmapUsage.safeLimit || 900);
}

async function refreshTmapUsage({ silent = false } = {}) {
  if (!silent) state.tmapUsage.loading = true;
  try {
    const data = await getTmapUsage();
    applyUsageSnapshot(data.usage || {});
  } catch (error) {
    state.tmapUsage = {
      ...state.tmapUsage,
      loading: false,
      configured: error.code !== 'TMAP_USAGE_STORAGE_NOT_CONFIGURED',
      error: error.message || 'TMAP 사용량을 확인하지 못했습니다.',
    };
  }
  renderTmapUsage();
  if (state.parsed) {
    renderBatchPanel();
    renderDestinations();
  }
  return state.tmapUsage;
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
  showToast.timer = window.setTimeout(() => dom.toast.classList.add('hidden'), 3000);
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

function setProgress({ visible, title = '', current = 0, total = 0, detail = '', subcounts = '', stopped = false }) {
  dom.progress_panel.classList.toggle('hidden', !visible);
  dom.progress_panel.classList.toggle('stopped', stopped);
  if (!visible) return;
  dom.progress_title.textContent = title;
  dom.progress_title.classList.toggle('working-text', state.busy && !stopped);
  dom.progress_count.textContent = `${current} / ${total}`;
  dom.progress_bar.style.width = total ? `${Math.min(100, Math.round((current / total) * 100))}%` : '0%';
  dom.progress_detail.textContent = detail;
  dom.progress_subcounts.textContent = subcounts;
}

function destinationStatus(destination) {
  if (!destination.location) {
    if (destination.searchStatus === 'searching') return { label: '위치 검색 중', kind: 'blue', group: 'resolved' };
    if (destination.searchStatus === 'error') return { label: '검색 실패', kind: 'coral', group: 'failed' };
    return { label: '위치 확인 필요', kind: 'coral', group: 'needs' };
  }
  if (destination.routeStatus === 'calculating') return { label: '거리 계산 중', kind: 'blue', group: 'resolved' };
  if (destination.routeStatus === 'error') return { label: '거리 계산 실패', kind: 'coral', group: 'failed' };
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
  const within = Number.isFinite(total) && total <= 2000;
  const over = Number.isFinite(total) && total > 2000;
  const boundary = Number.isFinite(total) && total >= 1900 && total <= 2100;
  const failed = destination?.searchStatus === 'error' || destination?.routeStatus === 'error';
  const needs = !destination?.location || failed || !destination?.route;

  let note = '—';
  if (failed || needs) note = base.note;
  else if (boundary) note = '출입구 위치 확인';
  else if (within) note = '이동수단 확인 필요';

  let displayLabel = base.label;
  if (within) displayLabel = boundary ? '2km 이내 · 경계' : '2km 이내';
  else if (over) displayLabel = boundary ? '2km 초과 · 경계' : '2km 초과';

  return {
    ...base,
    displayLabel,
    total,
    within,
    over,
    boundary,
    failed,
    needs,
    note,
  };
}

function initializeDestinations(parsed) {
  state.destinations = parsed.destinations.map((item) => {
    const memory = state.destinationMemory[item.key] || {};
    const remembered = memory.location || null;
    const destination = {
      ...item,
      location: remembered,
      locationSource: remembered ? 'saved' : null,
      locationStatus: remembered ? 'resolved' : 'needs',
      searchStatus: remembered ? 'resolved' : 'pending',
      route: null,
      routeStatus: 'pending',
      searchError: '',
      lastCheckedAt: memory.savedAt || null,
    };
    const key = routeCacheKey(state.workplace, remembered);
    const cached = getFreshRouteCache(key);
    if (cached) {
      destination.route = cached;
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
    const cached = getFreshRouteCache(key);
    if (cached) {
      destination.route = cached;
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

function summarizeDestinations() {
  const summary = {
    total: state.destinations.length,
    located: 0,
    unresolved: 0,
    within: 0,
    over: 0,
    boundary: 0,
    failed: 0,
    routeComplete: 0,
  };
  state.destinations.forEach((destination) => {
    const status = destinationStatus(destination);
    if (destination.location) summary.located += 1;
    else summary.unresolved += 1;
    if (destination.routeStatus === 'complete') summary.routeComplete += 1;
    if (destination.route?.totalDistance <= 2000) summary.within += 1;
    if (destination.route?.totalDistance > 2000) summary.over += 1;
    if (status.group === 'boundary') summary.boundary += 1;
    if (status.group === 'failed') summary.failed += 1;
  });
  return summary;
}

function renderTmapUsage() {
  if (!dom.tmap_usage_panel) return;
  const usage = state.tmapUsage;
  const used = Number(usage.used) || 0;
  const officialLimit = Number(usage.officialLimit) || 1000;
  const safeLimit = Number(usage.safeLimit) || 900;
  const warningAt = Number(usage.warningAt) || 800;
  const estimate = estimateRouteCalls();
  const projected = used + estimate;

  dom.tmap_usage_count.textContent = usage.loading || usage.error ? '—' : used.toLocaleString('ko-KR');
  dom.tmap_usage_bar.style.width = usage.loading || usage.error
    ? '0%'
    : `${Math.min(100, Math.round((used / officialLimit) * 100))}%`;

  dom.tmap_usage_panel.classList.remove('normal', 'warning', 'blocked', 'error');
  if (usage.loading) {
    dom.tmap_usage_panel.classList.add('normal');
    dom.tmap_usage_status.textContent = '오늘 사용량을 확인하고 있어요.';
    dom.tmap_usage_estimate.textContent = '왕복거리 1곳을 계산할 때 TMAP 경로조회 2회를 사용해요.';
    return;
  }

  if (usage.error || usage.configured !== true) {
    dom.tmap_usage_panel.classList.add('error');
    dom.tmap_usage_status.textContent = '사용량 보호 연결을 확인해 주세요.';
    dom.tmap_usage_estimate.textContent = '사용량을 확인할 수 없는 동안에는 신규 거리계산을 실행하지 않아요.';
    return;
  }

  if (used >= safeLimit) {
    dom.tmap_usage_panel.classList.add('blocked');
    dom.tmap_usage_status.textContent = `오늘 신규 거리계산을 중단했어요. · 안전한도 ${safeLimit.toLocaleString('ko-KR')}회`;
  } else if (used >= warningAt || projected > safeLimit) {
    dom.tmap_usage_panel.classList.add('warning');
    dom.tmap_usage_status.textContent = `오늘 사용량이 많아요. · 안전한도 ${safeLimit.toLocaleString('ko-KR')}회`;
  } else {
    dom.tmap_usage_panel.classList.add('normal');
    dom.tmap_usage_status.textContent = `정상 사용 가능 · 안전한도 ${safeLimit.toLocaleString('ko-KR')}회`;
  }

  if (!state.parsed) {
    dom.tmap_usage_estimate.textContent = `무료 제공량 ${officialLimit.toLocaleString('ko-KR')}회/일 · 왕복거리 1곳 = 경로조회 2회`;
  } else if (!state.workplace) {
    dom.tmap_usage_estimate.textContent = `근무지를 설정하면 이번 점검 예상 조회량을 계산해요. · 안전 여유 ${Math.max(0, safeLimit - used).toLocaleString('ko-KR')}회`;
  } else if (estimate === 0) {
    dom.tmap_usage_estimate.textContent = `새로 필요한 경로조회가 없어요. · 안전 여유 ${Math.max(0, safeLimit - used).toLocaleString('ko-KR')}회`;
  } else if (projected > safeLimit) {
    dom.tmap_usage_estimate.textContent = `이번 점검 최대 ${estimate.toLocaleString('ko-KR')}회 예상 · 실행 시 안전한도를 넘을 수 있어요.`;
  } else {
    dom.tmap_usage_estimate.textContent = `이번 점검 최대 ${estimate.toLocaleString('ko-KR')}회 예상 · 실행 후 약 ${projected.toLocaleString('ko-KR')}회`;
  }
}

function renderBatchPanel() {
  const summary = summarizeDestinations();
  dom.batch_destination_count.textContent = summary.total;
  const readiness = [];
  if (!state.workplace) readiness.push('<span class="readiness-item warning">근무지 설정 필요</span>');
  else readiness.push(`<span class="readiness-item success">근무지: ${escapeHtml(state.workplace.name)}</span>`);
  if (!state.apiConfigured) readiness.push('<span class="readiness-item warning">지도 API 연결 확인 필요</span>');
  else readiness.push('<span class="readiness-item success">지도 API 연결됨</span>');
  readiness.push(`<span class="readiness-item">위치 확인 ${summary.located}/${summary.total}곳</span>`);
  readiness.push(`<span class="readiness-item">거리 완료 ${summary.routeComplete}/${summary.total}곳</span>`);
  dom.batch_readiness.innerHTML = readiness.join('');

  const batchEstimatedCalls = estimateRouteCalls();
  dom.bulk_inspect.disabled = state.busy || !usageAllows(batchEstimatedCalls);
  dom.bulk_inspect.textContent = state.lastBatchSummary && summary.routeComplete > 0 ? '거리점검 다시 시작' : '거리점검 시작';
  dom.stop_inspect.classList.toggle('hidden', !state.busy);
  dom.stop_inspect.disabled = state.stopRequested;
  dom.stop_inspect.textContent = state.stopRequested ? '중지 중…' : '점검 중지';
  dom.batch_complete_actions.classList.toggle('hidden', state.busy || (!state.batchStarted && summary.routeComplete === 0 && summary.failed === 0));
  dom.retry_incomplete.disabled = state.busy || !state.destinations.some((item) => !item.location || item.searchStatus === 'error' || !item.route || item.routeStatus === 'error') || !usageAllows(estimateRouteCalls());
  dom.recalculate_all.disabled = state.busy || !state.workplace || !usageAllows(estimateRouteCalls({ forceRoutes: true, routeOnly: true }));
  renderTmapUsage();
}

function renderDestinationCounts() {
  const counts = { all: state.destinations.length, needs: 0, resolved: 0, within: 0, boundary: 0, failed: 0 };
  state.destinations.forEach((destination) => {
    const status = destinationStatus(destination);
    if (!destination.location && destination.searchStatus !== 'error') counts.needs += 1;
    if (destination.location) counts.resolved += 1;
    if (destination.route?.totalDistance <= 2000) counts.within += 1;
    if (status.group === 'boundary') counts.boundary += 1;
    if (status.group === 'failed') counts.failed += 1;
  });
  dom.filter_all_count.textContent = counts.all;
  dom.filter_needs_count.textContent = counts.needs;
  dom.filter_resolved_count.textContent = counts.resolved;
  dom.filter_within_count.textContent = counts.within;
  dom.filter_boundary_count.textContent = counts.boundary;
  dom.filter_failed_count.textContent = counts.failed;
}

function matchesDestinationFilter(destination) {
  const filter = state.destinationFilter;
  const status = destinationStatus(destination);
  if (filter === 'needs' && destination.location) return false;
  if (filter === 'resolved' && !destination.location) return false;
  if (filter === 'within' && !(destination.route?.totalDistance <= 2000)) return false;
  if (filter === 'boundary' && status.group !== 'boundary') return false;
  if (filter === 'failed' && status.group !== 'failed') return false;
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
    const locationAddress = destination.location?.address || (destination.ambiguous ? '정확한 장소를 직접 선택해 주세요.' : '거리점검에서 자동 검색');
    const locationBadge = destination.locationSource === 'auto'
      ? '<span class="auto-badge">자동 확인</span>'
      : destination.locationSource === 'saved'
        ? '<span class="saved-badge">저장 위치</span>'
        : '';
    const distance = destination.route ? formatDistance(destination.route.totalDistance) : '-';
    const distanceSub = destination.route ? `갈 때 ${formatDistance(destination.route.outbound?.distance)} · 올 때 ${formatDistance(destination.route.inbound?.distance)}` : '보행 왕복거리';
    const actions = [
      `<button class="row-button ${destination.location ? '' : 'primary'}" data-action="select-location" data-key="${escapeHtml(destination.key)}" type="button">${destination.location ? '위치 변경' : '장소 선택'}</button>`,
    ];
    if (destination.location && state.workplace && (!destination.route || destination.routeStatus === 'error')) {
      actions.push(`<button class="row-button primary" data-action="calculate-one" data-key="${escapeHtml(destination.key)}" type="button">${destination.routeStatus === 'error' ? '다시 계산' : '거리 계산'}</button>`);
    }
    if (destination.location) actions.push(`<button class="row-button" data-action="view-map" data-key="${escapeHtml(destination.key)}" type="button">지도 보기</button>`);

    return `
      <tr class="${status.group === 'failed' ? 'failed-row' : ''}">
        <td>
          <div class="cell-title">
            <button data-action="toggle-details" data-key="${escapeHtml(destination.key)}" type="button" aria-label="출장 상세 ${expanded ? '접기' : '펼치기'}">${expanded ? '−' : '+'}</button>
            <div>
              <strong>${escapeHtml(destination.originalName)}</strong>
              <span class="cell-sub">${destination.searchQueryChanged ? '지도 검색: ' : ''}${escapeHtml(destination.searchQuery)}</span>
              ${destination.searchQueryIndoorAdjusted ? '<span class="search-clean-note">검색할 때 층·실 정보를 제외했어요.</span>' : ''}
              ${destination.ambiguous ? '<span class="ambiguous-tag">자동 확정 안 함</span>' : ''}
            </div>
          </div>
        </td>
        <td><strong>${destination.count}</strong>건</td>
        <td><div class="place-cell"><div><strong>${escapeHtml(locationName)}</strong>${locationBadge}</div><span title="${escapeHtml(locationAddress)}">${escapeHtml(locationAddress)}</span></div></td>
        <td><div class="distance-cell"><strong>${distance}</strong><span>${distanceSub}</span></div></td>
        <td><span class="pill ${status.kind}">${escapeHtml(status.label)}</span>${destination.searchError ? `<span class="cell-sub error-copy">${escapeHtml(destination.searchError)}</span>` : ''}</td>
        <td><div class="row-actions">${actions.join('')}</div></td>
      </tr>
      ${expanded ? `<tr class="detail-row"><td colspan="6"><div class="detail-box"><span><strong>출장자</strong> ${escapeHtml(destination.travelers.join(', '))}</span><span><strong>출장일</strong> ${escapeHtml(destination.dates.join(', '))}</span></div></td></tr>` : ''}
    `;
  }).join('');

  dom.auto_search.disabled = state.busy || !state.parsed;
  dom.calculate_all.disabled = state.busy || !state.parsed || !usageAllows(estimateRouteCalls({ routeOnly: true }));
}

function allResultRows() {
  if (!state.parsed) return [];
  const destinationMap = new Map(state.destinations.map((destination) => [destination.key, destination]));
  const priority = (entry) => {
    if (entry.status.failed || entry.status.needs) return 0;
    if (entry.status.within || entry.status.boundary) return 1;
    return 2;
  };
  return state.parsed.trips.map((trip) => {
    const destination = destinationMap.get(trip.normalizedDestination);
    return { trip, destination, status: resultStatus(destination) };
  }).sort((a, b) => priority(a) - priority(b) || b.trip.startDate.localeCompare(a.trip.startDate));
}

function matchesResultFilter(entry) {
  const filter = state.resultFilter;
  if (filter === 'needs' && !(entry.status.needs || entry.status.within || entry.status.boundary || entry.status.failed)) return false;
  if (filter === 'within' && !entry.status.within) return false;
  if (filter === 'over' && !entry.status.over) return false;
  if (filter === 'boundary' && !entry.status.boundary) return false;
  if (filter === 'failed' && !entry.status.failed) return false;
  const query = canonical(state.resultQuery);
  if (query && !canonical(`${entry.trip.traveler} ${entry.trip.destination} ${entry.trip.purpose}`).includes(query)) return false;
  return true;
}

function renderResultMetrics(rows) {
  const total = rows.length;
  const within = rows.filter((row) => row.status.within).length;
  const over = rows.filter((row) => row.status.over).length;
  const needs = rows.filter((row) => row.status.needs || row.status.failed).length;
  const metrics = [
    ['총 출장', total, ''],
    ['왕복 2km 이내', within, 'emphasis'],
    ['왕복 2km 초과', over, ''],
    ['위치·거리 확인', needs, 'alert'],
  ];
  dom.result_metrics.innerHTML = metrics.map(([label, value, className]) => `
    <button class="result-metric ${className}" data-metric-filter="${label === '총 출장' ? 'all' : label === '왕복 2km 이내' ? 'within' : label === '왕복 2km 초과' ? 'over' : 'needs'}" type="button">
      <span>${label}</span><strong>${value}건</strong>
    </button>`).join('');
}

function renderResults() {
  const allRows = allResultRows();
  renderResultMetrics(allRows);
  const rows = allRows.filter(matchesResultFilter);
  dom.result_empty.classList.toggle('hidden', rows.length > 0);
  dom.result_body.innerHTML = rows.map(({ trip, destination, status }) => {
    const pillKind = status.boundary ? 'purple' : (status.within ? 'amber' : (status.over ? 'neutral' : 'coral'));
    const noteClass = status.note === '—' ? 'quiet' : '';
    return `<tr class="${status.needs || status.failed ? 'needs-row' : status.within ? 'within-row' : ''}">
      <td data-label="출장일">${escapeHtml(formatDateOnly(trip.startDate))}</td>
      <td data-label="출장자"><strong>${escapeHtml(trip.traveler)}</strong></td>
      <td data-label="출장지·목적">
        <div class="trip-summary-cell">
          <strong title="${escapeHtml(trip.destination)}">${escapeHtml(trip.destination)}</strong>
          <span title="${escapeHtml(trip.purpose)}">${escapeHtml(trip.purpose || '출장목적 없음')}</span>
        </div>
      </td>
      <td data-label="왕복거리"><strong class="result-distance">${destination?.route ? formatDistance(destination.route.totalDistance) : '-'}</strong></td>
      <td data-label="2km 판정">${!destination?.location
        ? `<button class="pill pill-action ${pillKind}" data-action="resolve-location" data-key="${escapeHtml(destination?.key || trip.normalizedDestination)}" type="button" title="장소 선택 열기">${escapeHtml(status.displayLabel)}</button>`
        : `<span class="pill ${pillKind}">${escapeHtml(status.displayLabel)}</span>`}</td>
      <td data-label="확인사항">
        <div class="check-cell ${noteClass}">
          <span>${escapeHtml(status.note)}</span>
          <button class="copy-button" data-action="copy-result" data-trip-id="${escapeHtml(trip.id)}" type="button" aria-label="결과 복사" title="결과 복사">⧉</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  dom.export_results.disabled = !state.parsed;
}

function renderAll() {
  expireStaleTmapData();
  renderWorkplace();
  if (!state.parsed) return;
  dom.analysis_section.classList.remove('hidden');
  dom.file_name.textContent = state.fileName;
  dom.file_detail.textContent = `${state.parsed.sheetNames.join(', ')} · 분석 완료`;
  dom.metric_trips.textContent = state.parsed.summary.tripCount;
  dom.metric_travelers.textContent = state.parsed.summary.travelerCount;
  dom.metric_destinations.textContent = state.parsed.summary.destinationCount;
  renderBatchPanel();
  renderDestinations();
  renderResults();
  const hasCompleted = state.destinations.some((destination) => destination.routeStatus === 'complete');
  if (state.busy) setStep(3);
  else if (hasCompleted || state.lastBatchSummary) setStep(4);
  else if (state.workplace) setStep(3);
  else setStep(2);
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
    state.batchStarted = false;
    state.lastBatchSummary = null;
    state.expanded.clear();
    initializeDestinations(parsed);
    setProgress({ visible: false });
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
  if (state.parsed) renderBatchPanel();
  return state.apiConfigured;
}

function getDestination(key) {
  return state.destinations.find((destination) => destination.key === key);
}

function saveDestinationLocation(destination, location, source = 'manual') {
  destination.lastCheckedAt = new Date().toISOString();
  const storedLocation = { ...location, savedAt: destination.lastCheckedAt };
  destination.location = storedLocation;
  destination.locationSource = source;
  destination.locationStatus = 'resolved';
  destination.searchStatus = 'resolved';
  destination.route = null;
  destination.routeStatus = 'pending';
  destination.searchError = '';
  state.destinationMemory[destination.key] = {
    location: storedLocation,
    source,
    originalName: destination.originalName,
    savedAt: destination.lastCheckedAt,
  };
  saveDestinationMemory(state.destinationMemory);
  const key = routeCacheKey(state.workplace, location);
  const cached = getFreshRouteCache(key);
  if (cached) {
    destination.route = cached;
    destination.routeStatus = 'complete';
  }
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

function confidenceCandidate(destination, candidates) {
  if (!candidates.length) return null;
  if (destination.extractedAddress) {
    const geocodes = candidates.filter((candidate) => candidate.source === 'geocode');
    if (geocodes.length === 1) return geocodes[0];
    if (candidates.length === 1) return candidates[0];
    return null;
  }

  const target = canonical(destination.searchQuery || destination.originalName);

  // 띄어쓰기·기호를 제외한 장소명이 정확히 일치하는 결과가 하나뿐이면
  // 주변의 주차장·지점 같은 유사 POI가 함께 검색되어도 본 장소를 자동 확정한다.
  // 지역 표기(예: 서울특별시 ↔ 서울)가 달라 정확한 장소를 놓치는 문제도 피한다.
  const exactByName = candidates.filter((candidate) => canonical(candidate.name) === target);
  if (exactByName.length === 1) return exactByName[0];
  if (exactByName.length > 1) {
    const exactSameRegion = exactByName.filter((candidate) => sameRegion(candidate, state.workplace));
    if (exactSameRegion.length === 1) return exactSameRegion[0];
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

function validateInspectionPrerequisites() {
  if (!state.parsed) {
    showToast('에듀파인 관내여비 파일을 먼저 가져와 주세요.', 'error');
    return false;
  }
  if (!state.workplace) {
    showToast('근무지를 먼저 설정해 주세요.', 'error');
    openLocationModal('workplace');
    return false;
  }
  if (!state.apiConfigured) {
    showToast('지도 API 연결을 확인해 주세요.', 'error');
    checkApi();
    return false;
  }
  return true;
}

async function ensureUsageCapacity(calls) {
  const requested = Math.max(0, Number(calls) || 0);
  if (requested === 0) return true;

  const usage = await refreshTmapUsage({ silent: true });
  if (usage.error || usage.configured !== true) {
    showToast('TMAP 사용량을 확인할 수 없어 거리 계산을 시작하지 않았어요.', 'error');
    return false;
  }

  const projected = (Number(usage.used) || 0) + requested;
  const safeLimit = Number(usage.safeLimit) || 900;
  if (projected > safeLimit) {
    showToast(`이번 점검은 최대 ${requested.toLocaleString('ko-KR')}회가 필요해 안전한도 ${safeLimit.toLocaleString('ko-KR')}회를 넘을 수 있어요.`, 'error');
    return false;
  }
  return true;
}

async function searchDestination(destination) {
  if (destination.ambiguous) {
    destination.searchStatus = 'needs';
    destination.searchError = '모호한 장소라 자동 확정하지 않았어요.';
    return false;
  }
  destination.searchStatus = 'searching';
  destination.searchError = '';
  try {
    const data = await searchPlaces(destination.searchQuery);
    const candidates = data.candidates || [];
    const candidate = confidenceCandidate(destination, candidates);
    if (candidate) {
      saveDestinationLocation(destination, candidate, 'auto');
      return true;
    }
    destination.searchStatus = 'needs';
    destination.searchError = candidates.length ? '검색 결과를 직접 선택해 주세요.' : '검색 결과가 없어요.';
    return false;
  } catch (error) {
    destination.searchStatus = 'error';
    destination.searchError = error.code === 'TMAP_APP_KEY_NOT_CONFIGURED'
      ? '지도 API 키가 필요해요.'
      : error.code === 'TMAP_AUTH_FAILED'
        ? 'TMAP 상품 사용 설정을 확인해 주세요.'
        : (error.message || '자동 검색에 실패했어요.');
    return false;
  }
}

async function calculateDestination(destination, { force = false } = {}) {
  if (!state.workplace || !destination.location) return false;
  const key = routeCacheKey(state.workplace, destination.location);
  const cached = getFreshRouteCache(key);
  if (!force && cached) {
    destination.route = cached;
    destination.routeStatus = 'complete';
    destination.searchError = '';
    return true;
  }

  destination.routeStatus = 'calculating';
  try {
    const response = await calculateRoundTrip(
      { ...state.workplace, name: state.workplace.name || '근무지' },
      { ...destination.location, name: destination.location.name || destination.originalName },
    );
    if (response.usage) applyUsageSnapshot(response.usage);
    const route = compactRoute(response);
    delete route.usage;
    if (!Number.isFinite(route.outbound?.distance) || !Number.isFinite(route.inbound?.distance)) {
      throw new Error('가는 길과 오는 길을 모두 확인하지 못했어요.');
    }
    destination.route = route;
    destination.routeStatus = 'complete';
    destination.searchError = '';
    state.routeCache[key] = { ...route, cachedAt: new Date().toISOString() };
    saveRouteCache(state.routeCache);
    renderTmapUsage();
    return true;
  } catch (error) {
    if (error.usage) applyUsageSnapshot(error.usage);
    if (error.code === 'TMAP_DAILY_SAFE_LIMIT_REACHED' || String(error.code || '').startsWith('TMAP_USAGE_STORAGE_')) {
      state.stopRequested = true;
    }
    destination.route = null;
    destination.routeStatus = 'error';
    destination.searchError = error.code === 'TMAP_APP_KEY_NOT_CONFIGURED'
      ? '지도 API 키가 필요해요.'
      : error.code === 'TMAP_AUTH_FAILED'
        ? 'TMAP 상품 사용 설정을 확인해 주세요.'
        : error.code === 'TMAP_DAILY_SAFE_LIMIT_REACHED'
          ? '오늘 거리조회 안전한도에 도달했어요.'
          : String(error.code || '').startsWith('TMAP_USAGE_STORAGE_')
            ? 'TMAP 사용량 보호 연결을 확인해 주세요.'
            : (error.message || '거리 계산에 실패했어요.');
    renderTmapUsage();
    return false;
  }
}

function inspectionSubcounts(searchDone, searchTotal, routeDone, routeTotal) {
  return `출장지 위치 확인 ${searchDone}/${searchTotal}곳 · 왕복거리 계산 ${routeDone}/${routeTotal}곳`;
}

async function runInspection({ searchOnly = false, routeOnly = false, forceRoutes = false } = {}) {
  if (state.busy || !validateInspectionPrerequisites()) return;
  if (!searchOnly) {
    const estimatedCalls = estimateRouteCalls({ forceRoutes, routeOnly });
    if (!(await ensureUsageCapacity(estimatedCalls))) return;
  }

  state.busy = true;
  state.stopRequested = false;
  state.batchStarted = true;
  let searchDone = 0;
  let searchResolved = 0;
  let routeDone = 0;
  let routeSuccess = 0;

  const searchTargets = routeOnly ? [] : state.destinations.filter((destination) => !destination.location);
  let routeTargets = [];
  const initialTotal = Math.max(1, searchTargets.length);
  setProgress({
    visible: true,
    title: searchTargets.length ? '출장지 위치를 확인하고 있어요' : '왕복거리 계산을 준비하고 있어요',
    current: 0,
    total: initialTotal,
    detail: '',
    subcounts: inspectionSubcounts(0, searchTargets.length, 0, 0),
  });
  renderAll();

  for (const destination of searchTargets) {
    if (state.stopRequested) break;
    setProgress({
      visible: true,
      title: '출장지 위치를 확인하고 있어요',
      current: searchDone,
      total: Math.max(1, searchTargets.length),
      detail: destination.originalName,
      subcounts: inspectionSubcounts(searchDone, searchTargets.length, routeDone, 0),
    });
    const resolved = await searchDestination(destination);
    searchDone += 1;
    if (resolved) searchResolved += 1;
    setProgress({
      visible: true,
      title: '출장지 위치를 확인하고 있어요',
      current: searchDone,
      total: Math.max(1, searchTargets.length),
      detail: destination.originalName,
      subcounts: inspectionSubcounts(searchDone, searchTargets.length, routeDone, 0),
    });
    renderDestinations();
    renderBatchPanel();
    await delay(120);
  }

  if (!state.stopRequested && !searchOnly) {
    routeTargets = state.destinations.filter((destination) => destination.location && (forceRoutes || !destination.route || destination.routeStatus === 'error'));
    for (const destination of routeTargets) {
      if (state.stopRequested) break;
      setProgress({
        visible: true,
        title: '보행 왕복거리를 계산하고 있어요',
        current: routeDone,
        total: Math.max(1, routeTargets.length),
        detail: destination.originalName,
        subcounts: inspectionSubcounts(searchDone, searchTargets.length, routeDone, routeTargets.length),
      });
      const success = await calculateDestination(destination, { force: forceRoutes });
      routeDone += 1;
      if (success) routeSuccess += 1;
      setProgress({
        visible: true,
        title: '보행 왕복거리를 계산하고 있어요',
        current: routeDone,
        total: Math.max(1, routeTargets.length),
        detail: destination.originalName,
        subcounts: inspectionSubcounts(searchDone, searchTargets.length, routeDone, routeTargets.length),
      });
      renderAll();
      await delay(140);
    }
  }

  state.busy = false;
  const stopped = state.stopRequested;
  state.stopRequested = false;
  const summary = summarizeDestinations();
  state.lastBatchSummary = {
    stopped,
    searchDone,
    searchResolved,
    routeDone,
    routeSuccess,
    completedAt: new Date().toISOString(),
  };

  if (stopped) {
    setProgress({
      visible: true,
      title: '거리점검을 중지했어요',
      current: searchDone + routeDone,
      total: Math.max(1, searchTargets.length + routeTargets.length),
      detail: `완료된 위치 ${searchDone}곳과 거리 ${routeDone}곳의 결과는 유지됩니다.`,
      subcounts: inspectionSubcounts(searchDone, searchTargets.length, routeDone, routeTargets.length),
      stopped: true,
    });
    showToast('거리점검을 중지했어요. 완료된 결과는 유지됩니다.');
  } else {
    setProgress({
      visible: true,
      title: searchOnly ? '출장지 위치 확인을 마쳤어요' : '거리점검이 완료됐어요',
      current: searchTargets.length + routeTargets.length,
      total: Math.max(1, searchTargets.length + routeTargets.length),
      detail: `거리 완료 ${summary.routeComplete}곳 · 위치 확인 필요 ${summary.unresolved}곳 · 실패 ${summary.failed}곳`,
      subcounts: inspectionSubcounts(searchDone, searchTargets.length, routeDone, routeTargets.length),
    });
    showToast(searchOnly
      ? `${searchResolved}곳의 위치를 자동 확인했어요.`
      : `${routeSuccess}곳의 왕복거리 계산을 마쳤어요.`);
  }
  renderAll();
  if (!searchOnly && (routeDone > 0 || summary.routeComplete > 0)) {
    dom.result_section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function autoSearchDestinations() {
  runInspection({ searchOnly: true });
}

function calculateAllDestinations() {
  runInspection({ routeOnly: true });
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
  dom.candidate_empty.innerHTML = '<strong>장소를 검색해 주세요.</strong><span>예: 대청중학교 또는 정확한 도로명주소</span>';
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
    const help = document.querySelector('.modal-help');
    if (help) {
      help.textContent = destination.searchQueryIndoorAdjusted
        ? `원본 출장지: ${destination.originalName} · 검색할 때 층·실 정보를 제외했어요.`
        : '검색 결과를 선택하거나 지도에서 실제 출입구를 눌러 위치를 조정할 수 있어요.';
    }
  }

  if (mode === 'workplace') {
    const help = document.querySelector('.modal-help');
    if (help) help.textContent = '검색 결과를 선택하거나 지도에서 실제 출입구를 눌러 위치를 조정할 수 있어요.';
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
  if (value.length < 2) {
    dom.candidate_empty.innerHTML = '<strong>두 글자 이상 입력해 주세요.</strong><span>학교명 전체 또는 도로명주소로 검색하면 더 정확해요.</span>';
    dom.candidate_empty.classList.remove('hidden');
    return;
  }
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
    state.workplace = { ...location, savedAt: new Date().toISOString() };
    saveWorkplace(state.workplace);
    invalidateRoutes();
    showToast('근무지를 저장했어요. 이제 거리점검을 시작할 수 있어요.');
  } else {
    const destination = getDestination(state.modal.key);
    if (destination) {
      saveDestinationLocation(destination, location, 'manual');
      showToast(`${destination.originalName} 위치를 확정했어요. ${destination.count}건에 함께 적용됩니다.`);
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
  state.batchStarted = false;
  state.lastBatchSummary = null;
  state.stopRequested = false;
  dom.file_input.value = '';
  dom.analysis_section.classList.add('hidden');
  showUploadError('');
  setProgress({ visible: false });
  setStep(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openHelpModal(section = '') {
  dom.help_modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const targetId = section === 'privacy' ? 'help-privacy' : (section === 'file' ? 'help-file' : '');
  window.setTimeout(() => {
    const target = targetId ? document.getElementById(targetId) : dom.help_modal.querySelector('.help-content');
    target?.scrollIntoView({ block: 'start' });
  }, 20);
}

function closeHelpModal() {
  dom.help_modal.classList.add('hidden');
  if (dom.location_modal.classList.contains('hidden')) document.body.style.overflow = '';
}

function clearStoredBrowserData() {
  clearAllStorage();
  state.workplace = null;
  state.destinationMemory = {};
  state.routeCache = {};
  state.destinations.forEach((destination) => {
    destination.location = null;
    destination.locationSource = null;
    destination.locationStatus = 'needs';
    destination.searchStatus = 'pending';
    destination.route = null;
    destination.routeStatus = 'pending';
    destination.searchError = '';
  });
  renderAll();
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

  dom.help_button.addEventListener('click', () => openHelpModal());
  document.querySelectorAll('[data-open-help]').forEach((button) => {
    button.addEventListener('click', () => openHelpModal(button.dataset.openHelp || ''));
  });
  dom.privacy_details.addEventListener('click', () => openHelpModal('privacy'));
  dom.reset_all.addEventListener('click', resetCurrent);
  [dom.set_workplace, dom.change_workplace].forEach((button) => button.addEventListener('click', () => openLocationModal('workplace')));
  dom.view_workplace.addEventListener('click', () => openLocationModal('workplace'));
  [dom.clear_all_storage, dom.clear_all_storage_upload].forEach((button) => button.addEventListener('click', () => {
    if (!window.confirm('이 브라우저에 저장된 근무지와 출장지 위치정보를 모두 삭제할까요?')) return;
    clearStoredBrowserData();
    showToast('저장된 정보를 삭제했어요.');
  }));
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
      destination.locationSource = null;
      destination.locationStatus = 'needs';
      destination.searchStatus = 'pending';
      destination.route = null;
      destination.routeStatus = 'pending';
      destination.searchError = '';
    });
    renderAll();
    showToast('저장된 출장지 정보를 초기화했어요.');
  });

  dom.bulk_inspect.addEventListener('click', () => runInspection());
  dom.stop_inspect.addEventListener('click', () => {
    if (!state.busy) return;
    state.stopRequested = true;
    dom.stop_inspect.disabled = true;
    dom.stop_inspect.textContent = '중지 중…';
  });
  dom.retry_incomplete.addEventListener('click', () => runInspection());
  dom.recalculate_all.addEventListener('click', () => {
    if (!window.confirm('저장된 거리 결과를 무시하고 위치가 확인된 출장지를 모두 다시 계산할까요?')) return;
    runInspection({ forceRoutes: true });
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
      if (!validateInspectionPrerequisites()) return;
      if (!(await ensureUsageCapacity(2))) return;
      state.busy = true;
      renderAll();
      const ok = await calculateDestination(destination, { force: destination.routeStatus === 'error' });
      state.busy = false;
      renderAll();
      showToast(ok ? '왕복거리를 계산했어요.' : '거리 계산에 실패했어요.', ok ? 'success' : 'error');
    }
  });

  dom.result_filters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.resultFilter = button.dataset.filter;
    dom.result_filters.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
    renderResults();
  });
  dom.result_metrics.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-metric-filter]');
    if (!button) return;
    state.resultFilter = button.dataset.metricFilter;
    dom.result_filters.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item.dataset.filter === state.resultFilter));
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
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'copy-result') {
      copyTripResult(button.dataset.tripId);
      return;
    }
    if (button.dataset.action === 'resolve-location') {
      const key = button.dataset.key;
      if (getDestination(key)) openLocationModal('destination', key);
    }
  });
  dom.export_results.addEventListener('click', () => {
    if (!state.parsed) return;
    exportResults({ XLSX, trips: state.parsed.trips, destinations: state.destinations, workplace: state.workplace });
    showToast('거리점검 결과 엑셀을 만들었어요.');
  });

  dom.close_help.addEventListener('click', closeHelpModal);
  dom.help_modal.addEventListener('click', (event) => {
    if (event.target === dom.help_modal) closeHelpModal();
  });
  dom.close_modal.addEventListener('click', closeLocationModal);
  dom.location_modal.addEventListener('click', (event) => {
    if (event.target === dom.location_modal) closeLocationModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!dom.help_modal.classList.contains('hidden')) closeHelpModal();
    else if (!dom.location_modal.classList.contains('hidden')) closeLocationModal();
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
refreshTmapUsage();
window.setInterval(() => {
  if (!state.busy && expireStaleTmapData()) renderAll();
}, 5 * 60 * 1000);
