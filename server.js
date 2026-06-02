'use strict';
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// ─── TOKEN MANAGEMENT ──────────────────────────────────────────────────────────────
// Токен берётся из wb_token.json (приоритет) или из config.js (запасной)
const TOKEN_FILE = path.join(__dirname, 'wb_token.json');

function getToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (data.token) return data.token;
    }
  } catch(e) { /* ignore */ }
  return config.WB_TOKEN || '';
}

function hasToken() {
  return !!getToken();
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    token,
    savedAt: new Date().toISOString(),
    note: 'Токен WB API. Не передавай этот файл никому!'
  }, null, 2), 'utf8');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Прямой HTTPS-агент без прокси — для запросов к Statistics API
// Системный прокси Windows (127.0.0.1:10829) обрезает большие ответы (428KB+)
const https = require('https');
const directAgent = new https.Agent({ keepAlive: true });

// ─── WAREHOUSE → REGION ───────────────────────────────────────────────────────
const REGION_KEYWORDS = {
  'Центральный':      ['коледино','подольск','электросталь','тула','вёшки','чашниково','wb','ногинск','лесной','огородово','белые','домодедово','обухово','хоругвино','клин','пушкино','щёлково','москв','балашиха','химки','мытищи','люберцы','видное','реутов','красногорск','рязань','тюшевское','софьино','белая дача','курск','воронеж','владимир','котовск','тамбов','липецк','орёл','орел','брянск','калуга','смоленск','тверь','ярославл'],
  'Северо-Западный':  ['санкт-петербург','шушары','невская','спб','мурманск','архангельск','великий новгород','петрозаводск','вологда','псков','калининград','ярославл','ярославль'],
  'Приволжский':      ['казань','самара','нижний новгород','уфа','пенза','ульяновск','саратов','оренбург','ижевск','чебоксары','йошкар','киров','тольятти','набережные','сарапул'],
  'Южный':            ['краснодар','ростов','волгоград','астрахань','ставрополь','сочи','новороссийск','симферополь','севастополь','элиста','махачкал','владикавказ','назрань','крыловская','невинномысск'],
  'Уральский':        ['екатеринбург','тюмень','челябинск','пермь','курган','магнитогорск','нижний тагил','сургут','нефтеюганск','ханты'],
  'Сибирский':        ['новосибирск','красноярск','омск','барнаул','иркутск','новокузнецк','томск','кемерово','горно-алтайск','абакан','чита','улан-удэ','ачинск','братск'],
  'Дальневосточный':  ['хабаровск','владивосток','якутск','благовещенск','сахалин','южно-сахалинск','петропавловск','магадан','артём','артем'],
  'СНГ':              ['астана','алматы','бишкек','ташкент','минск','гомель','армения','баку'],
};

function whToRegion(name) {
  if (!name) return 'Другие';
  const l = name.toLowerCase();
  // 'Остальные склады' — служебная категория WB, не логируем
  if (l.includes('остальные')) return 'Другие';
  for (const [region, keys] of Object.entries(REGION_KEYWORDS))
    if (keys.some(k => l.includes(k))) return region;
  // log unmatched for debugging
  console.log('⚠️  Unmapped warehouse:', name);
  return 'Другие';
}
const ALL_REGIONS = [...Object.keys(REGION_KEYWORDS), 'Другие'];

// ─── PHOTO URL fallback (если API не вернул фото) ─────────────────────────────
// Корзина НЕ вычисляется по диапазонам — WB сейчас на basket-25+
// Правильные URL берём из поля card.photos[] напрямую из Content API
function photoUrlFallback(nmId) {
  // Запасной вариант: сформировать URL через vol/part
  // basket = (vol % 34) + 1 — эмпирическая формула для текущих nmId
  const vol  = Math.floor(nmId / 100000);
  const part = Math.floor(nmId / 1000);
  const b    = String(((vol % 34) + 1)).padStart(2, '0');
  return {
    sm:  `https://basket-${b}.wbbasket.ru/vol${vol}/part${part}/${nmId}/images/c246x328/1.webp`,
    big: `https://basket-${b}.wbbasket.ru/vol${vol}/part${part}/${nmId}/images/big/1.webp`,
  };
}

// ─── WB API HELPER (with timeout, с токеном продавца) ───────────────────────
// agent: передай directAgent чтобы обойти системный прокси Windows
async function wbFetch(url, opts = {}, timeoutMs = 30000, agent = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      ...(agent ? { agent } : {}),
      headers: { Authorization: getToken(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`WB ${res.status} ${url.slice(0,80)}: ${(await res.text()).slice(0,200)}`);
    // WB иногда возвращает 200 с пустым телом вместо [] — обрабатываем gracefully
    const text = await res.text();
    if (!text || !text.trim()) {
      console.warn(`wbFetch: empty response (HTTP ${res.status}, body empty) from ${url.slice(0,80)} — returning null`);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch(e) {
      throw new Error(`invalid json from ${url.slice(0,80)}: ${e.message} (body: ${text.slice(0,100)})`);
    }
  } finally { clearTimeout(timer); }
}

// ─── SPP SOURCE ───────────────────────────────────────────────────────────────
// card.wb.ru/cards/v2/detail — возвращает 404 (WB убрал эндпоинт в 2026).
// Единственный надёжный источник SPP — поле `spp` в Orders/Sales API.
// Это те же данные, что показывает кабинет WB (seller.wildberries.ru)
// в разделе «Цена и скидка» → колонка «Скидка WB».

// ─── FETCHERS ─────────────────────────────────────────────────────────────────
async function fetchAllCards() {
  let all = [], cursor = { limit: 100 };
  for (let page = 0; page < 50; page++) {
    const data = await wbFetch('https://content-api.wildberries.ru/content/v2/get/cards/list', {
      method: 'POST',
      body: JSON.stringify({ settings: { cursor, filter: { withPhoto: -1 } } }),
    });
    const cards = data.cards || [];
    all = all.concat(cards);
    if (!cards.length || cards.length < 100 || !data.cursor?.nmID) break;
    cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID };
    await sleep(200);
  }
  return all;
}

async function fetchSellerPrices() {
  const map = {};
  try {
    let offset = 0;
    for (;;) {
      const data = await wbFetch(
        `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=1000&offset=${offset}`,
        {}, 20000
      );
      const items = data.data?.listGoods || [];
      for (const g of items) {
        // Цена лежит внутри sizes[0], а не на верхнем уровне
        const sz = (g.sizes || [])[0] || {};
        map[g.nmID] = {
          nmID:           g.nmID,
          discount:       g.discount       || 0,
          price:          sz.price         || 0,   // цена до скидки продавца (коп→руб уже)
          discountedPrice: sz.discountedPrice || 0, // цена после скидки продавца
        };
      }
      if (items.length < 1000) break;
      offset += 1000;
      await sleep(300);
    }
    console.log(`✅ Prices loaded: ${Object.keys(map).length} items`);
  } catch(e) { console.warn('seller prices fail:', e.message); }
  return map;
}

async function fetchStocks() {
  let stocks = [];

  // Источник 1 (основной): Analytics API — актуальные остатки на складах WB
  // Retry logic для 429 Too Many Requests
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await wbFetch(
        'https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses',
        { method: 'POST', body: JSON.stringify({}) }, 30000
      );
      const items = data && Array.isArray(data.data) ? data.data : [];
      if (items.length > 0) {
        stocks = items;
        console.log(`✅ Stocks (analytics): ${stocks.length} records`);
      }
      break; // успех — выходим из retry-цикла
    } catch(e) {
      if (e.message.includes('429') && attempt < 2) {
        const delay = (attempt + 1) * 15000; // 15s, 30s
        console.warn(`analytics stocks 429 — retry in ${delay/1000}s (attempt ${attempt+1}/3)`);
        await sleep(delay);
      } else {
        console.warn('analytics stocks fail:', e.message);
        break;
      }
    }
  }

  // Источник 2 (дополнение): Statistics stocks — с далёкой датой для полного покрытия
  // Statistics API возвращает записи изменённые ПОСЛЕ dateFrom, поэтому берём год назад
  // Примечание: WB возвращает пустое тело (не []) если данных нет — wbFetch вернёт null
  try {
    const data = await wbFetch(
      'https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=2025-01-01',
      {}, 30000
    );
    const extra = Array.isArray(data) ? data : [];
    if (extra.length > 0) {
      // Мержим: если в analytics уже есть запись для этого nmId+warehouse — пропускаем
      const existing = new Set(stocks.map(s => `${s.nmId}_${s.warehouseName}`));
      let added = 0;
      for (const s of extra) {
        const key = `${s.nmId}_${s.warehouseName}`;
        if (!existing.has(key)) {
          stocks.push(s);
          existing.add(key);
          added++;
        }
      }
      console.log(`✅ Stocks (statistics): +${added} extra records (total: ${stocks.length})`);
    }
  } catch(e) { console.warn('statistics stocks fail:', e.message); }

  return stocks;
}

async function fetchOrders(days = 90) {
  try {
    // directAgent обходит системный прокси Windows — он обрезает ответы 400KB+
    const data = await wbFetch(
      `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${daysAgo(days)}&flag=0`,
      {}, 120000, directAgent
    );
    console.log(`✅ Orders: ${Array.isArray(data) ? data.length : 0} records (last ${days} days)`);
    return Array.isArray(data) ? data : [];
  } catch(e) { console.warn('orders fail:', e.message); return []; }
}

async function fetchSales(days = 180) {
  try {
    // directAgent обходит системный прокси Windows — он обрезает ответы 400KB+
    // 180 дней: WB подтверждает выкупы с задержкой 45–60 дней
    const data = await wbFetch(
      `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${daysAgo(days)}`,
      {}, 180000, directAgent
    );
    console.log(`✅ Sales: ${Array.isArray(data) ? data.length : 0} records (last ${days} days)`);
    return Array.isArray(data) ? data : [];
  } catch(e) { console.warn('sales fail:', e.message); return []; }
}

async function fetchAnalytics() {
  // Актуальный endpoint аналитики — Wildberries Sales Funnel API v3 (2025)
  const endDate   = new Date();
  const startDate = new Date(Date.now() - 30 * 86400000);
  const fmt = d => d.toISOString().slice(0, 10); // YYYY-MM-DD
  const url = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';

  const allItems = [];
  let page = 1;
  for (;;) {
    try {
      const body = JSON.stringify({
        nmIds: [], // пустой массив = все товары
        selectedPeriod: { start: fmt(startDate), end: fmt(endDate) },
        page,
        limit: 100,
      });
      const data = await wbFetch(url, { method: 'POST', body }, 30000);
      const products = data.data?.products || [];
      allItems.push(...products);
      // Если страниц меньше лимита — заканчиваем
      if (products.length < 100 || !data.data?.isNextPage) break;
      page++;
      await sleep(500); // лимит 3 запроса/минуту
    } catch(e) {
      console.warn('analytics [sales-funnel]:', e.message);
      break;
    }
  }
  console.log(`✅ Analytics loaded: ${allItems.length} products`);
  return allItems;
}

// ─── SELLER PORTAL SESSION ────────────────────────────────────────────────────
// Читает seller_session.json (сохранены куки/токены из браузера с seller.wildberries.ru)
function loadSellerSession() {
  try {
    const f = require('fs');
    if (f.existsSync(SELLER_SESSION_FILE))
      return JSON.parse(f.readFileSync(SELLER_SESSION_FILE, 'utf8'));
  } catch(e) { console.warn('loadSellerSession:', e.message); }
  return null;
}

function buildSellerCookie(s) {
  return [
    `wbx-refresh=${s.wbxRefresh || ''}`,
    `wbx-validation-key=${s.wbxValidationKey || ''}`,
    `x-supplier-id=${s.xSupplierId || ''}`,
    `x-supplier-id-external=${s.xSupplierId || ''}`,
    `cfidsw-wb=${s.cfidsWb || ''}`,
    `__zzatw-wb=${s.zzatwWb || ''}`,
    'external-locale=ru', 'locale=ru',
  ].join('; ');
}

// Обновляет authorizev3 через долгоживущий wbxRefresh
// WB периодически меняет URL — перебираем несколько вариантов
const SELLER_AUTH_ENDPOINTS = [
  'https://seller-auth.wildberries.ru/auth/v3/token',
  'https://seller-auth.wildberries.ru/auth/v4/token',
  'https://user.wildberries.ru/auth/v3/token',
  'https://seller.wildberries.ru/ns/auth/seller-auth/auth/v3/token',
];

async function refreshSellerAuth(session) {
  if (!session?.wbxRefresh) return false;
  for (const endpoint of SELLER_AUTH_ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cookie': buildSellerCookie(session),
          'origin':  'https://seller.wildberries.ru',
          'referer': 'https://seller.wildberries.ru/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        },
        body: '{}',
      });
      if (r.status === 404) {
        // Тихо пробуем следующий endpoint (не спамим консоль)
        continue;
      }
      if (r.ok) {
        const text = await r.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch(_) {}
        const newAuth = data.authorizev3 || data.token || data.accessToken || data.access_token;
        if (newAuth) {
          session.authorizev3 = newAuth;
          session.updatedAt   = new Date().toISOString();
          require('fs').writeFileSync(SELLER_SESSION_FILE, JSON.stringify(session, null, 2), 'utf8');
          console.log(`✅ authorizev3 refreshed via ${endpoint}`);
          return true;
        }
        const sc = r.headers.get('set-cookie') || '';
        const m  = sc.match(/authorizev3=([^;,\s]+)/);
        if (m) {
          session.authorizev3 = m[1];
          session.updatedAt   = new Date().toISOString();
          require('fs').writeFileSync(SELLER_SESSION_FILE, JSON.stringify(session, null, 2), 'utf8');
          console.log(`✅ authorizev3 refreshed via Set-Cookie (${endpoint})`);
          return true;
        }
        // OK но токена нет — нет смысла пробовать дальше
        break;
      }
      if (r.status === 401) {
        // Сессия устарела — не спамим, просто выходим
        return false;
      }
      // Другие ошибки — тоже хватит
      break;
    } catch(e) {
      // Сетевые ошибки (ENOTFOUND и т.п.) — пробуем следующий endpoint
      continue;
    }
  }
  return false;
}

// Загружает реальную СПП (discountOnSite) с портала продавца WB
// НА СТАНДБАЙ: WB убрал отображение СПП в ЛК поставщика (~2026). Функция сохранена —
// как только WB вернёт данные, она автоматически начнёт работать без изменений кода.
async function fetchSellerPortalSpp() {
  const session = loadSellerSession();
  if (!session?.wbxRefresh) {
    console.log('ℹ️  No seller session → portal SPP skipped (add session via 🔑 button)');
    return {};
  }
  // Пробуем обновить краткоживущий authorizev3 через долгоживущий wbxRefresh
  await refreshSellerAuth(session);

  const result = {};
  let offset = 0, retried = false;

  for (;;) {
    try {
      const r = await fetch(
        'https://discounts-prices.wildberries.ru/ns/dp-api/discounts-prices/suppliers/api/v1/list/goods/filter',
        {
          method: 'POST',
          headers: {
            'accept':         '*/*',
            'authorizev3':    session.authorizev3 || '',
            'content-type':   'application/json',
            'root-version':   'v1.87.2',
            'cookie':         buildSellerCookie(session),
            'origin':         'https://seller.wildberries.ru',
            'referer':        'https://seller.wildberries.ru/',
          },
          body: JSON.stringify({
            limit: 100, offset,
            facets: [], filterWithoutPrice: false,
            filterWithLeftovers: false, filterWithoutCompetitivePrice: false,
            sort: 'price', sortOrder: 0,
          }),
        }
      );
      if (r.status === 401 && !retried) {
        retried = true;
        // Сессия истекла или WB временно убрал СПП — пробуем обновить
        if (await refreshSellerAuth(session)) continue;
        break; // не удалось — тихо выходим
      }
      if (!r.ok) { console.warn(`seller-portal SPP: HTTP ${r.status}`); break; }

      const data  = await r.json();
      const goods = data.data?.listGoods || [];
      for (const g of goods) {
        if (g.nmID && g.discountOnSite !== null && g.discountOnSite !== undefined)
          result[g.nmID] = g.discountOnSite;
      }
      if (goods.length < 100) break;
      offset  += 100;
      retried  = false;
      await sleep(300);
    } catch(e) { console.warn('seller-portal SPP:', e.message); break; }
  }

  console.log(`✅ Seller Portal SPP: ${Object.keys(result).length} products (discountOnSite)`);
  return result;
}

// ─── TARIFFS CACHE ────────────────────────────────────────────────────────────
let tariffsCache = null;        // { warehouseName → { boxDeliveryBase, boxDeliveryLiter } }
let tariffsUpdatedAt = 0;
const TARIFFS_TTL = 24 * 60 * 60 * 1000; // 24 часа (тарифы меняются редко)

async function fetchTariffs() {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const data = await wbFetch(`https://common-api.wildberries.ru/api/v1/tariffs/box?date=${date}`, {}, 20000);
    const list = data?.response?.data?.warehouseList || [];
    const map = {};
    for (const wh of list) {
      if (!wh.warehouseName) continue;
      map[wh.warehouseName] = {
        base:  parseFloat(wh.boxDeliveryBase)  || 0,
        liter: parseFloat(wh.boxDeliveryLiter) || 0,
      };
    }
    tariffsCache = map;
    tariffsUpdatedAt = Date.now();
    console.log(`✅ Tariffs loaded: ${list.length} warehouses`);
    return map;
  } catch(e) {
    console.warn('tariffs fail:', e.message);
    return tariffsCache || {};
  }
}

async function ensureTariffs() {
  if (!tariffsCache || Date.now() - tariffsUpdatedAt > TARIFFS_TTL) await fetchTariffs();
  return tariffsCache || {};
}

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = { cards: null, shopByDate: null, updatedAt: null };
let lastRefresh = 0, isRefreshing = false;
const CACHE_TTL = 10 * 60 * 1000;

async function refreshCache() {
  if (isRefreshing) return;
  isRefreshing = true;
  console.log('🔄 Refreshing WB data…');
  try {
    // Run in parallel, each with their own timeout
    // Statistics API (orders + sales) запрашиваем последовательно с паузой —
    // один рате-лимит на два endpointа, параллельно вызывает 429
    const [rawOrders, rawSales] = await (async () => {
      const orders = await fetchOrders(90);
      await sleep(3000); // 3с пауза — чтобы не влететь в rate limit
      const sales = await fetchSales(180);
      return [orders, sales];
    })();

    const [rawCards, sellerPricesMap, rawStocks, analyticsArr, portalSppMap] = await Promise.allSettled([
      fetchAllCards(),
      fetchSellerPrices(),
      fetchStocks(),
      fetchAnalytics(),
      fetchSellerPortalSpp(),
    ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : (console.warn('settled fail:', x.reason?.message), null)));

    const cards = rawCards || [];
    console.log(`Cards: ${cards.length}, Stocks: ${(rawStocks||[]).length}, Orders: ${(rawOrders||[]).length}`);

    // ── stocks: aggregate by nmId, by region, by warehouse ──
    // quantity = на складе, inWayToClient/inWayFromClient = в пути
    // "Остальные склады" — служебная категория WB (товары в пути), не реальный склад
    const stockMap = {};
    const priceFromStocks = {};
    const nmInStocks = new Set();

    for (const s of (rawStocks || [])) {
      const nm = s.nmId; if (!nm) continue;
      nmInStocks.add(nm);
      if (!stockMap[nm]) stockMap[nm] = { total: 0, inWayTo: 0, inWayFrom: 0, regions: {}, warehouses: [] };

      const qty       = s.quantity        || 0;
      const inWayTo   = s.inWayToClient   || 0;
      const inWayFrom = s.inWayFromClient || 0;
      const whName    = s.warehouseName   || '?';
      const isOther   = whName.toLowerCase().includes('остальные');

      // "В пути" агрегируем из ВСЕХ записей
      stockMap[nm].inWayTo   += inWayTo;
      stockMap[nm].inWayFrom += inWayFrom;

      // Остатки на складах — только реальный qty, пропускаем "Остальные склады"
      if (!isOther && qty > 0) {
        stockMap[nm].total += qty;
        // Analytics API уже содержит regionName, Statistics — нет
        const region = s.regionName || whToRegion(whName);
        stockMap[nm].regions[region] = (stockMap[nm].regions[region] || 0) + qty;
        const existing = stockMap[nm].warehouses.find(w => w.name === whName);
        if (existing) existing.qty += qty;
        else stockMap[nm].warehouses.push({ name: whName, region, qty });
      }

      if (!priceFromStocks[nm] && s.Price) priceFromStocks[nm] = { price: s.Price, discount: s.Discount || 0 };
    }

    // ── orders: aggregate by date (заказы + отказы) ──
    const shopByDate = {}, nmByDate = {};
    const nmWithOrders = new Set();

    // Собираем srid всех выкупов — для связки заказ → выкуп (конверсия)
    const boughtSrids = new Set();
    for (const s of (rawSales || [])) { if (s.srid) boughtSrids.add(s.srid); }

    for (const o of (rawOrders || [])) {
      const date = (o.date || '').slice(0, 10); if (!date) continue;
      shopByDate[date] = shopByDate[date] || { cnt: 0, sum: 0, buyoutSum: 0, cancels: 0, buyouts: 0, linked: 0 };
      const nm = o.nmId;
      if (nm) {
        nmByDate[nm] = nmByDate[nm] || {};
        nmByDate[nm][date] = nmByDate[nm][date] || { cnt: 0, sum: 0, buyoutSum: 0, cancels: 0, buyouts: 0, linked: 0 };
      }
      if (o.isCancel) {
        shopByDate[date].cancels++;
        if (nm) nmByDate[nm][date].cancels++;
      } else {
        shopByDate[date].cnt++;
        shopByDate[date].sum += o.finishedPrice || o.priceWithDisc || 0;
        // Был ли этот заказ выкуплен? (связка по srid)
        if (o.srid && boughtSrids.has(o.srid)) {
          shopByDate[date].linked++;
          if (nm) nmByDate[nm][date].linked++;
        }
        if (nm) {
          nmWithOrders.add(nm);
          nmByDate[nm][date].cnt++;
          nmByDate[nm][date].sum += o.finishedPrice || o.priceWithDisc || 0;
        }
      }
    }

    // ── sales (выкупы): aggregate by date ──
    for (const s of (rawSales || [])) {
      const date = (s.date || '').slice(0, 10); if (!date) continue;
      shopByDate[date] = shopByDate[date] || { cnt: 0, sum: 0, buyoutSum: 0, cancels: 0, buyouts: 0, linked: 0 };
      shopByDate[date].buyouts++;
      shopByDate[date].buyoutSum += s.finishedPrice || s.priceWithDisc || 0;
      const nm = s.nmId;
      if (nm) {
        nmByDate[nm] = nmByDate[nm] || {};
        nmByDate[nm][date] = nmByDate[nm][date] || { cnt: 0, sum: 0, buyoutSum: 0, cancels: 0, buyouts: 0, linked: 0 };
        nmByDate[nm][date].buyouts++;
        nmByDate[nm][date].buyoutSum += s.finishedPrice || s.priceWithDisc || 0;
      }
    }
    console.log(`Sales (buyouts): ${(rawSales||[]).length}`);

    // ── SPP из заказов/продаж ──────────────────────────────────────────────────
    // Формула расчёта: СПП% = round((priceWithDisc - finishedPrice) / priceWithDisc × 100)
    // Это математически то же самое что: (цена_после_скидки_продавца - цена_покупателя) / цена_после_скидки
    const sppMap = {};  // nmId → { latest, latestDate, freshDays, values[] }
    const today = new Date().toISOString().slice(0, 10);

    for (const o of (rawOrders || [])) {
      const nm = o.nmId;
      if (!nm || o.isCancel) continue;
      // Предпочитаем рассчитанную СПП из реальных цен (priceWithDisc vs finishedPrice)
      // если поле spp есть — используем его напрямую (точнее)
      let sppVal = o.spp;
      if (sppVal === undefined && o.priceWithDisc > 0 && o.finishedPrice > 0) {
        sppVal = Math.round((1 - o.finishedPrice / o.priceWithDisc) * 100);
      }
      if (sppVal === undefined || sppVal < 0 || sppVal > 80) continue;
      if (!sppMap[nm]) sppMap[nm] = { latest: 0, latestDate: '', values: [] };
      sppMap[nm].values.push(sppVal);
      const d = (o.date || '').slice(0, 10);
      if (d >= sppMap[nm].latestDate) { sppMap[nm].latestDate = d; sppMap[nm].latest = sppVal; }
    }
    for (const s of (rawSales || [])) {
      const nm = s.nmId;
      if (!nm) continue;
      let sppVal = s.spp;
      if (sppVal === undefined && s.priceWithDisc > 0 && s.finishedPrice > 0) {
        sppVal = Math.round((1 - s.finishedPrice / s.priceWithDisc) * 100);
      }
      if (sppVal === undefined || sppVal < 0 || sppVal > 80) continue;
      if (!sppMap[nm]) sppMap[nm] = { latest: 0, latestDate: '', values: [] };
      sppMap[nm].values.push(sppVal);
      const d = (s.date || '').slice(0, 10);
      if (d >= sppMap[nm].latestDate) { sppMap[nm].latestDate = d; sppMap[nm].latest = sppVal; }
    }
    // Вычисляем свежесть: сколько дней назад был последний заказ с SPP
    for (const nm of Object.keys(sppMap)) {
      const d = sppMap[nm].latestDate;
      sppMap[nm].freshDays = d ? Math.round((new Date(today) - new Date(d)) / 86400000) : 999;
    }
    console.log(`✅ SPP (orders/sales): ${Object.keys(sppMap).length} products`);

    // ── Эталонная таблица для интерполяции (ближайший сосед по discountedPrice) ──
    // Используем для товаров с остатками у которых нет данных из заказов
    // Структура: [ { discountedPrice, spp, freshDays } ]
    const sppReference = [];
    for (const [nmStr, sppData] of Object.entries(sppMap)) {
      const nmId = parseInt(nmStr);
      const priceData = (sellerPricesMap || {})[nmId];
      if (!priceData) continue;
      const discountedPrice = priceData.discountedPrice || 0;
      if (discountedPrice > 0 && sppData.latest > 0) {
        sppReference.push({ discountedPrice, spp: sppData.latest, freshDays: sppData.freshDays });
      }
    }
    console.log(`✅ SPP reference table: ${sppReference.length} data points for interpolation`);

    // ── analytics by nmId (Sales Funnel API v3) ──
    const anlMap = {};
    for (const a of (analyticsArr || [])) {
      const nm = a.product?.nmId;
      if (!nm) continue;
      const sel = a.statistic?.selected || {};
      const conv = sel.conversions || {};
      anlMap[nm] = {
        openCount:    sel.openCount    || 0,  // просмотры карточки
        cartCount:    sel.cartCount    || 0,  // добавления в корзину
        orderCount:   sel.orderCount   || 0,  // заказы
        orderSum:     sel.orderSum     || 0,
        buyoutCount:  sel.buyoutCount  || 0,  // выкупы
        cancelCount:  sel.cancelCount  || 0,
        cartPct:      conv.addToCartPercent  || 0, // конверсия просмотр → корзина
        orderPct:     conv.cartToOrderPercent || 0, // конверсия корзина → заказ
      };
    }

    // ── build card objects ──
    // Загружаем тарифы параллельно с обновлением карточек
    await ensureTariffs();
    cache.cards = cards.map(card => {
      const nm = card.nmID;
      const sel = (sellerPricesMap || {})[nm] || {};
      const stk = stockMap[nm] || { total: 0, regions: {}, warehouses: [] };
      const anl = anlMap[nm] || {};
      const stPrice = priceFromStocks[nm] || {};

      const colorChar = (card.characteristics || []).find(c => c.name?.toLowerCase().includes('цвет'));
      const color = colorChar?.value || card.colors?.[0] || '—';

      // ── Фото: берём URL прямо из ответа API (basket-25+, актуальные) ──
      const apiPhotos = card.photos || [];
      const fallback  = photoUrlFallback(nm);
      const photoSm   = apiPhotos[0]?.c246x328 || apiPhotos[0]?.['c246x328'] || fallback.sm;
      const photoBig  = apiPhotos[0]?.big        || fallback.big;

      // ── Цены: prefer discounts API ──
      // sel.price = розничная цена до скидки продавца
      // sel.discountedPrice = цена после скидки продавца (то что видит покупатель до SPP)
      const basePrice  = sel.price          || stPrice.price    || 0;
      const selDisc    = sel.discount        ?? stPrice.discount ?? 0;
      const afterDisc  = sel.discountedPrice || (basePrice && selDisc ? Math.round(basePrice * (1 - selDisc / 100)) : basePrice);
      // ── SPP: Приоритет: 1) портал (discountOnSite) 2) заказы 3) ближайший сосед ──
      const sppData    = sppMap[nm];
      const hasStock   = stk.total > 0;
      const portalSpp  = (portalSppMap || {})[nm]; // реальная с портала (discountOnSite)

      let spp          = 0;
      let sppFreshDays = 999;
      let sppEstimated = false;
      let sppSource    = 'none';

      if (portalSpp !== undefined && portalSpp !== null && hasStock) {
        // 1. Реальная СПП с портала (самая точная, только для товаров с остатками)
        spp = portalSpp; sppFreshDays = 0; sppSource = 'portal';
      } else if (sppData?.latest > 0) {
        // 2. Из Orders/Sales API (есть поле spp в заказах)
        spp = sppData.latest; sppFreshDays = sppData.freshDays ?? 999; sppSource = 'orders';
      } else if (hasStock && sppReference.length > 0 && afterDisc > 0) {
        // 3. Ближайший сосед по discountedPrice (оценка)
        let bestDiff = Infinity, bestSpp = 0;
        for (const ref of sppReference) {
          const diff = Math.abs(ref.discountedPrice - afterDisc);
          if (diff < bestDiff) { bestDiff = diff; bestSpp = ref.spp; }
        }
        if (bestSpp > 0 && bestDiff < 500) {
          spp = bestSpp; sppEstimated = true; sppFreshDays = 0; sppSource = 'estimate';
        }
      }

      const hasSpp     = spp > 0;
      const finalPrice = hasSpp ? Math.round(afterDisc * (1 - spp / 100)) : afterDisc;

      // isActive = есть заказы за 30 дней ИЛИ есть текущие остатки ИЛИ вообще фигурировал в stocks API
      const isActive = nmInStocks.has(nm) || nmWithOrders.has(nm) || stk.total > 0;

      // ── Заказы за 30 дней из Orders API (надёжно, даже если аналитика не работает) ──
      const ordersData = nmByDate[nm] || {};
      const orders30 = Object.values(ordersData).reduce((s, d) => s + d.cnt, 0);

      // ── Габариты товара (для расчёта объёма → литры для логистики) ──
      const dim = card.dimensions || {};
      // WB возвращает в мм → переводим в см
      const dimW = (dim.width  || 0);
      const dimH = (dim.height || 0);
      const dimL = (dim.length || 0);

      return {
        nmId: nm, vendorCode: card.vendorCode, title: card.title,
        category: card.subjectName, brand: card.brand, color, isActive,
        photo: photoSm, photoBig,
        dimensions: { width: dimW, height: dimH, length: dimL },
        prices: { basePrice, selDisc, afterDisc, spp, hasStock, hasSpp, finalPrice, sppFreshDays, sppEstimated, sppSource },
        stock: { total: stk.total, inWayTo: stk.inWayTo, inWayFrom: stk.inWayFrom, regions: stk.regions, warehouses: stk.warehouses },
        orders30, // кол-во заказов за 30 дней (из Orders API)
        analytics: {
          views:    anl.openCount  || 0,  // просмотры карточки
          cart:     anl.cartCount  || 0,  // в корзину
          orders:   anl.orderCount || orders30, // из аналитики или Orders API
          buyouts:  anl.buyoutCount || 0,
          cancels:  anl.cancelCount || 0,
          cartPct:  anl.cartPct     || 0,
          orderPct: anl.orderPct    || 0,
        },
        ordersByDate: ordersData,
      };
    });

    cache.shopByDate = shopByDate;
    cache.updatedAt = new Date().toISOString();
    lastRefresh = Date.now();
    const activeCount = cache.cards.filter(c => c.isActive).length;
    console.log(`✅ Done: ${cache.cards.length} cards (${activeCount} active)`);
  } catch (e) {
    console.error('❌ Refresh error:', e);
  } finally { isRefreshing = false; }
}

async function ensureCache() {
  if (!cache.cards || Date.now() - lastRefresh > CACHE_TTL) await refreshCache();
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/api/cards', async (req, res) => {
  try {
    await ensureCache();
    const showAll = req.query.showAll === 'true';
    const cards = cache.cards
      .filter(c => showAll || c.isActive)
      .map(({ ordersByDate, stock, ...c }) => ({
        ...c,
        stock: { total: stock.total, regions: stock.regions },
        // don't send warehouses in main list to save bandwidth
      }));
    res.json({ cards, total: cache.cards.length, updatedAt: cache.updatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TARIFFS API ──────────────────────────────────────────────────────────────
app.get('/api/tariffs', async (req, res) => {
  try {
    const tariffs = await ensureTariffs();
    res.json({ tariffs, updatedAt: new Date(tariffsUpdatedAt).toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LOGISTICS SETTINGS (ИЛ и ИРП) ──────────────────────────────────────────
const LOGISTICS_SETTINGS_FILE = path.join(__dirname, 'logistics_settings.json');

function loadLogisticsSettings() {
  try {
    if (fs.existsSync(LOGISTICS_SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(LOGISTICS_SETTINGS_FILE, 'utf8'));
  } catch(e) {}
  return { il: 1.0, irp: 0.0, updatedAt: null };
}

app.get('/api/logistics-settings', (req, res) => {
  res.json(loadLogisticsSettings());
});

app.post('/api/logistics-settings', (req, res) => {
  try {
    const { il, irp } = req.body;
    if (il === undefined || irp === undefined)
      return res.status(400).json({ error: 'il и irp обязательны' });
    const settings = { il: parseFloat(il), irp: parseFloat(irp), updatedAt: new Date().toISOString() };
    fs.writeFileSync(LOGISTICS_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    res.json({ ok: true, settings });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stocks', async (req, res) => {
  try {
    await ensureCache();
    const showAll = req.query.showAll === 'true';
    const cards = cache.cards.filter(c => showAll || c.isActive);

    // Collect all unique warehouses with their regions
    const warehouseSet = {}; // { warehouseName: region }
    for (const c of cards)
      for (const w of c.stock.warehouses)
        warehouseSet[w.name] = w.region;

    // Group warehouses by region for the response
    const regionWarehouses = {}; // { region: [warehouseName, ...] }
    for (const [wh, region] of Object.entries(warehouseSet)) {
      if (!regionWarehouses[region]) regionWarehouses[region] = [];
      regionWarehouses[region].push(wh);
    }

    // Build the matrix: one row per card, columns = region totals + per-warehouse
    const matrix = cards.map(c => {
      const row = { 
        nmId: c.nmId, 
        vendorCode: c.vendorCode, 
        title: c.title, 
        total: c.stock.total,
        photo: c.photo,
        photoBig: c.photoBig,
        color: c.color,
        category: c.category
      };
      // Region totals
      for (const r of ALL_REGIONS) row[`r_${r}`] = c.stock.regions[r] || 0;
      // Per-warehouse
      for (const w of c.stock.warehouses) row[`w_${w.name}`] = w.qty;
      return row;
    });

    res.json({ regions: ALL_REGIONS, regionWarehouses, matrix, updatedAt: cache.updatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/shop', async (req, res) => {
  try {
    await ensureCache();
    const days = parseInt(req.query.days) || 14;
    const showAll = req.query.showAll === 'true';
    const stats = Object.entries(cache.shopByDate || {})
      .filter(([d]) => d >= daysAgo(days))
      .map(([date, v]) => ({ date, orders: v.cnt, revenue: Math.round(v.buyoutSum || 0), buyouts: v.buyouts || 0, cancels: v.cancels || 0, linked: v.linked || 0 }))
      .sort((a, b) => b.date.localeCompare(a.date));

    // Агрегация по складам + суммарное "в пути"
    const warehouseMap = {};
    const cards = cache.cards.filter(c => showAll || c.isActive);
    let totalInWayTo = 0, totalInWayFrom = 0;
    for (const card of cards) {
      for (const wh of (card.stock.warehouses || [])) {
        if (!wh.qty) continue;
        if (!warehouseMap[wh.name]) warehouseMap[wh.name] = { name: wh.name, region: wh.region, qty: 0 };
        warehouseMap[wh.name].qty += wh.qty;
      }
      totalInWayTo   += card.stock.inWayTo   || 0;
      totalInWayFrom += card.stock.inWayFrom || 0;
    }
    const warehouses = Object.values(warehouseMap)
      .filter(w => w.qty > 0)
      .sort((a, b) => b.qty - a.qty);

    res.json({ stats, warehouses, inWayTo: totalInWayTo, inWayFrom: totalInWayFrom, updatedAt: cache.updatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/:nmId', async (req, res) => {
  try {
    await ensureCache();
    const nmId = parseInt(req.params.nmId);
    const days = parseInt(req.query.days) || 14;
    const card = cache.cards.find(c => c.nmId === nmId);
    const stats = Object.entries(card?.ordersByDate || {})
      .filter(([d]) => d >= daysAgo(days))
      .map(([date, v]) => ({ date, orders: v.cnt, revenue: Math.round(v.buyoutSum || 0), buyouts: v.buyouts || 0, cancels: v.cancels || 0, linked: v.linked || 0 }))
      .sort((a, b) => b.date.localeCompare(a.date));
    // Передаём склады по конкретному товару + данные "в пути"
    const warehouses = (card?.stock?.warehouses || [])
      .filter(w => w.qty > 0)
      .sort((a, b) => b.qty - a.qty);
    const inWayTo   = card?.stock?.inWayTo   || 0;
    const inWayFrom = card?.stock?.inWayFrom || 0;
    res.json({
      nmId, title: card?.title, vendorCode: card?.vendorCode,
      stats, warehouses, inWayTo, inWayFrom,
      dimensions: card?.dimensions || {},
      prices: { afterDisc: card?.prices?.afterDisc || 0 },
      updatedAt: cache.updatedAt
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/refresh', async (req, res) => {
  try { lastRefresh = 0; refreshCache(); res.json({ ok: true, message: 'Refresh started' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PROXY: публичные цены WB (card.wb.ru) ───────────────────────────────────
// Браузер не может напрямую обратиться к card.wb.ru из-за CORS.
// Сервер делает запрос с заголовками браузера (без токена продавца).
app.get('/api/wb-prices', async (req, res) => {
  const nm = (req.query.nm || '').trim();
  if (!nm) return res.status(400).json({ error: 'nm required' });

  const url = `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nm}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Origin': 'https://www.wildberries.ru',
        'Referer': 'https://www.wildberries.ru/',
      },
    });
    if (!r.ok) {
      console.warn(`wb-prices proxy: card.wb.ru status ${r.status}`);
      return res.status(r.status).json({ error: `card.wb.ru returned ${r.status}` });
    }
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.warn('wb-prices proxy error:', e.message);
    res.status(502).json({ error: e.message });
  } finally { clearTimeout(timer); }
});

// ─── WB SEARCH PROXY (через browser_search.js + CDP) ─────────────────────────
// catalog.wb.ru и search.wb.ru без браузерных куки возвращают 403/429.
// Используем существующую CDP-инфраструктуру (тот же браузер что и для позиций).
const { searchPosition, isBrowserAvailable, launchBrowser: launchSearchBrowser } = require('./browser_search');

const searchCache = new Map();  // key → { ts, data }
const SEARCH_TTL  = 20 * 60 * 1000;  // 20 минут

// GET /api/wb-search?q=запрос&page=1
app.get('/api/wb-search', async (req, res) => {
  const q    = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  if (!q) return res.status(400).json({ error: 'q required' });

  const cacheKey = `${q}|${page}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEARCH_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  // Запускаем браузер если ещё не запущен
  if (!await isBrowserAvailable()) {
    launchSearchBrowser().catch(() => {});
    // Подождём немного
    await new Promise(r => setTimeout(r, 4000));
  }

  try {
    const result = await searchPosition(q, 0, page);   // nmId=0 → все товары

    if (result.rateLimited) {
      if (cached) return res.json({ ...cached.data, cached: true, stale: true });
      return res.status(429).json({ error: 'WB rate limit — попробуй через минуту' });
    }

    const data = {
      query: q,
      page,
      total: result.totalResults || result.products?.length || 0,
      products: (result.products || []).map(p => ({
        pos:       p._position,
        id:        p.id,
        name:      p.name || '',
        brand:     p.brand || '',
        price:     Math.round((p.salePriceU || p.priceU || 0) / 100),
        rating:    p.reviewRating || 0,
        feedbacks: p.feedbacks || 0,
        supplierId: p.supplierId,
        photo:     `https://basket-${String((Math.floor(p.id/100000) % 34) + 1).padStart(2,'0')}.wbbasket.ru/vol${Math.floor(p.id/100000)}/part${Math.floor(p.id/1000)}/${p.id}/images/c246x328/1.webp`,
      })),
    };
    searchCache.set(cacheKey, { ts: Date.now(), data });
    res.json(data);
  } catch(e) {
    if (cached) return res.json({ ...cached.data, cached: true, stale: true });
    res.status(502).json({ error: e.message });
  }
});

// GET /api/wb-suggest?q=запрос
// Возвращает исходный запрос (suggest API заблокирован без браузерных куки)
app.get('/api/wb-suggest', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ suggests: [] });
  // Просто возвращаем сам запрос — пользователь сразу видит его в списке и нажимает
  res.json({ suggests: [q] });
});



app.get('/api/status', (req, res) => {
  res.json({
    ready: !!cache.cards, isRefreshing,
    cards: cache.cards?.length || 0,
    updatedAt: cache.updatedAt,
    configured: hasToken(),   // <-- фронт проверяет этот флаг
  });
});

// ─── SETUP API ────────────────────────────────────────────────────────────────

// GET /api/setup/status — настроен ли токен
app.get('/api/setup/status', (req, res) => {
  const token = getToken();
  const fromFile = fs.existsSync(TOKEN_FILE);
  res.json({
    configured: !!token,
    fromFile,
    tokenPreview: token ? token.slice(0, 20) + '…' : null,
  });
});

// POST /api/setup/token — сохранить токен (с проверкой через WB API)
app.post('/api/setup/token', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length < 20)
    return res.status(400).json({ ok: false, error: 'Токен слишком короткий — проверь правильность' });

  // Проверяем токен обращением к WB API
  try {
    const testRes = await fetch('https://content-api.wildberries.ru/content/v2/get/cards/list', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { cursor: { limit: 1 }, filter: { withPhoto: -1 } } }),
      signal: AbortSignal.timeout(15000),
    });
    if (testRes.status === 401)
      return res.status(400).json({ ok: false, error: 'Токен недействителен (ошибка 401). Проверь токен в кабинете WB.' });
    if (testRes.status === 403)
      return res.status(400).json({ ok: false, error: 'Нет прав на контент (403). Убедись что токен скопирован целиком.' });
  } catch(e) {
    return res.status(400).json({ ok: false, error: `Ошибка проверки: ${e.message}` });
  }

  saveToken(token);
  lastRefresh = 0;  // сбрасываем кэш — загрузит данные с новым токеном
  refreshCache();
  res.json({ ok: true, message: 'Токен сохранён и проверен! Загружаем данные…' });
});

// ─── CUSTOM NAMES (пользовательские названия товаров) ─────────────────────────
const CUSTOM_NAMES_FILE   = path.join(__dirname, 'custom_names.json');
const SELLER_SESSION_FILE = path.join(__dirname, 'seller_session.json');

app.get('/api/custom-names', (req, res) => {
  try {
    if (fs.existsSync(CUSTOM_NAMES_FILE)) {
      const data = JSON.parse(fs.readFileSync(CUSTOM_NAMES_FILE, 'utf8'));
      res.json(data);
    } else {
      res.json({});
    }
  } catch (e) { res.json({}); }
});

app.post('/api/custom-names', (req, res) => {
  try {
    const names = req.body;
    if (names && typeof names === 'object') {
      fs.writeFileSync(CUSTOM_NAMES_FILE, JSON.stringify(names, null, 2), 'utf8');
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'invalid data' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────
// GET /api/seller-session/status
app.get('/api/seller-session/status', (req, res) => {
  const s = loadSellerSession();
  if (!s) return res.json({ ok: false, message: 'Сессия не настроена. Добавь через кнопку 🔑 СПП.' });
  res.json({ ok: true, updatedAt: s.updatedAt, hasRefreshToken: !!s.wbxRefresh });
});

// POST /api/seller-session — сохранить сессию из браузера
app.post('/api/seller-session', (req, res) => {
  try {
    const { authorizev3, wbxRefresh, wbxValidationKey, xSupplierId, cfidsWb, zzatwWb } = req.body;
    if (!authorizev3 || !wbxRefresh)
      return res.status(400).json({ error: 'authorizev3 и wbxRefresh обязательны' });
    const prev = loadSellerSession() || {};
    const updated = {
      ...prev,
      authorizev3, wbxRefresh,
      ...(wbxValidationKey && { wbxValidationKey }),
      ...(xSupplierId      && { xSupplierId }),
      ...(cfidsWb          && { cfidsWb }),
      ...(zzatwWb          && { zzatwWb }),
      updatedAt: new Date().toISOString(),
      note: 'Обновлено через UI дашборда. wbxRefresh живёт до июля 2026.',
    };
    fs.writeFileSync(SELLER_SESSION_FILE, JSON.stringify(updated, null, 2), 'utf8');
    lastRefresh = 0; // сбросить кэш — следующий loadCards подтянет реальную СПП
    res.json({ ok: true, message: 'Сессия сохранена! Нажми «Обновить» для загрузки реальной СПП.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/seller-session/refresh-auth — обновить authorizev3 через wbxRefresh
app.post('/api/seller-session/refresh-auth', async (req, res) => {
  const session = loadSellerSession();
  if (!session?.wbxRefresh) return res.status(400).json({ ok: false, error: 'Нет wbxRefresh токена' });
  const ok = await refreshSellerAuth(session);
  lastRefresh = 0;
  res.json({ ok, message: ok ? '✅ authorizev3 обновлён' : '⚠️ Не удалось — обнови сессию вручную' });
});

// ─── SEARCH TEXTS (поисковые запросы товара из seller-портала) ─────────────────
// Endpoint: seller-content.wildberries.ru/ns/analytics-api/content-analytics/api/v2/product/search-texts
// Возвращает список запросов, по которым заказывают товар (вкладка «Продвижение»)
app.get('/api/search-texts/:nmId', async (req, res) => {
  const nmId = parseInt(req.params.nmId);
  if (!nmId) return res.status(400).json({ error: 'nmId required' });

  const session = loadSellerSession();
  if (!session?.authorizev3) {
    return res.status(400).json({ error: 'Нет seller-сессии. Обнови через 🔑.' });
  }

  // Пробуем обновить authorizev3 если есть refresh-токен
  await refreshSellerAuth(session);

  const cookie = [
    'external-locale=ru',
    `wbx-validation-key=${session.wbxValidationKey || ''}`,
    `x-supplier-id-external=${session.xSupplierId || ''}`,
    `__zzatw-wb=${session.zzatwWb || ''}`,
    `cfidsw-wb=${session.cfidsWb || ''}`,
  ].join('; ');

  const url = `https://seller-content.wildberries.ru/ns/analytics-api/content-analytics/api/v2/product/search-texts?nm_id=${nmId}`;

  try {
    const r = await fetch(url, {
      headers: {
        'accept': '*/*',
        'authorizev3': session.authorizev3,
        'content-type': 'application/json',
        'cookie': cookie,
        'origin': 'https://seller.wildberries.ru',
        'referer': 'https://seller.wildberries.ru/',
        'wb-seller-lk': session.wbSellerLk || '',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) {
      console.warn(`search-texts: HTTP ${r.status} for nmId ${nmId}`);
      return res.status(r.status).json({ error: `WB returned ${r.status}` });
    }

    const data = await r.json();
    // data.data.phrases = [{ position, phrase, count, dynamic }, ...]
    res.json(data);
  } catch (e) {
    console.warn('search-texts error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── SEARCH FREQUENCY (частотность запросов на WB — вкладка Поиск WB) ─────────
// Endpoint: seller-content.wildberries.ru/ns/analytics-api/content-analytics/api/v2/search-analysis/search-texts
// POST с body: { searchText, interval, limit, offset, orderBy, subjectIDs, itemIDs }
// Возвращает: массив { text, frequency, frequencyDynamic, avgFrequency, priorityItem }
app.post('/api/search-frequency', async (req, res) => {
  const session = loadSellerSession();
  if (!session?.authorizev3) {
    return res.status(400).json({ error: 'Нет seller-сессии. Обнови через 🔑.' });
  }
  await refreshSellerAuth(session);

  const cookie = [
    'external-locale=ru',
    `wbx-validation-key=${session.wbxValidationKey || ''}`,
    `x-supplier-id-external=${session.xSupplierId || ''}`,
    `__zzatw-wb=${session.zzatwWb || ''}`,
    `cfidsw-wb=${session.cfidsWb || ''}`,
  ].join('; ');

  const body = {
    limit:      req.body.limit      || 50,
    offset:     req.body.offset     || 0,
    subjectIDs: req.body.subjectIDs || [],
    itemIDs:    req.body.itemIDs    || [],
    searchText: req.body.searchText || '',
    interval:   req.body.interval   || 'yesterday',
    orderBy:    req.body.orderBy    || { field: 'frequency', mode: 'desc' },
  };

  const url = 'https://seller-content.wildberries.ru/ns/analytics-api/content-analytics/api/v2/search-analysis/search-texts';

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'authorizev3': session.authorizev3,
        'content-type': 'application/json',
        'cookie': cookie,
        'origin': 'https://seller.wildberries.ru',
        'referer': 'https://seller.wildberries.ru/',
        'wb-seller-lk': session.wbSellerLk || '',
        'root-version': 'v1.90.1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) {
      const text = await r.text();
      console.warn(`search-frequency: HTTP ${r.status}`, text.slice(0, 200));
      return res.status(r.status).json({ error: `WB returned ${r.status}`, detail: text.slice(0, 200) });
    }

    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.warn('search-frequency error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── UTILS ────────────────────────────────────────────────────────────────────
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── ADVERT API HELPER ────────────────────────────────────────────────────────
// Использует тот же WB_TOKEN (разрешение «Продвижение»)
async function advertFetch(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { Authorization: config.WB_TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`ADV ${res.status} ${url.slice(0, 80)}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  } finally { clearTimeout(timer); }
}

// Список рекламных кампаний (active=9, paused=11, ready=4)
async function fetchAdvertsList() {
  const statuses = [9, 11, 4];
  const all = [];
  for (const status of statuses) {
    try {
      const data = await advertFetch(
        `https://advert-api.wildberries.ru/adv/v1/promotion/adverts?status=${status}&order=change&direction=desc&limit=1000&offset=0`
      );
      if (Array.isArray(data)) all.push(...data);
    } catch (e) { console.warn(`adverts status=${status}:`, e.message); }
    await sleep(1100); // строгий rate limit 1 req/sec
  }
  console.log(`✅ Adverts: ${all.length} campaigns`);
  return all;
}

// Агрегированная статистика по кампаниям с разбивкой по ключевым словам
// POST /adv/v2/fullstat — принимает массив { id, dates: [dateFrom, dateTo] }
async function fetchAdvertStats(campaignIds, dateFrom, dateTo) {
  if (!campaignIds.length) return {};
  const statsMap = {};
  // WB принимает до 100 кампаний за раз
  for (let i = 0; i < campaignIds.length; i += 100) {
    const batch = campaignIds.slice(i, i + 100);
    try {
      const body = batch.map(id => ({ id, dates: [dateFrom, dateTo] }));
      const data = await advertFetch(
        'https://advert-api.wildberries.ru/adv/v2/fullstat',
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (Array.isArray(data)) {
        for (const item of data) {
          const cId = item.advertId ?? item.id;
          // Суммируем по дням: views, clicks, sum, orders
          let views = 0, clicks = 0, sum = 0, orders = 0;
          const keywordsMap = {}; // keyword → { views, clicks, sum, orders }
          for (const day of (item.days || [])) {
            views  += day.views  || 0;
            clicks += day.clicks || 0;
            sum    += day.sum    || 0;
            orders += day.orders || 0;
            // Разбивка по ключевым словам (search/auto кампании)
            for (const kw of (day.keywords || [])) {
              const k = kw.keyword || kw.name || '?';
              if (!keywordsMap[k]) keywordsMap[k] = { views: 0, clicks: 0, sum: 0, orders: 0 };
              keywordsMap[k].views  += kw.views  || 0;
              keywordsMap[k].clicks += kw.clicks || 0;
              keywordsMap[k].sum    += kw.sum    || 0;
              keywordsMap[k].orders += kw.orders || 0;
            }
            // Auto кампании: запросы в apps[].nm
            for (const app of (day.apps || [])) {
              for (const nm of (app.nm || [])) {
                for (const kw of (nm.keywords || [])) {
                  const k = kw.keyword || kw.name || '?';
                  if (!keywordsMap[k]) keywordsMap[k] = { views: 0, clicks: 0, sum: 0, orders: 0 };
                  keywordsMap[k].views  += kw.views  || 0;
                  keywordsMap[k].clicks += kw.clicks || 0;
                  keywordsMap[k].sum    += kw.sum    || 0;
                  keywordsMap[k].orders += kw.orders || 0;
                }
              }
            }
          }
          // Топ-20 ключей по показам
          const keywords = Object.entries(keywordsMap)
            .map(([keyword, s]) => ({
              keyword,
              views: s.views, clicks: s.clicks, sum: s.sum, orders: s.orders,
              ctr: s.views > 0 ? +(s.clicks / s.views * 100).toFixed(2) : 0,
            }))
            .sort((a, b) => b.views - a.views)
            .slice(0, 20);

          statsMap[cId] = {
            views, clicks, sum, orders,
            ctr: views > 0 ? +(clicks / views * 100).toFixed(2) : 0,
            cpc: clicks > 0 ? +(sum / clicks).toFixed(2) : 0,
            keywords,
          };
        }
      }
    } catch (e) { console.warn('advertStats batch:', e.message); }
    if (i + 100 < campaignIds.length) await sleep(1100);
  }
  return statsMap;
}

// ─── KEYWORD QUERIES STORAGE ──────────────────────────────────────────────────
// Хранит список ключевых запросов для каждого nmId + последние позиции
const KEYWORD_QUERIES_FILE = path.join(__dirname, 'keyword_queries.json');

function loadKeywordQueries() {
  try {
    if (fs.existsSync(KEYWORD_QUERIES_FILE))
      return JSON.parse(fs.readFileSync(KEYWORD_QUERIES_FILE, 'utf8'));
  } catch(e) { console.warn('loadKeywordQueries:', e.message); }
  return {};
}

function saveKeywordQueries(data) {
  try { fs.writeFileSync(KEYWORD_QUERIES_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch(e) { console.warn('saveKeywordQueries:', e.message); }
}

// ─── ADS CACHE ────────────────────────────────────────────────────────────────
let adsCache = { campaigns: null, updatedAt: null };
let adsLastRefresh = 0, adsIsRefreshing = false;
const ADS_CACHE_TTL = 15 * 60 * 1000; // 15 минут

async function refreshAdsCache(days = 7) {
  if (adsIsRefreshing) return;
  adsIsRefreshing = true;
  try {
    const campaigns = await fetchAdvertsList();
    if (!campaigns.length) {
      adsCache = { campaigns: [], updatedAt: new Date().toISOString() };
      adsLastRefresh = Date.now();
      return;
    }
    const dateFrom = daysAgo(days);
    const dateTo   = new Date().toISOString().slice(0, 10);
    const ids = campaigns.map(c => c.advertId || c.id).filter(Boolean);
    const statsMap = await fetchAdvertStats(ids, dateFrom, dateTo);

    const TYPE_LABELS = { 4: 'Каталог', 5: 'Карточка', 6: 'Поиск', 7: 'Рекомендации', 8: 'Авто', 9: 'Поиск' };
    const STATUS_LABELS = { '-1': 'Удалена', 4: 'Готова', 7: 'Завершена', 8: 'Отклонена', 9: 'Активна', 11: 'Пауза' };

    adsCache.campaigns = campaigns.map(c => {
      const id    = c.advertId || c.id;
      const stats = statsMap[id] || {};
      return {
        id,
        name:        c.name || `Кампания #${id}`,
        type:        c.type,
        typeLabel:   TYPE_LABELS[c.type] || `Тип ${c.type}`,
        status:      c.status,
        statusLabel: STATUS_LABELS[String(c.status)] || String(c.status),
        dailyBudget: c.dailyBudget || 0,
        createTime:  c.createTime,
        changeTime:  c.changeTime,
        views:    stats.views    || 0,
        clicks:   stats.clicks   || 0,
        ctr:      stats.ctr      || 0,
        cpc:      stats.cpc      || 0,
        sum:      stats.sum      || 0,
        orders:   stats.orders   || 0,
        keywords: stats.keywords || [],
      };
    });
    adsCache.updatedAt = new Date().toISOString();
    adsLastRefresh = Date.now();
    console.log(`✅ Ads cache: ${adsCache.campaigns.length} campaigns`);
  } catch (e) {
    console.error('❌ Ads refresh error:', e);
  } finally { adsIsRefreshing = false; }
}

async function ensureAdsCache(days = 7) {
  if (!adsCache.campaigns || Date.now() - adsLastRefresh > ADS_CACHE_TTL) await refreshAdsCache(days);
}

// ─── KEYWORD ROUTES ───────────────────────────────────────────────────────────

// GET /api/keywords/:nmId — список сохранённых запросов с позициями
app.get('/api/keywords/:nmId', (req, res) => {
  const nmId = parseInt(req.params.nmId);
  if (!nmId) return res.status(400).json({ error: 'invalid nmId' });
  const data = loadKeywordQueries();
  res.json({ keywords: data[nmId] || [] });
});

// POST /api/keywords/:nmId — сохранить/обновить список запросов
app.post('/api/keywords/:nmId', (req, res) => {
  const nmId = parseInt(req.params.nmId);
  if (!nmId) return res.status(400).json({ error: 'invalid nmId' });
  const { keywords } = req.body;
  if (!Array.isArray(keywords)) return res.status(400).json({ error: 'keywords must be array' });
  const data = loadKeywordQueries();
  data[nmId] = keywords;
  saveKeywordQueries(data);
  res.json({ ok: true });
});

// POST /api/check-positions/:nmId — проверить позиции по всем сохранённым запросам
// Ищет до MAX_PAGES страниц (100 товаров/страница) на search.wb.ru
app.post('/api/check-positions/:nmId', async (req, res) => {
  const nmId = parseInt(req.params.nmId);
  if (!nmId) return res.status(400).json({ error: 'invalid nmId' });

  const { queries } = req.body; // опционально: массив строк для добавления
  const data = loadKeywordQueries();
  let keywords = data[nmId] || [];

  // Если переданы новые запросы — объединяем (без дублей)
  if (Array.isArray(queries)) {
    for (const q of queries) {
      const trimmed = q.trim();
      if (trimmed && !keywords.find(k => k.query === trimmed))
        keywords.push({ query: trimmed, position: null, totalResults: null, checkedAt: null });
    }
  }

  if (!keywords.length) {
    return res.json({ keywords: [] });
  }

  const MAX_PAGES = 5; // ищем до 500 позиции
  const DELAY_BETWEEN_QUERIES = 2000;  // 2 сек между запросами
  const DELAY_BETWEEN_PAGES   = 1000;  // 1 сек между страницами

  const results = [];
  let rateLimited = false;

  for (let ki = 0; ki < keywords.length; ki++) {
    const kw = keywords[ki];
    if (rateLimited) {
      results.push({ ...kw, error: 'rate_limited' });
      continue;
    }

    let found = false;
    let position = null;
    let totalResults = 0;
    let searchError = null;

    try {
      for (let page = 1; page <= MAX_PAGES && !found; page++) {
        const q = encodeURIComponent(kw.query);
        // v5 works better from Node.js (v7 returns 429)
        const url = `https://search.wb.ru/exactmatch/ru/common/v5/search?query=${q}&spp=30&resultset=catalog&limit=100&sort=popular&page=${page}&appType=1&curr=rub&dest=-1257786`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const r = await fetch(url, {
            signal: controller.signal,
            headers: {
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
              'accept': '*/*',
              'accept-language': 'ru-RU,ru;q=0.9',
              'origin': 'https://www.wildberries.ru',
              'referer': 'https://www.wildberries.ru/',
            },
          });

          if (r.status === 429) { rateLimited = true; searchError = 'rate_limited'; break; }
          if (!r.ok) { searchError = `HTTP ${r.status}`; break; }

          const text = await r.text();
          let sd;
          try { sd = JSON.parse(text); }
          catch(e) { rateLimited = true; searchError = 'rate_limited'; break; } // HTML = rate limited

          // v5: sd.products, v7: sd.data.products
          const prods = sd?.data?.products || sd?.products || [];
          if (page === 1) totalResults = sd?.data?.total || sd?.total || 0;

          const idx = prods.findIndex(p => p.id === nmId);
          if (idx !== -1) {
            found = true;
            position = (page - 1) * 100 + idx + 1;
          }
          if (!found && prods.length < 100) break; // страниц больше нет
        } finally { clearTimeout(timer); }

        if (!found && page < MAX_PAGES) await sleep(DELAY_BETWEEN_PAGES);
      }
    } catch(e) { searchError = e.message; }

    const updatedKw = {
      query: kw.query,
      position: found ? position : null,
      totalResults,
      found,
      checkedAt: new Date().toISOString(),
      error: searchError,
    };
    results.push(updatedKw);

    if (ki < keywords.length - 1 && !rateLimited) await sleep(DELAY_BETWEEN_QUERIES);
  }

  // Сохраняем обновлённые данные
  data[nmId] = results;
  saveKeywordQueries(data);

  res.json({ keywords: results, rateLimited });
});

// ─── ADS ROUTES ───────────────────────────────────────────────────────────────

// GET /api/ads?days=7  — список кампаний с агрегированной статистикой
app.get('/api/ads', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    await ensureAdsCache(days);
    const empty = !adsCache.campaigns || adsCache.campaigns.length === 0;
    res.json({
      campaigns: adsCache.campaigns || [],
      empty,
      updatedAt: adsCache.updatedAt,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ads/refresh  — принудительное обновление кэша рекламы
app.post('/api/ads/refresh', async (req, res) => {
  adsLastRefresh = 0;
  refreshAdsCache(parseInt(req.query.days) || 7);
  res.json({ ok: true, message: 'Ads refresh started' });
});

// GET /api/ads/:campaignId?days=7  — детальная статистика одной кампании
app.get('/api/ads/:campaignId', async (req, res) => {
  try {
    const id   = parseInt(req.params.campaignId);
    const days = parseInt(req.query.days) || 7;
    if (!id) return res.status(400).json({ error: 'invalid campaignId' });
    const dateFrom = daysAgo(days);
    const dateTo   = new Date().toISOString().slice(0, 10);
    const statsMap = await fetchAdvertStats([id], dateFrom, dateTo);
    res.json({ id, stats: statsMap[id] || {}, updatedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/search-positions?nmId=123&query=панно+декор&page=1
// Проксирует запрос к WB Search API через browser CDP (приоритет) или Node.js fetch (fallback)
// nmId=0 допустим — означает «просто показать выдачу» (для вкладки Поиск WB)
app.get('/api/search-positions', async (req, res) => {
  const nmId  = parseInt(req.query.nmId) || 0;
  const query = (req.query.query || '').trim();
  const page  = parseInt(req.query.page) || 1;
  if (!query) return res.status(400).json({ error: 'query обязателен' });

  try {
    const { searchPosition } = require('./browser_search');
    const result = await searchPosition(query, nmId, page);
    result.query = query;
    res.json(result);
  } catch (e) {
    console.error('search-positions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/browser-status — проверить доступен ли Яндекс Браузер через CDP
app.get('/api/browser-status', async (req, res) => {
  try {
    const { isBrowserAvailable } = require('./browser_search');
    const available = await isBrowserAvailable();
    res.json({ available, port: 9222 });
  } catch(e) {
    res.json({ available: false, error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(config.PORT, () => {
  console.log(`🚀 WB Dashboard → http://localhost:${config.PORT}`);
  refreshCache();
});
setInterval(() => { if (Date.now() - lastRefresh > CACHE_TTL) refreshCache(); }, 60000);
