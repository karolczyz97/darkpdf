// pdf.js 4.10.38 trzymamy w repo (lib/pdfjs), więc razem z plikiem sw.js czytnik działa też bez internetu
const PDFJS = new URL('lib/pdfjs/', import.meta.url).href;
const pdfjsLib = await import(PDFJS + 'build/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.min.mjs';

import {
  initCalcPanel,
  isCalcOpen,
  setCalcOpen,
  toggleCalc,
  getCalcStageWidth,
  resetUserCustomWidth,
  isUserCustomWidth,
  snapCalcToHeightFit,
  handleCalcResize
} from './calc-panel.js?v=2';

// Pamięć podręczna aplikacji: po pierwszej wizycie czytnik otwiera się też offline
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register(new URL('sw.js', import.meta.url)).catch(() => {});
}

// ---- Ustawienia przeglądarki ----
const NOTCH_MIN_PX = 40;      // zdarzenie kółka >= tyle px = ząbek myszy (każdy ząbek = rozkładówka)
const TOUCHPAD_PX = 100;      // tyle px ruchu touchpada = jedna rozkładówka
const LO_QUALITY = 0.35;      // rozdzielczość szybkiego podglądu, gdy strona nie jest jeszcze gotowa
const PREFETCH_AHEAD = 3;     // ile rozkładówek do przodu renderować w tle
const PREFETCH_BEHIND = 1;    // ile rozkładówek wstecz
const TEXT_PAGES_AROUND = 2;  // tekst ilu stron przed/po trzymać w DOM dla czytników/Gemini
const MARGIN = 6;             // margines wokół stron (px)
const GAP = 4;                // odstęp między stronami (px)
const CACHE_MAX = 24;         // ile wyrenderowanych stron trzymać w pamięci

const stage = document.getElementById('stage');
const hint = document.getElementById('hint');
const textLayer = document.getElementById('text');
stage.style.gap = GAP + 'px';

// Ustawienia trzymane w przeglądarce; typ bierzemy z wartości domyślnej.
const pref = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      if (v === null) return d;
      if (typeof d === 'boolean') return v === '1';
      if (typeof d === 'number') return parseInt(v, 10) || d;
      return v;
    } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)); } catch {} },
  json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  setJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

const COLOR_MODES = ['dark', 'light', 'auto'];
const COLOR_LABELS = {
  dark: 'Tryb: Ciemny',
  light: 'Tryb: Jasny',
  auto: 'Tryb: Auto'
};


let colorMode = pref.get('colorMode', null);
if (!colorMode) {
  const oldDark = pref.get('dark', true);
  colorMode = oldDark ? 'dark' : 'light';
}
if (!COLOR_MODES.includes(colorMode)) colorMode = 'dark';

let palette = pref.get('palette', null);
if (!palette) {
  const oldTheme = pref.get('theme', 'gemini');
  palette = oldTheme === 'gemini' ? 'gemini' : 'system';
}
if (!['gemini', 'system'].includes(palette)) palette = 'gemini';

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
systemDark.addEventListener('change', () => {
  if (colorMode === 'auto') applyTheme();
});

let two = pref.get('two', true);           // dwie strony obok siebie czy jedna

// Tryb mobilny: wąski ekran albo dotyk. Na telefonie w pionie zawsze jedna strona
// (dwie byłyby nieczytelne), a zapamiętane ustawienie P zostaje na komputer.
// Tylko po rozmiarze ekranu: laptopy z ekranem dotykowym zgłaszają „dotyk” i „brak najechania”,
// więc na tym nie można polegać. Telefon w pionie jest wąski, a w poziomie niski.
const mobileMq = matchMedia('(max-width: 760px), (max-height: 500px) and (max-width: 1000px)');
const isMobile = () => mobileMq.matches;
const showTwo = () => two && !(isMobile() && window.innerWidth < window.innerHeight);
document.documentElement.classList.toggle('mobile', isMobile());
let crop = pref.get('crop', true);         // przycinanie białych marginesów
let rot = 0;                                             // obrót stron: 0, 90, 180, 270
let pairing = 'odd';      // 'odd' = 1–2, 3–4…   'even' = 1, 2–3, 4–5…
let pdf = null, numPages = 0, start = 1;
let fileKey = null, fileName = 'PDF';
let showToken = 0;

// Mapa, która sama wyrzuca najdawniej używany wpis po przekroczeniu limitu.
function lru(max = Infinity) {
  const m = new Map();
  return {
    has: (k) => m.has(k),
    get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) { m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); return v; },
    clear: () => m.clear()
  };
}

let fitMode = pref.get('fitMode', 'auto'); // 'auto' | 'width' | 'height'
document.documentElement.classList.toggle('fit-width', fitMode === 'width');
document.documentElement.classList.toggle('fit-height', fitMode === 'height');

const sizeCache = lru();             // nr strony -> obszar do pokazania
const canvasCache = lru(CACHE_MAX);  // klucz -> gotowa strona
const loCache = lru(60);             // klucz -> szybki podgląd
const tlCache = lru(CACHE_MAX);      // klucz -> warstwa tekstowa
const textCache = lru();             // nr strony -> tekst
const tcCache = lru();               // nr strony -> Promise<textContent>
const pending = new Map();           // klucz -> trwające renderowanie

// Gotowe obrazy stron są liczone dla konkretnej skali – po zmianie układu wyrzucamy je
function clearRenderCaches() { canvasCache.clear(); loCache.clear(); tlCache.clear(); }

// Przerysowanie z krótkim opóźnieniem, żeby seria zmian (przeciąganie, przełączniki) dała jedno
let resizeTimer;
function rerenderSoon(ms = 120) {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { clearRenderCaches(); show(start); }, ms);
}

function clearCaches() {
  for (const job of pending.values()) job.cancel();
  for (const c of [sizeCache, canvasCache, loCache, tlCache, textCache, tcCache]) c.clear();
  clearCropCache();
}

const isDarkNow = () => (colorMode === 'auto' ? systemDark.matches : colorMode === 'dark');


let menuReady = false;   // pasek jest budowany niżej w pliku; do tego czasu go nie odświeżamy

function applyTheme() {
  const isDark = isDarkNow();
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.classList.toggle('gemini', isDark && palette === 'gemini');
  if (menuReady) updateMenu();
}

function cycleColorMode() {
  const nextIdx = (COLOR_MODES.indexOf(colorMode) + 1) % COLOR_MODES.length;
  colorMode = COLOR_MODES[nextIdx];
  pref.set('colorMode', colorMode);
  pref.set('dark', colorMode !== 'light');
  applyTheme();
  flash(COLOR_LABELS[colorMode]);
}

function togglePalette() {
  palette = palette === 'gemini' ? 'system' : 'gemini';
  pref.set('palette', palette);
  pref.set('theme', palette === 'gemini' ? 'gemini' : 'normal');
  applyTheme();
  flash(palette === 'gemini' ? 'Motyw: Gemini' : 'Motyw: Systemowy');
}

applyTheme();
document.documentElement.classList.add('empty');

let hintTimer;
function flash(text, ms = 1200) {
  hint.textContent = text;
  hint.hidden = false;
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => { hint.hidden = true; }, ms);
}

initCalcPanel({
  pref,
  stage,
  isMobile,
  isPdfLoaded: () => Boolean(pdf),
  getStartPage: () => start,
  getPageBox: (n) => pageBox(n),
  getPageSize: (n) => sizeCache.get(n),
  setPageSize: (n, b) => sizeCache.set(n, b),
  spreadOf: (s) => spreadOf(s),
  showTwo: () => showTwo(),
  getFitMode: () => fitMode,
  MARGIN,
  GAP,
  fitNow,
  rerenderSoon,
  updateMenu,
  getTheme: () => ({ isDark: isDarkNow(), palette }),
  flash
});

// ---------- rozkład stron ----------
function spreadStartOf(p) {
  p = Math.min(Math.max(1, p), numPages);
  if (!showTwo()) return p;
  if (pairing === 'odd') return p % 2 ? p : p - 1;
  return p === 1 ? 1 : (p % 2 ? p - 1 : p);
}
function spreadOf(s) {
  if (!showTwo()) return [s, null];
  if (pairing === 'even' && s === 1) return [null, 1]; // okładka sama, po prawej
  return [s, s + 1 <= numPages ? s + 1 : null];
}
function nextStart(s) {
  const n = !showTwo() ? s + 1 : (pairing === 'even' && s === 1) ? 2 : s + 2;
  return n <= numPages ? n : null;
}
function prevStart(s) { return s <= 1 ? null : spreadStartOf(s - 1); }

const rotationOf = (page) => (page.rotate + rot + 360) % 360;
const CROP_SAMPLES = 28;        // ile stron badamy, żeby ustalić wspólne idealne obcięcie
const CROP_THRESHOLD = 235;    // jaśniejsze piksele uznajemy za pusty margines
const CROP_STEP = 2;           // co który piksel miniatury sprawdzamy

const cropJobs = new Map();    // klucz grupy stron -> Promise<box>

// Strony lewe i prawe mają w książkach inne marginesy, a strona może mieć inny
// rozmiar, więc grupujemy po parzystości i wymiarach. W obrębie grupy wszystkie
// strony dostają to samo obcięcie, żeby tekst nie skakał przy przewracaniu.
const groupKey = (n, full) => `${n % 2}|${Math.round(full.width)}x${Math.round(full.height)}|${rot}`;

const ownJobs = new Map();     // nr strony -> Promise<ramka treści tej jednej strony>

async function pageBox(n) {
  if (!pdf || !numPages || !n || n < 1 || n > numPages) return null;
  const page = await pdf.getPage(n);
  const full = page.getViewport({ scale: 1, rotation: rotationOf(page) });
  const whole = { x: 0, y: 0, w: full.width, h: full.height };
  if (!crop) return whole;
  const k = groupKey(n, full);
  if (!cropJobs.has(k)) {
    // Szybki start: najpierw kilka najbliższych stron, pełną próbkę liczymy w tle
    const quick = groupBox(n, full, k, CROP_QUICK);
    cropJobs.set(k, quick);
    refineCrop(n, full, k, quick);
  }
  const common = await cropJobs.get(k);
  if (!common) return whole;

  // Wyjątek dla stron, na których wspólne cięcie coś by ucięło: zdjęcie na całą stronę,
  // okładka, rysunek wchodzący w margines. Taka strona idzie w całości.
  if (!ownJobs.has(n)) ownJobs.set(n, detectContent(page, full));
  const own = await ownJobs.get(n);
  if (own && cutsContent(own, common, full)) return whole;
  return common;
}

const CROP_QUICK = 6;           // tyle stron badamy przed pokazaniem pierwszej
let cropGen = 0;                // rośnie przy każdym czyszczeniu – stare obliczenia w tle wtedy przepadają

// Pełna próbka w tle. Jeśli dała inne cięcie niż szybka, podmieniamy je raz i przerysowujemy.
async function refineCrop(n, full, k, quick) {
  const gen = cropGen;
  const first = await quick;
  const better = await groupBox(n, full, k, CROP_SAMPLES);
  if (gen !== cropGen || cropJobs.get(k) !== quick) return;   // w międzyczasie zmienił się plik lub ustawienia
  const same = (a, b) => (!a && !b) || (a && b && ['x', 'y', 'w', 'h'].every((q) => Math.abs(a[q] - b[q]) < 1));
  cropJobs.set(k, Promise.resolve(better));
  if (same(first, better)) return;
  sizeCache.clear();
  clearRenderCaches();
  show(start);
}

function cutsContent(own, box, full) {
  const tx = full.width * 0.015, ty = full.height * 0.015;   // tolerancja ~1,5%
  const fullBleed = (own.r - own.x) > full.width * 0.96 && (own.bt - own.y) > full.height * 0.96;
  return fullBleed ||
    own.x < box.x - tx || own.y < box.y - ty ||
    own.r > box.x + box.w + tx || own.bt > box.y + box.h + ty;
}

function clearCropCache() {
  cropGen++;
  cropJobs.clear();
  ownJobs.clear();
}

// Pomocnik do równoległego przetwarzania z limitem równoczesnych zadań
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const cur = index++;
      try {
        results[cur] = await fn(items[cur]);
      } catch {
        results[cur] = null;
      }
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

// Generuje reprezentatywną próbkę stron do wyznaczenia idealnego przycięcia:
// Bezpieczne dla dowolnej liczby stron (od 1 strony do tysięcy)
function getCropCandidatePages(n, total, max = CROP_SAMPLES) {
  if (!total) return [];
  n = Math.max(1, Math.min(total, n || 1));
  const parity = n % 2;
  const all = [];
  for (let p = parity || 2; p <= total; p += 2) all.push(p);
  if (all.length <= max) return all;                     // krótki dokument: bierzemy wszystko
  const pages = new Set([n]);
  for (let d = 2; d <= 24 && pages.size < Math.min(8, max); d += 2) {   // sąsiedztwo bieżącej strony
    if (n + d <= total) pages.add(n + d);
    if (n - d >= 1) pages.add(n - d);
  }
  const rest = max - pages.size;                         // reszta równo po całym dokumencie
  for (let i = 0; i < rest; i++) pages.add(all[Math.floor(((i + 0.5) / rest) * all.length)]);
  for (const p of all) { if (pages.size >= max) break; pages.add(p); }   // dopełnienie po kolizjach
  return [...pages].sort((x, y) => x - y);
}

// Bierzemy szeroką próbkę stron z tej samej grupy i najszerszy wspólny obszar treści,
// więc nic się nie urywa, a wszystkie strony wychodzą tej samej wielkości.
async function groupBox(n, full, k, samples = CROP_SAMPLES) {
  if (!pdf || !numPages || numPages < 1) return null;
  const pages = getCropCandidatePages(n, numPages, samples);
  if (!pages.length) return null;

  const scannedBoxes = await mapConcurrent(pages, 6, async (p) => {
    try {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1, rotation: rotationOf(page) });
      if (groupKey(p, vp) !== k) return null;
      if (!ownJobs.has(p)) ownJobs.set(p, detectContent(page, vp));   // wynik przyda się też przy wyświetlaniu
      return await ownJobs.get(p);
    } catch {
      return null;
    }
  });

  const valid = scannedBoxes.filter(Boolean);
  if (!valid.length) return null;

  // Sprawdzamy czy strona to full-bleed (np. okładka lub zdjęcie na całą stronę)
  const isFullBleed = (b) => (b.r - b.x) > full.width * 0.96 && (b.bt - b.y) > full.height * 0.96;
  let usable = valid;
  if (valid.length >= 3) {
    const normalPages = valid.filter(b => !isFullBleed(b));
    // Jeśli większość stron ma normalne marginesy, odrzucamy sporadyczne strony full-bleed,
    // aby okładka nie psuła idealnego przycięcia tekstu dla reszty książki
    if (normalPages.length >= Math.ceil(valid.length * 0.5)) {
      usable = normalPages;
    }
  }

  // Brzeg bierzemy „prawie najszerszy”: przy dużej próbce pomijamy po jednej skrajnej
  // stronie z każdej strony (np. pieczątkę albo rysunek wystający w margines),
  // przy małej – bierzemy pełną sumę, żeby nic nie uciąć.
  const edge = (vals, low) => {
    const v = [...vals].sort((a, b) => a - b);
    const skip = v.length >= 10 ? 1 : 0;
    return low ? v[skip] : v[v.length - 1 - skip];
  };
  if (!usable.length) return null;
  const box = {
    x: edge(usable.map((b) => b.x), true),
    y: edge(usable.map((b) => b.y), true),
    r: edge(usable.map((b) => b.r), false),
    bt: edge(usable.map((b) => b.bt), false)
  };
  const w = box.r - box.x, h = box.bt - box.y;
  if (w < full.width * 0.3 || h < full.height * 0.3) return null;  // podejrzanie mało treści
  return { x: box.x, y: box.y, w, h };
}

// Strona renderowana w miniaturze; szukamy pierwszego i ostatniego wiersza oraz
// kolumny, w których jest dość ciemnych pikseli, żeby pominąć brud ze skanu.
async function detectContent(page, full) {
  try {
    const s = Math.min(1, 240 / full.width);
    const vp = page.getViewport({ scale: s, rotation: rotationOf(page) });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(vp.width));
    c.height = Math.max(1, Math.ceil(vp.height));
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const rows = new Uint32Array(c.height), cols = new Uint32Array(c.width);
    for (let y = 0; y < c.height; y += CROP_STEP) {
      for (let x = 0; x < c.width; x += CROP_STEP) {
        const i = (y * c.width + x) * 4;
        if (d[i] < CROP_THRESHOLD || d[i + 1] < CROP_THRESHOLD || d[i + 2] < CROP_THRESHOLD) { rows[y]++; cols[x]++; }
      }
    }
    const span = (arr, len) => {
      const min = Math.max(2, Math.round(len * 0.004 / CROP_STEP));
      let a = 0, b = arr.length - 1;
      while (a < arr.length && arr[a] < min) a++;
      while (b > a && arr[b] < min) b--;
      return a <= b ? [a, b] : null;
    };
    const ys = span(rows, c.width), xs = span(cols, c.height);
    c.width = 0;
    c.height = 0;
    if (!ys || !xs) return null;
    const pad = 8 / s;                       // niewielki oddech wokół treści
    return {
      x: Math.max(0, xs[0] / s - pad),
      y: Math.max(0, ys[0] / s - pad),
      r: Math.min(full.width, (xs[1] + CROP_STEP) / s + pad),
      bt: Math.min(full.height, (ys[1] + CROP_STEP) / s + pad)
    };
  } catch { return null; }
}

function getStageDimensions() {
  const calcW = getCalcStageWidth();
  const W = Math.max(120, (window.innerWidth - calcW) - 2 * MARGIN - (showTwo() ? GAP : 0));
  const H = Math.max(120, window.innerHeight - 2 * MARGIN);
  return { W, H };
}

function fit(a, b, sa, sb) {
  const { W, H } = getStageDimensions();
  if (!showTwo()) {
    const scaleW = W / sa.w;
    const scaleH = H / sa.h;
    // Wysokość 100% nie może wypchnąć strony poza ekran – wtedy zostaje dopasowanie całości
    const scale = fitMode === 'width' ? scaleW : Math.min(scaleW, scaleH);
    return { a, b: null, scale, L: sa, R: sa, single: true };
  }
  const L = sa || sb, R = sb || sa;
  const totalW = L.w + R.w;
  const maxH = Math.max(L.h, R.h);
  const scaleW = W / totalW;
  const scaleH = H / maxH;
  const scale = fitMode === 'width' ? scaleW : Math.min(scaleW, scaleH);
  return { a, b, scale, L, R, single: false };
}

async function layout(s) {
  const [a, b] = spreadOf(s);
  const [sa, sb] = await Promise.all([
    a ? pageBox(a) : Promise.resolve(null),
    b ? pageBox(b) : Promise.resolve(null)
  ]);
  if (a) sizeCache.set(a, sa);
  if (b) sizeCache.set(b, sb);
  handleCalcResize();
  return fit(a, b, sa, sb);
}

function layoutSync(s) {
  const [a, b] = spreadOf(s);
  const sa = a ? sizeCache.get(a) : null;
  const sb = b ? sizeCache.get(b) : null;
  if ((a && !sa) || (b && !sb)) return null;
  return fit(a, b, sa, sb);
}

// ---------- renderowanie ----------
function cacheKey(n, scale, q = 1) { return `${n}|${scale.toFixed(5)}|${q === 1 ? (window.devicePixelRatio || 1) : 'lo'}|${rot}|${crop ? 1 : 0}`; }
function cancelled() { const e = new Error('cancelled'); e.name = 'RenderingCancelledException'; return e; }

function renderPage(n, scale, q = 1) {
  const k = cacheKey(n, scale, q);
  const cache = q === 1 ? canvasCache : loCache;
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  if (pending.has(k)) return pending.get(k).promise;

  let task = null, stop = false;
  const promise = (async () => {
    const page = await pdf.getPage(n);
    if (stop) throw cancelled();
    const dpr = q === 1 ? (window.devicePixelRatio || 1) : q;
    const b = await pageBox(n);
    if (stop) throw cancelled();
    const vp = page.getViewport({
      scale: scale * dpr, rotation: rotationOf(page),
      offsetX: -b.x * scale * dpr, offsetY: -b.y * scale * dpr
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(b.w * scale * dpr));
    canvas.height = Math.max(1, Math.floor(b.h * scale * dpr));
    canvas.style.width = Math.floor(b.w * scale) + 'px';
    canvas.style.height = Math.floor(b.h * scale) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    task = page.render({ canvasContext: ctx, viewport: vp });
    await task.promise;
    return cache.set(k, canvas);
  })().finally(() => pending.delete(k));

  pending.set(k, { promise, cancel() { stop = true; task?.cancel(); } });
  return promise;
}

function blank(size, scale) {
  const d = document.createElement('div');
  d.className = 'blank';
  d.style.width = Math.floor(size.w * scale) + 'px';
  d.style.height = Math.floor(size.h * scale) + 'px';
  return d;
}

let lastRenderedScale = null;
let lastRenderedDpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

async function show(s) {
  const token = ++showToken;
  start = s;
  const { a, b, scale, L, R, single } = await layout(s);
  if (token !== showToken) return;
  lastRenderedScale = scale;
  lastRenderedDpr = window.devicePixelRatio || 1;

  const pages = [a, b];
  const need = new Set();
  for (const n of pages) if (n) { need.add(cacheKey(n, scale)); need.add(cacheKey(n, scale, LO_QUALITY)); }
  for (const [k, job] of pending) if (!need.has(k)) job.cancel();

  const wrap = (canvas) => {
    const w = document.createElement('div');
    w.className = 'page';
    w.style.setProperty('--scale-factor', scale);
    w.append(canvas);
    return w;
  };
  let shown = [];
  const put = ([ca, cb]) => {
    shown = [ca && wrap(ca), cb && wrap(cb)];
    stage.replaceChildren(...(single
      ? [shown[0] || blank(L, scale)]
      : [shown[0] || blank(L, scale), shown[1] || blank(R, scale)]));
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
    const range = a && b ? `${a}–${b}` : `${a || b}`;
    document.title = `${range} / ${numPages} – ${fileName}`;
    if (!menu.hidden) updateMenu();
    showProgress();
  };

  try {
    const hiP = Promise.all(pages.map((n) => n ? renderPage(n, scale) : null));
    const ready = pages.every((n) => !n || canvasCache.has(cacheKey(n, scale)));
    if (!ready) {
      hiP.catch(() => {});
      const lo = await Promise.all(pages.map((n) => n ? renderPage(n, scale, LO_QUALITY) : null));
      if (token !== showToken) return;
      put(lo);
    }
    const hi = await hiP;
    if (token !== showToken) return;
    put(hi);
    const wrappers = shown;
    Promise.all(pages.map((n) => n ? textLayerFor(n, scale) : null)).then((tls) => {
      if (token !== showToken) return;
      tls.forEach((tl, i) => { if (tl && wrappers[i]) wrappers[i].append(tl); });
    }).catch(() => {});
  } catch (e) {
    if (token !== showToken || e?.name === 'RenderingCancelledException') return;
    throw e;
  }
  if (fileKey) pref.set('pos:' + fileKey, a || b);
  prefetch(s, token).then(() => updateText(s, token)).catch(() => {});
}

// ---------- warstwa tekstowa i dostępność ----------
function textContent(n) {
  if (!tcCache.has(n)) tcCache.set(n, pdf.getPage(n).then((p) => p.getTextContent()));
  return tcCache.get(n);
}

async function textLayerFor(n, scale) {
  const k = cacheKey(n, scale);
  const hit = tlCache.get(k);
  if (hit) return hit;
  const page = await pdf.getPage(n);
  const div = document.createElement('div');
  div.className = 'textLayer';

  const tc = await textContent(n);
  if (tc) {
    const b = await pageBox(n);
    const tl = new pdfjsLib.TextLayer({
      textContentSource: tc,
      container: div,
      viewport: page.getViewport({
        scale, rotation: rotationOf(page),
        offsetX: -b.x * scale, offsetY: -b.y * scale
      })
    });
    await tl.render();
  }

  const end = document.createElement('div');
  end.className = 'endOfContent';
  div.append(end);
  div.addEventListener('pointerdown', () => div.classList.add('selecting'));
  return tlCache.set(k, div);
}
document.addEventListener('pointerup', () => {
  for (const d of stage.querySelectorAll('.textLayer.selecting')) d.classList.remove('selecting');
});

async function pageText(n) {
  if (textCache.has(n)) return textCache.get(n);
  const tc = await textContent(n);
  let out = '';
  for (const it of tc.items) {
    if ('str' in it) out += it.str + (it.hasEOL ? '\n' : '');
  }
  out = out.replace(/[ \t]+\n/g, '\n').trim();
  textCache.set(n, out);
  return out;
}

async function updateText(s, token) {
  const [a, b] = spreadOf(s);
  const from = Math.max(1, (a || b) - TEXT_PAGES_AROUND);
  const to = Math.min(numPages, (b || a) + TEXT_PAGES_AROUND);
  const parts = [];
  for (let n = from; n <= to; n++) {
    if (n === a || n === b) continue;
    const t = await pageText(n);
    if (token !== showToken) return;
    const sec = document.createElement('section');
    sec.setAttribute('aria-label', `Strona ${n}`);
    const h = document.createElement('h2');
    h.textContent = `Strona ${n}`;
    const pre = document.createElement('p');
    pre.textContent = t || '[brak tekstu]';
    sec.append(h, pre);
    parts.push(sec);
  }
  if (token === showToken && textLayer) textLayer.replaceChildren(...parts);
}

// Prefetch stron w tle
async function prefetch(s, token) {
  const order = [];
  for (let t = s, i = 0; i < PREFETCH_AHEAD && (t = nextStart(t)) != null; i++) order.push(t);
  for (let t = s, i = 0; i < PREFETCH_BEHIND && (t = prevStart(t)) != null; i++) order.splice(1 + i, 0, t);
  for (const t of order) {
    if (token !== showToken) return;
    const { a, b, scale } = await layout(t);
    if (token !== showToken) return;
    if (a) await renderPage(a, scale);
    if (token !== showToken) return;
    if (b) await renderPage(b, scale);
  }
}

// Cienki wskaźnik postępu przy prawej krawędzi – pokazuje się przy zmianie strony i znika.
const prog = document.getElementById('prog');
let progTimer;
function showProgress() {
  if (!pdf || !prog) return;
  const [a, b] = spreadOf(start);
  const page = a || b;
  const frac = numPages > 1 ? (page - 1) / (numPages - 1) : 0;
  const thumb = prog.firstElementChild;
  thumb.style.height = Math.max(6, 100 / Math.max(1, numPages / (showTwo() ? 2 : 1))) + '%';
  thumb.style.top = `calc(${(frac * 100).toFixed(2)}% - ${(frac * parseFloat(thumb.style.height)).toFixed(2)}%)`;
  prog.classList.add('on');
  clearTimeout(progTimer);
  progTimer = setTimeout(() => prog.classList.remove('on'), 1200);
}

// ---------- zakładki ----------
const marksKey = () => 'marks:' + fileKey;
const getMarks = () => pref.json(marksKey(), []);
function toggleMark() {
  if (!pdf || !fileKey) return;
  const page = spreadOf(start).find(Boolean);
  const marks = getMarks();
  const i = marks.indexOf(page);
  if (i >= 0) marks.splice(i, 1);
  else marks.push(page);
  marks.sort((x, y) => x - y);
  pref.setJson(marksKey(), marks);
  const all = pref.json('bookmarks', []).filter((m) => m.key !== fileKey || m.page !== page);
  if (i < 0) all.unshift({ key: fileKey, name: fileName, page, ts: Date.now() });
  pref.setJson('bookmarks', all.slice(0, 30));
  flash(i >= 0 ? `Zakładka na stronie ${page} usunięta` : `Zakładka: strona ${page}`);
}

function go(s) { if (pdf && s != null) show(s); }
function flip(n) {
  if (!pdf || !n) return;
  let t = start;
  for (let i = 0; i < Math.abs(n); i++) {
    const u = n > 0 ? nextStart(t) : prevStart(t);
    if (u == null) break;
    t = u;
  }
  if (t !== start) go(t);
}
const next = () => flip(1);
const prev = () => flip(-1);

// ---------- otwieranie dokumentów ----------
async function open(src, name, key, startPage = null, rawBlob = null) {
  const blobToSave = rawBlob || (src?.data ? new Blob([src.data]) : null);
  flash('Ładowanie…', 0);
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      ...src,
      cMapUrl: PDFJS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS + 'standard_fonts/',
      isEvalSupported: false
    }).promise;
  } catch (err) {
    setEmpty(true);
    flash('Nie udało się otworzyć pliku: ' + (err?.message || err), 4000);
    return;
  }
  try {
    if (pdf) pdf.destroy();
    pdf = doc;
    document.documentElement.classList.remove('empty');
    hideMenu();
    numPages = pdf.numPages;
    fileName = name;
    fileKey = key;
    clearCaches();
    if (textLayer) textLayer.replaceChildren();
    pairing = pref.get('pairing:' + key, pref.get('pairing', 'odd'));
    rot = pref.get('rot:' + key, 0);
    if (blobToSave) rememberFile(key, name, blobToSave);
    let p = pref.get('pos:' + key, 1);
    if (startPage) p = startPage;
    if (pref.get('calcOpen', false)) {
      setCalcOpen(true);
    }
    show(spreadStartOf(p));
    if (pinned) showMenu();
  } catch (e) {
    console.error('Błąd inicjalizacji PDF:', e);
    flash('Błąd podczas wyświetlania: ' + (e?.message || e), 4000);
  } finally {
    hint.hidden = true;
  }
}

function nameFromUrl(u) {
  try {
    const last = new URL(u).pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || 'PDF');
  } catch { return 'PDF'; }
}

function loadViaExtension(url) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const timer = setTimeout(() => {
      if (!answered) { window.removeEventListener('message', onMsg); reject(new Error('NOEXT')); }
    }, 3000);
    function onMsg(e) {
      if (e.source !== window || e.data?.source !== 'zen-ext') return;
      answered = true;
      clearTimeout(timer);
      const m = e.data;
      if (m.type === 'progress') {
        flash(m.total
          ? `Ładowanie… ${Math.min(99, Math.round(m.loaded / m.total * 100))}%`
          : `Ładowanie… ${(m.loaded / 1048576).toFixed(1)} MB`, 0);
      } else if (m.type === 'data') {
        window.removeEventListener('message', onMsg);
        resolve(new Uint8Array(m.buffer));
      } else if (m.type === 'error') {
        window.removeEventListener('message', onMsg);
        reject(new Error(m.message));
      }
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'zen-page', type: 'load', url }, location.origin);
  });
}

async function openFromHash() {
  const h = location.href;
  const i = h.indexOf('#file=');
  if (i < 0) { setEmpty(true); renderRecent(); return; }
  let url = h.slice(i + 6);
  if (/^[a-z]+%3A/i.test(url)) url = decodeURIComponent(url);
  const pm = /#page=(\d+)/.exec(url);
  const clean = url.split('#')[0];
  setEmpty(false);
  flash('Ładowanie…', 0);
  try {
    const data = await loadViaExtension(clean);
    open({ data }, nameFromUrl(clean), clean, pm ? +pm[1] : null);
  } catch (err) {
    setEmpty(true);
    flash(err.message === 'NOEXT'
      ? 'Brak wtyczki DarkPDF – wybierz plik ręcznie'
      : 'Nie udało się pobrać pliku: ' + err.message, 4000);
  }
}
openFromHash();
window.addEventListener('hashchange', openFromHash);

// Pliki lokalne
const picker = document.createElement('input');
picker.type = 'file';
picker.accept = 'application/pdf,.pdf';
picker.hidden = true;
document.body.append(picker);

async function openLocal(f) {
  if (!f) return;
  history.replaceState(null, '', location.pathname);
  setEmpty(false);
  const data = new Uint8Array(await f.arrayBuffer());
  open({ data }, f.name, `local:${f.name}:${f.size}`, null, f);
}
function pickFile() { picker.value = ''; picker.click(); }
picker.addEventListener('change', () => openLocal(picker.files[0]));
const welcome = document.getElementById('welcome');
const welcomePickBtn = document.querySelector('#welcome .pick');
if (welcomePickBtn) welcomePickBtn.addEventListener('click', (e) => { e.stopPropagation(); pickFile(); });

// ---------- ostatnio otwierane pliki ----------
// Pliki z dysku trzymamy w IndexedDB przeglądarki, więc otwierają się bez pytania o dysk.
// Dla plików z sieci pamiętamy sam adres i pobieramy je ponownie przez wtyczkę.
const RECENT_MAX = 8;
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('darkpdf', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('recent', { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbDo(mode, fn) {
  return idb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction('recent', mode);
    const out = fn(tx.objectStore('recent'));
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => rej(tx.error);
  }));
}

async function rememberFile(key, name, dataOrBlob) {
  try {
    const rec = { key, name, ts: Date.now() };
    if (/^(https?|file):/i.test(key)) rec.url = key;
    else rec.blob = (dataOrBlob instanceof Blob) ? dataOrBlob : new Blob([dataOrBlob]);
    if (rec.blob && rec.blob.size === 0) return;
    await idbDo('readwrite', (st) => st.put(rec));
    const all = await idbDo('readonly', (st) => st.getAll());
    all.sort((a, b) => b.ts - a.ts);
    for (const old of all.slice(RECENT_MAX)) await idbDo('readwrite', (st) => st.delete(old.key));
  } catch {}
}

// Wiersze na ekranie startowym: ostatnie pliki i zakładki wyglądają tak samo.
function renderList(id, items, onPick) {
  const box = document.getElementById(id);
  if (!box) return;
  box.replaceChildren();
  box.hidden = items.length === 0;
  for (const it of items.slice(0, 6)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'recent-row';
    row.innerHTML = '<span class="rn"></span><span class="rp"></span>';
    row.querySelector('.rn').textContent = it.name;
    row.querySelector('.rp').textContent = `str. ${it.page}`;
    row.title = it.title || it.name;
    row.addEventListener('click', (e) => { e.stopPropagation(); onPick(it); });
    box.append(row);
  }
}

function renderBookmarks() {
  const marks = pref.json('bookmarks', []);
  renderList('marks', marks, async (m) => {
    let rec = null;
    try { rec = await idbDo('readonly', (st) => st.get(m.key)); } catch {}
    setEmpty(false);
    if (rec?.blob) {
      if (rec.blob.size === 0) {
        setEmpty(true);
        flash('Ten plik w pamięci był uszkodzony – wybierz go ponownie z dysku', 3500);
        return;
      }
      open({ data: new Uint8Array(await rec.blob.arrayBuffer()) }, m.name, m.key, m.page, rec.blob);
    }
    else if (/^(https?|file):/i.test(m.key)) location.hash = '#file=' + m.key + '#page=' + m.page;
    else { setEmpty(true); flash('Ten plik nie jest już zapisany – otwórz go z dysku', 3000); }
  });
}

let lastRecent = null;
async function openRecent(rec) {
  if (!rec) return;
  if (rec.blob && rec.blob.size === 0) {
    flash('Zapisany plik był uszkodzony lub pusty – otwórz go ponownie z dysku', 3500);
    try { await idbDo('readwrite', (st) => st.delete(rec.key)); } catch {}
    renderRecent();
    return;
  }
  setEmpty(false);
  if (rec.blob) open({ data: new Uint8Array(await rec.blob.arrayBuffer()) }, rec.name, rec.key, null, rec.blob);
  else if (rec.url) location.hash = '#file=' + rec.url;
}

async function renderRecent() {
  let all = [];
  try { all = await idbDo('readonly', (st) => st.getAll()); } catch {}
  all.sort((x, y) => y.ts - x.ts);
  lastRecent = all[0] || null;
  document.getElementById('recentHint').hidden = all.length === 0;
  renderList('recent', all.map((r) => ({ ...r, page: pref.get('pos:' + r.key, 1), title: r.url || r.name })), openRecent);
}

function setEmpty(v) {
  document.documentElement.classList.toggle('empty', v);
  if (v) {
    if (isCalcOpen()) {
      setCalcOpen(false);
    }
    renderRecent(); renderBookmarks();
  }
}
window.addEventListener('dragover', (e) => { e.preventDefault(); welcome?.classList.add('drag'); });
window.addEventListener('dragleave', () => welcome?.classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  welcome?.classList.remove('drag');
  openLocal(e.dataTransfer.files[0]);
});

// ---------- dolny pasek menu ----------
const menu = document.getElementById('menu');
const popoverEl = document.getElementById('menu-popover');
const pinBtn = menu.querySelector('.menu-pin');
const toggleBtn = menu.querySelector('.menu-toggle');
const pageInput = menu.querySelector('.page-input');
const totalSpan = menu.querySelector('.total');

let pinned = pref.get('menuPinned', false);
let popoverOpen = pref.get('popoverOpen', true);
let menuTimer = null;
menuReady = true;     // od teraz applyTheme() może odświeżać pasek

// Pasek chowa się po 2 s bezczynności, jeśli nie jest najechany ani zablokowany kłódką
function scheduleHide() {
  clearTimeout(menuTimer);
  if (pinned || menu.hidden || menu.matches(':hover') || document.activeElement === pageInput) return;
  menuTimer = setTimeout(hideMenu, 2000);
}

menu.addEventListener('mouseenter', () => {
  clearTimeout(menuTimer);
});
menu.addEventListener('mouseleave', () => {
  scheduleHide();
});


function hideMenu() {
  if (pinned) return;
  menu.hidden = true;
  clearTimeout(menuTimer);
  syncPopover();
}

function showMenu() {
  if (!pdf) return;
  menu.hidden = false;
  updateMenu();
  scheduleHide();
}

function setBtnLabel(btn, text, key) {
  if (!btn) return;
  const labelEl = btn.querySelector('.label-text');
  if (labelEl) labelEl.textContent = text;
  const kEl = btn.querySelector('.k');
  if (kEl && key) kEl.textContent = key;
}

// Menu opcji to natywny popover (warstwa nad wszystkim, zakotwiczony nad paskiem).
// Pokazujemy go tylko razem z paskiem; to, czy ma być otwarty, pamiętamy osobno.
function syncPopover() {
  if (!popoverEl?.showPopover) return;
  const want = popoverOpen && !menu.hidden;
  if (want !== popoverEl.matches(':popover-open')) want ? popoverEl.showPopover() : popoverEl.hidePopover();
}

function setPopoverOpen(open) {
  popoverOpen = !!open;
  pref.set('popoverOpen', popoverOpen);
  updateMenu();
}

function togglePopover(force) {
  setPopoverOpen(force !== undefined ? force : !popoverOpen);
}

function updateMenu() {
  const [a, b] = spreadOf(start);
  if (document.activeElement !== pageInput) {
    pageInput.value = (a && b ? `${a}–${b}` : `${a || b}`);
  }
  if (totalSpan) totalSpan.textContent = `/ ${numPages}`;
  syncPopover();

  // [klucz przycisku, etykieta, skrót, czy podświetlony]
  const buttons = [
    ['calc', isCalcOpen() ? 'Ukryj kalkulator' : 'Kalkulator', 'K', isCalcOpen()],
    ['fit-w', fitMode === 'width' ? 'Szerokość [100%]' : 'Szerokość 100%', 'W', fitMode === 'width'],
    ['fit-h', fitMode === 'height' ? 'Wysokość [100%]' : 'Wysokość 100%', 'H', fitMode === 'height'],
    ['pages', two ? 'Jedna strona' : 'Dwie strony', 'P'],
    ['pairing', pairing === 'odd' ? 'Pary 1–2' : 'Pary 1, 2–3', 'O'],
    ['dark', COLOR_LABELS[colorMode] || 'Tryb: Ciemny', 'D'],
    ['theme', palette === 'gemini' ? 'Motyw: Gemini' : 'Motyw: Systemowy', 'T'],
    ['crop', crop ? 'Z marginesami' : 'Przytnij marginesy', 'C'],
    ['rotate', 'Obróć o 90°', 'R']
  ];
  for (const [k, text, key, active] of buttons) {
    const btn = menu.querySelector(`[data-k="${k}"]`);
    if (!btn) continue;
    setBtnLabel(btn, text, key);
    if (active !== undefined) btn.classList.toggle('active', active);
  }
  const pr = menu.querySelector('[data-k="pairing"]');
  if (pr) pr.hidden = !showTwo();
  // telefon w pionie zawsze pokazuje jedną stronę – przełącznik nic by nie zmienił
  const pagesBtn = menu.querySelector('[data-k="pages"]');
  if (pagesBtn) pagesBtn.hidden = isMobile() && window.innerWidth < window.innerHeight;
  const darkBtn = menu.querySelector('[data-k="dark"]');
  if (darkBtn) {
    darkBtn.querySelector('use')?.setAttribute('href', `#i-mode-${colorMode}`);
  }
  const themeBtn = menu.querySelector('[data-k="theme"]');
  if (themeBtn) {
    themeBtn.querySelector('use')?.setAttribute('href', `#i-pal-${palette}`);
  }

  if (pinBtn) {
    pinBtn.classList.toggle('pinned', pinned);
    pinBtn.querySelector('.icon-unlocked').hidden = pinned;
    pinBtn.querySelector('.icon-locked').hidden = !pinned;
    pinBtn.dataset.tip = pinned ? 'Odblokuj pasek (auto-ukrywanie)' : 'Zablokuj pasek na stałe';
  }

  if (toggleBtn) {
    toggleBtn.classList.toggle('open', popoverOpen);
    toggleBtn.dataset.tip = popoverOpen ? 'Zamknij menu opcji (M)' : 'Otwórz menu opcji (M)';
  }
}

// Skok do strony: automatyczny po 1s lub natychmiastowy po Enter
let pageJumpTimer = null;
let digitTriggeredFocus = false;

function schedulePageJump() {
  clearTimeout(pageJumpTimer);
  const val = parseInt(pageInput.value, 10);
  if (val >= 1 && val <= numPages) {
    pageJumpTimer = setTimeout(() => {
      pageJumpTimer = null;
      if (spreadStartOf(val) !== start) go(spreadStartOf(val));
      if (document.activeElement === pageInput) pageInput.blur();
    }, 1000);
  }
}

pageInput.addEventListener('focus', () => {
  clearTimeout(menuTimer);
  if (digitTriggeredFocus) { digitTriggeredFocus = false; return; }
  setTimeout(() => { if (document.activeElement === pageInput) pageInput.select(); }, 10);
});

function applyPageInput(jump) {
  clearTimeout(pageJumpTimer);
  pageJumpTimer = null;
  const val = parseInt(pageInput.value, 10);
  if (jump && val >= 1 && val <= numPages && spreadStartOf(val) !== start) go(spreadStartOf(val));
  else updateMenu();
}

pageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  e.preventDefault();
  applyPageInput(e.key === 'Enter');
  pageInput.blur();
});

// Kliknięcia wewnątrz paska i tak nie wychodzą dalej (obsługa niżej), a klawisze
// są pomijane, gdy piszesz w polu – dlatego wystarczy tyle:
pageInput.addEventListener('blur', () => {
  applyPageInput(true);
  scheduleHide();
});
pageInput.addEventListener('input', schedulePageJump);
menu.querySelector('.page-select').addEventListener('click', () => pageInput.focus());

async function setFitMode(mode) {
  fitMode = mode;
  pref.set('fitMode', fitMode);
  document.documentElement.classList.toggle('fit-width', fitMode === 'width');
  document.documentElement.classList.toggle('fit-height', fitMode === 'height');
  flash(fitMode === 'width' ? 'Zablokowano: Szerokość 100%' : (fitMode === 'height' ? 'Zablokowano: Wysokość 100%' : 'Dopasowanie: Auto'));
  updateMenu();

  if (fitMode === 'height') {
    resetUserCustomWidth();
    if (isCalcOpen()) {
      await snapCalcToHeightFit(true);
    }
  }
  fitNow();
  rerenderSoon();
}

// ---------- akcje wspólne dla klawiatury, menu i kalkulatora ----------
function act(k) {
  switch (k) {
    case 'prev': prev(); break;
    case 'next': next(); break;
    case 'open': pickFile(); break;
    case 'calc':
      if (!pdf) break;
      toggleCalc();
      break;
    case 'fit-w':
      if (!pdf) break;
      setFitMode(fitMode === 'width' ? 'auto' : 'width');
      break;
    case 'fit-h':
      if (!pdf) break;
      setFitMode(fitMode === 'height' ? 'auto' : 'height');
      break;
    case 'pin':
      pinned = !pinned;
      pref.set('menuPinned', pinned);
      updateMenu();
      if (pinned) {
        clearTimeout(menuTimer);
        flash('Pasek zablokowany (na stałe)', 1200);
      } else {
        if (!menu.matches(':hover')) menuTimer = setTimeout(hideMenu, 2000);
        flash('Auto-ukrywanie paska włączone', 1200);
      }
      break;
    case 'toggle-menu':
      togglePopover();
      break;
    case 'full':
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      break;
    case 'crop':
      if (!pdf) break;
      crop = !crop;
      pref.set('crop', crop);
      sizeCache.clear();
      clearCropCache();
      flash(crop ? 'Marginesy przycięte' : 'Pełne strony');
      show(start);
      break;
    case 'rotate': {
      if (!pdf) break;
      rot = (rot + 90) % 360;
      if (fileKey) pref.set('rot:' + fileKey, rot);
      sizeCache.clear();
      clearCropCache();
      flash(`Obrót ${rot}°`);
      show(start);
      break;
    }
    case 'dark':
      cycleColorMode();
      break;
    case 'theme':
      togglePalette();
      break;
    case 'pages': {
      if (!pdf) break;
      const anchor = spreadOf(start).find(Boolean);
      two = !two;
      pref.set('two', two);
      flash(two ? 'Dwie strony' : 'Jedna strona');
      if (fitMode === 'height' && isCalcOpen() && !isUserCustomWidth()) {
        snapCalcToHeightFit();
      }
      go(spreadStartOf(anchor));
      break;
    }
    case 'pairing': {
      if (!pdf || !showTwo()) break;
      const anchor = spreadOf(start).find(Boolean);
      pairing = pairing === 'odd' ? 'even' : 'odd';
      pref.set('pairing', pairing);
      if (fileKey) pref.set('pairing:' + fileKey, pairing);
      flash(pairing === 'odd' ? 'Pary: 1–2, 3–4, 5–6…' : 'Pary: 1, 2–3, 4–5…');
      go(spreadStartOf(anchor));
      break;
    }
  }
  if (!menu.hidden) showMenu();
}

menu.addEventListener('click', (e) => {
  e.stopPropagation();
  clearTimeout(menuTimer);
  const b = e.target.closest('button');
  if (b) {
    act(b.dataset.k);
    scheduleHide();
  }
});

window.addEventListener('dblclick', (e) => {
  if (isMobile()) return;
  if (!pdf || String(window.getSelection())) return;   // dwuklik w tekst zaznacza słowo
  if (e.target.closest('#menu, #calc-sidebar')) return;
  act('full');
});

window.addEventListener('click', (e) => {
  if (!pdf) return;
  if (String(window.getSelection())) return;
  if (e.target.closest('#menu, #calc-sidebar, #calc-resizer')) return;
  // Telefon: stuknięcie w lewą / prawą część strony przewraca, środek otwiera pasek
  if (isMobile()) {
    const x = e.clientX / window.innerWidth;
    if (x < 0.3) { hideMenu(); prev(); return; }
    if (x > 0.7) { hideMenu(); next(); return; }
  }
  if (pinned) {
    if (popoverOpen) setPopoverOpen(false);
    return;
  }
  menu.hidden ? showMenu() : hideMenu();
});

// Kursor znika po 2 s bez ruchu i wraca przy pierwszym drgnięciu.
let cursorTimer;
function wakeCursor() {
  document.documentElement.classList.remove('nocursor');
  clearTimeout(cursorTimer);
  if (pdf) cursorTimer = setTimeout(() => document.documentElement.classList.add('nocursor'), 2000);
}
['mousemove', 'mousedown', 'wheel', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, wakeCursor, { passive: true }));

// Dotyk: przesunięcie palcem w bok zmienia stronę.
let touchX = 0, touchY = 0, touchAt = 0;
window.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { touchAt = 0; return; }
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
  touchAt = Date.now();
}, { passive: true });
window.addEventListener('touchend', (e) => {
  if (!pdf || !touchAt || String(window.getSelection())) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchX, dy = t.clientY - touchY;
  const ms = Date.now() - touchAt;
  touchAt = 0;
  if (ms > 700 || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  dx < 0 ? next() : prev();
}, { passive: true });

// ---------- kółko myszy i gesty ----------
let lastWheel = 0, notch = 100, acc = 0;
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return;
  // W trybie blokady szerokości pozwól na naturalne przewijanie, jeśli strona wystaje pionowo
  if (fitMode === 'width') {
    const isScrollable = stage.scrollHeight > stage.clientHeight + 10;
    if (isScrollable) {
      const atTop = stage.scrollTop <= 2;
      const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
      const scrollingDown = e.deltaY > 0;
      const scrollingUp = e.deltaY < 0;
      if ((scrollingDown && !atBottom) || (scrollingUp && !atTop)) {
        return; // Naturalne przewijanie strony
      }
    }
  }
  e.preventDefault();
  let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (e.deltaMode === 1) d *= 40;
  else if (e.deltaMode === 2) d *= window.innerHeight;
  if (!d) return;
  if (!menu.hidden && !pinned) scheduleHide();
  const now = performance.now(), gap = now - lastWheel;
  lastWheel = now;
  const ad = Math.abs(d);

  const jumpMult = e.shiftKey ? 10 : 1;
  if (ad >= NOTCH_MIN_PX) {
    if (gap > 120) notch = ad;
    acc = 0;
    flip(Math.sign(d) * Math.max(1, Math.round(ad / notch)) * jumpMult);
    return;
  }
  if (Math.sign(d) !== Math.sign(acc)) acc = 0;
  acc += d;
  const n = Math.trunc(acc / TOUCHPAD_PX);
  if (n) { acc -= n * TOUCHPAD_PX; flip(n * jumpMult); }
}, { passive: false });

// ---------- klawisze ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (document.activeElement === pageInput) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); pickFile(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;

  if (k === 'Escape') {
    if (popoverOpen) {
      setPopoverOpen(false);
      e.preventDefault();
      return;
    }
    if (isCalcOpen()) {
      setCalcOpen(false);
      e.preventDefault();
      return;
    }
    if (!menu.hidden && !pinned) {
      hideMenu();
      e.preventDefault();
      return;
    }
  }

  if (!pdf && k === 'Enter' && lastRecent) { e.preventDefault(); openRecent(lastRecent); return; }

  if (/^[0-9]$/.test(k) && pdf) {
    e.preventDefault();
    showMenu();
    digitTriggeredFocus = true;
    pageInput.focus();
    pageInput.value = k;
    schedulePageJump();
    return;
  }

  if (!menu.hidden && !pinned) scheduleHide();

  const keyActions = {
    d: 'dark', D: 'dark', t: 'theme', T: 'theme',
    p: 'pages', P: 'pages', o: 'pairing', O: 'pairing',
    f: 'full', F: 'full', c: 'crop', C: 'crop', r: 'rotate', R: 'rotate',
    k: 'calc', K: 'calc',
    w: 'fit-w', W: 'fit-w',
    h: 'fit-h', H: 'fit-h',
    m: 'toggle-menu', M: 'toggle-menu'
  };
  if (keyActions[k]) { act(keyActions[k]); e.preventDefault(); return; }

  const jump = e.shiftKey ? 10 : 1;   // Shift = skok o 10 rozkładówek
  if (['ArrowRight', 'ArrowDown', 'PageDown', 'j', 'l'].includes(k)) { flip(jump); e.preventDefault(); return; }
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) { flip(-jump); e.preventDefault(); return; }
  if (k === ' ') { e.shiftKey ? prev() : next(); e.preventDefault(); return; }
  if (k === 'b' || k === 'B') { toggleMark(); e.preventDefault(); return; }
  if (k === 'Home') { go(1); e.preventDefault(); return; }
  if (k === 'End') { if (pdf) go(spreadStartOf(numPages)); e.preventDefault(); return; }
  if (k === '?') {
    flash('→ ↓ Spacja PgDn  następne\n← ↑ PgUp  poprzednie\nHome / End  początek / koniec\n' +
          'numer (lub Enter)  skok do strony\nShift + strzałka / scroll  skok o 10\nB  zakładka na tej stronie\n' +
          'M  menu opcji\nK  kalkulator z boku\nW  zablokuj szerokość 100%\nH  zablokuj wysokość 100%\n' +
          'C  przycinanie marginesów\nR  obrót o 90°\n' +
          'P  jedna / dwie strony\nD  tryb: ciemny / jasny / auto\nT  motyw: Gemini / systemowy\nO  pary nieparzyste / parzyste\n' +
          'F  pełny ekran\ndwuklik  pełny ekran\nCtrl+O  otwórz plik\nkliknięcie  pasek z przyciskami', 6000);
    e.preventDefault();
  }
});

// ---------- dopasowanie i skalowanie okna ----------
function fitNow() {
  const l = layoutSync(start);
  if (!l) return;
  const sizes = l.single ? [l.L] : [l.L, l.R];
  [...stage.children].forEach((el, i) => {
    const size = sizes[i];
    if (!size) return;
    const w = Math.floor(size.w * l.scale) + 'px', h = Math.floor(size.h * l.scale) + 'px';
    el.style.setProperty('--scale-factor', l.scale);
    const c = el.querySelector('canvas');
    if (c) { c.style.width = w; c.style.height = h; }
    else { el.style.width = w; el.style.height = h; }
  });
}

window.addEventListener('resize', () => {
  handleCalcResize();
  if (!pdf) return;
  fitNow();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const isMob = isMobile();
    const wasMob = document.documentElement.classList.contains('mobile');
    document.documentElement.classList.toggle('mobile', isMob);
    const l = layoutSync(start);
    const dpr = window.devicePixelRatio || 1;
    const dprChanged = Math.abs(dpr - lastRenderedDpr) > 1e-3;
    const scaleChanged = !l || Math.abs((l.scale || 0) - (lastRenderedScale || 0)) > 1e-4;
    if (scaleChanged || isMob !== wasMob || dprChanged) {
      clearRenderCaches();
      show(spreadStartOf(start));
    }
    updateMenu();
  }, 180);
});
