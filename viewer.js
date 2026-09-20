const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const pdfjsLib = await import(PDFJS + 'build/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.min.mjs';

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
    const v = localStorage.getItem(k);
    if (v === null) return d;
    if (typeof d === 'boolean') return v === '1';
    if (typeof d === 'number') return parseInt(v, 10) || d;
    return v;
  },
  set(k, v) { try { localStorage.setItem(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)); } catch {} },
  json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  setJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

let dark = pref.get('dark', false);
let theme = pref.get('theme', 'normal');   // 'normal' | 'gemini'
let two = pref.get('two', true);           // dwie strony obok siebie czy jedna
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

// ---- Kalkulator i tryb dopasowania ----
let calcOpen = localStorage.getItem('calcOpen') === '1';
let calcWidth = parseInt(localStorage.getItem('calcWidth'), 10) || 440;
let fitMode = localStorage.getItem('fitMode') || 'auto'; // 'auto' | 'width' | 'height'

const calcSidebar = document.getElementById('calc-sidebar');
const calcFrame = document.getElementById('calc-frame');
const calcClose = calcSidebar?.querySelector('.calc-close');
const calcResizer = calcSidebar?.querySelector('.calc-resizer');

document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
document.documentElement.classList.toggle('calc-open', calcOpen);
document.documentElement.classList.toggle('fit-width', fitMode === 'width');
document.documentElement.classList.toggle('fit-height', fitMode === 'height');

const sizeCache = lru();             // nr strony -> obszar do pokazania
const canvasCache = lru(CACHE_MAX);  // klucz -> gotowa strona
const loCache = lru(60);             // klucz -> szybki podgląd
const tlCache = lru(CACHE_MAX);      // klucz -> warstwa tekstowa
const textCache = lru();             // nr strony -> tekst
const tcCache = lru();               // nr strony -> Promise<textContent>
const pending = new Map();           // klucz -> trwające renderowanie

function clearCaches() {
  for (const job of pending.values()) job.cancel();
  for (const c of [sizeCache, canvasCache, loCache, tlCache, textCache, tcCache]) c.clear();
  cropJobs.clear();
}

applyDark();
document.documentElement.classList.add('empty');

function getCalcUrl() {
  const themeParam = theme === 'gemini' ? 'gemini' : (dark ? 'dark' : 'auto');
  const custom = localStorage.getItem('calcUrl') || window.DARKPDF_CALC_URL;
  let base = custom;
  if (!base) {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      base = '/calc/index.html';
    } else if (location.hostname.endsWith('github.io')) {
      const user = location.hostname.split('.')[0];
      base = `https://${user}.github.io/calc/`;
    } else {
      base = '../calc/index.html';
    }
  }
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}embed=1&side=1&theme=${themeParam}`;
}

if (calcOpen && calcFrame) {
  calcFrame.src = getCalcUrl();
}

function applyDark() {
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('gemini', dark && theme === 'gemini');
  if (calcFrame && calcFrame.src && calcFrame.src !== 'about:blank') {
    calcFrame.src = getCalcUrl();
  }
}

let hintTimer;
function flash(text, ms = 1200) {
  hint.textContent = text;
  hint.hidden = false;
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => { hint.hidden = true; }, ms);
}

// ---------- rozkład stron ----------
function spreadStartOf(p) {
  p = Math.min(Math.max(1, p), numPages);
  if (!two) return p;
  if (pairing === 'odd') return p % 2 ? p : p - 1;
  return p === 1 ? 1 : (p % 2 ? p - 1 : p);
}
function spreadOf(s) {
  if (!two) return [s, null];
  if (pairing === 'even' && s === 1) return [null, 1]; // okładka sama, po prawej
  return [s, s + 1 <= numPages ? s + 1 : null];
}
function nextStart(s) {
  const n = !two ? s + 1 : (pairing === 'even' && s === 1) ? 2 : s + 2;
  return n <= numPages ? n : null;
}
function prevStart(s) { return s <= 1 ? null : spreadStartOf(s - 1); }

const rotationOf = (page) => (page.rotate + rot + 360) % 360;
const CROP_SAMPLES = 5;        // ile stron badamy, żeby ustalić wspólne obcięcie
const CROP_THRESHOLD = 235;    // jaśniejsze piksele uznajemy za pusty margines
const CROP_STEP = 2;           // co który piksel miniatury sprawdzamy

const cropJobs = new Map();    // klucz grupy stron -> Promise<box>

// Strony lewe i prawe mają w książkach inne marginesy, a strona może mieć inny
// rozmiar, więc grupujemy po parzystości i wymiarach. W obrębie grupy wszystkie
// strony dostają to samo obcięcie, żeby tekst nie skakał przy przewracaniu.
const groupKey = (n, full) => `${n % 2}|${Math.round(full.width)}x${Math.round(full.height)}|${rot}`;

async function pageBox(n) {
  const page = await pdf.getPage(n);
  const full = page.getViewport({ scale: 1, rotation: rotationOf(page) });
  const whole = { x: 0, y: 0, w: full.width, h: full.height };
  if (!crop) return whole;
  const k = groupKey(n, full);
  if (!cropJobs.has(k)) cropJobs.set(k, groupBox(n, full, k));
  return (await cropJobs.get(k)) || whole;
}

// Bierzemy kilka stron z tej samej grupy i najszerszy wspólny obszar treści,
// więc nic się nie urywa, a wszystkie strony wychodzą tej samej wielkości.
async function groupBox(n, full, k) {
  const pages = [n];
  for (let d = 2; pages.length < CROP_SAMPLES && d <= 2 * CROP_SAMPLES; d += 2) {
    if (n + d <= numPages) pages.push(n + d);
    if (pages.length < CROP_SAMPLES && n - d >= 1) pages.push(n - d);
  }
  let box = null;
  for (const p of pages) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1, rotation: rotationOf(page) });
    if (groupKey(p, vp) !== k) continue;
    const found = await detectContent(page, vp);
    if (!found) continue;
    box = box ? {
      x: Math.min(box.x, found.x),
      y: Math.min(box.y, found.y),
      r: Math.max(box.r, found.r),
      bt: Math.max(box.bt, found.bt)
    } : found;
  }
  if (!box) return null;
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
  const calcW = calcOpen ? calcWidth : 0;
  const W = Math.max(120, (window.innerWidth - calcW) - 2 * MARGIN - (two ? GAP : 0));
  const H = Math.max(120, window.innerHeight - 2 * MARGIN);
  return { W, H };
}

function fit(a, b, sa, sb) {
  const { W, H } = getStageDimensions();
  if (!two) {
    const scaleW = W / sa.w;
    const scaleH = H / sa.h;
    let scale;
    if (fitMode === 'width') scale = scaleW;
    else if (fitMode === 'height') scale = scaleH;
    else scale = Math.min(scaleW, scaleH);
    return { a, b: null, scale, L: sa, R: sa, single: true };
  }
  const L = sa || sb, R = sb || sa;
  const totalW = L.w + R.w;
  const maxH = Math.max(L.h, R.h);
  const scaleW = W / totalW;
  const scaleH = H / maxH;
  let scale;
  if (fitMode === 'width') scale = scaleW;
  else if (fitMode === 'height') scale = scaleH;
  else scale = Math.min(scaleW, scaleH);
  return { a, b, scale, L, R, single: false };
}

async function layout(s) {
  const [a, b] = spreadOf(s);
  const sa = a ? await pageBox(a) : null, sb = b ? await pageBox(b) : null;
  if (a) sizeCache.set(a, sa);
  if (b) sizeCache.set(b, sb);
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
function cacheKey(n, scale, q = 1) { return `${n}|${scale.toFixed(5)}|${q === 1 ? devicePixelRatio : 'lo'}|${rot}|${crop ? 1 : 0}`; }
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
    const dpr = q === 1 ? (devicePixelRatio || 1) : q;
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

async function show(s) {
  const token = ++showToken;
  start = s;
  const { a, b, scale, L, R, single } = await layout(s);
  if (token !== showToken) return;

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
  if (token === showToken) textLayer.replaceChildren(...parts);
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
  thumb.style.height = Math.max(6, 100 / Math.max(1, numPages / (two ? 2 : 1))) + '%';
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
async function open(src, name, key, startPage = null) {
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
  if (pdf) pdf.destroy();
  pdf = doc;
  document.documentElement.classList.remove('empty');
  hideMenu();
  numPages = pdf.numPages;
  fileName = name;
  fileKey = key;
  clearCaches();
  textLayer.replaceChildren();
  pairing = pref.get('pairing:' + key, pref.get('pairing', 'odd'));
  hint.hidden = true;

  rot = pref.get('rot:' + key, 0);
  if (src.data) rememberFile(key, name, src.data);
  let p = pref.get('pos:' + key, 1);
  if (startPage) p = startPage;
  show(spreadStartOf(p));
  if (pinned) showMenu();
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
  open({ data }, f.name, `local:${f.name}:${f.size}`);
}
function pickFile() { picker.value = ''; picker.click(); }
picker.addEventListener('change', () => openLocal(picker.files[0]));

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

async function rememberFile(key, name, data) {
  try {
    const rec = { key, name, ts: Date.now() };
    if (/^(https?|file):/i.test(key)) rec.url = key;
    else rec.blob = new Blob([data]);
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
    if (rec?.blob) open({ data: new Uint8Array(await rec.blob.arrayBuffer()) }, m.name, m.key, m.page);
    else if (/^(https?|file):/i.test(m.key)) location.hash = '#file=' + m.key + '#page=' + m.page;
    else { setEmpty(true); flash('Ten plik nie jest już zapisany – otwórz go z dysku', 3000); }
  });
}

let lastRecent = null;
async function openRecent(rec) {
  if (!rec) return;
  setEmpty(false);
  if (rec.blob) open({ data: new Uint8Array(await rec.blob.arrayBuffer()) }, rec.name, rec.key);
  else location.hash = '#file=' + rec.url;
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
  if (v) { renderRecent(); renderBookmarks(); }
}
window.addEventListener('dragover', (e) => { e.preventDefault(); welcome.classList.add('drag'); });
window.addEventListener('dragleave', () => welcome.classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  welcome.classList.remove('drag');
  openLocal(e.dataTransfer.files[0]);
});

// ---------- dolny pasek menu ----------
const menu = document.getElementById('menu');
const pinBtn = menu.querySelector('.menu-pin');
const pageInput = menu.querySelector('.page-input');
const totalSpan = menu.querySelector('.total');
const tipEl = document.getElementById('menu-tip');

let pinned = pref.get('menuPinned', false);
let menuTimer = null, tipTimer = null, expandTimer = null, collapseTimer = null;

function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) { tipEl.classList.remove('show'); tipEl.hidden = true; }
}

function showTipFor(el) {
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    if (!el || !tipEl || menu.hidden) return;
    const text = el.dataset.tip, key = el.dataset.key;
    if (!text) return;
    tipEl.innerHTML = `${text}${key ? ` <span class="tip-k">${key}</span>` : ''}`;
    tipEl.hidden = false;

    const rect = el.getBoundingClientRect(), tipRect = tipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2;
    let top = rect.top - tipRect.height - 8;
    if (top < 6) top = rect.bottom + 8;
    left = Math.max(tipRect.width / 2 + 8, Math.min(window.innerWidth - tipRect.width / 2 - 8, left));
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
    tipEl.classList.add('show');
  }, 100);
}

function expandMenu() { clearTimeout(collapseTimer); menu.classList.add('expanded'); }
function collapseMenu() { clearTimeout(expandTimer); menu.classList.remove('expanded'); hideTip(); }

// Pasek chowa się po 3.5 s bezczynności, jeśli nie jest najechany ani zablokowany kłódką
function scheduleHide() {
  clearTimeout(menuTimer);
  if (pinned || menu.hidden || menu.matches(':hover') || document.activeElement === pageInput) return;
  menuTimer = setTimeout(hideMenu, 3500);
}

menu.addEventListener('mouseenter', () => {
  clearTimeout(menuTimer);
});
menu.addEventListener('mouseleave', () => {
  scheduleHide();
});

menu.addEventListener('pointerover', (e) => { const t = e.target.closest('[data-tip]'); if (t) showTipFor(t); });
menu.addEventListener('pointerout', (e) => { const t = e.target.closest('[data-tip]'); if (t) hideTip(); });

function hideMenu() {
  if (pinned) return;
  menu.hidden = true;
  clearTimeout(menuTimer);
  hideTip();
}

function showMenu() {
  if (!pdf) return;
  updateMenu();
  menu.hidden = false;
  scheduleHide();
}

const label = (text, key) => `${text} <span class="k">(${key})</span>`;

function updateMenu() {
  const [a, b] = spreadOf(start);
  if (document.activeElement !== pageInput) {
    pageInput.value = (a && b ? `${a}–${b}` : `${a || b}`);
  }
  if (totalSpan) totalSpan.textContent = `/ ${numPages}`;
  const calcBtn = menu.querySelector('[data-k="calc"]');
  if (calcBtn) {
    calcBtn.classList.toggle('active', calcOpen);
    calcBtn.innerHTML = label(calcOpen ? 'Ukryj kalkulator' : 'Kalkulator', 'K');
  }
  const fitWBtn = menu.querySelector('[data-k="fit-w"]');
  if (fitWBtn) {
    fitWBtn.classList.toggle('active', fitMode === 'width');
    fitWBtn.innerHTML = label(fitMode === 'width' ? 'Szerokość [100%]' : 'Szerokość 100%', 'W');
  }
  const fitHBtn = menu.querySelector('[data-k="fit-h"]');
  if (fitHBtn) {
    fitHBtn.classList.toggle('active', fitMode === 'height');
    fitHBtn.innerHTML = label(fitMode === 'height' ? 'Wysokość [100%]' : 'Wysokość 100%', 'H');
  }
  menu.querySelector('[data-k="pages"]').innerHTML = label(two ? 'Jedna strona' : 'Dwie strony', 'P');
  const pr = menu.querySelector('[data-k="pairing"]');
  pr.innerHTML = label(pairing === 'odd' ? 'Pary 1–2' : 'Pary 1, 2–3', 'O');
  pr.hidden = !two;
  menu.querySelector('[data-k="theme"]').innerHTML = label(theme === 'gemini' ? 'Motyw Gemini' : 'Motyw zwykły', 'T');
  menu.querySelector('[data-k="dark"]').innerHTML = label(dark ? 'Ciemny' : 'Jasny', 'D');
  menu.querySelector('[data-k="crop"]').innerHTML = label(crop ? 'Z marginesami' : 'Przytnij marginesy', 'C');
  menu.querySelector('[data-k="rotate"]').innerHTML = label('Obróć', 'R');

  if (pinBtn) {
    pinBtn.classList.toggle('pinned', pinned);
    pinBtn.querySelector('.icon-unlocked').hidden = pinned;
    pinBtn.querySelector('.icon-locked').hidden = !pinned;
    pinBtn.dataset.tip = pinned ? 'Odblokuj dymek (auto-ukrywanie)' : 'Zablokuj dymek strony na stałe';
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
  clearTimeout(collapseTimer);
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
  if (!menu.matches(':hover')) collapseMenu();
  scheduleHide();
});
pageInput.addEventListener('input', schedulePageJump);
menu.querySelector('.page-select').addEventListener('click', () => pageInput.focus());

function setCalcOpen(open) {
  calcOpen = !!open;
  localStorage.setItem('calcOpen', calcOpen ? '1' : '0');
  document.documentElement.classList.toggle('calc-open', calcOpen);
  if (calcOpen && (!calcFrame.src || calcFrame.src === 'about:blank')) {
    calcFrame.src = getCalcUrl();
  }
  window.focus(); // Fokus pozostaje na dokumencie PDF
  updateMenu();
  fitNow();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    canvasCache.clear(); loCache.clear(); tlCache.clear();
    show(start);
  }, 120);
}

function updateCalcWidth(w) {
  calcWidth = Math.max(320, Math.min(window.innerWidth - 100, Math.round(w)));
  document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
  localStorage.setItem('calcWidth', String(calcWidth));
}

// Przeciąganie krawędzi kalkulatora (resizer)
if (calcResizer) {
  let startX = 0, initialW = 0, isDragging = false;
  calcResizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDragging = true;
    startX = e.clientX;
    initialW = calcWidth;
    calcResizer.classList.add('dragging');
    calcSidebar.style.transition = 'none';
    stage.style.transition = 'none';

    const onMove = (ev) => {
      if (!isDragging) return;
      const dx = ev.clientX - startX;
      updateCalcWidth(initialW + dx);
      fitNow();
    };

    const onUp = () => {
      isDragging = false;
      calcResizer.classList.remove('dragging');
      calcSidebar.style.transition = '';
      stage.style.transition = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvasCache.clear(); loCache.clear(); tlCache.clear();
      show(start);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'darkpdf_close_calc') {
    setCalcOpen(false);
    window.focus();
  }
});
calcClose?.addEventListener('click', (e) => {
  e.stopPropagation();
  setCalcOpen(false);
  window.focus();
});

function setFitMode(mode) {
  fitMode = mode;
  localStorage.setItem('fitMode', fitMode);
  document.documentElement.classList.toggle('fit-width', fitMode === 'width');
  document.documentElement.classList.toggle('fit-height', fitMode === 'height');
  flash(fitMode === 'width' ? 'Zablokowano: Szerokość 100%' : (fitMode === 'height' ? 'Zablokowano: Wysokość 100%' : 'Dopasowanie: Auto'));
  updateMenu();
  fitNow();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    canvasCache.clear(); loCache.clear(); tlCache.clear();
    show(start);
  }, 120);
}

function act(k) {
  switch (k) {
    case 'prev': prev(); break;
    case 'next': next(); break;
    case 'open': pickFile(); break;
    case 'calc': setCalcOpen(!calcOpen); break;
    case 'fit-w':
      setFitMode(fitMode === 'width' ? 'auto' : 'width');
      break;
    case 'fit-h':
      setFitMode(fitMode === 'height' ? 'auto' : 'height');
      break;
    case 'fit':
      setFitMode(fitMode === 'auto' ? 'width' : (fitMode === 'width' ? 'height' : 'auto'));
      break;
    case 'pin':
      pinned = !pinned;
      pref.set('menuPinned', pinned);
      updateMenu();
      if (pinned) {
        clearTimeout(menuTimer);
        flash('Dymek strony zablokowany (na stałe)', 1200);
      } else {
        if (!menu.matches(':hover')) menuTimer = setTimeout(hideMenu, 2000);
        flash('Auto-ukrywanie dymka włączone', 1200);
      }
      break;
    case 'full':
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      break;
    case 'crop':
      if (!pdf) break;
      crop = !crop;
      pref.set('crop', crop);
      sizeCache.clear();
      cropJobs.clear();
      flash(crop ? 'Marginesy przycięte' : 'Pełne strony');
      show(start);
      break;
    case 'rotate': {
      if (!pdf) break;
      rot = (rot + 90) % 360;
      if (fileKey) pref.set('rot:' + fileKey, rot);
      sizeCache.clear();
      cropJobs.clear();
      flash(`Obrót ${rot}°`);
      show(start);
      break;
    }
    case 'dark':
      dark = !dark;
      pref.set('dark', dark);
      applyDark();
      break;
    case 'theme':
      if (!dark) { dark = true; theme = 'gemini'; }
      else theme = theme === 'gemini' ? 'normal' : 'gemini';
      pref.set('dark', true);
      pref.set('theme', theme);
      applyDark();
      flash(theme === 'gemini' ? 'Motyw: Gemini' : 'Motyw: zwykły ciemny');
      break;
    case 'pages': {
      if (!pdf) break;
      const anchor = spreadOf(start).find(Boolean);
      two = !two;
      pref.set('two', two);
      flash(two ? 'Dwie strony' : 'Jedna strona');
      go(spreadStartOf(anchor));
      break;
    }
    case 'pairing': {
      if (!pdf || !two) break;
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
  if (!pdf || String(getSelection())) return;   // dwuklik w tekst zaznacza słowo
  if (e.target.closest('#menu, #calc-sidebar')) return;
  act('full');
});

window.addEventListener('click', (e) => {
  if (!pdf) { pickFile(); return; }
  if (String(getSelection())) return;
  if (e.target.closest('#menu, #calc-sidebar')) return;
  if (pinned) return;
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
  if (!pdf || !touchAt || String(getSelection())) return;
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

  hideMenu();
  const now = performance.now(), gap = now - lastWheel;
  lastWheel = now;
  const ad = Math.abs(d);

  if (ad >= NOTCH_MIN_PX) {
    if (gap > 120) notch = ad;
    acc = 0;
    flip(Math.sign(d) * Math.max(1, Math.round(ad / notch)));
    return;
  }
  if (Math.sign(d) !== Math.sign(acc)) acc = 0;
  acc += d;
  const n = Math.trunc(acc / TOUCHPAD_PX);
  if (n) { acc -= n * TOUCHPAD_PX; flip(n); }
}, { passive: false });

// ---------- klawisze ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (document.activeElement === pageInput) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); pickFile(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;

  if (k === 'Escape' && calcOpen) {
    setCalcOpen(false);
    e.preventDefault();
    return;
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

  hideMenu();

  const keyActions = {
    d: 'dark', D: 'dark', t: 'theme', T: 'theme',
    p: 'pages', P: 'pages', o: 'pairing', O: 'pairing',
    f: 'full', F: 'full', c: 'crop', C: 'crop', r: 'rotate', R: 'rotate',
    k: 'calc', K: 'calc',
    w: 'fit-w', W: 'fit-w',
    h: 'fit-h', H: 'fit-h'
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
          'numer (lub Enter)  skok do strony\nShift + strzałka  skok o 10\nB  zakładka na tej stronie\n' +
          'K  kalkulator z boku\nW  zablokuj szerokość 100%\nH  zablokuj wysokość 100%\n' +
          'C  przycinanie marginesów\nR  obrót o 90°\n' +
          'P  jedna / dwie strony\nD  tryb ciemny\nT  motyw zwykły / Gemini\nO  pary nieparzyste / parzyste\n' +
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

let resizeTimer;
window.addEventListener('resize', () => {
  if (!pdf) return;
  fitNow();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    canvasCache.clear(); loCache.clear(); tlCache.clear();
    show(start);
  }, 180);
});
