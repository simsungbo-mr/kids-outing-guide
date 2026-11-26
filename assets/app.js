(function () {
  'use strict';

  const STORAGE_KEY_FAVS = 'kids_outing_favs_v1';
  const STORAGE_KEY_VISITED = 'kids_outing_visited_v1';
  const STORAGE_KEY_CUSTOM = 'kids_outing_custom_places_v1';

  let state = {
    places: [],
    meta: { lastUpdated: '2026-11-26' },
    activeTab: 'explore',
    viewMode: 'cards',
    activePreset: 'all',
    filters: {
      search: '',
      region: '전체',
      category: '전체',
      priceTier: '전체',
      ageGroup: '전체',
      parkingType: '전체',
      environment: '전체',
      sortBy: 'value'
    },
    favorites: new Set(),
    visited: new Set(),
    selectedPlaceId: null
  };

  let priceChartInstance = null;
  let regionChartInstance = null;

  function safeStorageGet(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Ignore storage quota or sandbox restrictions
    }
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    container.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'toast-enter fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-medium px-4 py-2.5 rounded-full shadow-lg flex items-center gap-2';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 2600);
  }

  function loadPersistedState() {
    const favArr = safeStorageGet(STORAGE_KEY_FAVS, []);
    const visArr = safeStorageGet(STORAGE_KEY_VISITED, []);
    state.favorites = new Set(Array.isArray(favArr) ? favArr : []);
    state.visited = new Set(Array.isArray(visArr) ? visArr : []);
  }

  async function initData() {
    loadPersistedState();
    let baseData = null;

    if (window.INITIAL_PLACES_DATA && Array.isArray(window.INITIAL_PLACES_DATA.places)) {
      baseData = window.INITIAL_PLACES_DATA;
    } else {
      try {
        const resp = await fetch('./data/places.json');
        if (resp.ok) {
          baseData = await resp.json();
        }
      } catch (e) {
        // Fallback handled below
      }
    }

    if (baseData && Array.isArray(baseData.places)) {
      state.places = baseData.places.slice();
      if (baseData.meta) state.meta = baseData.meta;
    }

    const customPlaces = safeStorageGet(STORAGE_KEY_CUSTOM, []);
    if (Array.isArray(customPlaces) && customPlaces.length > 0) {
      const existingIds = new Set(state.places.map((p) => p.id));
      customPlaces.forEach((cp) => {
        if (cp && cp.id && !existingIds.has(cp.id)) {
          state.places.unshift(cp);
        }
      });
    }

    updateHeaderStats();
    renderAll();
  }

  function getFilteredPlaces() {
    const f = state.filters;
    const q = f.search.trim().toLowerCase();

    let list = state.places.filter((p) => {
      if (state.activePreset === 'age5' && !p.suitableFor5) return false;
      if (state.activePreset === 'cheap' && !(p.priceTier === '무료' || p.priceTier === '1만원 이하')) return false;
      if (state.activePreset === 'show' && p.category !== '공연·연극·뮤지컬') return false;
      if (state.activePreset === 'festival' && p.category !== '축제·이벤트') return false;
      if (state.activePreset === 'new' && !(p.category === '신상 오픈' || p.isNew)) return false;
      if (state.activePreset === 'freepark' && p.parkingType !== '무료 주차') return false;
      if (state.activePreset === 'indoor' && !(p.environment === '실내' || p.environment === '실내+야외')) return false;

      if (f.region !== '전체' && p.region !== f.region) return false;
      if (f.category !== '전체' && p.category !== f.category) return false;
      if (f.priceTier !== '전체' && p.priceTier !== f.priceTier) return false;
      if (f.ageGroup !== '전체' && (!Array.isArray(p.ageGroups) || !p.ageGroups.includes(f.ageGroup))) return false;
      if (f.parkingType !== '전체' && p.parkingType !== f.parkingType) return false;
      if (f.environment !== '전체' && p.environment !== f.environment) return false;

      if (q) {
        const hay = [
          p.title,
          p.region,
          p.subRegion,
          p.address,
          p.category,
          p.priceText,
          p.ageDetail,
          p.parkingDetail,
          p.valueReason,
          ...(p.highlights || [])
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const gradeRank = { S: 3, A: 2, B: 1 };
    if (f.sortBy === 'value') {
      list.sort((a, b) => {
        const diff = (gradeRank[b.valueGrade] || 0) - (gradeRank[a.valueGrade] || 0);
        if (diff !== 0) return diff;
        return (a.priceMin || 0) - (b.priceMin || 0);
      });
    } else if (f.sortBy === 'priceAsc') {
      list.sort((a, b) => (a.priceMin || 0) - (b.priceMin || 0));
    } else if (f.sortBy === 'priceDesc') {
      list.sort((a, b) => (b.priceMin || 0) - (a.priceMin || 0));
    } else if (f.sortBy === 'newest') {
      list.sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }

    return list;
  }

  function updateHeaderStats() {
    const totalEl = document.getElementById('stat-total');
    const age5El = document.getElementById('stat-age5');
    const cheapEl = document.getElementById('stat-cheap');
    const updatedEl = document.getElementById('last-updated-badge');
    const favCountEl = document.getElementById('nav-fav-count');

    const total = state.places.length;
    const age5Count = state.places.filter((p) => p.suitableFor5).length;
    const cheapCount = state.places.filter((p) => p.priceTier === '무료' || p.priceTier === '1만원 이하').length;

    if (totalEl) totalEl.textContent = total + '곳';
    if (age5El) age5El.textContent = age5Count + '곳';
    if (cheapEl) cheapEl.textContent = cheapCount + '곳';
    if (updatedEl) updatedEl.textContent = state.meta.lastUpdated || '2026-11-26';
    if (favCountEl) favCountEl.textContent = String(state.favorites.size);
  }

  function getCategoryBadgeStyle(cat) {
    switch (cat) {
      case '공연·연극·뮤지컬':
        return 'bg-purple-50 text-purple-700 border-purple-200';
      case '축제·이벤트':
        return 'bg-amber-50 text-amber-800 border-amber-200';
      case '신상 오픈':
        return 'bg-rose-50 text-rose-700 border-rose-200';
      default:
        return 'bg-sky-50 text-sky-700 border-sky-200';
    }
  }

  function getParkingBadgeStyle(parking) {
    if (parking === '무료 주차') return 'bg-emerald-50 text-emerald-700';
    if (parking === '유료 주차') return 'bg-slate-100 text-slate-700';
    return 'bg-orange-50 text-orange-700';
  }

  function renderCards(list, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = `
        <div class="col-span-full bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center">
          <p class="text-lg font-bold text-slate-700 mb-1">조건에 맞는 장소가 없습니다</p>
          <p class="text-sm text-slate-500 mb-4">필터를 조금 넓히거나 초기화해 전국 34곳의 추천 코스를 확인해 보세요.</p>
          <button type="button" data-action="reset-filters" class="px-4 py-2 rounded-xl bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 transition">필터 초기화</button>
        </div>`;
      return;
    }

    container.innerHTML = list.map((p) => {
      const isFav = state.favorites.has(p.id);
      const isVis = state.visited.has(p.id);
      const catStyle = getCategoryBadgeStyle(p.category);
      const parkStyle = getParkingBadgeStyle(p.parkingType);
      const gradeLabel = p.valueGrade === 'S' ? '초가성비 S' : p.valueGrade === 'A' ? '가성비 A' : '스페셜 B';

      return `
        <article class="place-card bg-white rounded-2xl border border-slate-200 p-5 flex flex-col justify-between cursor-pointer" data-open-detail="${escapeHtml(p.id)}">
          <div>
            <div class="flex items-start justify-between gap-2 mb-3">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full border ${catStyle}">${escapeHtml(p.category)}</span>
                <span class="text-xs font-bold px-2.5 py-0.5 rounded-full grade-${escapeHtml(p.valueGrade)}">${gradeLabel}</span>
                ${p.isNew ? '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-rose-500 text-white">NEW</span>' : ''}
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button type="button" data-toggle-visited="${escapeHtml(p.id)}" title="다녀온 곳 표시" class="p-1.5 rounded-lg border transition ${isVis ? 'bg-emerald-50 border-emerald-300 text-emerald-600' : 'bg-white border-slate-200 text-slate-400 hover:text-emerald-600'}">
                  <i data-lucide="check-circle-2" class="w-4 h-4"></i>
                </button>
                <button type="button" data-toggle-fav="${escapeHtml(p.id)}" title="찜하기" class="p-1.5 rounded-lg border transition ${isFav ? 'bg-rose-50 border-rose-300 text-rose-500' : 'bg-white border-slate-200 text-slate-400 hover:text-rose-500'}">
                  <i data-lucide="heart" class="w-4 h-4 ${isFav ? 'fill-current' : ''}"></i>
                </button>
              </div>
            </div>

            <h3 class="text-base font-bold text-slate-900 leading-snug mb-1.5">${escapeHtml(p.title)}</h3>
            <p class="text-xs text-slate-500 flex items-center gap-1 mb-3">
              <i data-lucide="map-pin" class="w-3.5 h-3.5 text-slate-400 shrink-0"></i>
              <span>${escapeHtml(p.region)} · ${escapeHtml(p.subRegion)}</span>
              <span class="mx-1 text-slate-300">|</span>
              <span>${escapeHtml(p.environment)}</span>
            </p>

            <div class="bg-slate-50 rounded-xl p-3 mb-3 space-y-1.5 text-xs">
              <div class="flex items-start justify-between gap-2">
                <span class="text-slate-500 shrink-0">가격</span>
                <span class="font-bold text-slate-900 text-right">${escapeHtml(p.priceText)}</span>
              </div>
              <div class="flex items-start justify-between gap-2">
                <span class="text-slate-500 shrink-0">연령</span>
                <span class="font-medium text-slate-700 text-right">${escapeHtml(p.ageDetail)}</span>
              </div>
              <div class="flex items-start justify-between gap-2">
                <span class="text-slate-500 shrink-0">일정</span>
                <span class="text-slate-700 text-right">${escapeHtml(p.periodOrHours)}</span>
              </div>
            </div>

            <p class="text-xs text-slate-600 leading-relaxed mb-3">
              <span class="font-semibold text-orange-600">가성비 포인트:</span> ${escapeHtml(p.valueReason)}
            </p>
          </div>

          <div class="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-[11px] font-semibold px-2 py-0.5 rounded-md ${parkStyle}">🚗 ${escapeHtml(p.parkingType)}</span>
              ${p.suitableFor5 ? '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-orange-50 text-orange-700">👶 5살 딱!</span>' : '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-500">키/연령 확인</span>'}
            </div>
            <span class="text-xs font-semibold text-sky-600 shrink-0">상세보기 →</span>
          </div>
        </article>`;
    }).join('');
  }

  function renderTable(list, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = `<div class="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">조건에 맞는 장소가 없습니다.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
        <table class="w-full text-left border-collapse min-w-[760px]">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-600">
              <th class="py-3 px-4">장소 / 공연명</th>
              <th class="py-3 px-3">지역</th>
              <th class="py-3 px-3">가격대</th>
              <th class="py-3 px-3">5살 적합</th>
              <th class="py-3 px-3">주차</th>
              <th class="py-3 px-3">가성비</th>
              <th class="py-3 px-3 text-right">상세</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 text-xs">
            ${list.map((p) => `
              <tr class="hover:bg-slate-50 cursor-pointer" data-open-detail="${escapeHtml(p.id)}">
                <td class="py-3 px-4">
                  <div class="font-bold text-slate-900">${escapeHtml(p.title)}</div>
                  <div class="text-[11px] text-slate-500">${escapeHtml(p.category)} · ${escapeHtml(p.environment)}</div>
                </td>
                <td class="py-3 px-3 text-slate-700">${escapeHtml(p.region)}<br><span class="text-[11px] text-slate-400">${escapeHtml(p.subRegion)}</span></td>
                <td class="py-3 px-3 font-semibold text-slate-800">${escapeHtml(p.priceText)}</td>
                <td class="py-3 px-3">${p.suitableFor5 ? '<span class="px-2 py-0.5 rounded bg-orange-50 text-orange-700 font-semibold">추천</span>' : '<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-500">확인</span>'}</td>
                <td class="py-3 px-3"><span class="px-2 py-0.5 rounded font-medium ${getParkingBadgeStyle(p.parkingType)}">${escapeHtml(p.parkingType)}</span></td>
                <td class="py-3 px-3"><span class="px-2 py-0.5 rounded-full font-bold grade-${escapeHtml(p.valueGrade)}">${escapeHtml(p.valueGrade)}</span></td>
                <td class="py-3 px-3 text-right text-sky-600 font-semibold">보기</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function renderExplore() {
    const filtered = getFilteredPlaces();
    const countEl = document.getElementById('result-count');
    if (countEl) countEl.textContent = `총 ${filtered.length}건`;

    const cardsWrap = document.getElementById('cards-grid');
    const tableWrap = document.getElementById('table-container');

    if (state.viewMode === 'cards') {
      if (cardsWrap) cardsWrap.classList.remove('hidden');
      if (tableWrap) tableWrap.classList.add('hidden');
      renderCards(filtered, 'cards-grid');
    } else {
      if (cardsWrap) cardsWrap.classList.add('hidden');
      if (tableWrap) tableWrap.classList.remove('hidden');
      renderTable(filtered, 'table-container');
    }
  }

  function renderWishlist() {
    const favList = state.places.filter((p) => state.favorites.has(p.id));
    const visList = state.places.filter((p) => state.visited.has(p.id));

    const favTitle = document.getElementById('wishlist-fav-count');
    const visTitle = document.getElementById('wishlist-vis-count');
    if (favTitle) favTitle.textContent = `${favList.length}곳`;
    if (visTitle) visTitle.textContent = `${visList.length}곳`;

    renderCards(favList, 'wishlist-fav-grid');
    renderCards(visList, 'wishlist-vis-grid');
  }

  function renderAnalytics() {
    if (typeof window.Chart === 'undefined') return;

    const priceTiers = ['무료', '1만원 이하', '1~3만원', '3~5만원', '5만원 이상'];
    const priceCounts = priceTiers.map((t) => state.places.filter((p) => p.priceTier === t).length);

    const priceCtx = document.getElementById('chart-price');
    if (priceCtx) {
      if (priceChartInstance) priceChartInstance.destroy();
      priceChartInstance = new window.Chart(priceCtx, {
        type: 'bar',
        data: {
          labels: priceTiers,
          datasets: [{
            label: '등록 장소/공연 수',
            data: priceCounts,
            backgroundColor: ['#10b981', '#0ea5e9', '#6366f1', '#f59e0b', '#f43f5e'],
            borderRadius: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { beginAtZero: true, ticks: { stepSize: 2 } }
          }
        }
      });
    }

    const regions = ['서울', '경기', '인천', '강원', '충청·세종·대전', '경상·부산·대구', '전라·광주', '제주'];
    const regionCounts = regions.map((r) => state.places.filter((p) => p.region === r).length);

    const regionCtx = document.getElementById('chart-region');
    if (regionCtx) {
      if (regionChartInstance) regionChartInstance.destroy();
      regionChartInstance = new window.Chart(regionCtx, {
        type: 'doughnut',
        data: {
          labels: regions,
          datasets: [{
            data: regionCounts,
            backgroundColor: ['#ff6b4a', '#0ea5e9', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#64748b'],
            borderWidth: 2,
            borderColor: '#ffffff'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } }
          }
        }
      });
    }

    const topPicks = state.places
      .filter((p) => p.suitableFor5 && p.valueGrade === 'S')
      .slice(0, 6);
    renderCards(topPicks, 'analytics-top-picks');
  }

  function renderDetailModal() {
    const modal = document.getElementById('detail-modal');
    const body = document.getElementById('detail-modal-body');
    if (!modal || !body) return;

    if (!state.selectedPlaceId) {
      modal.classList.add('hidden');
      return;
    }

    const p = state.places.find((item) => item.id === state.selectedPlaceId);
    if (!p) {
      modal.classList.add('hidden');
      return;
    }

    const isFav = state.favorites.has(p.id);
    const isVis = state.visited.has(p.id);
    const gradeLabel = p.valueGrade === 'S' ? '초가성비 (S등급)' : p.valueGrade === 'A' ? '가성비 우수 (A등급)' : '스페셜 체험 (B등급)';

    body.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-4">
        <div>
          <div class="flex flex-wrap items-center gap-1.5 mb-2">
            <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full border ${getCategoryBadgeStyle(p.category)}">${escapeHtml(p.category)}</span>
            <span class="text-xs font-bold px-2.5 py-0.5 rounded-full grade-${escapeHtml(p.valueGrade)}">${gradeLabel}</span>
            ${p.suitableFor5 ? '<span class="text-xs font-bold px-2.5 py-0.5 rounded-full bg-orange-100 text-orange-700">👶 5살 아이 추천</span>' : ''}
          </div>
          <h2 class="text-xl font-extrabold text-slate-900">${escapeHtml(p.title)}</h2>
          <p class="text-sm text-slate-500 mt-1">${escapeHtml(p.address)}</p>
        </div>
        <button type="button" data-close-modal="true" class="p-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 text-sm">
        <div class="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
          <div class="text-xs font-semibold text-slate-500 mb-1">💰 가격 정보 (${escapeHtml(p.priceTier)})</div>
          <div class="font-bold text-slate-900">${escapeHtml(p.priceText)}</div>
        </div>
        <div class="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
          <div class="text-xs font-semibold text-slate-500 mb-1">🚗 주차 안내 (${escapeHtml(p.parkingType)})</div>
          <div class="font-medium text-slate-800">${escapeHtml(p.parkingDetail)}</div>
        </div>
        <div class="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
          <div class="text-xs font-semibold text-slate-500 mb-1">👶 권장 연령 & 기준</div>
          <div class="font-medium text-slate-800">${escapeHtml(p.ageDetail)}</div>
        </div>
        <div class="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
          <div class="text-xs font-semibold text-slate-500 mb-1">🗓 운영시간 / 기간 & 예약</div>
          <div class="font-medium text-slate-800">${escapeHtml(p.periodOrHours)}</div>
          <div class="text-xs text-slate-500 mt-1">${escapeHtml(p.reservation)} · ${escapeHtml(p.reservationDetail || '')}</div>
        </div>
      </div>

      <div class="bg-orange-50/70 border border-orange-200 rounded-xl p-4 mb-4">
        <div class="text-xs font-bold text-orange-700 mb-1">✨ 5살 부모 관점 가성비 포인트</div>
        <p class="text-sm text-slate-800 font-medium">${escapeHtml(p.valueReason)}</p>
        <ul class="mt-2.5 space-y-1">
          ${(p.highlights || []).map((h) => `<li class="text-xs text-slate-700 flex items-center gap-1.5"><span class="text-orange-500">•</span>${escapeHtml(h)}</li>`).join('')}
        </ul>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200">
        <div class="flex items-center gap-2">
          <button type="button" data-toggle-fav="${escapeHtml(p.id)}" class="px-3.5 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 ${isFav ? 'bg-rose-500 text-white border-rose-500' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}">
            <i data-lucide="heart" class="w-4 h-4 ${isFav ? 'fill-current' : ''}"></i> ${isFav ? '찜 완료' : '찜하기'}
          </button>
          <button type="button" data-toggle-visited="${escapeHtml(p.id)}" class="px-3.5 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 ${isVis ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}">
            <i data-lucide="check-circle-2" class="w-4 h-4"></i> ${isVis ? '다녀왔어요' : '방문 체크'}
          </button>
        </div>
        <a href="${escapeHtml(p.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition inline-flex items-center gap-1.5">
          <span>공식 안내 · 출처 보기</span>
          <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
        </a>
      </div>`;

    modal.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
      panel.classList.toggle('hidden', panel.getAttribute('data-tab-panel') !== tabName);
    });
    renderAll();
  }

  function renderAll() {
    updateHeaderStats();
    if (state.activeTab === 'explore') {
      renderExplore();
    } else if (state.activeTab === 'analytics') {
      renderAnalytics();
    } else if (state.activeTab === 'wishlist') {
      renderWishlist();
    }
    if (window.lucide) window.lucide.createIcons();
  }

  function resetAllFilters() {
    state.activePreset = 'all';
    state.filters = {
      search: '',
      region: '전체',
      category: '전체',
      priceTier: '전체',
      ageGroup: '전체',
      parkingType: '전체',
      environment: '전체',
      sortBy: 'value'
    };

    const mapping = {
      'filter-search': '',
      'filter-region': '전체',
      'filter-category': '전체',
      'filter-price': '전체',
      'filter-age': '전체',
      'filter-parking': '전체',
      'filter-env': '전체',
      'filter-sort': 'value'
    };
    Object.keys(mapping).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = mapping[id];
    });
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-preset') === 'all');
    });
    renderAll();
  }

  function exportPlacesJson(downloadFile) {
    const payload = {
      meta: {
        title: '전국 5살 아이 나들이·공연·축제·신상 가이드',
        lastUpdated: new Date().toISOString().slice(0, 10),
        targetAgeNote: '5세(만 4~5세) 중심 · 전 연령 필터 지원',
        totalCount: state.places.length
      },
      places: state.places
    };
    const jsonStr = JSON.stringify(payload, null, 2);

    if (downloadFile) {
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'places.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('places.json 파일이 다운로드되었습니다. GitHub의 data/ 폴더에 올려주세요!');
    } else {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(jsonStr).then(
          () => showToast('최신 JSON 데이터가 클립보드에 복사되었습니다!'),
          () => fallbackCopy(jsonStr)
        );
      } else {
        fallbackCopy(jsonStr);
      }
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('최신 JSON 데이터가 클립보드에 복사되었습니다!');
    } catch (e) {
      showToast('복사에 실패했습니다. 파일 다운로드를 이용해 주세요.');
    }
    document.body.removeChild(ta);
  }

  function attachEvents() {
    document.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        switchTab(tabBtn.getAttribute('data-tab'));
        return;
      }

      const presetBtn = e.target.closest('[data-preset]');
      if (presetBtn) {
        state.activePreset = presetBtn.getAttribute('data-preset');
        document.querySelectorAll('[data-preset]').forEach((b) => {
          b.classList.toggle('active', b === presetBtn);
        });
        if (state.activeTab !== 'explore') switchTab('explore');
        else renderAll();
        return;
      }

      const viewBtn = e.target.closest('[data-view-mode]');
      if (viewBtn) {
        state.viewMode = viewBtn.getAttribute('data-view-mode');
        document.querySelectorAll('[data-view-mode]').forEach((b) => {
          const active = b === viewBtn;
          b.classList.toggle('bg-slate-900', active);
          b.classList.toggle('text-white', active);
          b.classList.toggle('bg-white', !active);
          b.classList.toggle('text-slate-600', !active);
        });
        renderExplore();
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      const resetBtn = e.target.closest('[data-action="reset-filters"]');
      if (resetBtn) {
        resetAllFilters();
        showToast('모든 필터가 초기화되었습니다.');
        return;
      }

      const favBtn = e.target.closest('[data-toggle-fav]');
      if (favBtn) {
        e.stopPropagation();
        const id = favBtn.getAttribute('data-toggle-fav');
        if (state.favorites.has(id)) {
          state.favorites.delete(id);
          showToast('찜 목록에서 제거했습니다.');
        } else {
          state.favorites.add(id);
          showToast('찜 목록에 추가했습니다!');
        }
        safeStorageSet(STORAGE_KEY_FAVS, Array.from(state.favorites));
        renderAll();
        if (state.selectedPlaceId === id) renderDetailModal();
        return;
      }

      const visBtn = e.target.closest('[data-toggle-visited]');
      if (visBtn) {
        e.stopPropagation();
        const id = visBtn.getAttribute('data-toggle-visited');
        if (state.visited.has(id)) {
          state.visited.delete(id);
          showToast('방문 체크를 해제했습니다.');
        } else {
          state.visited.add(id);
          showToast('다녀온 곳으로 기록했습니다!');
        }
        safeStorageSet(STORAGE_KEY_VISITED, Array.from(state.visited));
        renderAll();
        if (state.selectedPlaceId === id) renderDetailModal();
        return;
      }

      const closeModalBtn = e.target.closest('[data-close-modal]');
      if (closeModalBtn || e.target.id === 'detail-modal') {
        state.selectedPlaceId = null;
        renderDetailModal();
        return;
      }

      const detailCard = e.target.closest('[data-open-detail]');
      if (detailCard) {
        state.selectedPlaceId = detailCard.getAttribute('data-open-detail');
        renderDetailModal();
        return;
      }

      if (e.target.closest('#btn-export-json')) {
        exportPlacesJson(true);
        return;
      }

      if (e.target.closest('#btn-copy-json')) {
        exportPlacesJson(false);
        return;
      }
    });

    const bindFilter = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.tagName === 'INPUT' ? 'input' : 'change';
      el.addEventListener(evt, (e) => {
        state.filters[key] = e.target.value;
        renderExplore();
        if (window.lucide) window.lucide.createIcons();
      });
    };

    bindFilter('filter-search', 'search');
    bindFilter('filter-region', 'region');
    bindFilter('filter-category', 'category');
    bindFilter('filter-price', 'priceTier');
    bindFilter('filter-age', 'ageGroup');
    bindFilter('filter-parking', 'parkingType');
    bindFilter('filter-env', 'environment');
    bindFilter('filter-sort', 'sortBy');

    const addForm = document.getElementById('daily-add-form');
    if (addForm) {
      addForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(addForm);
        const title = String(fd.get('title') || '').trim();
        if (!title) {
          showToast('장소 또는 공연 이름을 입력해 주세요.');
          return;
        }
        const priceMin = Number(fd.get('priceMin')) || 0;
        const priceTier = priceMin === 0 ? '무료' : priceMin <= 10000 ? '1만원 이하' : priceMin <= 30000 ? '1~3만원' : priceMin <= 50000 ? '3~5만원' : '5만원 이상';
        const ageChecks = Array.from(addForm.querySelectorAll('input[name="ageGroups"]:checked')).map((c) => c.value);
        const newItem = {
          id: 'custom_' + Date.now(),
          title,
          category: String(fd.get('category') || '나들이·체험관'),
          region: String(fd.get('region') || '서울'),
          subRegion: String(fd.get('subRegion') || '').trim() || '기타',
          address: String(fd.get('address') || '').trim() || '상세 주소 확인',
          priceTier,
          priceMin,
          priceText: String(fd.get('priceText') || '').trim() || (priceMin === 0 ? '무료' : priceMin.toLocaleString() + '원'),
          ageGroups: ageChecks.length ? ageChecks : ['유아 (3~5세)'],
          ageDetail: String(fd.get('ageDetail') || '').trim() || '유아(5세) 동반 가능',
          suitableFor5: ageChecks.length === 0 || ageChecks.includes('유아 (3~5세)'),
          parkingType: String(fd.get('parkingType') || '유료 주차'),
          parkingDetail: String(fd.get('parkingDetail') || '').trim() || '현장 주차 안내 확인',
          environment: String(fd.get('environment') || '실내'),
          periodOrHours: String(fd.get('periodOrHours') || '').trim() || '운영시간 확인',
          reservation: String(fd.get('reservation') || '예약 불필요'),
          reservationDetail: '',
          valueGrade: String(fd.get('valueGrade') || 'S'),
          valueReason: String(fd.get('valueReason') || '').trim() || '직접 추가한 추천 장소',
          highlights: ['일일 업데이트로 직접 추가됨'],
          sourceTitle: '사용자 등록 링크',
          sourceUrl: String(fd.get('sourceUrl') || '').trim() || 'https://korean.visitkorea.or.kr/',
          updatedAt: new Date().toISOString().slice(0, 10),
          isNew: true
        };

        state.places.unshift(newItem);
        const savedCustom = safeStorageGet(STORAGE_KEY_CUSTOM, []);
        savedCustom.unshift(newItem);
        safeStorageSet(STORAGE_KEY_CUSTOM, savedCustom);

        addForm.reset();
        showToast(`"${title}" 항목이 추가되었습니다! JSON 다운로드로 GitHub에 반영할 수 있어요.`);
        switchTab('explore');
      });
    }

    const importInput = document.getElementById('json-import-file');
    if (importInput) {
      importInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result));
            const arr = Array.isArray(parsed) ? parsed : parsed.places;
            if (!Array.isArray(arr) || arr.length === 0) {
              showToast('유효한 places 배열이 없는 JSON 파일입니다.');
              return;
            }
            state.places = arr;
            if (parsed.meta) state.meta = parsed.meta;
            showToast(`총 ${arr.length}건의 데이터를 불러왔습니다!`);
            switchTab('explore');
          } catch (err) {
            showToast('JSON 형식이 올바르지 않습니다.');
          }
        };
        reader.readAsText(file, 'utf-8');
        e.target.value = '';
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.selectedPlaceId) {
        state.selectedPlaceId = null;
        renderDetailModal();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    attachEvents();
    initData();
  });
})();
