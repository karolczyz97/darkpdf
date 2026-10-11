// viewer.js – czytnik DarkPDF: stan dokumentu, renderowanie stron, układ rozkładówek i koordynacja modułów.
// Moduły składowe:
// - layout.js: geometria rozkładówek, dopasowanie i wykrywanie układu
// - crop.js: silnik badania marginesów stron
// - library.js: IndexedDB i pamięć ostatnio czytanych pozycji
// - calc-panel.js: boczny kalkulator naukowy
// - theme.js: tryby ciemny/jasny, motyw Gemini i filtry SVG
// - doc-history.js: historia przeglądarki i trasa hashowa
// - doc-loader.js: ładowanie plików, okno hasła i ekran powitalny
// - menu-bar.js: dolny pasek opcji, menu i skok do strony
// - input.js: skróty klawiatury, kółko myszy, touchpad i gesty dotykowe
// - util.js: localStorage, LRU cache i współbieżność

const PDFJS = new URL('lib/pdfjs/', import.meta.url).href;
const pdfjsLib = await import(PDFJS + 'build/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.min.mjs';

import { pref, lru } from './util.js';
import * as geo from './layout.js';
import { createCropper } from './crop.js';
import { toggleBookmark } from './library.js';
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
} from './calc-panel.js';
import {
  initTheme,
  cycleColorMode,
  togglePalette,
  paperFilterOf,
  clearPaperCache,
  getColorMode,
  getPalette,
  COLOR_LABELS,
  PALETTE_LABELS
} from './theme.js';
import {
  initDocHistory,
  updateDocHistory,
  goHome
} from './doc-history.js';
import {
  initDocLoader,
  openFromHash,
  openUrl,
  openStored,
  openRecent,
  pickFile,
  setEmpty,
  getLastRecent,
  isPasswordOpen
} from './doc-loader.js';
import {
  initMenuBar,
  showMenu,
  hideMenu,
  updateMenu,
  setPopoverOpen,
  isPopoverOpen,
  isPinned,
  togglePin,
  scheduleHide,
  focusPageInputWithDigit,
  isPageInputFocused,
  isMenuHidden
} from './menu-bar.js';
import { initInput, resetCursor } from './input.js';

// Pamięć podręczna aplikacji: po pierwszej wizycie czytnik otwiera się też offline
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register(new URL('sw.js', import.meta.url)).catch(() => {});
}

// ---- Ustawienia czytnika ----
const LO_QUALITY = 0.35;      // rozdzielczość szybkiego podglądu, gdy strona nie jest jeszcze gotowa
const PREFETCH_AHEAD = 3;     // ile rozkładówek do przodu renderować w tle
const PREFETCH_BEHIND = 1;    // ile rozkładówek wstecz
const TEXT_PAGES_AROUND = 2;  // tekst ilu stron przed/po trzymać w DOM dla czytników/Gemini
const MARGIN = 0;             // margines wokół stron (px) – brak szpar
const GAP = 0;                // odstęp między stronami (px) – strony sklejone ze sobą
const CACHE_MAX = 24;         // ile wyrenderowanych stron trzymać w pamięci
const CACHE_MAX_MOBILE = 10;  // telefon: iOS ma limit pamięci na płótna
const LO_CACHE_MAX = 60;      // ile szybkich podglądów trzymać w pamięci
const TITLE = document.title || 'DarkPDF';

const stage = document.getElementById('stage');
const hint = document.getElementById('hint');
const textLayer = document.getElementById('text');
const prog = document.getElementById('prog');
stage.style.gap = GAP + 'px';

// ---------- stan czytnika ----------
let two = pref.get('two', true);           // dwie strony obok siebie czy jedna
const mobileMq = matchMedia('(max-width: 800px), (max-height: 500px) and (max-width: 1000px)');
const isMobile = () => mobileMq.matches;
const isPortraitPhone = () => isMobile() && window.innerWidth < window.innerHeight;
const showTwo = () => two && !isPortraitPhone();
let lastMobileState = isMobile();
document.documentElement.classList.toggle('mobile', isMobile());

let crop = pref.get('crop', true);         // przycinanie białych marginesów
let rot = 0;                               // obrót stron: 0, 90, 180, 270
let pairing = 'odd';                       // 'odd' = 1–2, 3–4…   'even' = 1, 2–3, 4–5…
let pdf = null, numPages = 0, start = 1;
let fileKey = null, fileName = 'PDF';
let showToken = 0;                         // rośnie przy każdym show() – starsze renderowania przepadają

let fitMode = pref.get('fitMode', 'auto'); // 'auto' | 'width' | 'height'
function applyFitClasses() {
  document.documentElement.classList.toggle('fit-width', fitMode === 'width');
  document.documentElement.classList.toggle('fit-height', fitMode === 'height');
}
applyFitClasses();

// ---------- pamięć podręczna ----------
const releaseCanvas = (c) => setTimeout(() => { if (!c.isConnected) { c.width = 0; c.height = 0; } }, 1000);

const sizeCache = lru();             // nr strony -> obszar do pokazania
const canvasCache = lru(() => (isMobile() ? CACHE_MAX_MOBILE : CACHE_MAX), releaseCanvas);   // klucz -> gotowa strona
const loCache = lru(LO_CACHE_MAX, releaseCanvas);   // klucz -> szybki podgląd
const tlCache = lru(CACHE_MAX);      // klucz -> warstwa tekstowa
const tcCache = lru();               // nr strony -> Promise<textContent>
const textCache = lru();             // nr strony -> Promise<tekst strony>
const pending = new Map();           // klucz -> trwające renderowanie { promise, cancel }

let layoutGen = 0;

const cropper = createCropper({
  doc: () => pdf,
  rotation: () => rot,
  enabled: () => crop,
  onRefine: () => { sizeCache.clear(); clearRenderCaches(); show(start); }   // dokładniejsze cięcie z pełnej próbki
});
const pageBox = (n) => cropper.pageBox(n);
const rotationOf = (page) => cropper.rotationOf(page);

function clearRenderCaches() {
  layoutGen++;
  for (const job of [...pending.values()]) job.cancel();
  canvasCache.clear(); loCache.clear(); tlCache.clear();
}

let resizeTimer;
function rerenderSoon(ms = 120) {
  if (!pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { clearRenderCaches(); show(start); }, ms);
}

function resetLayout() {
  sizeCache.clear();
  cropper.reset();
  clearRenderCaches();
}

function clearCaches() {
  resetLayout();
  tcCache.clear();
  textCache.clear();
  clearPaperCache();
}

function relayout() {
  resetLayout();
  show(start);
}

// ---------- komunikaty na ekranie (dymki) ----------
let hintTimer;
function flash(text, ms = 1200) {
  hint.textContent = text;
  hint.hidden = false;
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => { hint.hidden = true; }, ms);
}
const hideHint = () => { hint.hidden = true; };

// ---------- rozkład stron ----------
const spreadOpts = () => ({ numPages, two: showTwo(), pairing });
const spreadStartOf = (p) => geo.spreadStartOf(p, spreadOpts());
const spreadOf = (s) => geo.spreadOf(s, spreadOpts());
const nextStart = (s) => geo.nextStart(s, spreadOpts());
const prevStart = (s) => geo.prevStart(s, spreadOpts());
const spreadLabel = (s = start) => geo.spreadLabel(spreadOf(s));

function fit(a, b, sa, sb) {
  const twoCurrent = showTwo();
  const W = Math.max(120, window.innerWidth - getCalcStageWidth() - 2 * MARGIN - (twoCurrent ? GAP : 0));
  const H = Math.max(120, window.innerHeight - 2 * MARGIN);
  return { a, b: twoCurrent ? b : null, ...geo.fitSpread(sa, sb, { W, H, two: twoCurrent, fitMode }) };
}

async function layoutSpread(s) {
  const gen = layoutGen;
  const [a, b] = spreadOf(s);
  const [sa, sb] = await Promise.all([a ? pageBox(a) : null, b ? pageBox(b) : null]);
  if (gen !== layoutGen) throw cancelled();
  if (a) sizeCache.set(a, sa);
  if (b) sizeCache.set(b, sb);
  if (s === start) handleCalcResize();
  return fit(a, b, sa, sb);
}

function layoutSpreadSync(s) {
  const [a, b] = spreadOf(s);
  const sa = a ? sizeCache.get(a) : null;
  const sb = b ? sizeCache.get(b) : null;
  if ((a && !sa) || (b && !sb)) return null;
  return fit(a, b, sa, sb);
}

// ---------- renderowanie stron ----------
function cacheKey(n, scale, q = 1) { return `${layoutGen}|${n}|${scale.toFixed(5)}|${q === 1 ? (window.devicePixelRatio || 1) : 'lo'}`; }
function cancelled() { const e = new Error('cancelled'); e.name = 'RenderingCancelledException'; return e; }

function renderPage(n, scale, q = 1) {
  const k = cacheKey(n, scale, q);
  const cache = q === 1 ? canvasCache : loCache;
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  if (pending.has(k)) return pending.get(k).promise;

  let task = null, stop = false, job = null;
  const check = () => { if (stop) throw cancelled(); };
  const drop = () => { if (pending.get(k) === job) pending.delete(k); };
  job = { cancel() { stop = true; task?.cancel(); drop(); } };
  job.promise = (async () => {
    const page = await pdf.getPage(n);
    check();
    const dpr = q === 1 ? (window.devicePixelRatio || 1) : q;
    const b = await pageBox(n);
    check();
    const vp = page.getViewport({
      scale: scale * dpr, rotation: rotationOf(page),
      offsetX: -b.x * scale * dpr, offsetY: -b.y * scale * dpr
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(b.w * scale * dpr));
    canvas.height = Math.max(1, Math.floor(b.h * scale * dpr));
    canvas.style.width = geo.pagePx(b.w * scale) + 'px';
    canvas.style.height = geo.pagePx(b.h * scale) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    task = page.render({ canvasContext: ctx, viewport: vp });
    try {
      await task.promise;
      check();
    } catch (e) {
      canvas.width = 0;
      canvas.height = 0;
      throw e;
    }
    const paper = paperFilterOf(n, canvas);
    if (paper) canvas.style.setProperty('--paper', paper);
    return cache.set(k, canvas);
  })().finally(drop);

  pending.set(k, job);
  return job.promise;
}

function blank(size, scale) {
  const d = document.createElement('div');
  d.className = 'blank';
  d.style.width = geo.pagePx(size.w * scale) + 'px';
  d.style.height = geo.pagePx(size.h * scale) + 'px';
  return d;
}

let lastRenderedScale = null;
let lastRenderedDpr = window.devicePixelRatio || 1;

function showError(e) {
  console.error('Błąd wyświetlania strony:', e);
  flash('Nie udało się wyświetlić strony: ' + (e?.message || e), 4000);
}

async function show(s, { keepShown = false } = {}) {
  if (!pdf) return;
  const token = ++showToken;
  start = s = spreadStartOf(s);
  const failed = (e) => { if (token === showToken && e?.name !== 'RenderingCancelledException') showError(e); };
  let lay;
  try { lay = await layoutSpread(s); } catch (e) { failed(e); return; }
  if (token !== showToken || !pdf) return;
  const { a, b, scale, L, R, single } = lay;
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
    if (!single && shown[0] && shown[1]) {
      shown[0].classList.add('has-right');
      shown[1].classList.add('has-left');
    }
    stage.replaceChildren(...(single
      ? [shown[0] || blank(L, scale)]
      : [shown[0] || blank(L, scale), shown[1] || blank(R, scale)]));
    stage.scrollTop = 0;
    centerX();
    document.title = `${geo.spreadLabel([a, b])} / ${numPages} – ${fileName}`;
    updateMenu();
    showProgress();
  };

  try {
    const hiP = Promise.all(pages.map((n) => n ? renderPage(n, scale) : null));
    const ready = pages.every((n) => !n || canvasCache.has(cacheKey(n, scale)));
    if (!ready && !(keepShown && stage.querySelector('canvas'))) {
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
    failed(e);
    return;
  }
  pref.set('pos:' + fileKey, a || b);
  prefetch(s, token).catch(() => {}).then(() => updateText(s, token)).catch(() => {});
}

// ---------- warstwa tekstowa i dostępność ----------
function textContent(n) {
  if (!tcCache.has(n)) tcCache.set(n, pdf.getPage(n).then((p) => p.getTextContent()));
  return tcCache.get(n);
}

function pageText(n) {
  if (!textCache.has(n)) {
    textCache.set(n, textContent(n).then((tc) => tc.items.filter((it) => 'str' in it)
      .map((it) => it.str + (it.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim()));
  }
  return textCache.get(n);
}

async function textLayerFor(n, scale) {
  const k = cacheKey(n, scale);
  const hit = tlCache.get(k);
  if (hit) return hit;
  const page = await pdf.getPage(n);
  const div = document.createElement('div');
  div.className = 'textLayer';
  div.style.setProperty('--scale-factor', scale);

  const tc = await textContent(n);
  const b = await pageBox(n);
  await new pdfjsLib.TextLayer({
    textContentSource: tc,
    container: div,
    viewport: page.getViewport({ scale, rotation: rotationOf(page) })
  }).render();

  const bx = b?.x || 0, by = b?.y || 0;
  div.style.left = `calc(var(--scale-factor) * ${-bx}px)`;
  div.style.top = `calc(var(--scale-factor) * ${-by}px)`;

  const end = document.createElement('div');
  end.className = 'endOfContent';
  div.append(end);
  div.addEventListener('pointerdown', () => div.classList.add('selecting'));
  return tlCache.set(k, div);
}

['pointerup', 'pointercancel'].forEach((ev) => {
  document.addEventListener(ev, () => {
    for (const d of stage.querySelectorAll('.textLayer.selecting')) d.classList.remove('selecting');
  });
});

async function updateText(s, token) {
  const [a, b] = spreadOf(s);
  const from = Math.max(1, (a || b) - TEXT_PAGES_AROUND);
  const to = Math.min(numPages, (b || a) + TEXT_PAGES_AROUND);
  const parts = [];
  for (let n = from; n <= to; n++) {
    if (n === a || n === b) continue;
    const t = await pageText(n).catch(() => null);
    if (token !== showToken) return;
    const sec = document.createElement('section');
    sec.setAttribute('aria-label', `Strona ${n}`);
    const h = document.createElement('h2');
    h.textContent = `Strona ${n}`;
    const pre = document.createElement('p');
    pre.textContent = t === null ? '[nie da się odczytać tej strony]' : (t || '[brak tekstu]');
    sec.append(h, pre);
    parts.push(sec);
  }
  if (token === showToken) textLayer.replaceChildren(...parts);
}

async function prefetch(s, token) {
  const order = [];
  for (let t = s, i = 0; i < PREFETCH_AHEAD && (t = nextStart(t)) != null; i++) order.push(t);
  for (let t = s, i = 0; i < PREFETCH_BEHIND && (t = prevStart(t)) != null; i++) order.splice(1 + i, 0, t);
  for (const t of order) {
    if (token !== showToken) return;
    const { a, b, scale } = await layoutSpread(t);
    if (token !== showToken) return;
    if (a) await renderPage(a, scale);
    if (token !== showToken) return;
    if (b) await renderPage(b, scale);
  }
}

// Cienki wskaźnik postępu przy prawej krawędzi
let progTimer;
function showProgress() {
  const page = spreadOf(start).find(Boolean);
  const frac = numPages > 1 ? (page - 1) / (numPages - 1) : 0;
  const thumb = prog.firstElementChild;
  thumb.style.height = Math.max(6, 100 / Math.max(1, numPages / (showTwo() ? 2 : 1))) + '%';
  thumb.style.top = `calc(${(frac * 100).toFixed(2)}% - ${(frac * parseFloat(thumb.style.height)).toFixed(2)}%)`;
  prog.classList.add('on');
  clearTimeout(progTimer);
  progTimer = setTimeout(() => prog.classList.remove('on'), 1200);
}

// ---------- nawigacja i zakładki ----------
function toggleMark() {
  if (!pdf) return;
  const page = spreadOf(start).find(Boolean);
  const added = toggleBookmark(fileKey, fileName, page);
  flash(added ? `Zakładka: strona ${page}` : `Zakładka na stronie ${page} usunięta`);
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

function setFitMode(mode) {
  fitMode = mode;
  pref.set('fitMode', fitMode);
  applyFitClasses();
  flash(fitMode === 'width' ? 'Zablokowano: Szerokość 100%' : (fitMode === 'height' ? 'Zablokowano: Wysokość 100%' : 'Dopasowanie: Auto'));
  updateMenu();

  if (fitMode === 'height') {
    resetUserCustomWidth();
    if (isCalcOpen()) snapCalcToHeightFit();
  }
  fitNow();
  rerenderSoon();
}

function toggleFullscreen() {
  if (!document.fullscreenEnabled) {
    setFitMode(fitMode === 'width' ? 'auto' : 'width');
    return;
  }
  const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  p?.catch(() => {
    setFitMode(fitMode === 'width' ? 'auto' : 'width');
  });
}

// ---------- zamknięcie dokumentu ----------
function closeDocument() {
  if (!pdf) return;
  clearTimeout(resizeTimer);
  resetCursor();
  showToken++;
  clearCaches();
  pdf.destroy().catch(() => {});
  pdf = null;
  numPages = 0;
  fileKey = null;
  stage.replaceChildren();
  textLayer.replaceChildren();
  document.title = TITLE;
  hideMenu(true);
}

// ---------- akcje wspólne dla klawiatury, menu i kalkulatora ----------
const WITHOUT_PDF = new Set(['open', 'pin', 'toggle-menu', 'full', 'dark', 'theme']);

function act(k) {
  if (!pdf && !WITHOUT_PDF.has(k)) return;
  switch (k) {
    case 'home': goHome(); break;
    case 'prev': prev(); break;
    case 'next': next(); break;
    case 'open': pickFile(); break;
    case 'calc': toggleCalc(); break;
    case 'fit-w': setFitMode(fitMode === 'width' ? 'auto' : 'width'); break;
    case 'fit-h':
      if (fitMode === 'height' && isCalcOpen() && isUserCustomWidth()) {
        snapCalcToHeightFit();
        flash('Szerokość kalkulatora: automatycznie');
      } else {
        setFitMode(fitMode === 'height' ? 'auto' : 'height');
      }
      break;
    case 'pin':
      togglePin();
      break;
    case 'toggle-menu':
      setPopoverOpen(!isPopoverOpen());
      break;
    case 'full':
      toggleFullscreen();
      break;
    case 'crop':
      crop = !crop;
      pref.set('crop', crop);
      flash(crop ? 'Marginesy przycięte' : 'Pełne strony');
      relayout();
      break;
    case 'rotate':
      rot = (rot + 90) % 360;
      pref.set('rot:' + fileKey, rot);
      flash(`Obrót ${rot}°`);
      relayout();
      break;
    case 'dark':
      cycleColorMode();
      break;
    case 'theme':
      togglePalette();
      break;
    case 'pages': {
      const anchor = spreadOf(start).find(Boolean);
      two = !two;
      pref.set('two', two);
      if (fileKey) pref.set('two:' + fileKey, two);
      flash(two ? 'Dwie strony' : 'Jedna strona');
      if (fitMode === 'height' && isCalcOpen() && !isUserCustomWidth()) snapCalcToHeightFit();
      go(spreadStartOf(anchor));
      break;
    }
    case 'pairing': {
      if (!showTwo()) break;
      const anchor = spreadOf(start).find(Boolean);
      pairing = pairing === 'odd' ? 'even' : 'odd';
      pref.set('pairing', pairing);
      pref.set('pairing:' + fileKey, pairing);
      flash(pairing === 'odd' ? 'Pary: 1–2, 3–4, 5–6…' : 'Pary: 1, 2–3, 4–5…');
      go(spreadStartOf(anchor));
      break;
    }
  }
  if (!isMenuHidden()) showMenu();
}

window.addEventListener('dblclick', (e) => {
  if (window.matchMedia?.('(pointer: coarse) and not (pointer: fine)')?.matches && isMobile()) return;
  if (!pdf) return;
  if (e.target?.closest?.('#calc-sidebar, #calc-resizer, #pw-dialog')) return;
  hideMenu(true);
  act('full');
});

// ---------- dopasowanie i skalowanie okna ----------
function fitNow() {
  const l = layoutSpreadSync(start);
  if (!l) return;
  const sizes = l.single ? [l.L] : [l.L, l.R];
  [...stage.children].forEach((el, i) => {
    const size = sizes[i];
    if (!size) return;
    const w = geo.pagePx(size.w * l.scale) + 'px', h = geo.pagePx(size.h * l.scale) + 'px';
    el.style.setProperty('--scale-factor', l.scale);
    const c = el.querySelector('canvas');
    if (c) { c.style.width = w; c.style.height = h; }
    else { el.style.width = w; el.style.height = h; }
    const tl = el.querySelector('.textLayer');
    if (tl) tl.style.setProperty('--scale-factor', l.scale);
  });
  centerX();
}

function centerX() {
  stage.scrollLeft = fitMode === 'height' ? Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2) : 0;
}

let renderInterrupted = false;
function stopStaleRendering() {
  const l = layoutSpreadSync(start);
  if (!l || Math.abs(l.scale - (lastRenderedScale || 0)) <= 1e-4) return;
  if (!pending.size && renderInterrupted) return;
  showToken++;
  for (const job of [...pending.values()]) job.cancel();
  renderInterrupted = true;
}

window.addEventListener('resize', () => {
  document.documentElement.classList.toggle('mobile', isMobile());
  handleCalcResize();
  if (!pdf) return;
  fitNow();
  stopStaleRendering();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!pdf) return;
    const isMob = isMobile();
    const mobChanged = isMob !== lastMobileState;
    lastMobileState = isMob;
    const l = layoutSpreadSync(start);
    const dpr = window.devicePixelRatio || 1;
    const dprChanged = Math.abs(dpr - lastRenderedDpr) > 1e-3;
    const scaleChanged = !l || Math.abs((l.scale || 0) - (lastRenderedScale || 0)) > 1e-4;
    if (scaleChanged || mobChanged || dprChanged) {
      clearRenderCaches();
      show(spreadStartOf(start), { keepShown: !isMob && !mobChanged });
    } else if (renderInterrupted) {
      show(start);
    }
    renderInterrupted = false;
    updateMenu();
  }, 180);
});

// ---------- inicjalizacja podsystemów ----------
initTheme({
  onThemeChange: updateMenu,
  flash
});

document.documentElement.classList.add('empty');

initCalcPanel({
  pref,
  stage,
  isMobile,
  isPdfLoaded: () => Boolean(pdf),
  getStartPage: () => start,
  getPageSize: (n) => sizeCache.get(n),
  spreadOf: (s) => spreadOf(s),
  showTwo: () => showTwo(),
  getFitMode: () => fitMode,
  MARGIN,
  GAP,
  fitNow,
  rerenderSoon,
  updateMenu,
  flash
});

initMenuBar({
  pref,
  isPdfLoaded: () => Boolean(pdf),
  getNumPages: () => numPages,
  getSpreadLabel: () => spreadLabel(),
  getSpreadStartOf: (p) => spreadStartOf(p),
  getCurrentStart: () => start,
  goToSpread: (s) => go(s),
  onAction: (k) => act(k),
  isCalcOpen,
  getFitMode: () => fitMode,
  getTwo: () => two,
  showTwo: () => showTwo(),
  getPairing: () => pairing,
  getCrop: () => crop,
  getColorMode,
  getColorLabel: (m) => COLOR_LABELS[m],
  getPalette,
  getPaletteLabel: (p) => PALETTE_LABELS[p],
  isPortraitPhone,
  flash
});

initDocHistory({
  isPdfLoaded: () => Boolean(pdf),
  getFileKey: () => fileKey,
  closeDocument,
  setEmpty,
  openUrl,
  openStored
});

initDocLoader({
  PDFJS,
  pdfjsLib,
  flash,
  hideHint,
  isPdfLoaded: () => Boolean(pdf),
  closeDocument,
  isCalcOpen,
  setCalcOpen,
  resetCursor,
  onDocumentReady: async ({ doc, name, key, page, blob, layoutHint }) => {
    pdf?.destroy();
    pdf = doc;
    document.documentElement.classList.remove('empty');
    hideMenu();
    numPages = pdf.numPages;
    fileName = name;
    fileKey = key;
    clearCaches();

    const savedPairing = pref.get('pairing:' + key);
    pairing = savedPairing !== undefined ? savedPairing : layoutHint.pairing;

    const savedTwo = pref.get('two:' + key);
    if (savedTwo !== undefined) {
      two = savedTwo;
    } else if (layoutHint.two !== undefined && !layoutHint.two) {
      two = false;
    } else {
      two = pref.get('two', true);
    }

    rot = pref.get('rot:' + key, 0);
    const p = page || pref.get('pos:' + key, 1);
    if (pref.get('calcOpen', false) && !isMobile()) setCalcOpen(true);
    show(spreadStartOf(p));
    if (isPinned()) showMenu();
    updateDocHistory(key);
  }
});

initInput({
  isPdfLoaded: () => Boolean(pdf),
  isMobile,
  isPopoverOpen,
  setPopoverOpen,
  isMenuHidden,
  isPinned,
  hideMenu,
  showMenu,
  scheduleHide,
  isCalcOpen,
  setCalcOpen,
  goHome,
  getLastRecent,
  openRecent,
  focusPageInputWithDigit,
  isPageInputFocused,
  pickFile,
  act,
  next,
  prev,
  flip,
  go,
  toggleMark,
  flash,
  getSpreadStartOf: (p) => spreadStartOf(p),
  getNumPages: () => numPages,
  getFitMode: () => fitMode,
  stage,
  isPasswordOpen
});

openFromHash();
