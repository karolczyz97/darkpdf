const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const pdfjsLib = await import(PDFJS + 'build/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.min.mjs';

// ---- Ustawienia do ewentualnej zmiany ----
const NOTCH_MIN_PX = 40;      // zdarzenie kółka >= tyle px = ząbek myszy (każdy ząbek = rozkładówka)
const TOUCHPAD_PX = 100;      // tyle px ruchu touchpada = jedna rozkładówka
const LO_QUALITY = 0.35;      // rozdzielczość szybkiego podglądu, gdy strona nie jest jeszcze gotowa
const PREFETCH_AHEAD = 3;     // ile rozkładówek do przodu renderować w tle
const PREFETCH_BEHIND = 1;    // ile rozkładówek wstecz
const TEXT_PAGES_AROUND = 2;  // tekst ilu stron przed/po bieżącej trzymać w DOM dla Gemini (nie wpływa na szybkość)
const MARGIN = 6;             // margines wokół stron (px)
const GAP = 4;                // odstęp między stronami (px)
const CACHE_MAX = 24;         // ile wyrenderowanych stron trzymać w pamięci

const stage = document.getElementById('stage');
const hint = document.getElementById('hint');
const textLayer = document.getElementById('text');
stage.style.gap = GAP + 'px';

let dark = localStorage.getItem('dark') === '1';
let pairing = 'odd';      // 'odd' = 1–2, 3–4…   'even' = 1, 2–3, 4–5…
let pdf = null, numPages = 0, start = 1;
let fileKey = null, fileName = 'PDF';
let showToken = 0;

const sizeCache = new Map();   // nr strony -> {w, h}
const canvasCache = new Map(); // klucz -> canvas (kolejność = LRU)
const pending = new Map();     // klucz -> Promise<canvas>
const textCache = new Map();   // nr strony -> tekst
const tcCache = new Map();     // nr strony -> Promise<textContent>
const tlCache = new Map();     // klucz -> gotowa warstwa tekstowa (zaznaczanie)

applyDark();
document.documentElement.classList.add('empty');

// ---------- pomocnicze ----------
function applyDark() { document.documentElement.classList.toggle('dark', dark); }

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
  if (pairing === 'odd') return p % 2 ? p : p - 1;
  return p === 1 ? 1 : (p % 2 ? p - 1 : p);
}
function spreadOf(s) {
  if (pairing === 'even' && s === 1) return [null, 1]; // okładka sama, po prawej
  return [s, s + 1 <= numPages ? s + 1 : null];
}
function nextStart(s) {
  const n = (pairing === 'even' && s === 1) ? 2 : s + 2;
  return n <= numPages ? n : null;
}
function prevStart(s) { return s <= 1 ? null : spreadStartOf(s - 1); }

async function pageSize(n) {
  let s = sizeCache.get(n);
  if (!s) {
    const v = (await pdf.getPage(n)).getViewport({ scale: 1 });
    s = { w: v.width, h: v.height };
    sizeCache.set(n, s);
  }
  return s;
}

// Skala dobrana tak, żeby rozkładówka wypełniła okno bez przewijania.
async function layout(s) {
  const [a, b] = spreadOf(s);
  const sa = a ? await pageSize(a) : null;
  const sb = b ? await pageSize(b) : null;
  const L = sa || sb, R = sb || sa; // pojedyncza strona zachowuje rozmiar jak w parze
  const W = window.innerWidth - 2 * MARGIN - GAP;
  const H = window.innerHeight - 2 * MARGIN;
  const scale = Math.min(W / (L.w + R.w), H / Math.max(L.h, R.h));
  return { a, b, scale, L, R };
}

// ---------- renderowanie ----------
function cacheKey(n, scale, q = 1) { return `${n}|${scale.toFixed(5)}|${q === 1 ? devicePixelRatio : 'lo'}`; }

const loCache = new Map(); // szybkie podglądy niskiej rozdzielczości
function cancelled() { const e = new Error('cancelled'); e.name = 'RenderingCancelledException'; return e; }

function renderPage(n, scale, q = 1) {
  const k = cacheKey(n, scale, q);
  const cache = q === 1 ? canvasCache : loCache;
  const hit = cache.get(k);
  if (hit) { cache.delete(k); cache.set(k, hit); return Promise.resolve(hit); }
  if (pending.has(k)) return pending.get(k).promise;

  let task = null, stop = false;
  const promise = (async () => {
    const page = await pdf.getPage(n);
    if (stop) throw cancelled();
    const dpr = q === 1 ? (devicePixelRatio || 1) : q;
    const css = page.getViewport({ scale });
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    canvas.style.width = Math.floor(css.width) + 'px';
    canvas.style.height = Math.floor(css.height) + 'px';
    task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });
    await task.promise;
    cache.set(k, canvas);
    const max = q === 1 ? CACHE_MAX : 60;
    while (cache.size > max) cache.delete(cache.keys().next().value);
    return canvas;
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

// Strony podmieniane są w całości, bez animacji. Jeśli rozkładówka nie jest jeszcze
// wyrenderowana, najpierw pojawia się szybki podgląd, a ostra wersja zaraz po nim.
// Przy szybkim przewijaniu niepotrzebne już renderowania są przerywane.
async function show(s) {
  const token = ++showToken;
  start = s;
  const { a, b, scale, L, R } = await layout(s);
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
    stage.replaceChildren(shown[0] || blank(L, scale), shown[1] || blank(R, scale));
    const range = a && b ? `${a}–${b}` : `${a || b}`;
    document.title = `${range} / ${numPages} – ${fileName}`;
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
  if (fileKey) localStorage.setItem('pos:' + fileKey, String(a || b));
  prefetch(s, token).then(() => updateText(s, token)).catch(() => {});
}

// ---------- warstwa tekstowa: zaznaczanie i kopiowanie tekstu ----------
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
  const tl = new pdfjsLib.TextLayer({
    textContentSource: await textContent(n),
    container: div,
    viewport: page.getViewport({ scale })
  });
  await tl.render();
  const end = document.createElement('div');
  end.className = 'endOfContent';
  div.append(end);
  div.addEventListener('pointerdown', () => div.classList.add('selecting'));
  tlCache.set(k, div);
  while (tlCache.size > CACHE_MAX) tlCache.delete(tlCache.keys().next().value);
  return div;
}
document.addEventListener('pointerup', () => {
  for (const d of stage.querySelectorAll('.textLayer.selecting')) d.classList.remove('selecting');
});

// ---------- tekst sąsiednich stron w DOM (dla Gemini / czytników ekranu) ----------
async function pageText(n) {
  if (textCache.has(n)) return textCache.get(n);
  const tc = await textContent(n);
  let out = '';
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    out += it.str + (it.hasEOL ? '\n' : '');
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
    if (n === a || n === b) continue;   // widoczne strony mają własną warstwę tekstową
    const t = await pageText(n);
    if (token !== showToken) return;
    const sec = document.createElement('section');
    sec.setAttribute('aria-label', `Strona ${n}`);
    if (n === a || n === b) sec.setAttribute('aria-current', 'page');
    const h = document.createElement('h2');
    h.textContent = `Strona ${n}` + (n === a || n === b ? ' (widoczna)' : '');
    const pre = document.createElement('p');
    pre.textContent = t || '[brak tekstu – strona jest prawdopodobnie skanem]';
    sec.append(h, pre);
    parts.push(sec);
  }
  if (token === showToken) textLayer.replaceChildren(...parts);
}

// Następna i poprzednia rozkładówka renderują się w tle → przełączanie natychmiastowe.
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

function go(s) { if (pdf && s != null) show(s); }
function flip(n) {           // n > 0 do przodu, n < 0 wstecz, o |n| rozkładówek
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

// ---------- otwieranie ----------
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
    flash('Nie udało się otworzyć pliku: ' + (err?.message || err) +
          '\nKliknij, żeby wybrać plik PDF, albo przeciągnij go tutaj.', 0);
    return;
  }
  if (pdf) pdf.destroy();
  pdf = doc;
  document.documentElement.classList.remove('empty');
  numPages = pdf.numPages;
  fileName = name;
  fileKey = key;
  for (const job of pending.values()) job.cancel();
  sizeCache.clear();
  canvasCache.clear();
  loCache.clear();
  textCache.clear();
  tcCache.clear();
  tlCache.clear();
  textLayer.replaceChildren();
  pairing = localStorage.getItem('pairing:' + key) || localStorage.getItem('pairing') || 'odd';
  hint.hidden = true;

  let p = parseInt(localStorage.getItem('pos:' + key), 10) || 1;
  if (startPage) p = startPage;
  show(spreadStartOf(p));
}

function nameFromUrl(u) {
  try {
    const last = new URL(u).pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || 'PDF');
  } catch { return 'PDF'; }
}

// ---------- pobieranie przez wtyczkę ----------
// Strona (github.io) nie może sama pobrać PDF-a z innej domeny (CORS),
// więc prosi o to wtyczkę DarkPDF przez window.postMessage.
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

// Adres PDF-a jest w części po # (nie trafia na serwery GitHuba).
async function openFromHash() {
  const h = location.href;
  const i = h.indexOf('#file=');
  if (i < 0) { flash('Kliknij, żeby wybrać plik PDF, albo przeciągnij go tutaj', 0); return; }
  let url = h.slice(i + 6);
  if (/^[a-z]+%3A/i.test(url)) url = decodeURIComponent(url);
  const pm = /#page=(\d+)/.exec(url);
  const clean = url.split('#')[0];
  flash('Ładowanie…', 0);
  let data;
  try {
    data = await loadViaExtension(clean);
  } catch (err) {
    flash(err.message === 'NOEXT'
      ? 'Brak wtyczki DarkPDF.\nKliknij, żeby wybrać plik PDF, albo przeciągnij go tutaj.'
      : 'Nie udało się pobrać pliku: ' + err.message + '\nKliknij, żeby wybrać plik PDF, albo przeciągnij go tutaj.', 0);
    return;
  }
  open({ data }, nameFromUrl(clean), clean, pm ? +pm[1] : null);
}
openFromHash();
window.addEventListener('hashchange', openFromHash);

// ---------- pliki z dysku: kliknięcie (gdy nic nie jest otwarte), Ctrl+O, przeciągnięcie ----------
const picker = document.createElement('input');
picker.type = 'file';
picker.accept = 'application/pdf,.pdf';
picker.hidden = true;
document.body.append(picker);

async function openLocal(f) {
  if (!f) return;
  history.replaceState(null, '', location.pathname); // odświeżenie nie wróci do poprzedniego linku
  const data = new Uint8Array(await f.arrayBuffer());
  open({ data }, f.name, `local:${f.name}:${f.size}`);
}
function pickFile() { picker.value = ''; picker.click(); }

picker.addEventListener('change', () => openLocal(picker.files[0]));
window.addEventListener('click', () => { if (!pdf) pickFile(); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); openLocal(e.dataTransfer.files[0]); });

// ---------- sterowanie ----------
// Kółko myszy: każdy ząbek = jedna rozkładówka, bez limitu szybkości.
// Gdy przeglądarka połączy kilka ząbków w jedno zdarzenie (przy bardzo szybkim kręceniu),
// przeskakujemy o tyle rozkładówek, ile było ząbków.
// Touchpad: co TOUCHPAD_PX ruchu jedna rozkładówka.
let lastWheel = 0, notch = 100, acc = 0;
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return; // Ctrl+kółko zostawiamy przeglądarce
  e.preventDefault();
  let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (e.deltaMode === 1) d *= 40;
  else if (e.deltaMode === 2) d *= window.innerHeight;
  if (!d) return;

  const now = performance.now();
  const gap = now - lastWheel;
  lastWheel = now;
  const ad = Math.abs(d);

  if (ad >= NOTCH_MIN_PX) {                 // ząbek (lub kilka połączonych)
    if (gap > 120) notch = ad;              // pojedynczy, spokojny ząbek → zapamiętaj jego wielkość
    acc = 0;
    flip(Math.sign(d) * Math.max(1, Math.round(ad / notch)));
    return;
  }
  if (Math.sign(d) !== Math.sign(acc)) acc = 0;
  acc += d;
  const n = Math.trunc(acc / TOUCHPAD_PX);
  if (n) { acc -= n * TOUCHPAD_PX; flip(n); }
}, { passive: false });

let numBuf = '';
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); pickFile(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;

  // Skok do strony: wpisz numer + Enter
  if (/^[0-9]$/.test(k)) { numBuf += k; flash('Idź do strony: ' + numBuf, 0); return; }
  if (numBuf) {
    if (k === 'Enter') {
      const n = parseInt(numBuf, 10);
      numBuf = ''; hint.hidden = true;
      if (n >= 1 && n <= numPages) go(spreadStartOf(n));
      else flash(`Dokument ma ${numPages} stron`);
      return;
    }
    if (k === 'Backspace') { numBuf = numBuf.slice(0, -1); numBuf ? flash('Idź do strony: ' + numBuf, 0) : (hint.hidden = true); return; }
    if (k === 'Escape') { numBuf = ''; hint.hidden = true; return; }
  }

  switch (k) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'j': case 'l':
      next(); break;
    case ' ':
      e.shiftKey ? prev() : next(); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'k': case 'h':
      prev(); break;
    case 'Home':
      go(1); break;
    case 'End':
      if (pdf) go(spreadStartOf(numPages)); break;
    case 'd': case 'D':
      dark = !dark;
      localStorage.setItem('dark', dark ? '1' : '0');
      applyDark();
      break;
    case 'o': case 'O': {
      if (!pdf) break;
      const anchor = spreadOf(start).find(Boolean);
      pairing = pairing === 'odd' ? 'even' : 'odd';
      localStorage.setItem('pairing', pairing);
      if (fileKey) localStorage.setItem('pairing:' + fileKey, pairing);
      flash(pairing === 'odd' ? 'Pary: 1–2, 3–4, 5–6…' : 'Pary: 1, 2–3, 4–5…');
      go(spreadStartOf(anchor));
      break;
    }
    case 'f': case 'F':
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      break;
    case '?':
      flash('→ ↓ Spacja PgDn  następne\n← ↑ PgUp  poprzednie\nHome / End  początek / koniec\n' +
            'numer + Enter  skok do strony\nCtrl+O  otwórz plik z dysku\nD  tryb ciemny\nO  pary nieparzyste / parzyste\nF  pełny ekran', 5000);
      break;
    default:
      return;
  }
  e.preventDefault();
});

// Automatyczne dopasowanie przy zmianie rozmiaru okna / zoomu.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!pdf) return;
    canvasCache.clear(); loCache.clear(); tlCache.clear();
    show(start);
  }, 120);
});
