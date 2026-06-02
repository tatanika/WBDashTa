'use strict';

// ── STATE ──────────────────────────────────────────────────────────────────────
let allCards = [];
let filteredCards = [];
let sortKey = 'orders', sortDir = -1;  // по умолчанию: заказы по убыванию
let selectedNmId = null;
let panelDays = 14;
let showInactive = false;
let autoRefreshTimer = null;
let customNames = {};  // nmId → пользовательское название

// ── ЛОГИСТИКА ──────────────────────────────────────────────────────────────────
let logisticsSettings = { il: 1.0, irp: 0.0, updatedAt: null };  // ИЛ и ИРП
let tariffs = {};  // warehouseName → { base, liter }
let currentCardDimensions = {};   // габариты выбранной карточки
let currentCardPrice = 0;         // цена выбранной карточки

// ── INIT ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadCustomNames();
  initTabs();
  initToolbar();
  initBottomPanel();
  initSessionModal();
  initLogisticsModal();
  loadLogisticsData();
  initSetupScreen();   // ← проверяет токен; если нет — показывает экран настройки
});

// ── TABS ───────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      document.getElementById('toolbar').style.display = tab === 'cards' ? '' : 'none';
      if (tab === 'regions') renderRegions();
      if (tab === 'ads') loadAds();
    });
  });
}

// ── TOOLBAR ────────────────────────────────────────────────────────────────────
function initToolbar() {
  // Синхронизируем select с начальным состоянием sortKey/sortDir
  const sel = document.getElementById('sort-select');
  sel.value = `${sortKey}-${sortDir === 1 ? 'asc' : 'desc'}`;

  document.getElementById('search').addEventListener('input', () => applyFilter());
  document.getElementById('cat-filter').addEventListener('change', () => applyFilter());
  sel.addEventListener('change', e => {
    const parts = e.target.value.split('-');
    // 'vendorCode-asc' → k='vendorCode', d='asc'
    // 'finalPrice-desc' → k='finalPrice', d='desc'
    const d = parts.pop(); // последний элемент — направление
    const k = parts.join('-'); // остальное — ключ (на случай 'finalPrice')
    sortKey = k; sortDir = d === 'asc' ? 1 : -1;
    renderTable();
  });
  document.getElementById('refresh-btn').addEventListener('click', () => loadCards(false, true));
  document.getElementById('show-inactive-btn').addEventListener('click', () => {
    showInactive = !showInactive;
    document.getElementById('show-inactive-btn').classList.toggle('active', showInactive);
    document.getElementById('show-inactive-btn').textContent = showInactive ? '📦 Скрыть старые' : '📦 Старые товары';
    loadCards(false);
  });
  document.getElementById('spp-session-btn')?.addEventListener('click', openSessionModal);
}

function populateCategoryFilter(cards) {
  const cats = [...new Set(cards.map(c => c.category).filter(Boolean))].sort();
  const sel = document.getElementById('cat-filter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Все</option>' +
    cats.map(c => `<option value="${esc(c)}"${c===prev?' selected':''}>${esc(c)}</option>`).join('');
}

function applyFilter() {
  const search = document.getElementById('search').value.toLowerCase();
  const cat = document.getElementById('cat-filter').value;
  filteredCards = allCards.filter(c => {
    if (cat && c.category !== cat) return false;
    if (search && !`${c.vendorCode} ${c.title} ${c.color}`.toLowerCase().includes(search)) return false;
    return true;
  });
  renderTable();
}

// ── DATA LOADING ───────────────────────────────────────────────────────────────
async function loadCards(silent = false, forceRefresh = false) {
  if (!silent) showLoader(true, 'Загружаем данные с Wildberries…');
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');

  try {
    if (forceRefresh) {
      await fetch('/api/refresh', { method: 'POST' });
      // wait for refresh to complete
      await waitForReady();
    }

    const [cardsRes, statsRes] = await Promise.all([
      fetch(`/api/cards?showAll=${showInactive}`).then(r => r.json()),
      fetch(`/api/stats/shop?days=${panelDays}&showAll=${showInactive}`).then(r => r.json()),
    ]);

    allCards = cardsRes.cards || [];
    populateCategoryFilter(allCards);
    applyFilter();
    renderShopStats(statsRes.stats || [], statsRes.warehouses || [], statsRes.inWayTo || 0, statsRes.inWayFrom || 0);
    updateUpdatedLabel(cardsRes.updatedAt);
    if (!silent) showLoader(false);
    if (forceRefresh) toast('✅ Данные обновлены');
  } catch (e) {
    console.error(e);
    if (!silent) showLoader(false);
    toast('❌ Ошибка: ' + e.message);
  } finally {
    btn.classList.remove('spinning');
  }
}

async function waitForReady(maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const st = await fetch('/api/status').then(r => r.json()).catch(() => ({}));
    if (st.ready && !st.isRefreshing) return;
    await sleep(1500);
  }
}

async function loadItemStats(nmId, days) {
  try { return await fetch(`/api/stats/${nmId}?days=${days}`).then(r => r.json()); }
  catch (e) { return null; }
}

// ── TABLE RENDER ───────────────────────────────────────────────────────────────
function renderTable() {
  const sorted = [...filteredCards].sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case 'vendorCode': va = a.vendorCode;       vb = b.vendorCode;       break;
      case 'color':      va = a.color;             vb = b.color;            break;
      case 'finalPrice': va = a.prices.finalPrice; vb = b.prices.finalPrice; break;
      case 'stock':      va = a.stock.total;       vb = b.stock.total;      break;
      case 'orders':     va = a.orders30 ?? a.analytics.orders; vb = b.orders30 ?? b.analytics.orders; break;
      case 'views':      va = a.analytics.views;   vb = b.analytics.views;  break;
      case 'category':   va = a.category;          vb = b.category;         break;
      default:           va = a.vendorCode;        vb = b.vendorCode;
    }
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    return ((va || 0) - (vb || 0)) * sortDir;
  });

  document.getElementById('count-badge').textContent = `${sorted.length} товаров`;
  const maxOrders = Math.max(...sorted.map(c => c.analytics.orders), 1);
  const maxCart   = Math.max(...sorted.map(c => c.analytics.cart),   1);

  const tbody = document.getElementById('cards-tbody');
  tbody.innerHTML = sorted.map(c => cardRow(c, maxOrders, maxCart)).join('');

  tbody.querySelectorAll('tr[data-nm]').forEach(row => {
    const nm = parseInt(row.dataset.nm);
    row.addEventListener('click', e => {
      if (e.target.classList.contains('thumb')) return;
      if (e.target.classList.contains('custom-name')) return; // не выделяем при редактировании
      selectCard(nm, row);
    });
    row.querySelector('.thumb')?.addEventListener('click', e => {
      e.stopPropagation();
      const img = e.currentTarget;
      const zoomed = img.classList.contains('zoomed');
      document.querySelectorAll('.thumb.zoomed').forEach(i => {
        if (i !== img) { i.classList.remove('zoomed'); i.src = i.dataset.sm; }
      });
      img.classList.toggle('zoomed', !zoomed);
      img.src = zoomed ? img.dataset.sm : img.dataset.lg;
    });
    // Обработка сохранения кастомного названия
    const nameDiv = row.querySelector('.custom-name');
    if (nameDiv) {
      nameDiv.addEventListener('blur', () => {
        const text = nameDiv.textContent.trim();
        if (text) customNames[nm] = text;
        else delete customNames[nm];
        saveCustomNames();
      });
      nameDiv.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); nameDiv.blur(); }
        if (e.key === 'Escape') { nameDiv.textContent = customNames[nm] || ''; nameDiv.blur(); }
      });
      nameDiv.addEventListener('click', e => e.stopPropagation());
    }
  });

  if (selectedNmId) {
    const row = tbody.querySelector(`tr[data-nm="${selectedNmId}"]`);
    if (row) row.classList.add('selected');
  }
}

function cardRow(c, maxOrders, maxCart) {
  const p = c.prices, s = c.stock, a = c.analytics;
  const stockCls = s.total === 0 ? 'stock-zero' : s.total < 5 ? 'stock-low' : s.total < 20 ? 'stock-warn' : 'stock-ok';
  const ordBar  = Math.round((a.orders / maxOrders) * 46);
  const cartBar = Math.round((a.cart   / maxCart)   * 46);

  // ── Price chain: base → after seller discount → after SPP (buyer price) ──
  const badges  = [];
  if (p.selDisc) badges.push(`<span class="badge badge-orange">-${p.selDisc}%</span>`);

  // ── СПП бейдж: показываем только если есть данные ──
  const hasStock    = c.stock?.total > 0;
  const sppVal      = p.spp || 0;
  const freshDays   = p.sppFreshDays ?? 999;   // дней назад был последний заказ
  const isEstimated = p.sppEstimated === true;  // ближайший сосед (нет своих заказов)

  if (sppVal > 0) {
    if (!hasStock) {
      // ▪️ Товар БЕЗ остатков — УСТАРЕВШИЕ данные, серый бейдж
      const ago = freshDays < 999 ? ` (${freshDays} дн. назад)` : '';
      badges.push(`<span class="badge badge-spp-old" title="СПП: -${sppVal}% — из последних заказов${ago}. Товара нет на складе">↩ WB -${sppVal}%</span>`);
    } else if (isEstimated) {
      // ≈ Товар с остатком, СПП — оценка (нет своих заказов)
      badges.push(`<span class="badge badge-purple badge-dim" title="СПП: ≈${sppVal}% — оценка по аналогичному товару (ваших заказов нет за 90 дн.)">~WB -${sppVal}%</span>`);
    } else if (freshDays <= 3) {
      // ✅ Товар с остатком, СПП свежая (заказ в последние ц 3 дня)
      badges.push(`<span class="badge badge-purple" title="СПП: -${sppVal}% — актуальная (заказ ${freshDays} дн. наз)">WB -${sppVal}%</span>`);
    } else {
      // ⏳ Товар с остатком, но заказ был 4+ дней назад
      badges.push(`<span class="badge badge-purple badge-dim" title="СПП: -${sppVal}% — из заказа ${freshDays} дн. назад (может устареть)">≈WB -${sppVal}%</span>`);
    }
  }

  const baseStr  = p.basePrice ? `${fmt(p.basePrice)} ₽` : '';
  const afterStr = p.afterDisc ? `${fmt(p.afterDisc)} ₽` : '';
  const finalStr = p.finalPrice ? `${fmt(p.finalPrice)} ₽` : '—';

  // Тултип: полная разбивка цены + источник данных
  const tooltipParts = [];
  if (p.basePrice) tooltipParts.push(`Базовая: ${fmt(p.basePrice)} ₽`);
  if (p.selDisc)   tooltipParts.push(`Скидка продавца: -${p.selDisc}%`);
  if (p.afterDisc) tooltipParts.push(`После скидки: ${fmt(p.afterDisc)} ₽`);
  if (sppVal > 0) {
    let src;
    if (!hasStock)       src = `↩ из заказов (${freshDays} дн. назад), товара нет`;
    else if (isEstimated) src = '≈ оценка по аналогичному товару';
    else if (freshDays <= 3) src = `✅ заказ ${freshDays} дн. назад`;
    else                  src = `⏳ заказ ${freshDays} дн. назад`;
    tooltipParts.push(`Скидка WB (СПП): -${sppVal}% [${src}]`);
  }
  if (p.finalPrice && sppVal > 0) tooltipParts.push(`Цена покупателя: ${fmt(p.finalPrice)} ₽`);
  const tooltip = tooltipParts.join('\n');

  // Компактный вывод:
  // 1) Базовая (зачёркнутая) — всегда показываем если есть
  // 2) После скидки продавца — серым
  // 3) Цена покупателя (после SPP) — крупным зелёным
  let priceHtml = '';
  if (p.selDisc && p.basePrice) {
    priceHtml += `<div class="price-base">${baseStr}</div>`;
  }
  if (p.spp > 0 && p.afterDisc) {
    priceHtml += `<div class="price-after">${afterStr}</div>`;
    priceHtml += `<div class="price-final">${finalStr}</div>`;
  } else {
    priceHtml += `<div class="price-final">${p.afterDisc ? afterStr : finalStr}</div>`;
  }
  priceHtml += `<div class="price-badges">${badges.join('')}</div>`;

  const inactive = !c.isActive ? ' style="opacity:.55"' : '';

  return `
<tr data-nm="${c.nmId}"${inactive}>
  <td class="photo-cell">
    <img class="thumb" src="${esc(c.photo)}" data-sm="${esc(c.photo)}" data-lg="${esc(c.photoBig)}"
         alt="${esc(c.vendorCode)}" loading="lazy" onerror="this.style.opacity='.2'">
  </td>
  <td class="product-cell">
    <div class="product-top">
      <span class="vendor-code">${esc(c.vendorCode)}</span>
      <span class="custom-name" contenteditable="true" data-nm="${c.nmId}">${esc(customNames[c.nmId] || '')}</span>
    </div>
    <div class="product-title">${esc(c.title || '—')}</div>
    <div class="product-sub">${esc(c.category || '')}</div>
  </td>
  <td class="color-cell">${esc(c.color)}</td>
  <td class="price-cell" title="${esc(tooltip)}">
    ${priceHtml}
  </td>
  <td class="stock-cell">
    <div class="stock-num ${stockCls}">${s.total}</div>
    <div class="stock-label">шт.</div>
  </td>
  <td class="anl-cell">
    <div class="anl-row"><span class="anl-lbl">Клики </span><div class="anl-bar-wrap"><div class="anl-bar" style="width:${ordBar}px"></div></div><span class="anl-val">${fmt(a.views)}</span></div>
    <div class="anl-row"><span class="anl-lbl">Корзина</span><div class="anl-bar-wrap"><div class="anl-bar" style="width:${cartBar}px;background:#3fb950"></div></div><span class="anl-val">${fmt(a.cart)}</span>${a.cartPct?`<span class="anl-pct">${a.cartPct.toFixed(1)}%</span>`:''}</div>
    <div class="anl-row"><span class="anl-lbl">Заказы </span><span class="anl-val">${fmt(a.orders)}</span>${a.orderPct?`<span class="anl-pct">${a.orderPct.toFixed(1)}%</span>`:''}</div>
  </td>
  <td class="ad-cell">—</td>
</tr>`;
}

// ── CARD SELECTION ─────────────────────────────────────────────────────────────
async function selectCard(nmId, row) {
  document.querySelectorAll('#cards-tbody tr.selected').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
  selectedNmId = nmId;
  const card = allCards.find(c => c.nmId === nmId);
  const titleText = card ? `${card.vendorCode} — ${(card.title || '').slice(0, 35)}` : `#${nmId}`;
  document.getElementById('panel-title-text').textContent = `📦 ${titleText}`;
  document.getElementById('back-btn').classList.add('visible');
  // Показываем вкладки [По дням] / [Запросы] и сбрасываем на Stats
  document.getElementById('panel-view-tabs')?.classList.remove('hidden');
  currentPanelView = 'stats';
  document.querySelectorAll('.panel-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === 'stats'));
  document.getElementById('panel-body')?.classList.remove('hidden');
  document.getElementById('panel-queries')?.classList.add('hidden');
  document.getElementById('stats-tbody').innerHTML = '<tr><td colspan="5" id="no-stats">Загрузка…</td></tr>';
  const data = await loadItemStats(nmId, panelDays);
  if (data) {
    // Сохраняем габариты и цену для расчёта логистики
    currentCardDimensions = data.dimensions || {};
    currentCardPrice = data.prices?.afterDisc || card?.prices?.afterDisc || 0;
    renderStats(data.stats || [], panelDays);
    renderWarehouses(data.warehouses || [], false, data.inWayTo || 0, data.inWayFrom || 0);
  } else {
    currentCardDimensions = {};
    currentCardPrice = card?.prices?.afterDisc || 0;
    document.getElementById('stats-tbody').innerHTML = '<tr><td colspan="5" id="no-stats">Нет данных</td></tr>';
    renderWarehouses([], false, 0, 0);
  }
}

function deselectCard() {
  selectedNmId = null;
  document.querySelectorAll('#cards-tbody tr.selected').forEach(r => r.classList.remove('selected'));
  document.getElementById('panel-title-text').textContent = 'Весь магазин — По дням';
  document.getElementById('back-btn').classList.remove('visible');
  // Скрываем вкладки и возвращаем к stats-виду
  document.getElementById('panel-view-tabs')?.classList.add('hidden');
  currentPanelView = 'stats';
  document.querySelectorAll('.panel-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === 'stats'));
  document.getElementById('panel-body')?.classList.remove('hidden');
  document.getElementById('panel-queries')?.classList.add('hidden');
  loadShopStats();
}

// ── BOTTOM PANEL ─────────────────────────────────────────────────────────
function initBottomPanel() {
  document.getElementById('back-btn').addEventListener('click', deselectCard);
  document.getElementById('days-select').addEventListener('change', e => {
    panelDays = parseInt(e.target.value);
    if (selectedNmId) {
      const row = document.querySelector(`tr[data-nm="${selectedNmId}"]`);
      if (row) selectCard(selectedNmId, row);
    } else loadShopStats();
  });

  // ── Вертикальный resize (высота нижней панели) ──
  const vHandle = document.getElementById('panel-resize-handle');
  const panel   = document.getElementById('bottom-panel');
  let vDragging = false, vStartY = 0, vStartH = 0;
  vHandle.addEventListener('mousedown', e => {
    vDragging = true; vStartY = e.clientY; vStartH = panel.offsetHeight;
    vHandle.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!vDragging) return;
    const delta = vStartY - e.clientY; // тянем вверх = панель растёт
    const newH = Math.min(Math.max(vStartH + delta, 80), window.innerHeight * 0.6);
    panel.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!vDragging) return;
    vDragging = false;
    vHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // ── Горизонтальный resize (ширина левой колонки) ──
  const hHandle = document.getElementById('panel-col-divider');
  const leftCol = document.getElementById('panel-left');
  const rightCol = document.getElementById('panel-right');

  // Очищаем мусорные inline-стили с предыдущих сессий
  leftCol.style.cssText = '';
  rightCol.style.cssText = '';

  let hDragging = false, hStartX = 0, hStartLeftW = 0, hStartRightW = 0;
  hHandle.addEventListener('mousedown', e => {
    hDragging = true;
    hStartX = e.clientX;
    hStartLeftW = leftCol.offsetWidth;
    hStartRightW = rightCol.offsetWidth;
    hHandle.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!hDragging) return;
    const delta = e.clientX - hStartX;
    const totalW = hStartLeftW + hStartRightW;
    if (totalW <= 0) return;
    let newLeft  = hStartLeftW + delta;
    let newRight = hStartRightW - delta;
    const minW = totalW * 0.15;
    if (newLeft < minW)  { newLeft = minW;  newRight = totalW - minW; }
    if (newRight < minW) { newRight = minW; newLeft = totalW - minW; }
    const leftRatio  = newLeft / totalW;
    const rightRatio = newRight / totalW;
    leftCol.style.flex  = `${(leftRatio * 5).toFixed(2)} 1 0px`;
    rightCol.style.flex = `${(rightRatio * 5).toFixed(2)} 1 0px`;
  });
  document.addEventListener('mouseup', () => {
    if (!hDragging) return;
    hDragging = false;
    hHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

}

async function loadShopStats() {
  try {
    const data = await fetch(`/api/stats/shop?days=${panelDays}&showAll=${showInactive}`).then(r => r.json());
    renderShopStats(data.stats || [], data.warehouses || [], data.inWayTo || 0, data.inWayFrom || 0);
  } catch (e) { console.error(e); }
}

function renderShopStats(stats, warehouses, inWayTo, inWayFrom) {
  document.getElementById('panel-title-text').textContent = 'Весь магазин — По дням';
  renderStats(stats, panelDays);
  renderWarehouses(warehouses, true, inWayTo || 0, inWayFrom || 0);
}

function renderStats(stats, days) {
  const d = days || panelDays;
  const dateMap = {};
  for (const s of stats) dateMap[s.date] = s;
  const allDates = [];
  for (let i = 0; i < d; i++) {
    const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    allDates.push(dt);
  }

  if (!allDates.length) {
    document.getElementById('stats-tbody').innerHTML = '<tr><td colspan="5" id="no-stats">Нет данных</td></tr>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const maxOrders = Math.max(...Object.values(dateMap).map(s => s.orders || 0), 1);
  document.getElementById('stats-tbody').innerHTML = allDates.map(date => {
    const s = dateMap[date];
    const orders  = s?.orders  || 0;
    const revenue = s?.revenue || 0;
    const buyouts = s?.buyouts || 0;
    const cancels = s?.cancels || 0;
    const linked  = s?.linked  || 0; // заказов этого дня, которые выкупили

    const barW = Math.round((orders / maxOrders) * 22);
    const zeroClass = orders === 0 && buyouts === 0 ? ' class="zero-row"' : '';

    // Конверсия: из заказов этого дня → выкупили
    // ⏳ показываем только если: прошло < 14 дней И конверсия ещё неполная (< 100%)
    const daysDiff = Math.round((new Date(today) - new Date(date)) / 86400000);
    const allBought = orders > 0 && linked >= orders; // 100% выкупили
    const isPending = daysDiff < 14 && !allBought;    // ещё могут быть выкупы
    let convHtml = '';
    if (orders > 0) {
      if (linked > 0) {
        const pct = Math.round(linked / orders * 100);
        const cls = pct >= 70 ? 'conv-good' : pct >= 40 ? 'conv-mid' : 'conv-bad';
        const icon = isPending ? '⏳' : '';
        const hint = allBought ? `Все ${orders} заказов этого дня выкупили` : `${linked} из ${orders} заказов этого дня выкупили${isPending ? ' (ещё идут выкупы)' : ''}`;
        convHtml = `<span class="conv ${cls}" title="${hint}">${icon}→${linked}(${pct}%)</span>`;
      } else if (!isPending) {
        // Прошло 14+ дней и ни одного выкупа — всё вернули
        convHtml = `<span class="conv conv-bad" title="Ни один заказ этого дня не был выкуплен">→0(0%)</span>`;
      }
    }

    return `<tr${zeroClass}>
  <td>${formatDate(date)}</td>
  <td class="orders-cell">
    <span class="order-bar-wrap"><span class="order-bar" style="width:${barW}px"></span></span>
    <span class="num">${orders || '—'}</span>
    <span class="conv-anchor">${convHtml}</span>
  </td>
  <td class="buyout-cell">${buyouts || '—'}</td>
  <td class="cancel-cell">${cancels || '—'}</td>
  <td class="rev">${buyouts ? fmtRub(revenue) : ''}</td>
</tr>`;
  }).join('');
}


function renderWarehouses(warehouses, isShopMode, inWayTo, inWayFrom) {
  const title = isShopMode ? 'Склады — весь магазин' : 'Склады товара';
  document.getElementById('warehouses-title').textContent = '📦 ' + title;

  let transitHtml = '';
  if (inWayTo > 0) {
    transitHtml += '<div class="wh-item wh-transit-item"><div class="wh-name">🚚 В пути до покупателя</div><div class="wh-qty wh-qty-transit">' + inWayTo + ' шт.</div></div>';
  }
  if (inWayFrom > 0) {
    transitHtml += '<div class="wh-item wh-transit-item"><div class="wh-name">↩️ Возврат от покупателя</div><div class="wh-qty wh-qty-transit">' + inWayFrom + ' шт.</div></div>';
  }

  const hasSettings = logisticsSettings.il > 0 && logisticsSettings.irp >= 0;
  const isStale = logisticsSettings.updatedAt
    ? (Date.now() - new Date(logisticsSettings.updatedAt).getTime()) > 8 * 24 * 60 * 60 * 1000
    : true;

  if (!warehouses.length) {
    let emptyHtml = transitHtml ||
      '<div style="color:var(--muted);font-size:11px;padding-top:8px">Остатков нет</div>';
    // Для товаров без остатков — выпадающее меню выбора склада
    if (!isShopMode) {
      emptyHtml += buildWarehouseSelectorHtml(hasSettings, isStale);
    }
    document.getElementById('warehouses-list').innerHTML = emptyHtml;
    if (!isShopMode) attachWarehouseSelectorEvents();
    return;
  }

  const maxQty = Math.max(...warehouses.map(w => w.qty), 1);
  let html = transitHtml + warehouses.map(w => {
    const barW = Math.round((w.qty / maxQty) * 38);
    // Расчёт стоимости логистики
    const logCost = !isShopMode ? calcLogistics(w.name) : null;
    const staleIcon = logCost !== null && isStale ? '<span class="log-stale" title="Обнови ИЛ/ИРП — они меняются каждый понедельник">&#9888;</span>' : '';
    const logHtml = logCost !== null
      ? `<div class="wh-log-cost" title="Стоимость доставки с склада ${esc(w.name)} (Формула WB с ИЛ=${logisticsSettings.il} ИРП=${logisticsSettings.irp}%)">${staleIcon}🚚 ${logCost} ₽</div>`
      : (hasSettings ? '<div class="wh-log-na">—</div>' : '');
    return `<div class="wh-item">
  <div class="wh-name" title="${esc(w.name)}">${esc(w.name)}</div>
  <div class="wh-region">${esc(w.region || '')}</div>
  <div class="wh-bar-wrap"><div class="wh-bar" style="width:${barW}px"></div></div>
  <div class="wh-qty">${w.qty} шт.</div>
  ${logHtml}
</div>`;
  }).join('');

  // Дополнительный селектор для выбора другого склада (даже если есть остатки)
  if (!isShopMode) {
    html += buildWarehouseSelectorHtml(hasSettings, isStale);
  }

  document.getElementById('warehouses-list').innerHTML = html;
  if (!isShopMode) attachWarehouseSelectorEvents();
}

// ── REGIONS TAB (product-first with accordion) ───────────────────────────────
let regionsData = null;
let regionsSortKey = 'vendorCode'; // 'vendorCode' | 'stock' | 'orders' | 'r_...'
let regionsSearchQuery = '';       // фильтр по артикулу
const expandedProducts = new Set(); // ключ строки (nmId или vendorCode)

async function renderRegions() {
  // Инициализируем кнопки сортировки только один раз
  if (!renderRegions._initDone) {
    renderRegions._initDone = true;
    document.querySelectorAll('.regions-sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        regionsSortKey = btn.dataset.sort;
        document.querySelectorAll('.regions-sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (regionsData) buildRegionsTable(regionsData);
      });
    });
    // Фильтр по артикулу
    document.getElementById('regions-search')?.addEventListener('input', e => {
      regionsSearchQuery = e.target.value.trim().toLowerCase();
      if (regionsData) buildRegionsTable(regionsData);
    });
    // Кнопка «Свернуть всё»
    document.getElementById('regions-collapse-btn')?.addEventListener('click', () => {
      expandedProducts.clear();
      if (regionsData) buildRegionsTable(regionsData);
      updateCollapseBtn();
    });
  }
  try {
    const data = await fetch(`/api/stocks?showAll=${showInactive}`).then(r => r.json());
    regionsData = data;
    buildRegionsTable(data);
  } catch (e) { console.error(e); }
}

function sortRegionsMatrix(matrix) {
  const sorted = [...matrix];
  if (regionsSortKey === 'vendorCode') {
    sorted.sort((a, b) => {
      const va = parseInt(a.vendorCode);
      const vb = parseInt(b.vendorCode);
      if (!isNaN(va) && !isNaN(vb)) return va - vb;
      return String(a.vendorCode || '').localeCompare(String(b.vendorCode || ''));
    });
  } else if (regionsSortKey === 'stock') {
    sorted.sort((a, b) => (b.total || 0) - (a.total || 0));
  } else if (regionsSortKey === 'orders') {
    const ordersMap = {};
    for (const c of allCards) ordersMap[c.nmId] = c.orders30 || c.analytics?.orders || 0;
    sorted.sort((a, b) => (ordersMap[b.nmId] || 0) - (ordersMap[a.nmId] || 0));
  } else if (regionsSortKey.startsWith('r_')) {
    // Сортировка по конкретному региону (ключ r_Центральный и т.д.)
    sorted.sort((a, b) => (b[regionsSortKey] || 0) - (a[regionsSortKey] || 0));
  }
  return sorted;
}

function buildRegionsTable(data) {
  const { regions, regionWarehouses } = data;
  // Фильтруем по артикулу если есть запрос
  const rawMatrix = regionsSearchQuery
    ? data.matrix.filter(row => String(row.vendorCode || '').toLowerCase().startsWith(regionsSearchQuery))
    : data.matrix;
  const matrix = sortRegionsMatrix(rawMatrix);
  // Только регионы, где реально есть остатки
  const activeRegions = regions.filter(r => matrix.some(row => (row[`r_${r}`] || 0) > 0));

  // Шапка: Фото | Артикул | Название | Всего | [Регион1] | [Регион2] | …
  document.getElementById('regions-thead').innerHTML = `<tr>
    <th class="photo-cell" style="width:36px"></th>
    <th style="text-align:left;min-width:100px">Артикул</th>
    <th style="text-align:left;min-width:140px">Название</th>
    <th style="min-width:55px">Всего</th>
    ${activeRegions.map(r => {
      const warehouses = (regionWarehouses[r] || []).sort();
      const whCount = warehouses.length;

      // Суммируем остатки по каждому складу региона (по всем товарам)
      const whTotals = warehouses.map(wh => ({
        name: wh,
        total: matrix.reduce((sum, row) => sum + (row[`w_${wh}`] || 0), 0),
      })).filter(w => w.total > 0).sort((a, b) => b.total - a.total);

      // HTML тултипа
      const tooltipRows = whTotals.map(w =>
        `<div class="rtt-row">
          <span class="rtt-name">${esc(w.name)}</span>
          <span class="rtt-qty">${w.total} шт.</span>
        </div>`
      ).join('');

      return `<th class="region-th" style="min-width:65px">
        ${esc(r)}${whCount > 1 ? `<br><span class="rth-sub">${whCount} скл.</span>` : ''}
        <div class="region-tooltip">
          <div class="rtt-title">📍 ${esc(r)}</div>
          ${tooltipRows || '<span style="color:var(--muted)">нет данных</span>'}
        </div>
      </th>`;
    }).join('')}
  </tr>`;

  buildRegionsBody(activeRegions, regionWarehouses, matrix);
}


function buildRegionsBody(activeRegions, regionWarehouses, matrix) {
  let html = '';

  for (const row of matrix) {
    // Пропускаем товары без остатков вообще
    const hasData = (row.total || 0) > 0 || activeRegions.some(r => (row[`r_${r}`] || 0) > 0);
    if (!hasData) continue;

    const key = String(row.nmId || row.vendorCode);
    const isExpanded = expandedProducts.has(key);
    const photoHtml = row.photo
      ? `<img src="${esc(row.photo)}" alt="" loading="lazy" onerror="this.style.opacity='.1'">`
      : '';

    const total = row.total || 0;
    const stockCls = total === 0 ? 'stock-zero' : total < 5 ? 'stock-low' : total < 20 ? 'stock-warn' : 'stock-ok';

    // Строка товара
    html += `<tr class="product-row${isExpanded ? ' expanded' : ''}" data-key="${esc(key)}">
      <td class="photo-cell">${photoHtml}</td>
      <td class="vendor-cell"><span class="expand-icon">${isExpanded ? '▼' : '▶'}</span>${esc(row.vendorCode)}${customNames[row.nmId] ? `<span class="region-custom-name">${esc(customNames[row.nmId])}</span>` : ''}</td>
      <td class="title-cell">${esc(row.title || '')}</td>
      <td class="${stockCls}" style="text-align:center;font-weight:700">${total}</td>
      ${activeRegions.map(r => {
        const v = row[`r_${r}`] || 0;
        const cls = v >= 10 ? 'cell-hot' : v >= 3 ? 'cell-med' : v > 0 ? 'cell-cold' : 'cell-zero';
        return `<td class="${cls}">${v || '—'}</td>`;
      }).join('')}
    </tr>`;

    // Раскрытая детализация складов
    if (isExpanded) {
      let detailHtml = '';
      let hasAnyWh = false;

      for (const region of activeRegions) {
        const warehouses = (regionWarehouses[region] || []).sort();
        const whsInRegion = warehouses.filter(wh => (row[`w_${wh}`] || 0) > 0);
        if (!whsInRegion.length) continue;
        hasAnyWh = true;

        detailHtml += `<div class="wh-group">
          <div class="wh-group-title">📍 ${esc(region)}</div>
          <div class="wh-grid">
            ${whsInRegion.map(wh => {
              const qty = row[`w_${wh}`] || 0;
              const wCls = qty >= 10 ? 'cell-hot' : qty >= 3 ? 'cell-med' : 'cell-cold';
              return `<div class="wh-detail-item ${wCls}">
                <span class="wh-detail-name">${esc(wh)}</span>
                <span class="wh-detail-qty">${qty} шт.</span>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }

      if (!hasAnyWh) {
        detailHtml = '<span style="color:var(--muted);font-size:11px">Нет данных по конкретным складам</span>';
      }

      // Считаем кол-во регионов с остатками (определяет размер фото)
      const regionCount = activeRegions.filter(r => (row[`r_${r}`] || 0) > 0).length;
      const photoW = regionCount <= 2 ? 100 : regionCount <= 3 ? 130 : 160;

      // Фото товара для превью (photoBig — лучшее качество, photo — запасной)
      const previewSrc = row.photoBig || row.photo || '';
      const photoBlock = previewSrc
        ? `<div class="wh-preview-photo" style="width:${photoW}px">
             <img src="${esc(previewSrc)}" alt="${esc(row.vendorCode)}"
                  style="width:${photoW}px"
                  onerror="this.style.opacity='.15'">
           </div>`
        : '';

      html += `<tr class="warehouse-details-row">
        <td colspan="${4 + activeRegions.length}">
          <div class="warehouse-details-container">
            ${photoBlock}
            <div class="wh-detail-content">
              ${detailHtml}
            </div>
          </div>
        </td>
      </tr>`;
    }
  }

  document.getElementById('regions-tbody').innerHTML = html;
  updateCollapseBtn();

  // Обработчики клика: раскрытие/свёртка строки товара
  document.querySelectorAll('#regions-tbody .product-row').forEach(row => {
    row.addEventListener('click', () => {
      const k = row.dataset.key;
      if (expandedProducts.has(k)) expandedProducts.delete(k);
      else expandedProducts.add(k);
      const { regions, regionWarehouses } = regionsData;
      // Применяем тот же фильтр поиска, что и в buildRegionsTable
      const filteredMatrix = regionsSearchQuery
        ? regionsData.matrix.filter(row => String(row.vendorCode || '').toLowerCase().startsWith(regionsSearchQuery))
        : regionsData.matrix;
      const sortedMatrix = sortRegionsMatrix(filteredMatrix);
      const activeRegions = regions.filter(r => sortedMatrix.some(m => (m[`r_${r}`] || 0) > 0));
      buildRegionsBody(activeRegions, regionWarehouses, sortedMatrix);
    });
  });
}

// ── COLLAPSE BTN STATE ────────────────────────────────────────────────────────
function updateCollapseBtn() {
  const btn = document.getElementById('regions-collapse-btn');
  if (!btn) return;
  const hasAny = expandedProducts.size > 0;
  btn.classList.toggle('has-expanded', hasAny);
  btn.title = hasAny ? `Свернуть всё (раскрыто: ${expandedProducts.size})` : 'Свернуть все раскрытые товары';
}

// ── UTILS ──────────────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(n) { return (n||0).toLocaleString('ru-RU'); }
function fmtRub(n) { return (n||0).toLocaleString('ru-RU') + ' ₽'; }
function formatDate(d) {
  if (!d) return '—';
  const [,m,day] = d.split('-');
  const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  return `${parseInt(day)} ${months[parseInt(m)-1]}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showLoader(show, text) {
  const el = document.getElementById('loader');
  el.classList.toggle('hidden', !show);
  if (show && text) document.getElementById('loader-status').textContent = text;
}

function updateUpdatedLabel(iso) {
  if (!iso) return;
  const d = new Date(iso);
  document.getElementById('updated-label').textContent =
    `Обновлено в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── CUSTOM NAMES (пользовательские названия товаров) ──────────────────────────
async function loadCustomNames() {
  // Сначала из localStorage (быстро)
  try {
    const stored = localStorage.getItem('wb_custom_names');
    if (stored) customNames = JSON.parse(stored);
  } catch (e) {}
  // Потом обновляем с сервера (надёжно)
  try {
    const res = await fetch('/api/custom-names');
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        customNames = data;
        localStorage.setItem('wb_custom_names', JSON.stringify(customNames));
      }
    }
  } catch (e) { /* server might not support it yet */ }
}

let saveTimer;
function saveCustomNames() {
  // Сохраняем в localStorage сразу
  localStorage.setItem('wb_custom_names', JSON.stringify(customNames));
  // На сервер — с debounce (500ms)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fetch('/api/custom-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customNames),
      });
    } catch (e) { console.warn('save custom names:', e.message); }
  }, 500);
}

// ── SESSION MODAL ──────────────────────────────────────────────────────────────────
function initSessionModal() {
  document.getElementById('session-close-btn')?.addEventListener('click', closeSessionModal);
  document.getElementById('session-modal')?.addEventListener('click', e => {
    if (e.target.id === 'session-modal') closeSessionModal();
  });
  document.getElementById('session-save-btn')?.addEventListener('click', saveSession);
  document.getElementById('session-refresh-auth-btn')?.addEventListener('click', refreshAuth);
  // Показать статус сессии при загрузке
  fetch('/api/seller-session/status').then(r => r.json()).then(d => {
    const btn = document.getElementById('spp-session-btn');
    if (btn) btn.style.opacity = d.ok ? '1' : '0.5';
  }).catch(() => {});
}

function openSessionModal() {
  const modal = document.getElementById('session-modal');
  modal?.classList.remove('hidden');
  // Показать текущий статус
  fetch('/api/seller-session/status').then(r => r.json()).then(d => {
    setSessionStatus(d.ok
      ? `✅ Сессия активна. Обновлена: ${new Date(d.updatedAt).toLocaleString('ru-RU')}. wbxRefresh: ${d.hasRefreshToken ? 'есть (до июля 2026)' : 'нет'}`
      : '⚠️ Сессия не настроена. СПП берётся из заказов (fallback).',
      d.ok
    );
  }).catch(() => setSessionStatus('ℹ️ Статус недоступен', false));
}

function closeSessionModal() {
  document.getElementById('session-modal')?.classList.add('hidden');
}

function setSessionStatus(text, ok) {
  const bar = document.getElementById('session-status-bar');
  if (!bar) return;
  bar.textContent = text;
  bar.className = 'session-status ' + (ok ? 'status-ok' : 'status-warn');
}

async function saveSession() {
  const authorizev3      = document.getElementById('inp-authorizev3')?.value.trim();
  const wbxRefresh       = document.getElementById('inp-wbxRefresh')?.value.trim();
  const wbxValidationKey = document.getElementById('inp-wbxValidationKey')?.value.trim();
  const cfidsWb          = document.getElementById('inp-cfidsWb')?.value.trim();
  const zzatwWb          = document.getElementById('inp-zzatwWb')?.value.trim();

  if (!authorizev3 || !wbxRefresh) {
    setSessionStatus('❌ Заполни authorizev3 и wbx-refresh.', false);
    return;
  }
  const btn = document.getElementById('session-save-btn');
  btn.disabled = true; btn.textContent = 'Сохраняю…';
  try {
    const res = await fetch('/api/seller-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorizev3, wbxRefresh, wbxValidationKey, cfidsWb, zzatwWb }),
    });
    const d = await res.json();
    if (d.ok) {
      setSessionStatus('✅ ' + d.message, true);
      document.getElementById('spp-session-btn').style.opacity = '1';
      toast('✅ Сессия сохранена! Нажми «Обновить» для загрузки реальной СПП.');
    } else {
      setSessionStatus('❌ ' + (d.error || 'Ошибка'), false);
    }
  } catch(e) {
    setSessionStatus('❌ Ошибка: ' + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = '💾 Сохранить сессию';
  }
}

async function refreshAuth() {
  const btn = document.getElementById('session-refresh-auth-btn');
  btn.disabled = true; btn.textContent = 'Обновляю…';
  try {
    const res = await fetch('/api/seller-session/refresh-auth', { method: 'POST' });
    const d = await res.json();
    setSessionStatus((d.ok ? '✅ ' : '⚠️ ') + d.message, d.ok);
    if (d.ok) toast('✅ Токен обновлён!');
  } catch(e) {
    setSessionStatus('❌ ' + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = '🔄 Авто-обновить токен';
  }
}

// ── ADS TAB ───────────────────────────────────────────────────────────────────
let adsDays = 7;
const expandedCampaigns = new Set();

function initAdsTab() {
  // Кнопки периода
  document.querySelectorAll('.ads-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ads-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      adsDays = parseInt(btn.dataset.days);
      loadAds(true);
    });
  });
  // Кнопка обновить
  document.getElementById('ads-refresh-btn')?.addEventListener('click', () => loadAds(true, true));
}

async function loadAds(forceRefresh = false, hardRefresh = false) {
  adsShowState('loading');
  const btn = document.getElementById('ads-refresh-btn');
  if (btn) btn.classList.add('spinning');

  try {
    if (hardRefresh) {
      await fetch(`/api/ads/refresh?days=${adsDays}`, { method: 'POST' });
      await sleep(2000); // даём секунду стартовать
    }
    const res = await fetch(`/api/ads?days=${adsDays}`).then(r => r.json());

    if (res.error) throw new Error(res.error);

    if (res.updatedAt) {
      const d = new Date(res.updatedAt);
      const el = document.getElementById('ads-updated-label');
      if (el) el.textContent = `Обновлено в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    }

    if (res.empty || !res.campaigns?.length) {
      adsShowState('empty');
    } else {
      renderAdsTable(res.campaigns);
      adsShowState('table');
    }
  } catch (e) {
    document.getElementById('ads-error-text').textContent = e.message;
    adsShowState('error');
    toast('❌ Реклама: ' + e.message);
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

function adsShowState(state) {
  document.getElementById('ads-loading').classList.toggle('hidden', state !== 'loading');
  document.getElementById('ads-empty').classList.toggle('hidden', state !== 'empty');
  document.getElementById('ads-error').classList.toggle('hidden', state !== 'error');
  document.getElementById('ads-table-wrap').classList.toggle('hidden', state !== 'table');
}

function renderAdsTable(campaigns) {
  const tbody = document.getElementById('ads-tbody');
  tbody.innerHTML = '';

  for (const c of campaigns) {
    const statusCls = c.status === 9 ? 'ads-status-active' : c.status === 11 ? 'ads-status-pause' : 'ads-status-other';
    const hasKw = c.keywords?.length > 0;
    const isExpanded = expandedCampaigns.has(c.id);

    // Строка кампании
    const tr = document.createElement('tr');
    tr.className = 'ads-campaign-row' + (isExpanded ? ' expanded' : '');
    tr.dataset.id = c.id;
    tr.innerHTML = `
      <td class="ads-expand-col">
        ${hasKw ? `<span class="ads-expand-icon">${isExpanded ? '▼' : '▶'}</span>` : ''}
      </td>
      <td class="ads-name-col" title="${esc(c.name)}">${esc(c.name)}</td>
      <td><span class="ads-type-badge">${esc(c.typeLabel)}</span></td>
      <td><span class="ads-status ${statusCls}">${esc(c.statusLabel)}</span></td>
      <td class="ads-num">${fmt(c.views)}</td>
      <td class="ads-num">${fmt(c.clicks)}</td>
      <td class="ads-num ${c.ctr >= 1 ? 'ads-ctr-good' : ''}">${c.ctr ? c.ctr.toFixed(2) + '%' : '—'}</td>
      <td class="ads-num">${c.sum ? fmtRub(Math.round(c.sum)) : '—'}</td>
      <td class="ads-num">${c.cpc ? c.cpc.toFixed(1) + ' ₽' : '—'}</td>
      <td class="ads-num">${c.orders || '—'}</td>
    `;

    if (hasKw) {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => {
        if (expandedCampaigns.has(c.id)) expandedCampaigns.delete(c.id);
        else expandedCampaigns.add(c.id);
        renderAdsTable(campaigns);
      });
    }
    tbody.appendChild(tr);

    // Раскрытые ключевые слова
    if (isExpanded && hasKw) {
      const kwTr = document.createElement('tr');
      kwTr.className = 'ads-keywords-row';
      const maxViews = Math.max(...c.keywords.map(k => k.views), 1);
      kwTr.innerHTML = `
        <td colspan="10">
          <div class="ads-keywords-wrap">
            <table class="ads-keywords-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Запрос</th>
                  <th>Показы</th>
                  <th>Клики</th>
                  <th>CTR</th>
                  <th>Расход</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${c.keywords.map((k, i) => {
                  const barW = Math.round((k.views / maxViews) * 120);
                  return `<tr>
                    <td class="kw-rank">${i + 1}</td>
                    <td class="kw-word">${esc(k.keyword)}</td>
                    <td class="kw-num">${fmt(k.views)}</td>
                    <td class="kw-num">${fmt(k.clicks)}</td>
                    <td class="kw-num ${k.ctr >= 1 ? 'ads-ctr-good' : ''}">${k.ctr ? k.ctr.toFixed(2) + '%' : '—'}</td>
                    <td class="kw-num">${k.sum ? Math.round(k.sum) + ' ₽' : '—'}</td>
                    <td class="kw-bar-cell"><div class="kw-bar" style="width:${barW}px"></div></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </td>
      `;
      tbody.appendChild(kwTr);
    }
  }
}

// ── SEARCH QUERIES / POSITION TRACKER ────────────────────────────────────────
let currentPanelView = 'stats'; // 'stats' | 'queries'
let posKeywords = [];           // [{ query, position, totalResults, found, checkedAt, error }]
let posNmId = null;             // nmId для которого загружены запросы
let posChecking = false;        // идёт проверка

function initPanelTabs() {
  document.querySelectorAll('.panel-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchPanelView(btn.dataset.panel);
    });
  });
}

function switchPanelView(view) {
  currentPanelView = view;
  const isStats = view === 'stats';
  document.getElementById('panel-body').classList.toggle('hidden', !isStats);
  document.getElementById('panel-queries').classList.toggle('hidden', isStats);
  if (view === 'queries' && selectedNmId && selectedNmId !== posNmId) {
    loadKeywords(selectedNmId);
  }
}

// ── Загрузка сохранённых запросов + автодобавление из рекламы + из WB analytics ──
async function loadKeywords(nmId) {
  posNmId = nmId;
  try {
    const data = await fetch(`/api/keywords/${nmId}`).then(r => r.json());
    posKeywords = data.keywords || [];
    // Пробуем автодобавить запросы из рекламных кампаний
    await autoImportFromAds(nmId);
    // Автодобавить запросы из WB seller portal (вкладка «Продвижение»)
    await autoImportFromWB(nmId);
    renderKeywords();
  } catch(e) {
    console.warn('loadKeywords:', e);
    posKeywords = [];
    renderKeywords();
  }
}

// ── Автоимпорт поисковых запросов из WB analytics (seller-портал) ──
async function autoImportFromWB(nmId) {
  try {
    const res = await fetch(`/api/search-texts/${nmId}`);
    if (!res.ok) {
      if (res.status === 400) console.log('search-texts: no seller session');
      return;
    }
    const data = await res.json();
    const phrases = data?.data?.phrases || [];
    if (!phrases.length) return;

    let added = 0;
    for (const p of phrases) {
      const q = (p.phrase || '').trim();
      if (!q) continue;
      const exists = posKeywords.find(k => k.query.toLowerCase() === q.toLowerCase());
      if (exists) {
        // Обновляем данные WB для существующего запроса
        exists.wbCount = p.count;
        exists.wbDynamic = p.dynamic;
        exists.wbPosition = p.position;
        if (!exists.source) exists.source = 'wb';
        continue;
      }
      posKeywords.push({
        query: q,
        position: null,
        totalResults: null,
        found: null,
        checkedAt: null,
        source: 'wb',
        wbCount: p.count,
        wbDynamic: p.dynamic,
        wbPosition: p.position,
      });
      added++;
    }
    if (added > 0) {
      console.log(`✅ Auto-imported ${added} keywords from WB search-texts`);
      await saveKeywords();
    }
  } catch(e) { console.warn('autoImportFromWB:', e.message); }
}

// ── Добавить новый запрос ──
function posAddQuery() {
  const inp = document.getElementById('pos-query-input');
  const val = (inp?.value || '').trim();
  if (!val) return;
  if (posKeywords.find(k => k.query.toLowerCase() === val.toLowerCase())) {
    toast('⚠️ Запрос уже добавлен');
    inp.value = '';
    return;
  }
  posKeywords.push({ query: val, position: null, totalResults: null, found: null, checkedAt: null });
  inp.value = '';
  renderKeywords();
  saveKeywords();
}

// ── Удалить запрос ──
function posDeleteQuery(idx) {
  posKeywords.splice(idx, 1);
  renderKeywords();
  saveKeywords();
}

// ── Сохранить список запросов на сервер ──
async function saveKeywords() {
  if (!posNmId) return;
  try {
    await fetch(`/api/keywords/${posNmId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: posKeywords }),
    });
  } catch(e) { console.warn('saveKeywords:', e); }
}

// ── Автоимпорт запросов из рекламных кампаний этого товара ──
async function autoImportFromAds(nmId) {
  try {
    const adsData = await fetch('/api/ads?days=30').then(r => r.json()).catch(() => null);
    if (!adsData?.campaigns?.length) return;

    const card = allCards.find(c => c.nmId === nmId);
    const vendorCode = card?.vendorCode || '';
    const titleWords = (card?.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);

    let added = 0;
    for (const campaign of adsData.campaigns) {
      // Берём ключи из кампаний у которых есть ключевые слова
      for (const kw of (campaign.keywords || [])) {
        const q = (kw.keyword || '').trim().toLowerCase();
        if (!q || q.length < 4) continue;
        // Добавляем только если запрос релевантен товару (перекрывается по словам)
        const qWords = q.split(/\s+/);
        const isRelevant = qWords.some(w => titleWords.some(tw => tw.includes(w) || w.includes(tw)));
        if (!isRelevant && !q.includes('декор') && !q.includes('панно') && !q.includes('wall')) continue;
        if (!posKeywords.find(k => k.query.toLowerCase() === q)) {
          posKeywords.push({ query: kw.keyword.trim(), position: null, totalResults: null, found: null, checkedAt: null, source: 'ads' });
          added++;
        }
      }
    }
    if (added > 0) {
      console.log(`✅ Auto-imported ${added} keywords from ads`);
      await saveKeywords();
    }
  } catch(e) { console.warn('autoImportFromAds:', e.message); }
}

// (duplicate checkAllPositions removed — see below)

// ── Состояние rate limit ──
let rateLimitUntil = 0;    // timestamp когда разблокируется
let rateLimitTimer = null; // таймер обратного отсчёта

function setRateLimit(seconds = 180) {
  rateLimitUntil = Date.now() + seconds * 1000;
  clearInterval(rateLimitTimer);
  const statusEl = document.getElementById('pos-status');
  rateLimitTimer = setInterval(() => {
    const left = Math.ceil((rateLimitUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(rateLimitTimer);
      rateLimitTimer = null;
      if (statusEl) statusEl.textContent = '✅ WB разблокирован — можно проверять';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
    } else {
      if (statusEl) statusEl.textContent = `⏳ WB лимит — подождите ${left} сек.`;
    }
  }, 1000);
}

// ── Проверка позиции через сервер (который использует CDP браузер или Node.js fetch) ──
async function checkPositionViaServer(nmId, query) {
  // Если знаем что лимит ещё активен — сразу сообщаем
  if (Date.now() < rateLimitUntil) throw new Error('rate_limited');

  const MAX_PAGES = 3; // максимум 3 страницы (300 позиций)
  let position = null, totalResults = 0, found = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `/api/search-positions?nmId=${nmId}&query=${encodeURIComponent(query)}&page=${page}`
    ).then(r => r.json());

    if (res.rateLimited) {
      setRateLimit(180);
      throw new Error('rate_limited');
    }
    if (res.error) throw new Error(res.error);
    if (page === 1) totalResults = res.totalResults || 0;
    if (res.found) { found = true; position = res.position; break; }
    if ((res.pageSize || 0) < 100) break;
    await sleep(4000); // 4 сек между страницами
  }

  return { position, totalResults, found, checkedAt: new Date().toISOString(), error: null };
}

// ── Проверить все позиции ──
async function checkAllPositions() {
  if (!posNmId || !posKeywords.length || posChecking) return;
  posChecking = true;

  const checkBtn = document.getElementById('pos-check-btn');
  const statusEl = document.getElementById('pos-status');
  if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = '⏳ Проверяем…'; }

  // НЕ скрываем таблицу — показываем результаты по мере поступления
  document.getElementById('queries-loading').classList.add('hidden');
  document.getElementById('queries-table-wrap').classList.remove('hidden');
  document.getElementById('queries-empty').classList.add('hidden');

  let done = 0;
  const total = posKeywords.length;

  for (let i = 0; i < posKeywords.length; i++) {
    const kw = posKeywords[i];
    const remaining = total - i - 1;
    if (statusEl) statusEl.textContent = `${i + 1}/${total}: «${kw.query.slice(0, 30)}»…`;

    try {
      const result = await checkPositionViaServer(posNmId, kw.query);
      posKeywords[i] = { ...kw, ...result };
      done++;
    } catch(e) {
      posKeywords[i] = { ...kw, error: e.message, checkedAt: new Date().toISOString() };
      // Если rate limited — останавливаем
      if (e.message === 'rate_limited') {
        for (let j = i + 1; j < posKeywords.length; j++) {
          posKeywords[j] = { ...posKeywords[j], error: 'rate_limited', checkedAt: new Date().toISOString() };
        }
        renderKeywords();
        break;
      }
    }

    renderKeywords();

    if (i < posKeywords.length - 1) await sleep(5000); // 5 сек между запросами
  }

  await saveKeywords();
  posChecking = false;
  if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = '🔍 Проверить все'; }
  if (statusEl) {
    statusEl.textContent = `✅ Готово (${done}/${total})`;
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
  }
}

// ── Проверка одного запроса (кнопка ↻ в строке) ──
async function checkOnePosition(idx) {
  if (posChecking || !posNmId) return;
  const kw = posKeywords[idx];
  if (!kw) return;

  posKeywords[idx] = { ...kw, error: null };
  renderKeywords();

  try {
    const result = await checkPositionViaServer(posNmId, kw.query);
    posKeywords[idx] = { ...posKeywords[idx], ...result };
  } catch(e) {
    posKeywords[idx] = { ...posKeywords[idx], error: e.message, checkedAt: new Date().toISOString() };
  }

  renderKeywords();
  saveKeywords();
}

// ── Рендер таблицы запросов ──
function renderKeywords() {
  const hasKeywords = posKeywords.length > 0;

  document.getElementById('queries-empty').classList.toggle('hidden', hasKeywords);
  document.getElementById('queries-table-wrap').classList.toggle('hidden', !hasKeywords);
  document.getElementById('queries-loading').classList.add('hidden');

  if (!hasKeywords) return;

  const tbody = document.getElementById('queries-tbody');
  tbody.innerHTML = posKeywords.map((kw, i) => {
    const checkedStr = kw.checkedAt
      ? new Date(kw.checkedAt).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
      : '—';

    let posBadge = '', posClass = '';
    const wbUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(kw.query)}`;

    if (kw.error === 'rate_limited') {
      posBadge = `<span class="pos-badge pos-error kw-manual-btn" data-idx="${i}" title="WB временно ограничил запросы.\nНажми 🔗 чтобы найти позицию вручную\nили кликни сюда чтобы ввести позицию">⏳ лимит</span>`;
    } else if (kw.error) {
      posBadge = `<span class="pos-badge pos-error kw-manual-btn" data-idx="${i}" title="${esc(kw.error)}. Нажми чтобы ввести позицию вручную">⚠️ ошибка</span>`;
    } else if (!kw.checkedAt) {
      posBadge = `<span class="pos-badge pos-unknown kw-manual-btn" data-idx="${i}" title="Нажми ↻ для автопроверки или кликни сюда чтобы ввести вручную">не проверен</span>`;
    } else if (!kw.found) {
      posBadge = `<span class="pos-badge pos-notfound kw-manual-btn" data-idx="${i}" title="Не найден в топ-500. Нажми чтобы ввести позицию вручную">не найден</span>`;
      posClass = 'q-row-notfound';
    } else {
      const p = kw.position;
      const cls = p <= 10 ? 'pos-top10' : p <= 30 ? 'pos-top30' : p <= 100 ? 'pos-top100' : 'pos-far';
      const icon = p <= 10 ? '🏆' : p <= 30 ? '🥈' : p <= 100 ? '📍' : '📉';
      posBadge = `<span class="pos-badge ${cls} kw-manual-btn" data-idx="${i}" title="Нажми чтобы изменить позицию вручную">${icon} ${p}</span>`;
      posClass = p <= 10 ? 'q-row-top' : '';
    }


    const srcBadge = kw.source === 'wb' ? '<span class="kw-src-badge kw-src-wb" title="Из WB аналитики (Продвижение)">🔎</span> '
      : kw.source === 'ads' ? '<span class="kw-src-badge" title="Из рекламной кампании">📣</span> ' : '';
    // WB orders count badge
    const wbCountHtml = kw.wbCount != null ? `<span class="kw-wb-count" title="Заказов по этому запросу (WB данные)">${kw.wbCount}</span>` : '';
    const wbDynHtml = kw.wbDynamic != null ? `<span class="kw-wb-dyn ${kw.wbDynamic > 0 ? 'dyn-up' : kw.wbDynamic < 0 ? 'dyn-down' : 'dyn-flat'}" title="Динамика заказов">${kw.wbDynamic > 0 ? '+' : ''}${kw.wbDynamic}</span>` : '';

    return `<tr class="q-kw-row ${posClass}" data-idx="${i}">
      <td class="q-rank">${i + 1}</td>
      <td class="q-keyword">${srcBadge}${esc(kw.query)}</td>
      <td class="q-num">${posBadge}</td>
      <td class="q-num q-wb-orders">${wbCountHtml}${wbDynHtml}</td>
      <td class="q-num q-date">${checkedStr}</td>
      <td class="q-del">
        <a class="pos-wb-btn" href="${wbUrl}" target="_blank" title="Найти на Wildberries">🔗</a>
        <button class="pos-one-btn" data-idx="${i}" title="Проверить позицию">↻</button>
        <button class="pos-del-btn" data-idx="${i}" title="Удалить">✕</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.pos-del-btn').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); posDeleteQuery(parseInt(btn.dataset.idx)); })
  );
  tbody.querySelectorAll('.pos-one-btn').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); checkOnePosition(parseInt(btn.dataset.idx)); })
  );
  // Клик по бейджу — ручной ввод позиции
  tbody.querySelectorAll('.kw-manual-btn').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); manualEnterPosition(parseInt(btn.dataset.idx)); })
  );
}

// ── Ручной ввод позиции ──
function manualEnterPosition(idx) {
  const kw = posKeywords[idx];
  if (!kw) return;
  const cur = kw.position ? String(kw.position) : '';
  const input = prompt(`Введи позицию для запроса:\n"${kw.query}"\n\n(оставь пустым чтобы отметить "не найден")`, cur);
  if (input === null) return; // отмена
  const pos = parseInt(input.trim());
  if (input.trim() === '') {
    posKeywords[idx] = { ...kw, position: null, found: false, checkedAt: new Date().toISOString(), error: null };
  } else if (!isNaN(pos) && pos > 0) {
    posKeywords[idx] = { ...kw, position: pos, found: true, checkedAt: new Date().toISOString(), error: null };
  } else {
    toast('⚠️ Введи число больше 0');
    return;
  }
  renderKeywords();
  saveKeywords();
}


// ── Инициализация UI панели запросов ──
function initQueriesPanel() {
  document.getElementById('pos-add-btn')?.addEventListener('click', posAddQuery);
  document.getElementById('pos-query-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); posAddQuery(); }
  });
  const chkBtn = document.getElementById('pos-check-btn');
  if (chkBtn) {
    chkBtn.textContent = '🔍 Проверить все';
    chkBtn.addEventListener('click', checkAllPositions);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ── SEARCH WB TAB (частотность запросов + выдача) ─────────────────────────
// ══════════════════════════════════════════════════════════════════════════
let searchFreqResults = [];      // [{ text, frequency, frequencyDynamic, avgFrequency, priorityItem }]
let searchFreqSelected = null;   // выбранный запрос (индекс)
let searchFreqInterval = 'yesterday';
let searchFreqInput = '';        // текущий текст в поле ввода
let searchShowOwn = false;       // показывать только свои товары
let searchOwnNmIds = new Set();  // nmId наших товаров

function initSearchTab() {
  // Ввод запроса
  const inp = document.getElementById('search-freq-input');
  if (inp) {
    let debounce;
    inp.addEventListener('input', () => {
      clearTimeout(debounce);
      searchFreqInput = inp.value.trim();
      debounce = setTimeout(() => {
        if (searchFreqInput.length >= 2) searchFrequency(searchFreqInput);
      }, 400);
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(debounce);
        searchFreqInput = inp.value.trim();
        if (searchFreqInput) searchFrequency(searchFreqInput);
      }
    });
  }

  // Кнопки интервала
  document.querySelectorAll('.search-interval-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.search-interval-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      searchFreqInterval = btn.dataset.interval;
      if (searchFreqInput) searchFrequency(searchFreqInput);
    });
  });

  // Чекбокс «Свои»
  document.getElementById('search-own-check')?.addEventListener('change', e => {
    searchShowOwn = e.target.checked;
    if (searchFreqSelected !== null) {
      searchShowDetail(searchFreqResults[searchFreqSelected]);
    }
  });

  // Кэшируем nmId наших товаров
  buildOwnNmIds();
}

function buildOwnNmIds() {
  searchOwnNmIds = new Set(allCards.map(c => c.nmId));
}

// ── Запрос частотности ──
async function searchFrequency(text) {
  buildOwnNmIds();
  searchFreqSelected = null;

  const listEl = document.getElementById('search-freq-list');
  const emptyEl = document.getElementById('search-freq-empty');
  const loadEl = document.getElementById('search-freq-loading');
  const labelWrap = document.getElementById('search-freq-label-wrap');
  const detailEmpty = document.getElementById('search-detail-empty');
  const detailContent = document.getElementById('search-detail-content');

  emptyEl?.classList.add('hidden');
  listEl?.classList.add('hidden');
  loadEl?.classList.remove('hidden');
  labelWrap?.classList.add('hidden');
  detailEmpty?.classList.remove('hidden');
  detailContent?.classList.add('hidden');

  try {
    const res = await fetch('/api/search-frequency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchText: text,
        interval: searchFreqInterval,
        limit: 50,
        offset: 0,
        orderBy: { field: 'frequency', mode: 'desc' },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    searchFreqResults = data?.data?.phrases || data?.data || [];

    loadEl?.classList.add('hidden');

    if (!searchFreqResults.length) {
      emptyEl?.classList.remove('hidden');
      emptyEl.innerHTML = `
        <div class="search-empty-icon">🤷</div>
        <p>Нет результатов для «${esc(text)}»</p>
        <p class="search-empty-hint">Попробуй другой запрос</p>
      `;
      return;
    }

    renderSearchFreqList();
    listEl?.classList.remove('hidden');
    labelWrap?.classList.remove('hidden');

  } catch (e) {
    loadEl?.classList.add('hidden');
    emptyEl?.classList.remove('hidden');
    emptyEl.innerHTML = `
      <div class="search-empty-icon">⚠️</div>
      <p>Ошибка: ${esc(e.message)}</p>
      <p class="search-empty-hint">Проверь сессию продавца (🔑 СПП)</p>
    `;
    console.warn('searchFrequency:', e);
  }
}

// ── Рендер списка запросов с частотностью ──
function renderSearchFreqList() {
  const listEl = document.getElementById('search-freq-list');
  if (!listEl) return;

  const maxFreq = Math.max(...searchFreqResults.map(r => r.frequency || 0), 1);

  listEl.innerHTML = searchFreqResults.map((r, i) => {
    const barW = Math.round(((r.frequency || 0) / maxFreq) * 100);
    const dynVal = r.frequencyDynamic ?? r.dynamic ?? 0;
    const dynCls = dynVal > 0 ? 'dyn-up' : dynVal < 0 ? 'dyn-down' : 'dyn-flat';
    const dynStr = dynVal > 0 ? `+${dynVal}%` : dynVal < 0 ? `${dynVal}%` : '—';
    const activeClass = i === searchFreqSelected ? ' active' : '';

    return `<div class="search-freq-item${activeClass}" data-idx="${i}">
      <div class="search-freq-text" title="${esc(r.text)}">${esc(r.text)}</div>
      <div class="search-freq-bar-wrap"><div class="search-freq-bar" style="width:${barW}%"></div></div>
      <div class="search-freq-num">${fmt(r.frequency || 0)}</div>
      <div class="search-freq-dynamic ${dynCls}">${dynStr}</div>
    </div>`;
  }).join('');

  // Обработчики клика
  listEl.querySelectorAll('.search-freq-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      searchFreqSelected = idx;
      // Подсветить активный
      listEl.querySelectorAll('.search-freq-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      // Показать детали
      searchShowDetail(searchFreqResults[idx]);
    });
  });
}

// ── Показать детали по выбранному запросу (правая панель) ──
async function searchShowDetail(queryData) {
  if (!queryData) return;

  const detailEmpty = document.getElementById('search-detail-empty');
  const detailContent = document.getElementById('search-detail-content');
  const detailLoading = document.getElementById('search-detail-loading');
  const detailProducts = document.getElementById('search-detail-products');

  detailEmpty?.classList.add('hidden');
  detailContent?.classList.remove('hidden');

  // Заголовок
  document.getElementById('search-detail-query').textContent = queryData.text || '';
  document.getElementById('search-detail-freq').textContent = `${fmt(queryData.frequency || 0)} запросов`;

  // Показать загрузку
  detailLoading?.classList.remove('hidden');
  detailProducts.innerHTML = Array(6).fill('<div class="search-product-shimmer"></div>').join('');

  try {
    // Ищем товары по этому запросу через WB поиск
    const q = encodeURIComponent(queryData.text);
    // Используем search.wb.ru через серверный прокси
    const searchRes = await fetch(`/api/search-positions?nmId=0&query=${q}&page=1`).then(r => r.json()).catch(() => null);

    detailLoading?.classList.add('hidden');

    if (searchRes?.rateLimited) {
      detailProducts.innerHTML = `
        <div class="search-no-results">
          <p>⏳ WB временно ограничил запросы</p>
          <p style="font-size:12px;color:var(--muted);margin-top:8px">Лимит сбросится через <span id="retry-countdown">30</span> сек.</p>
          <button id="retry-search-btn" style="margin-top:12px;padding:8px 20px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">🔄 Повторить сейчас</button>
        </div>
      `;
      // Кнопка повторить
      document.getElementById('retry-search-btn')?.addEventListener('click', () => {
        searchShowDetail(queryData);
      });
      // Обратный отсчёт + авто-повтор
      let sec = 30;
      const cntEl = document.getElementById('retry-countdown');
      const timer = setInterval(() => {
        sec--;
        if (cntEl) cntEl.textContent = sec;
        if (sec <= 0) {
          clearInterval(timer);
          searchShowDetail(queryData);
        }
      }, 1000);
      return;
    }

    if (!searchRes || searchRes.error) {
      // Fallback: покажем что поиск через WB не удался, но покажем данные из WB аналитики
      detailProducts.innerHTML = `
        <div class="search-no-results">
          <p>⚠️ Не удалось загрузить выдачу WB</p>
          <p style="font-size:12px;color:var(--muted);margin-top:8px">${esc(searchRes?.error || 'Ошибка подключения')}</p>
          <p style="font-size:12px;color:var(--muted);margin-top:4px">Попробуйте позже или запустите Яндекс.Браузер через start_with_browser.bat</p>
        </div>
      `;
      return;
    }

    // Показать кол-во результатов
    const totalEl = document.getElementById('search-detail-freq');
    if (totalEl && searchRes.totalResults) {
      totalEl.textContent = `${fmt(queryData.frequency || 0)} запросов · ${fmt(searchRes.totalResults)} товаров`;
    }

    // У searchRes.products — массив товаров из выдачи
    const products = searchRes.products || [];
    renderSearchProducts(products, queryData.text);

  } catch (e) {
    detailLoading?.classList.add('hidden');
    detailProducts.innerHTML = `
      <div class="search-no-results">
        <p>⚠️ Ошибка: ${esc(e.message)}</p>
      </div>
    `;
  }
}

// ── Рендер товаров из выдачи WB ──
function renderSearchProducts(products, query) {
  const container = document.getElementById('search-detail-products');
  if (!container) return;

  if (!products.length) {
    container.innerHTML = `
      <div class="search-no-results">
        <p>Нет товаров в выдаче</p>
        <p style="font-size:12px;color:var(--muted);margin-top:6px">Попробуйте другой запрос</p>
      </div>
    `;
    return;
  }

  // Если "Свои" — фильтруем только наши
  const filtered = searchShowOwn
    ? products.filter(p => searchOwnNmIds.has(p.id))
    : products;

  if (!filtered.length && searchShowOwn) {
    container.innerHTML = `
      <div class="search-no-results">
        <p>Ваших товаров нет в первых ${products.length} позициях</p>
        <p style="font-size:12px;color:var(--muted);margin-top:6px">Снимите галочку «Свои товары» чтобы увидеть всю выдачу</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((p, idx) => {
    const isOwn = searchOwnNmIds.has(p.id);
    const ownClass = isOwn ? ' own-product' : '';
    // Фото из basket
    const photoUrl = getProductPhotoUrl(p.id);
    // Цена
    const price = p.salePriceU ? Math.round(p.salePriceU / 100) : (p.priceU ? Math.round(p.priceU / 100) : 0);
    const origPrice = p.priceU ? Math.round(p.priceU / 100) : 0;
    const hasDiscount = origPrice > price && price > 0;
    // Позиция в выдаче
    const pos = p._position || (idx + 1);

    return `<div class="search-product-card${ownClass}">
      <div class="search-product-pos">${pos}</div>
      <img class="search-product-photo" src="${esc(photoUrl)}" alt="" loading="lazy" onerror="this.style.opacity='.15'">
      <div class="search-product-info">
        <div class="search-product-name" title="${esc(p.name || '')}">${esc(p.name || `Товар #${p.id}`)}</div>
        <div class="search-product-meta">${esc(p.brand || '')} · ${p.id}${isOwn ? ' · <b style="color:var(--accent)">ВАШ ТОВАР</b>' : ''}</div>
      </div>
      <div>
        <span class="search-product-price">${price ? fmt(price) + ' ₽' : '—'}</span>
        ${hasDiscount ? `<span class="search-product-old-price">${fmt(origPrice)} ₽</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── Генерация URL фото товара ──
function getProductPhotoUrl(nmId) {
  // WB photo URL: vol = nmId / 100000, part = nmId / 1000
  const vol = Math.floor(nmId / 100000);
  const part = Math.floor(nmId / 1000);
  let basket;
  if (vol <= 143) basket = '01';
  else if (vol <= 287) basket = '02';
  else if (vol <= 431) basket = '03';
  else if (vol <= 719) basket = '04';
  else if (vol <= 1007) basket = '05';
  else if (vol <= 1061) basket = '06';
  else if (vol <= 1115) basket = '07';
  else if (vol <= 1169) basket = '08';
  else if (vol <= 1313) basket = '09';
  else if (vol <= 1601) basket = '10';
  else if (vol <= 1655) basket = '11';
  else if (vol <= 1919) basket = '12';
  else if (vol <= 2045) basket = '13';
  else if (vol <= 2189) basket = '14';
  else if (vol <= 2405) basket = '15';
  else if (vol <= 2621) basket = '16';
  else if (vol <= 2837) basket = '17';
  else if (vol <= 3053) basket = '18';
  else if (vol <= 3269) basket = '19';
  else if (vol <= 3485) basket = '20';
  else if (vol <= 3701) basket = '21';
  else if (vol <= 3917) basket = '22';
  else if (vol <= 4133) basket = '23';
  else if (vol <= 4349) basket = '24';
  else basket = '25';
  return `https://basket-${basket}.wbbasket.ru/vol${vol}/part${part}/${nmId}/images/c246x328/1.webp`;
}

// ── Инициализация при загрузке страницы ──
document.addEventListener('DOMContentLoaded', () => {
  initAdsTab();
  initPanelTabs();
  initQueriesPanel();
  initSearchTab();
});

// ── ЛОГИСТИКА: расчёт и UI ─────────────────────────────────────────────────────

/**
 * Рассчитывает стоимость логистики для конкретного склада.
 * Формула WB: (base + liter × (литры-1)) × ИЛ + цена × (ИРП/100)
 * где base/liter уже с коэффициентом склада (из tariffs API).
 */
function calcLogistics(warehouseName) {
  const t = tariffs[warehouseName];
  if (!t) return null;
  const il  = logisticsSettings.il  || 0;
  const irp = logisticsSettings.irp || 0;
  if (il === 0) return null;

  const { width = 0, height = 0, length = 0 } = currentCardDimensions;
  if (!width || !height || !length) return null;

  // Объём в литрах, WB округляет вниз до целых
  const volumeLiters = Math.floor((width * height * length) / 1000);
  const extraLiters  = Math.max(volumeLiters - 1, 0);

  const baseCost = (t.base + t.liter * extraLiters) * il;
  const irpCost  = currentCardPrice * (irp / 100);

  return Math.round(baseCost + irpCost);
}

/**
 * Строит HTML выпадающего блока для выбора любого склада из тарифов WB.
 */
function buildWarehouseSelectorHtml(hasSettings, isStale) {
  const whNames = Object.keys(tariffs).sort();
  if (!whNames.length) return '';

  const staleWarning = (hasSettings && isStale)
    ? '<div class="wh-selector-stale">⚠️ ИЛ/ИРП устарели — обнови в настройках 🚚</div>'
    : '';

  const noSettings = !hasSettings
    ? '<div class="wh-selector-stale">Настрой ИЛ и ИРП через кнопку 🚚 Логистика</div>'
    : '';

  const options = whNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');

  return `
<div class="wh-selector-block">
  <div class="wh-selector-label">📍 Расчёт для другого склада:</div>
  ${staleWarning}${noSettings}
  <div class="wh-selector-row">
    <select id="wh-calc-select" class="wh-calc-select">
      <option value="">— выбери склад —</option>
      ${options}
    </select>
    <div id="wh-calc-result" class="wh-calc-result"></div>
  </div>
</div>`;
}

/**
 * Вешает обработчик на селектор склада после рендера.
 */
function attachWarehouseSelectorEvents() {
  const sel = document.getElementById('wh-calc-select');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const name = sel.value;
    const result = document.getElementById('wh-calc-result');
    if (!name || !result) return;
    const cost = calcLogistics(name);
    if (cost !== null) {
      result.textContent = `🚚 ${cost} ₽`;
      result.className = 'wh-calc-result wh-calc-result--ok';
    } else if (!logisticsSettings.il) {
      result.textContent = 'Настрой ИЛ/ИРП';
      result.className = 'wh-calc-result wh-calc-result--na';
    } else {
      result.textContent = 'Нет тарифа';
      result.className = 'wh-calc-result wh-calc-result--na';
    }
  });
}

/**
 * Загружает настройки логистики (ИЛ/ИРП) и тарифы складов с сервера.
 */
async function loadLogisticsData() {
  try {
    const [settingsRes, tariffsRes] = await Promise.all([
      fetch('/api/logistics-settings').then(r => r.json()),
      fetch('/api/tariffs').then(r => r.json()),
    ]);
    if (settingsRes.il !== undefined) {
      logisticsSettings = settingsRes;
      // Обновляем кнопку — если настройки не заданы или устарели
      updateLogisticsBtn();
    }
    if (tariffsRes.tariffs) {
      tariffs = tariffsRes.tariffs;
    }
  } catch(e) {
    console.warn('loadLogisticsData:', e.message);
  }
}

/**
 * Обновляет вид кнопки 🚚 Логистика (предупреждение если ИЛ/ИРП устарели).
 */
function updateLogisticsBtn() {
  const btn = document.getElementById('logistics-settings-btn');
  if (!btn) return;
  const il = logisticsSettings.il;
  const irp = logisticsSettings.irp;
  const upd = logisticsSettings.updatedAt;
  const isStale = !upd || (Date.now() - new Date(upd).getTime()) > 8 * 24 * 60 * 60 * 1000;
  const noData  = !il || irp === undefined;

  if (noData) {
    btn.classList.add('logistics-btn--warn');
    btn.title = 'Настрой ИЛ и ИРП для расчёта стоимости логистики';
  } else if (isStale) {
    btn.classList.add('logistics-btn--stale');
    btn.title = 'ИЛ/ИРП устарели — обнови (меняются каждый понедельник)';
  } else {
    btn.classList.remove('logistics-btn--warn', 'logistics-btn--stale');
    btn.title = `Логистика: ИЛ=${il}, ИРП=${irp}%`;
  }
}

/**
 * Инициализирует модальное окно настроек логистики.
 */
function initLogisticsModal() {
  const modal   = document.getElementById('logistics-modal');
  const openBtn = document.getElementById('logistics-settings-btn');
  const closeBtn  = document.getElementById('logistics-close-btn');
  const closeBtn2 = document.getElementById('logistics-close-btn2');
  const saveBtn   = document.getElementById('logistics-save-btn');
  const inpIl     = document.getElementById('inp-il');
  const inpIrp    = document.getElementById('inp-irp');
  const statusBar = document.getElementById('logistics-status-bar');

  if (!modal || !openBtn) return;

  const openModal = () => {
    // Заполняем текущими значениями
    if (logisticsSettings.il > 0) inpIl.value = logisticsSettings.il;
    if (logisticsSettings.irp >= 0) inpIrp.value = logisticsSettings.irp;

    // Показываем дату последнего обновления
    if (logisticsSettings.updatedAt) {
      const d = new Date(logisticsSettings.updatedAt);
      const days = Math.round((Date.now() - d.getTime()) / 86400000);
      const dayStr = days === 0 ? 'сегодня' : `${days} дн. назад`;
      const isStale = days > 7;
      statusBar.innerHTML = `<div class="status-bar ${isStale ? 'status-warn' : 'status-ok'}">
        ${isStale ? '⚠️' : '✅'} Последнее обновление: ${dayStr}
        ${isStale ? '— <b>пора обновить!</b>' : ''}
      </div>`;
    } else {
      statusBar.innerHTML = '<div class="status-bar status-warn">⚠️ Значения не заданы — введи ИЛ и ИРП</div>';
    }
    modal.classList.remove('hidden');
  };

  const closeModal = () => modal.classList.add('hidden');

  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  closeBtn2.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  saveBtn.addEventListener('click', async () => {
    const il  = parseFloat(inpIl.value);
    const irp = parseFloat(inpIrp.value);

    if (isNaN(il) || il <= 0) {
      statusBar.innerHTML = '<div class="status-bar status-warn">⚠️ Введи корректное значение ИЛ (например 1.22)</div>';
      inpIl.focus();
      return;
    }
    if (isNaN(irp) || irp < 0) {
      statusBar.innerHTML = '<div class="status-bar status-warn">⚠️ Введи корректное значение ИРП (например 1.75)</div>';
      inpIrp.focus();
      return;
    }

    try {
      const res = await fetch('/api/logistics-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ il, irp }),
      });
      if (res.ok) {
        logisticsSettings = { il, irp, updatedAt: new Date().toISOString() };
        updateLogisticsBtn();
        statusBar.innerHTML = '<div class="status-bar status-ok">✅ Сохранено! ИЛ=' + il + ', ИРП=' + irp + '%</div>';
        toast('✅ Настройки логистики сохранены');
        // Перерисовываем склады если есть выбранная карточка
        setTimeout(() => {
          if (selectedNmId) {
            const row = document.querySelector(`tr[data-nm="${selectedNmId}"]`);
            if (row) selectCard(selectedNmId, row);
          }
          closeModal();
        }, 800);
      } else {
        const err = await res.json();
        statusBar.innerHTML = `<div class="status-bar status-warn">❌ Ошибка: ${err.error}</div>`;
      }
    } catch(e) {
      statusBar.innerHTML = `<div class="status-bar status-warn">❌ ${e.message}</div>`;
    }
  });
}

// ── SETUP SCREEN ───────────────────────────────────────────────────────────────
async function initSetupScreen() {
  const setupScreen = document.getElementById('setup-screen');
  const loader      = document.getElementById('loader');
  const main        = document.getElementById('main');
  const topbar      = document.getElementById('topbar');
  const toolbar     = document.getElementById('toolbar');

  let configured = false;
  try {
    const status = await fetch('/api/setup/status').then(r => r.json());
    configured = status.configured;
  } catch(e) { configured = false; }

  if (configured) {
    setupScreen.classList.add('hidden');
    loadCards();
    autoRefreshTimer = setInterval(() => loadCards(true), 10 * 60 * 1000);
    return;
  }

  loader.classList.add('hidden');
  if (main)    main.classList.add('hidden');
  if (topbar)  topbar.classList.add('hidden');
  if (toolbar) toolbar.classList.add('hidden');
  setupScreen.classList.remove('hidden');

  const saveBtn    = document.getElementById('setup-save-btn');
  const tokenInput = document.getElementById('setup-token-input');
  const errorDiv   = document.getElementById('setup-error');
  const btnText    = document.getElementById('setup-btn-text');
  const spinner    = document.getElementById('setup-btn-spinner');

  const doSave = async () => {
    const token = (tokenInput.value || '').trim();
    errorDiv.classList.add('hidden');
    if (!token) {
      errorDiv.textContent = 'Вставь токен — поле не может быть пустым';
      errorDiv.classList.remove('hidden');
      return;
    }
    if (token.length < 100) {
      errorDiv.textContent = 'Токен слишком короткий. Убедись что скопирован целиком.';
      errorDiv.classList.remove('hidden');
      return;
    }
    btnText.textContent = 'Проверяем токен...';
    spinner.classList.remove('hidden');
    saveBtn.disabled = true;
    try {
      const res  = await fetch('/api/setup/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.ok) {
        btnText.textContent = 'Подключено! Загружаем данные...';
        setupScreen.classList.add('hidden');
        loader.classList.remove('hidden');
        document.getElementById('loader-status').textContent = 'Подключаемся к Wildberries...';
        if (main)    main.classList.remove('hidden');
        if (topbar)  topbar.classList.remove('hidden');
        if (toolbar) toolbar.classList.remove('hidden');
        await new Promise(r => setTimeout(r, 2000));
        loadCards();
        autoRefreshTimer = setInterval(() => loadCards(true), 10 * 60 * 1000);
      } else {
        errorDiv.textContent = data.error || 'Неизвестная ошибка';
        errorDiv.classList.remove('hidden');
        btnText.textContent = 'Подключить магазин';
        spinner.classList.add('hidden');
        saveBtn.disabled = false;
      }
    } catch(e) {
      errorDiv.textContent = 'Ошибка: ' + e.message;
      errorDiv.classList.remove('hidden');
      btnText.textContent = 'Подключить магазин';
      spinner.classList.add('hidden');
      saveBtn.disabled = false;
    }
  };
  saveBtn.addEventListener('click', doSave);
  tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSave(); });
}
