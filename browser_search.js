/**
 * browser_search.js — Модуль поиска позиции товара через CDP (Chrome DevTools Protocol)
 * 
 * Автоматически запускает headless-браузер (Chrome / Edge / Яндекс Браузер)
 * с --remote-debugging-port=9222 и делает поисковые запросы через него.
 * 
 * Запросы идут через реальный браузер — TLS-фингерпринт легитимный,
 * как у Bider и других расширений. WB не блокирует их (в отличие от Node.js fetch).
 */
'use strict';

const http = require('http');
const fetch = require('node-fetch');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const SEARCH_DELAY_MS = 3000;

let lastSearchTime = 0;
let browserProcess = null;
let browserLaunching = false;

const httpsAgent = new https.Agent({ rejectUnauthorized: true });

// ── Пути к браузерам на Windows ──
const BROWSER_PATHS = [
  process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env['PROGRAMFILES'] + '\\Yandex\\YandexBrowser\\Application\\browser.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Yandex\\YandexBrowser\\Application\\browser.exe',
  process.env['LOCALAPPDATA'] + '\\Yandex\\YandexBrowser\\Application\\browser.exe',
  process.env['LOCALAPPDATA'] + '\\Google\\Chrome SxS\\Application\\chrome.exe',
].filter(Boolean);

// ── HTTP GET ──
function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── CDP available? ──
async function isBrowserAvailable() {
  try {
    const data = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/version`, 2000);
    JSON.parse(data);
    return true;
  } catch(e) { return false; }
}

// ── Найти браузер ──
function findBrowser() {
  for (const p of BROWSER_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch(e) {}
  }
  return null;
}

// ── Запустить браузер ──
async function launchBrowser() {
  if (browserLaunching) return;
  browserLaunching = true;

  if (await isBrowserAvailable()) {
    console.log('✅ Браузер уже запущен с CDP на порту', CDP_PORT);
    browserLaunching = false;
    return;
  }

  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('⚠️  Браузер не найден. Установите Chrome/Edge/Яндекс Браузер.');
    browserLaunching = false;
    return;
  }

  const name = browserPath.includes('YandexBrowser') ? 'Яндекс Браузер'
    : browserPath.includes('msedge') ? 'Edge' : 'Chrome';
  console.log(`🌐 Запуск ${name} (headless) для поиска WB...`);

  const userDataDir = path.join(__dirname, '.browser-cdp-profile');
  browserProcess = spawn(browserPath, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu', '--disable-sync',
    '--mute-audio', '--window-size=1280,720', 'about:blank',
  ], { detached: false, stdio: 'ignore', windowsHide: true });

  browserProcess.on('error', () => { browserProcess = null; });
  browserProcess.on('exit', () => { browserProcess = null; });

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isBrowserAvailable()) {
      console.log(`✅ ${name} запущен (CDP :${CDP_PORT})`);
      browserLaunching = false;
      return;
    }
  }
  console.warn('⚠️  CDP не отвечает');
  browserLaunching = false;
}

function stopBrowser() {
  if (browserProcess) { try { browserProcess.kill(); } catch(e) {} browserProcess = null; }
}
process.on('exit', stopBrowser);
process.on('SIGINT', () => { stopBrowser(); process.exit(); });

// ── CDP WebSocket ──
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = {};
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
    });
    ws.addEventListener('open', () => {
      resolve({
        send: (method, params = {}) => new Promise(res => {
          const id = nextId++;
          pending[id] = res;
          ws.send(JSON.stringify({ id, method, params }));
        }),
        close: () => { try { ws.close(); } catch(e) {} },
      });
    });
    ws.addEventListener('error', () => reject(new Error('CDP WS error')));
    setTimeout(() => reject(new Error('CDP connect timeout')), 8000);
  });
}

// ── Навигация на WB (один раз) ──
let wbPageReady = false;

async function ensureWBPage() {
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${CDP_PORT}/json`));
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No browser tab');

  if (!wbPageReady) {
    const cdp = await cdpConnect(page.webSocketDebuggerUrl);
    try {
      const loc = await cdp.send('Runtime.evaluate', {
        expression: 'window.location.href', returnByValue: true,
      });
      const url = loc?.result?.result?.value || '';
      if (!url.includes('wildberries.ru')) {
        console.log('  📄 Opening wildberries.ru in browser...');
        await cdp.send('Page.enable');
        await cdp.send('Page.navigate', { url: 'https://www.wildberries.ru/' });
        await new Promise(r => setTimeout(r, 5000));
      }
      wbPageReady = true;
    } finally { cdp.close(); }
  }
  return page;
}

// ── Fetch JSON через CDP (двухшаговый подход) ──
// Шаг 1: запускаем fetch() и сохраняем результат в window.__cdpResult
// Шаг 2: читаем window.__cdpResult
// Это надёжнее чем awaitPromise (который может потеряться при больших ответах)
async function browserFetchJSON(url) {
  const page = await ensureWBPage();
  const cdp = await cdpConnect(page.webSocketDebuggerUrl);

  try {
    // Шаг 1: запускаем fetch и сохраняем результат
    const uid = '_r' + Date.now();
    await cdp.send('Runtime.evaluate', {
      expression: `
        window.${uid} = null;
        window.${uid}_err = null;
        fetch(${JSON.stringify(url)})
          .then(r => {
            if (r.status === 429) { window.${uid}_err = '429'; return; }
            if (!r.ok) { window.${uid}_err = 'HTTP_' + r.status; return; }
            return r.text();
          })
          .then(t => { if (t) window.${uid} = t; })
          .catch(e => { window.${uid}_err = e.message; });
        true;
      `,
      returnByValue: true,
    });

    // Шаг 2: ждём и читаем результат (до 8 секунд)
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));

      // Проверяем ошибку
      const errResp = await cdp.send('Runtime.evaluate', {
        expression: `window.${uid}_err`,
        returnByValue: true,
      });
      const err = errResp?.result?.result?.value;
      if (err === '429') return { _rateLimited: true };
      if (err) throw new Error(err);

      // Проверяем результат
      const resp = await cdp.send('Runtime.evaluate', {
        expression: `window.${uid} ? window.${uid}.length : -1`,
        returnByValue: true,
      });
      const len = resp?.result?.result?.value;
      if (len > 0) {
        // Результат готов — читаем частями если большой
        let fullText = '';
        const CHUNK = 50000;
        for (let offset = 0; offset < len; offset += CHUNK) {
          const chunkResp = await cdp.send('Runtime.evaluate', {
            expression: `window.${uid}.substring(${offset}, ${offset + CHUNK})`,
            returnByValue: true,
          });
          fullText += chunkResp?.result?.result?.value || '';
        }

        // Очистка
        await cdp.send('Runtime.evaluate', {
          expression: `delete window.${uid}; delete window.${uid}_err;`,
        });

        return JSON.parse(fullText);
      }
    }

    throw new Error('Browser fetch timeout');
  } finally {
    cdp.close();
  }
}

// ── Build search URL ──
function buildSearchUrl(query, page) {
  const q = encodeURIComponent(query);
  return `https://search.wb.ru/exactmatch/ru/common/v5/search?query=${q}&spp=30&resultset=catalog&limit=100&sort=popular&page=${page}&appType=1&curr=rub&dest=-1257786`;
}

// ── Search via Browser CDP ──
async function searchViaBrowser(query, nmId, page = 1) {
  const url = buildSearchUrl(query, page);
  const data = await browserFetchJSON(url);
  if (data._rateLimited) return { rateLimited: true };

  const prods = data?.data?.products || data?.products || [];
  if (data.shardKey && data.query && !prods.length) {
    await new Promise(r => setTimeout(r, 2000));
    const url2 = `https://search.wb.ru/exactmatch/ru/${data.shardKey}/catalog?${data.query}&resultset=catalog&limit=100&sort=popular&page=${page}&appType=1&curr=rub&dest=-1257786&spp=30`;
    const data2 = await browserFetchJSON(url2);
    if (data2._rateLimited) return { rateLimited: true };
    return extractPosition(data2, nmId, page);
  }

  return extractPosition(data, nmId, page);
}

// ── Search via Node.js fetch (fallback, often gets 429) ──
async function searchViaNodeFetch(query, nmId, page = 1) {
  const url = buildSearchUrl(query, page);
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 8000;
      console.log(`  ↻ Retry ${attempt}/${MAX_RETRIES} after ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const r = await fetch(url, {
        headers: {
          'accept': '*/*',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'origin': 'https://www.wildberries.ru',
          'referer': 'https://www.wildberries.ru/',
        },
        agent: httpsAgent,
        signal: AbortSignal.timeout(15000),
      });

      if (r.status === 429) {
        if (attempt < MAX_RETRIES) continue;
        return { rateLimited: true };
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); }
      catch(e) { if (attempt < MAX_RETRIES) continue; return { rateLimited: true }; }

      return extractPosition(data, nmId, page);
    } catch(e) {
      if (attempt >= MAX_RETRIES) throw e;
    }
  }
  return { rateLimited: true };
}

// ── Extract position (supports v5 and v7 formats) ──
function extractPosition(data, nmId, page) {
  const products = data?.data?.products || data?.products || [];
  const total = data?.data?.total || data?.total || 0;
  const idx = nmId > 0 ? products.findIndex(p => p.id === nmId) : -1;

  const productsWithPos = products.map((p, i) => {
    let salePriceU = p.salePriceU;
    let priceU = p.priceU;
    if (!salePriceU && p.sizes?.length) {
      const sz = p.sizes[0];
      salePriceU = sz.price?.product;
      priceU = sz.price?.basic;
    }
    return {
      ...p,
      _position: (page - 1) * 100 + i + 1,
      salePriceU: salePriceU || 0,
      priceU: priceU || 0,
    };
  });

  return {
    query: null, page, nmId,
    found: idx !== -1,
    position: idx !== -1 ? (page - 1) * 100 + idx + 1 : null,
    posOnPage: idx !== -1 ? idx + 1 : null,
    totalResults: total,
    pageSize: products.length,
    products: productsWithPos,
    rateLimited: false,
  };
}

// ── Main search function ──
async function searchPosition(query, nmId, page = 1) {
  const now = Date.now();
  const elapsed = now - lastSearchTime;
  if (elapsed < SEARCH_DELAY_MS) {
    await new Promise(r => setTimeout(r, SEARCH_DELAY_MS - elapsed));
  }
  lastSearchTime = Date.now();

  const hasBrowser = await isBrowserAvailable();

  if (hasBrowser) {
    try {
      console.log(`🌐 Search via CDP: "${query}" page ${page}`);
      return await searchViaBrowser(query, nmId, page);
    } catch(e) {
      console.warn('CDP search failed:', e.message, '→ fallback to Node.js');
    }
  } else if (!browserLaunching && !browserProcess) {
    launchBrowser().catch(() => {});
  }

  console.log(`📡 Search via Node.js: "${query}" page ${page}`);
  return await searchViaNodeFetch(query, nmId, page);
}

// Автозапуск браузера
launchBrowser().catch(() => {});

module.exports = { searchPosition, isBrowserAvailable, launchBrowser, stopBrowser };
