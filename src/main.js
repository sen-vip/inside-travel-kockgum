import * as XLSX from 'xlsx';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { parseEdufineWorkbook } from './parser.js';
import { calculateRoundTrip, getApiHealth, searchPlaces } from './api.js';
import {
  clearDestinationStorage,
  clearReviewStorage,
  loadDestinationMemory,
  loadReviewMemory,
  loadRouteCache,
  loadWorkplace,
  saveDestinationMemory,
  saveReviewMemory,
  saveRouteCache,
  saveWorkplace,
} from './storage.js';
import { exportResults, statusFor } from './exporter.js';
import { buildReviewGroups, formatDuration, TRANSPORT_OPTIONS, transportLabel } from './review.js';

const dom = Object.fromEntries([
  'api-status', 'reset-all', 'drop-zone', 'file-input', 'upload-error', 'analysis-section',
  'file-name', 'file-detail', 'metric-trips', 'metric-travelers', 'metric-destinations',
  'set-workplace', 'workplace-empty', 'workplace-card', 'workplace-name', 'workplace-address',
  'view-workplace', 'change-workplace', 'clear-workplace-storage', 'clear-destination-storage',
  'batch-destination-count', 'bulk-inspect', 'stop-inspect', 'batch-readiness',
  'batch-complete-actions', 'retry-incomplete', 'recalculate-all',
  'auto-search', 'calculate-all', 'progress-panel', 'progress-title', 'progress-count',
  'progress-bar', 'progress-detail', 'progress-subcounts', 'destination-filters',
  'destination-search', 'destination-body', 'destination-empty', 'filter-all-count',
  'filter-needs-count', 'filter-resolved-count', 'filter-within-count', 'filter-boundary-count',
  'filter-failed-count', 'result-section', 'export-results', 'result-metrics', 'show-needs-only',
  'result-filters', 'result-search', 'paid-only', 'unpaid-empty-only', 'result-body', 'result-empty',
  'clear-review-storage', 'review-metrics', 'review-filters', 'review-search',
  'review-list-title', 'review-list-count', 'review-list', 'review-empty',
  'review-detail', 'review-detail-empty', 'review-detail-content',
  'location-modal', 'modal-kicker', 'modal-title', 'close-modal', 'place-search-form',
  'place-search-input', 'candidate-loading', 'candidate-list', 'candidate-empty',
  'pending-location', 'pending-name', 'pending-address', 'confirm-location', 'toast',
].map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]));

const state = {
  parsed: null,
  fileName: '',
  workplace: loadWorkplace(),
  destinationMemory: loadDestinationMemory(),
  routeCache: loadRouteCache(),
  reviewMemory: loadReviewMemory(),
  destinations: [],
  destinationFilter: 'all',
  destinationQuery: '',
  resultFilter: 'all',
  resultQuery: '',
  reviewFilter: 'pending',
  reviewQuery: '',
  selectedReviewKey: null,
  paidOnly: false,
  unpaidEmptyOnly: false,
  expanded: new Set(),
  busy: false,
  stopRequested: false,
  apiConfigured: false,
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

function resultStatus(destination, trip = null) {
  const base = statusFor(destination || {});
  const total = destination?.route?.totalDistance;
  const within = Number.isFinite(total) && total <= 2000;
  const over = Number.isFinite(total) && total > 2000;
  const boundary = Number.isFinite(total) && total >= 1900 && total <= 2100;
  const failed = destination?.searchStatus === 'error' || destination?.routeStatus === 'error';
  const needs = !destination?.location || failed || !destination?.route;
  const paid = Number(trip?.paymentAmount || trip?.travelAmount || 0) > 0;
  const paymentReview = within && paid;
  return {
    ...base,
    total,
    within,
    over,
    boundary,
    failed,
    needs,
    paid,
    paymentReview,
    note: paymentReview ? '지급내역 확인 필요 · 실제 교통비 발생 여부 확인' : base.note,
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

  dom.bulk_inspect.disabled = state.busy;
  dom.bulk_inspect.textContent = state.lastBatchSummary && summary.routeComplete > 0 ? '일괄검사 다시 시작' : '일괄검사 시작';
  dom.stop_inspect.classList.toggle('hidden', !state.busy);
  dom.stop_inspect.disabled = state.stopRequested;
  dom.stop_inspect.textContent = state.stopRequested ? '중지 중…' : '검사 중지';
  dom.batch_complete_actions.classList.toggle('hidden', state.busy || (!state.batchStarted && summary.routeComplete === 0 && summary.failed === 0));
  dom.retry_incomplete.disabled = state.busy || !state.destinations.some((item) => !item.location || item.searchStatus === 'error' || !item.route || item.routeStatus === 'error');
  dom.recalculate_all.disabled = state.busy || !state.workplace;
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
    const locationAddress = destination.location?.address || (destination.ambiguous ? '정확한 장소를 직접 선택해 주세요.' : '일괄검사에서 자동 검색');
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
            <div><strong>${escapeHtml(destination.originalName)}</strong><span class="cell-sub">${escapeHtml(destination.searchQuery)}</span>${destination.ambiguous ? '<span class="ambiguous-tag">자동 확정 안 함</span>' : ''}</div>
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
  dom.calculate_all.disabled = state.busy || !state.parsed;
}

function allResultRows() {
  if (!state.parsed) return [];
  const destinationMap = new Map(state.destinations.map((destination) => [destination.key, destination]));
  const priority = (entry) => {
    if (entry.status.failed || !entry.destination?.location) return 0;
    if (entry.status.paymentReview) return 1;
    if (entry.status.within) return entry.status.boundary ? 2 : 3;
    if (entry.status.boundary) return 4;
    if (entry.status.needs) return 5;
    return 6;
  };
  return state.parsed.trips.map((trip) => {
    const destination = destinationMap.get(trip.normalizedDestination);
    return { trip, destination, status: resultStatus(destination, trip) };
  }).sort((a, b) => priority(a) - priority(b) || b.trip.startDate.localeCompare(a.trip.startDate));
}

function matchesResultFilter(entry) {
  const filter = state.resultFilter;
  if (filter === 'needs' && !(entry.status.needs || entry.status.within || entry.status.paymentReview)) return false;
  if (filter === 'within' && !entry.status.within) return false;
  if (filter === 'over' && !entry.status.over) return false;
  if (filter === 'boundary' && !entry.status.boundary) return false;
  if (filter === 'failed' && !entry.status.failed) return false;
  if (state.paidOnly && !entry.status.paid) return false;
  if (state.unpaidEmptyOnly && String(entry.trip.unpaid || '').trim()) return false;
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
  const paymentReview = rows.filter((row) => row.status.paymentReview).length;
  dom.result_metrics.innerHTML = [
    ['총 출장', total, ''],
    ['왕복 2km 이내', within, 'emphasis'],
    ['왕복 2km 초과', over, ''],
    ['경계 구간', boundary, ''],
    ['위치·거리 확인', needs, 'alert'],
    ['지급내역 확인', paymentReview, 'review'],
  ].map(([label, value, className]) => `<div class="result-metric ${className}"><span>${label}</span><strong>${value}건</strong></div>`).join('');
}

function renderResults() {
  const allRows = allResultRows();
  renderResultMetrics(allRows);
  const rows = allRows.filter(matchesResultFilter);
  dom.result_empty.classList.toggle('hidden', rows.length > 0);
  dom.result_body.innerHTML = rows.map(({ trip, destination, status }) => {
    const pillKind = status.boundary ? 'purple' : (status.within ? 'amber' : (status.over ? 'blue' : 'coral'));
    const paidValue = Number(trip.paymentAmount || trip.travelAmount || 0);
    return `<tr class="${status.paymentReview ? 'review-row' : ''}">
      <td>${escapeHtml(formatDateOnly(trip.startDate))}</td>
      <td><strong>${escapeHtml(trip.traveler)}</strong></td>
      <td><div class="ellipsis" title="${escapeHtml(trip.destination)}">${escapeHtml(trip.destination)}</div></td>
      <td><div class="ellipsis purpose" title="${escapeHtml(trip.purpose)}">${escapeHtml(trip.purpose)}</div></td>
      <td><strong>${destination?.route ? formatDistance(destination.route.totalDistance) : '-'}</strong></td>
      <td><span class="pill ${pillKind}">${escapeHtml(status.label)}</span></td>
      <td><div class="payment-cell"><strong>${formatMoney(paidValue)}</strong>${trip.unpaid ? `<span>부지급: ${escapeHtml(trip.unpaid)}</span>` : ''}</div></td>
      <td>${status.paymentReview ? '<span class="review-label">지급내역 확인 필요</span>' : ''}<span>${escapeHtml(status.note)}</span></td>
      <td><button class="copy-button" data-action="copy-result" data-trip-id="${escapeHtml(trip.id)}" type="button" aria-label="결과 복사">⧉</button></td>
    </tr>`;
  }).join('');
  dom.export_results.disabled = !state.parsed;
}

function getReviewGroups() {
  if (!state.parsed) return [];
  return buildReviewGroups({
    trips: state.parsed.trips,
    destinations: state.destinations,
    reviewMemory: state.reviewMemory,
  });
}

function reviewStatusMeta(status) {
  return {
    pending: { label: '확인 필요', kind: 'amber' },
    hold: { label: '보류', kind: 'coral' },
    complete: { label: '검토 완료', kind: 'green' },
    clear: { label: '일반', kind: 'slate' },
  }[status] || { label: '확인 필요', kind: 'amber' };
}

function reviewFilterLabel(filter) {
  return { pending: '확인 필요', hold: '보류', complete: '검토 완료', clear: '일반', all: '전체' }[filter] || '확인 필요';
}

function formatReviewDate(value) {
  const [year, month, day] = String(value || '').split('-');
  return year && month && day ? `${Number(month)}월 ${Number(day)}일` : value;
}

function timeRange(trip) {
  const start = String(trip.startDate || '').slice(11, 16);
  const end = String(trip.endDate || '').slice(11, 16);
  return start && end ? `${start}~${end}` : '-';
}

function updateReviewMemory(groupKey, patch = {}) {
  const group = getReviewGroups().find((item) => item.key === groupKey);
  if (!group) return;
  const current = state.reviewMemory[groupKey] || {};
  state.reviewMemory[groupKey] = {
    ...current,
    signature: group.signature,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveReviewMemory(state.reviewMemory);
}

function setTransport(groupKey, tripId, value) {
  const current = state.reviewMemory[groupKey] || {};
  updateReviewMemory(groupKey, {
    status: current.status === 'complete' ? 'pending' : current.status,
    transports: { ...(current.transports || {}), [tripId]: value },
  });
}

function reopenReviewGroups(groupKeys) {
  let changed = false;
  groupKeys.forEach((key) => {
    const current = state.reviewMemory[key];
    if (!current || current.status !== 'complete') return;
    state.reviewMemory[key] = { ...current, status: 'pending', updatedAt: new Date().toISOString() };
    changed = true;
  });
  if (changed) saveReviewMemory(state.reviewMemory);
}

function reopenAllReviews() {
  reopenReviewGroups(new Set(getReviewGroups().map((group) => group.key)));
}

function reopenReviewsForDestination(destinationKey) {
  if (!state.parsed) return;
  const keys = new Set(state.parsed.trips
    .filter((trip) => trip.normalizedDestination === destinationKey)
    .map((trip) => `${String(trip.startDate || '').slice(0, 10)}|${trip.traveler}`));
  reopenReviewGroups(keys);
}

function matchesReviewFilter(group) {
  if (state.reviewFilter !== 'all' && group.status !== state.reviewFilter) return false;
  const query = canonical(state.reviewQuery);
  if (!query) return true;
  const haystack = [
    group.traveler,
    group.date,
    ...group.trips.flatMap((entry) => [entry.trip.destination, entry.trip.purpose]),
  ].join(' ');
  return canonical(haystack).includes(query);
}

function renderReviewMetrics(groups) {
  const counts = {
    all: groups.length,
    pending: groups.filter((group) => group.status === 'pending').length,
    complete: groups.filter((group) => group.status === 'complete').length,
    hold: groups.filter((group) => group.status === 'hold').length,
    clear: groups.filter((group) => group.status === 'clear').length,
  };
  dom.review_metrics.innerHTML = [
    ['all', '전체 묶음', counts.all, ''],
    ['pending', '확인 필요', counts.pending, 'attention'],
    ['complete', '검토 완료', counts.complete, 'complete'],
    ['hold', '보류', counts.hold, 'hold'],
  ].map(([filter, label, value, kind]) => `
    <button class="review-metric ${kind} ${state.reviewFilter === filter ? 'active' : ''}" data-review-filter="${filter}" type="button">
      <span>${label}</span><strong>${value}</strong><small>묶음</small>
    </button>
  `).join('');
}

function renderReviewList(groups) {
  const rows = groups.filter(matchesReviewFilter);
  if (!rows.some((group) => group.key === state.selectedReviewKey)) {
    state.selectedReviewKey = rows[0]?.key || null;
  }
  dom.review_list_title.textContent = reviewFilterLabel(state.reviewFilter);
  dom.review_list_count.textContent = `${rows.length}묶음`;
  dom.review_empty.classList.toggle('hidden', rows.length > 0);
  dom.review_list.innerHTML = rows.map((group) => {
    const status = reviewStatusMeta(group.status);
    const active = group.key === state.selectedReviewKey;
    const issueTags = group.issues.slice(0, 3).map((issue) => `<span>${escapeHtml(issue)}</span>`).join('');
    const extra = group.issues.length > 3 ? `<span>+${group.issues.length - 3}</span>` : '';
    return `
      <button class="review-list-item ${active ? 'active' : ''} ${group.status}" data-action="select-review" data-group-key="${escapeHtml(group.key)}" type="button">
        <div class="review-list-top">
          <div><strong>${escapeHtml(group.traveler)}</strong><span>${escapeHtml(formatReviewDate(group.date))}</span></div>
          <span class="review-status ${status.kind}">${status.label}</span>
        </div>
        <div class="review-list-summary">
          <span>출장 ${group.trips.length}건</span><span>${formatDuration(group.totalDuration)}</span><span>${formatMoney(group.paidTotal)}</span>
        </div>
        <div class="review-issue-tags">${issueTags}${extra || (!group.issues.length ? '<span class="quiet">특이사항 없음</span>' : '')}</div>
      </button>
    `;
  }).join('');
}

function reviewTripCard(group, entry, index) {
  const { trip, destination, review } = entry;
  const statusKind = review.boundary ? 'purple' : review.within ? 'amber' : review.routeReady ? 'blue' : 'coral';
  const distanceLabel = review.routeReady ? formatDistance(review.distance) : '거리 미확인';
  const transportButtons = TRANSPORT_OPTIONS.map((option) => `
    <button class="transport-option ${review.transport === option.value ? 'active' : ''}" data-action="transport" data-group-key="${escapeHtml(group.key)}" data-trip-id="${escapeHtml(trip.id)}" data-value="${option.value}" type="button">${option.label}</button>
  `).join('');
  return `
    <article class="review-trip-card">
      <div class="review-trip-head">
        <div><span class="trip-order">${index + 1}</span><strong>${escapeHtml(timeRange(trip))}</strong><small>${formatDuration(review.duration)}</small></div>
        <span class="pill ${statusKind}">${escapeHtml(distanceLabel)}</span>
      </div>
      <div class="review-trip-place">
        <strong title="${escapeHtml(trip.destination)}">${escapeHtml(trip.destination)}</strong>
        <span title="${escapeHtml(trip.purpose)}">${escapeHtml(trip.purpose || '출장목적 없음')}</span>
      </div>
      <dl class="review-trip-facts">
        <div><dt>확인된 장소</dt><dd>${escapeHtml(destination?.location?.name || '위치 확인 필요')}</dd></div>
        <div><dt>기존 지급</dt><dd>${formatMoney(review.paid)}${trip.unpaid ? ` · 부지급 ${escapeHtml(trip.unpaid)}` : ''}</dd></div>
      </dl>
      <div class="transport-block">
        <div class="transport-label"><strong>실제 이동수단</strong><span>${review.within ? '2km 이내 검토에 필요해요' : '필요할 때 입력하세요'}</span></div>
        <div class="transport-options">${transportButtons}</div>
      </div>
      <div class="review-recommendation ${review.routeReady ? '' : 'warning'}">
        <strong>${escapeHtml(review.headline)}</strong><span>${escapeHtml(review.note)}</span>
      </div>
      ${(!review.routeReady || review.boundary) ? `<button class="inline-location-button" data-action="review-location" data-destination-key="${escapeHtml(trip.normalizedDestination)}" type="button">${review.routeReady ? '출입구 위치 확인' : '출장지 위치 확인'}</button>` : ''}
    </article>
  `;
}

function renderReviewDetail(groups) {
  const group = groups.find((item) => item.key === state.selectedReviewKey);
  dom.review_detail_empty.classList.toggle('hidden', Boolean(group));
  dom.review_detail_content.classList.toggle('hidden', !group);
  if (!group) {
    dom.review_detail_content.innerHTML = '';
    return;
  }
  const status = reviewStatusMeta(group.status);
  const issueTags = group.issues.map((issue) => `<span>${escapeHtml(issue)}</span>`).join('');
  const sameDayNotice = group.trips.length > 1 ? `
    <div class="same-day-notice"><strong>당일 합산 검토</strong><span>같은 날짜에 출장 ${group.trips.length}건이 있습니다. 각 건과 당일 전체 지급내역을 함께 확인해 주세요.</span></div>
  ` : '';
  const canComplete = group.unresolvedCount === 0 && group.transportMissingCount === 0;
  dom.review_detail_content.innerHTML = `
    <div class="review-detail-header">
      <div><p>${escapeHtml(formatReviewDate(group.date))}</p><h3>${escapeHtml(group.traveler)}</h3><span>출장 ${group.trips.length}건 · 총 ${formatDuration(group.totalDuration)} · 기존 지급 ${formatMoney(group.paidTotal)}</span></div>
      <span class="review-status large ${status.kind}">${status.label}</span>
    </div>
    <div class="review-detail-issues">${issueTags || '<span class="quiet">자동 확인 특이사항 없음</span>'}</div>
    ${sameDayNotice}
    <div class="review-trip-stack">${group.trips.map((entry, index) => reviewTripCard(group, entry, index)).join('')}</div>
    <label class="review-note-field">
      <span>검토 메모</span>
      <textarea data-action="review-note" data-group-key="${escapeHtml(group.key)}" rows="3" placeholder="확인한 내용이나 보류 사유를 적어두세요.">${escapeHtml(group.note)}</textarea>
    </label>
    <div class="review-detail-actions">
      ${group.status === 'complete' || group.status === 'hold' ? `<button class="button ghost" data-action="reopen-review" data-group-key="${escapeHtml(group.key)}" type="button">다시 검토</button>` : ''}
      <button class="button secondary" data-action="hold-review" data-group-key="${escapeHtml(group.key)}" type="button">보류</button>
      <button class="button primary" data-action="complete-review" data-group-key="${escapeHtml(group.key)}" type="button" ${canComplete ? '' : 'disabled'}>검토 완료</button>
    </div>
    ${canComplete ? '' : '<p class="completion-help">거리 미확인 건과 2km 이내 이동수단 미입력 건을 먼저 확인해 주세요.</p>'}
    <p class="review-disclaimer">이 화면은 확인 순서를 정리하는 보조 도구입니다. 최종 지급 판단은 관련 지침과 기관 기준을 확인해 주세요.</p>
  `;
}

function renderReviews() {
  const groups = getReviewGroups();
  renderReviewMetrics(groups);
  renderReviewList(groups);
  renderReviewDetail(groups);
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
  renderBatchPanel();
  renderDestinations();
  renderReviews();
  renderResults();
  const hasCompleted = state.destinations.some((destination) => destination.routeStatus === 'complete');
  const reviewGroups = getReviewGroups();
  const unresolvedReviews = reviewGroups.filter((group) => group.requiresReview && (group.status === 'pending' || group.status === 'hold')).length;
  if (state.busy) setStep(2);
  else if (!hasCompleted && !state.lastBatchSummary) setStep(2);
  else if (unresolvedReviews > 0) setStep(3);
  else setStep(4);
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
    state.reviewFilter = 'pending';
    state.reviewQuery = '';
    state.selectedReviewKey = null;
    state.paidOnly = false;
    state.unpaidEmptyOnly = false;
    state.batchStarted = false;
    state.lastBatchSummary = null;
    state.expanded.clear();
    dom.paid_only.checked = false;
    dom.unpaid_empty_only.checked = false;
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
  destination.location = location;
  destination.locationSource = source;
  destination.locationStatus = 'resolved';
  destination.searchStatus = 'resolved';
  destination.route = null;
  destination.routeStatus = 'pending';
  destination.searchError = '';
  destination.lastCheckedAt = new Date().toISOString();
  state.destinationMemory[destination.key] = {
    location,
    source,
    originalName: destination.originalName,
    savedAt: destination.lastCheckedAt,
  };
  saveDestinationMemory(state.destinationMemory);
  const key = routeCacheKey(state.workplace, location);
  if (key && state.routeCache[key]) {
    destination.route = state.routeCache[key];
    destination.routeStatus = 'complete';
  }
}

function sameRegion(candidate, workplace) {
  if (!workplace?.address || !candidate?.address) return true;
  const workTokens = String(workplace.address).match(/[가-힣]+(?:특별시|광역시|특별자치시|도|시|구)/g) || [];
  const candidateAddress = String(candidate.address || '');
  if (!workTokens.length) return true;
  return workTokens.slice(0, 1).some((token) => candidateAddress.includes(token));
}

function confidenceCandidate(destination, candidates) {
  if (!candidates.length) return null;
  if (destination.extractedAddress) {
    const geocodes = candidates.filter((candidate) => candidate.source === 'geocode');
    if (geocodes.length === 1) return geocodes[0];
    if (candidates.length === 1) return candidates[0];
    return null;
  }
  const target = canonical(destination.originalName);
  const exact = candidates.filter((candidate) => canonical(candidate.name) === target && sameRegion(candidate, state.workplace));
  if (exact.length === 1) return exact[0];
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
  if (!force && state.routeCache[key]) {
    destination.route = state.routeCache[key];
    destination.routeStatus = 'complete';
    destination.searchError = '';
    return true;
  }

  destination.routeStatus = 'calculating';
  try {
    const route = compactRoute(await calculateRoundTrip(
      { ...state.workplace, name: state.workplace.name || '근무지' },
      { ...destination.location, name: destination.location.name || destination.originalName },
    ));
    if (!Number.isFinite(route.outbound?.distance) || !Number.isFinite(route.inbound?.distance)) {
      throw new Error('가는 길과 오는 길을 모두 확인하지 못했어요.');
    }
    destination.route = route;
    destination.routeStatus = 'complete';
    destination.searchError = '';
    state.routeCache[key] = { ...route, cachedAt: new Date().toISOString() };
    saveRouteCache(state.routeCache);
    return true;
  } catch (error) {
    destination.route = null;
    destination.routeStatus = 'error';
    destination.searchError = error.code === 'TMAP_APP_KEY_NOT_CONFIGURED'
      ? '지도 API 키가 필요해요.'
      : error.code === 'TMAP_AUTH_FAILED'
        ? 'TMAP 상품 사용 설정을 확인해 주세요.'
        : (error.message || '거리 계산에 실패했어요.');
    return false;
  }
}

function inspectionSubcounts(searchDone, searchTotal, routeDone, routeTotal) {
  return `출장지 위치 확인 ${searchDone}/${searchTotal}곳 · 왕복거리 계산 ${routeDone}/${routeTotal}곳`;
}

async function runInspection({ searchOnly = false, routeOnly = false, forceRoutes = false } = {}) {
  if (state.busy || !validateInspectionPrerequisites()) return;

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
      title: '일괄검사를 중지했어요',
      current: searchDone + routeDone,
      total: Math.max(1, searchTargets.length + routeTargets.length),
      detail: `완료된 위치 ${searchDone}곳과 거리 ${routeDone}곳의 결과는 유지됩니다.`,
      subcounts: inspectionSubcounts(searchDone, searchTargets.length, routeDone, routeTargets.length),
      stopped: true,
    });
    showToast('일괄검사를 중지했어요. 완료된 결과는 유지됩니다.');
  } else {
    setProgress({
      visible: true,
      title: searchOnly ? '출장지 위치 확인을 마쳤어요' : '일괄검사가 완료됐어요',
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
    state.workplace = location;
    saveWorkplace(location);
    invalidateRoutes();
    reopenAllReviews();
    showToast('근무지를 저장했어요. 이제 일괄검사를 시작할 수 있어요.');
  } else {
    const destination = getDestination(state.modal.key);
    if (destination) {
      saveDestinationLocation(destination, location, 'manual');
      reopenReviewsForDestination(destination.key);
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
  state.selectedReviewKey = null;
  state.reviewFilter = 'pending';
  state.reviewQuery = '';
  dom.analysis_section.classList.add('hidden');
  showUploadError('');
  setProgress({ visible: false });
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
    `기존 지급금액: ${formatMoney(entry.trip.paymentAmount || entry.trip.travelAmount)}`,
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
    reopenAllReviews();
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
    reopenAllReviews();
    renderAll();
    showToast('저장된 출장지 정보를 초기화했어요.');
  });
  dom.clear_review_storage.addEventListener('click', () => {
    if (!Object.keys(state.reviewMemory).length) return showToast('저장된 지급 검토가 없어요.');
    if (!window.confirm('저장된 이동수단, 검토 상태와 메모를 모두 초기화할까요?')) return;
    clearReviewStorage();
    state.reviewMemory = {};
    state.selectedReviewKey = null;
    renderAll();
    showToast('저장된 지급 검토를 초기화했어요.');
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
    state.destinations.forEach((destination) => {
      if (destination.location) {
        destination.route = null;
        destination.routeStatus = 'pending';
      }
    });
    reopenAllReviews();
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
      state.busy = true;
      renderAll();
      const ok = await calculateDestination(destination, { force: destination.routeStatus === 'error' });
      state.busy = false;
      renderAll();
      showToast(ok ? '왕복거리를 계산했어요.' : '거리 계산에 실패했어요.', ok ? 'success' : 'error');
    }
  });

  const applyReviewFilter = (filter) => {
    state.reviewFilter = filter;
    state.selectedReviewKey = null;
    dom.review_filters.querySelectorAll('button[data-review-filter]').forEach((button) => button.classList.toggle('active', button.dataset.reviewFilter === filter));
    renderReviews();
  };
  dom.review_filters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-review-filter]');
    if (button) applyReviewFilter(button.dataset.reviewFilter);
  });
  dom.review_metrics.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-review-filter]');
    if (button) applyReviewFilter(button.dataset.reviewFilter);
  });
  dom.review_search.addEventListener('input', (event) => {
    state.reviewQuery = event.target.value;
    state.selectedReviewKey = null;
    renderReviews();
  });
  dom.review_list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="select-review"]');
    if (!button) return;
    state.selectedReviewKey = button.dataset.groupKey;
    renderReviews();
  });
  dom.review_detail_content.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const groupKey = button.dataset.groupKey;
    const action = button.dataset.action;
    if (action === 'transport') {
      setTransport(groupKey, button.dataset.tripId, button.dataset.value);
      renderAll();
      return;
    }
    if (action === 'review-location') {
      openLocationModal('destination', button.dataset.destinationKey);
      return;
    }
    if (action === 'complete-review') {
      const group = getReviewGroups().find((item) => item.key === groupKey);
      if (!group || group.unresolvedCount > 0 || group.transportMissingCount > 0) {
        showToast('거리와 2km 이내 이동수단을 먼저 확인해 주세요.', 'error');
        return;
      }
      updateReviewMemory(groupKey, { status: 'complete' });
      state.selectedReviewKey = null;
      showToast('검토 완료로 정리했어요.');
      renderAll();
      return;
    }
    if (action === 'hold-review') {
      updateReviewMemory(groupKey, { status: 'hold' });
      state.selectedReviewKey = null;
      showToast('보류로 표시했어요.');
      renderAll();
      return;
    }
    if (action === 'reopen-review') {
      updateReviewMemory(groupKey, { status: 'pending' });
      showToast('다시 검토할 수 있게 열었어요.');
      renderAll();
    }
  });
  dom.review_detail_content.addEventListener('input', (event) => {
    const field = event.target.closest('[data-action="review-note"]');
    if (!field) return;
    updateReviewMemory(field.dataset.groupKey, { note: field.value });
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
  dom.paid_only.addEventListener('change', (event) => {
    state.paidOnly = event.target.checked;
    renderResults();
  });
  dom.unpaid_empty_only.addEventListener('change', (event) => {
    state.unpaidEmptyOnly = event.target.checked;
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
    exportResults({ XLSX, trips: state.parsed.trips, destinations: state.destinations, workplace: state.workplace, reviewMemory: state.reviewMemory });
    showToast('지급 검토 결과 엑셀을 만들었어요.');
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
