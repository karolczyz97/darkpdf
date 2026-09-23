// viewer.js – czytnik DarkPDF: stan dokumentu, renderowanie stron, otwieranie plików, pasek menu, klawisze i gesty.
// Osobno: layout.js (geometria rozkładówek i przycinania), crop.js (wykrywanie marginesów),
// library.js (ostatnie pliki i zakładki), calc-panel.js (kalkulator z boku), util.js (ustawienia, pamięć LRU).

// pdf.js 4.10.38 trzymamy w repo (lib/pdfjs), więc razem z plikiem sw.js czytnik działa też bez internetu
const PDFJS = new URL('lib/pdfjs/', import.meta.url).href;
const pdfjsLib = await import(PDFJS + 'build/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.min.mjs';

import { pref, lru } from './util.js';
import * as geo from './layout.js';
import { createCropper } from './crop.js';
import { isRemoteKey, rememberFile, recentFiles, storedFile, forgetFile, bookmarks, toggleBookmark } from './library.js';
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
const CACHE_MAX_MOBILE = 10;  // telefon: iOS ma limit pamięci na płótna, po przekroczeniu strony robią się puste
const LO_CACHE_MAX = 60;      // ile szybkich podglądów trzymać w pamięci
const TITLE = document.title || 'DarkPDF';

const stage = document.getElementById('stage');
const hint = document.getElementById('hint');
const textLayer = document.getElementById('text');
stage.style.gap = GAP + 'px';

// ---------- wygląd: tryb i paleta ----------
const COLOR_MODES = ['dark', 'light', 'auto'];
const COLOR_LABELS = { dark: 'Tryb: Ciemny', light: 'Tryb: Jasny', auto: 'Tryb: Auto' };
const PALETTE_LABELS = { gemini: 'Motyw: Gemini', system: 'Motyw: Systemowy' };

// Starsze wersje zapisywały „dark” (1/0) i „theme” – z nich bierzemy ustawienie, gdy nowego jeszcze nie ma
let colorMode = pref.get('colorMode', null) || (pref.get('dark', true) ? 'dark' : 'light');
if (!COLOR_MODES.includes(colorMode)) colorMode = 'dark';
let palette = pref.get('palette', null) || (pref.get('theme', 'gemini') === 'gemini' ? 'gemini' : 'system');
if (!(palette in PALETTE_LABELS)) palette = 'gemini';

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
systemDark.addEventListener('change', () => {
  if (colorMode === 'auto') applyTheme();
});

// ---------- stan czytnika ----------
let two = pref.get('two', true);           // dwie strony obok siebie czy jedna

// Tryb mobilny: wąski ekran albo dotyk. Na telefonie w pionie zawsze jedna strona
// (dwie byłyby nieczytelne), a zapamiętane ustawienie P zostaje na komputer.
// Tylko po rozmiarze ekranu: laptopy z ekranem dotykowym zgłaszają „dotyk” i „brak najechania”,
// więc na tym nie można polegać. Telefon w pionie jest wąski, a w poziomie niski.
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
// Płótno wyrzucone z pamięci zwalniamy od razu (iPhone nie oddaje go sam), ale dopiero gdy na pewno
// nie jest już na ekranie – trwające show() może je jeszcze za chwilę wstawić
const releaseCanvas = (c) => setTimeout(() => { if (!c.isConnected) { c.width = 0; c.height = 0; } }, 1000);

const sizeCache = lru();             // nr strony -> obszar do pokazania
const canvasCache = lru(() => (isMobile() ? CACHE_MAX_MOBILE : CACHE_MAX), releaseCanvas);   // klucz -> gotowa strona
const loCache = lru(LO_CACHE_MAX, releaseCanvas);   // klucz -> szybki podgląd
const tlCache = lru(CACHE_MAX);      // klucz -> warstwa tekstowa
const tcCache = lru();               // nr strony -> Promise<textContent>
const textCache = lru();             // nr strony -> Promise<tekst strony>
const pending = new Map();           // klucz -> trwające renderowanie { promise, cancel }

// Rośnie przy każdym wyrzuceniu obrazów stron (inna skala, plik, obrót, przycięcie). Jest w kluczach
// i w layoutSpread(), więc to, co jeszcze liczy się dla starego układu, nigdzie już nie trafi.
let layoutGen = 0;

const cropper = createCropper({
  doc: () => pdf,
  rotation: () => rot,
  enabled: () => crop,
  onRefine: () => { sizeCache.clear(); clearRenderCaches(); show(start); }   // dokładniejsze cięcie z pełnej próbki
});
const pageBox = (n) => cropper.pageBox(n);
const rotationOf = (page) => cropper.rotationOf(page);

// Gotowe obrazy stron są liczone dla konkretnej skali i pól stron – po zmianie układu wyrzucamy je
function clearRenderCaches() {
  layoutGen++;
  for (const job of [...pending.values()]) job.cancel();
  canvasCache.clear(); loCache.clear(); tlCache.clear();
}

// Przerysowanie z krótkim opóźnieniem, żeby seria zmian (przeciąganie, przełączniki) dała jedno
let resizeTimer;
function rerenderSoon(ms = 120) {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { clearRenderCaches(); show(start); }, ms);
}

// Inne pola stron (plik, przycinanie, obrót): układ i obrazy stron liczymy od nowa
function resetLayout() {
  sizeCache.clear();
  cropper.reset();
  clearRenderCaches();
}

// Nowy plik albo jego zamknięcie: także tekst stron
function clearCaches() {
  resetLayout();
  tcCache.clear();
  textCache.clear();
}

function relayout() {
  resetLayout();
  show(start);
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
  colorMode = COLOR_MODES[(COLOR_MODES.indexOf(colorMode) + 1) % COLOR_MODES.length];
  pref.set('colorMode', colorMode);
  applyTheme();
  flash(COLOR_LABELS[colorMode]);
}

function togglePalette() {
  palette = palette === 'gemini' ? 'system' : 'gemini';
  pref.set('palette', palette);
  applyTheme();
  flash(PALETTE_LABELS[palette]);
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

// ---------- rozkład stron ----------
const spreadOpts = () => ({ numPages, two: showTwo(), pairing });
const spreadStartOf = (p) => geo.spreadStartOf(p, spreadOpts());
const spreadOf = (s) => geo.spreadOf(s, spreadOpts());
const nextStart = (s) => geo.nextStart(s, spreadOpts());
const prevStart = (s) => geo.prevStart(s, spreadOpts());
const spreadLabel = (s = start) => geo.spreadLabel(spreadOf(s));

// Skala rozkładówki w miejscu, które zostaje obok kalkulatora
function fit(a, b, sa, sb) {
  const two = showTwo();
  const W = Math.max(120, window.innerWidth - getCalcStageWidth() - 2 * MARGIN - (two ? GAP : 0));
  const H = Math.max(120, window.innerHeight - 2 * MARGIN);
  return { a, b: two ? b : null, ...geo.fitSpread(sa, sb, { W, H, two, fitMode }) };
}

async function layoutSpread(s) {
  const gen = layoutGen;
  const [a, b] = spreadOf(s);
  const [sa, sb] = await Promise.all([a ? pageBox(a) : null, b ? pageBox(b) : null]);
  if (gen !== layoutGen) throw cancelled();   // w międzyczasie inny plik, obrót albo skala – te pola są nieaktualne
  if (a) sizeCache.set(a, sa);
  if (b) sizeCache.set(b, sb);
  if (s === start) handleCalcResize();   // szerokość kalkulatora zależy od stron na ekranie, nie od tych w tle
  return fit(a, b, sa, sb);
}

function layoutSpreadSync(s) {
  const [a, b] = spreadOf(s);
  const sa = a ? sizeCache.get(a) : null;
  const sb = b ? sizeCache.get(b) : null;
  if ((a && !sa) || (b && !sb)) return null;
  return fit(a, b, sa, sb);
}

// ---------- renderowanie ----------
function cacheKey(n, scale, q = 1) { return `${layoutGen}|${n}|${scale.toFixed(5)}|${q === 1 ? (window.devicePixelRatio || 1) : 'lo'}`; }
function cancelled() { const e = new Error('cancelled'); e.name = 'RenderingCancelledException'; return e; }

function renderPage(n, scale, q = 1) {
  const k = cacheKey(n, scale, q);
  const cache = q === 1 ? canvasCache : loCache;
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  if (pending.has(k)) return pending.get(k).promise;

  let task = null, stop = false;
  const check = () => { if (stop) throw cancelled(); };
  const drop = () => { if (pending.get(k) === job) pending.delete(k); };
  // Przerwane zadanie od razu znika z listy – następne pytanie o tę stronę zaczyna od nowa
  const job = { cancel() { stop = true; task?.cancel(); drop(); } };
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
    canvas.style.width = Math.floor(b.w * scale) + 'px';
    canvas.style.height = Math.floor(b.h * scale) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    task = page.render({ canvasContext: ctx, viewport: vp });
    try {
      await task.promise;
      check();                         // skończone tuż po przerwaniu (np. inny plik) – do pamięci nie trafia
    } catch (e) {
      canvas.width = 0;                // przerwane albo nieudane – pamięć płótna od razu z powrotem
      canvas.height = 0;
      throw e;
    }
    return cache.set(k, canvas);
  })().finally(drop);

  pending.set(k, job);
  return job.promise;
}

function blank(size, scale) {
  const d = document.createElement('div');
  d.className = 'blank';
  d.style.width = Math.floor(size.w * scale) + 'px';
  d.style.height = Math.floor(size.h * scale) + 'px';
  return d;
}

let lastRenderedScale = null;
let lastRenderedDpr = window.devicePixelRatio || 1;

// Uszkodzona strona (np. złe drzewo stron): komunikat zamiast pustego ekranu i nieobsłużonego wyjątku.
// show() wołane jest w wielu miejscach bez await, więc błędy obsługuje samo.
function showError(e) {
  console.error('Błąd wyświetlania strony:', e);
  flash('Nie udało się wyświetlić strony: ' + (e?.message || e), 4000);
}

async function show(s) {
  const token = ++showToken;
  // Początek rozkładówki liczymy przy każdym pokazaniu: po obrocie telefonu (jedna strona → dwie)
  // przerysowanie z rerenderSoon() mogłoby inaczej pokazać parę 2–3 zamiast 1–2
  start = s = spreadStartOf(s);
  // Przerwane (nowsze show(), nowy układ) to nie błąd; komunikat tylko dla tego, co widać
  const failed = (e) => { if (token === showToken && e?.name !== 'RenderingCancelledException') showError(e); };
  let lay;
  try { lay = await layoutSpread(s); } catch (e) { failed(e); return; }
  if (token !== showToken) return;
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
    stage.replaceChildren(...(single
      ? [shown[0] || blank(L, scale)]
      : [shown[0] || blank(L, scale), shown[1] || blank(R, scale)]));
    stage.scrollTop = 0;
    centerX();
    document.title = `${geo.spreadLabel([a, b])} / ${numPages} – ${fileName}`;
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
    failed(e);
    return;
  }
  pref.set('pos:' + fileKey, a || b);
  prefetch(s, token).catch(() => {}).then(() => updateText(s, token)).catch(() => {});   // uszkodzona sąsiednia strona nie blokuje tekstu
}

// ---------- warstwa tekstowa i dostępność ----------
// Tekst strony z pdf.js i ten sam tekst jako zwykły napis (dla czytników ekranu i Gemini). Obietnice
// zapisujemy od razu, więc wynik należy do pliku otwartego w chwili pytania i nie trafi do następnego.
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

// Prefetch stron w tle
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

// Cienki wskaźnik postępu przy prawej krawędzi – pokazuje się przy zmianie strony i znika.
const prog = document.getElementById('prog');
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

// ---------- zakładki ----------
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

// ---------- otwieranie dokumentów ----------
// Każde żądanie otwarcia (plik z dysku, z pamięci, z sieci) dostaje numer. Starsze, które skończy się
// później (np. długie pobieranie przez wtyczkę), nie podmieni pliku wybranego w międzyczasie.
let openSeq = 0;

// Nieudane otwarcie: otwarty wcześniej PDF zostaje na ekranie, a bez niego wracamy do ekranu startowego
function openFailed(msg) {
  setEmpty(!pdf);
  flash(msg, 4000);
}

// src – źródło dla pdf.js ({ data }); blob – oryginalny plik z dysku do zapamiętania; req – numer żądania
async function open(src, { name, key, page = null, blob = null, req }) {
  flash('Ładowanie…', 0);
  let doc, task, cancelled = false;
  try {
    task = pdfjsLib.getDocument({
      ...src,
      cMapUrl: PDFJS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS + 'standard_fonts/',
      isEvalSupported: false
    });
    // PDF z hasłem: pdf.js pyta przez task.onPassword (ta sama nazwa jako opcja getDocument() jest ignorowana)
    task.onPassword = (update, reason) => {
      hint.hidden = true;
      askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw === null) { cancelled = true; update(new Error('Anulowano')); return; }
        flash('Ładowanie…', 0);
        update(pw);
      });
    };
    doc = await task.promise;
  } catch (err) {
    task?.destroy().catch(() => {});
    if (req !== openSeq) return;          // w międzyczasie wybrano inny plik
    if (cancelled) {                      // rezygnacja z hasła to nie błąd – zostaje to, co było otwarte
      hint.hidden = true;
      setEmpty(!pdf);
      return;
    }
    openFailed('Nie udało się otworzyć pliku: ' + (err?.message || err));
    return;
  }
  if (req !== openSeq) { doc.destroy(); return; }
  try {
    pdf?.destroy();
    pdf = doc;
    document.documentElement.classList.remove('empty');
    hideMenu();
    numPages = pdf.numPages;
    fileName = name;
    fileKey = key;
    clearCaches();
    textLayer.replaceChildren();
    pairing = pref.get('pairing:' + key, pref.get('pairing', 'odd'));
    rot = pref.get('rot:' + key, 0);
    rememberFile(key, name, blob);
    const p = page || pref.get('pos:' + key, 1);
    if (pref.get('calcOpen', false) && !isMobile()) setCalcOpen(true);
    show(spreadStartOf(p));
    if (pinned) showMenu();
  } catch (e) {
    console.error('Błąd inicjalizacji PDF:', e);
    flash('Błąd podczas wyświetlania: ' + (e?.message || e), 4000);
    return;
  }
  hint.hidden = true;                   // „Ładowanie…” znika; komunikat błędu z catch zostaje
}

// Powrót (np. przyciskiem Wstecz) do adresu bez pliku: zamykamy dokument i pokazujemy ekran startowy
function closeDocument() {
  if (!pdf) return;
  showToken++;                          // trwające renderowanie i tekst stron przepadają
  clearCaches();
  pdf.destroy();
  pdf = null;
  numPages = 0;
  fileKey = null;
  stage.replaceChildren();
  textLayer.replaceChildren();
  document.title = TITLE;
  menu.hidden = true;                   // także przypięty – bez pliku pasek nie ma czego pokazywać
  syncPopover();
}

// Okno hasła do zaszyfrowanego PDF-a → Promise z hasłem albo null (Anuluj, Esc)
const pwDialog = document.getElementById('pw-dialog');
const pwInput = document.getElementById('pw-input');
document.getElementById('pw-ok').addEventListener('click', () => pwDialog.close('ok'));
document.getElementById('pw-cancel').addEventListener('click', () => pwDialog.close());
pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pwDialog.close('ok'); } });
function askPassword(wrong) {
  document.getElementById('pw-msg').textContent = wrong ? 'Nieprawidłowe hasło – spróbuj jeszcze raz.' : 'Ten plik jest chroniony hasłem.';
  pwInput.value = '';
  pwDialog.returnValue = '';
  pwDialog.showModal();
  pwInput.focus();
  return new Promise((resolve) => pwDialog.addEventListener('close', () => resolve(pwDialog.returnValue === 'ok' ? pwInput.value : null), { once: true }));
}

function nameFromUrl(u) {
  try {
    const last = new URL(u).pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || 'PDF');
  } catch { return 'PDF'; }
}

// Plik z sieci pobiera wtyczka DarkPDF (strona sama nie ominie CORS); odpowiada przez postMessage
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

// Adres z wtyczki: …/darkpdf/#file=https://…/plik.pdf#page=12
async function openFromHash() {
  const req = ++openSeq;
  const h = location.href;
  const i = h.indexOf('#file=');
  if (i < 0) { closeDocument(); setEmpty(true); return; }
  let url = h.slice(i + 6);
  if (/^[a-z]+%3A/i.test(url)) { try { url = decodeURIComponent(url); } catch {} }   // zepsute %… zostawiamy jak są
  const pm = /#page=(\d+)/.exec(url);
  const clean = url.split('#')[0];
  setEmpty(false);
  flash('Ładowanie…', 0);
  try {
    const data = await loadViaExtension(clean);
    if (req !== openSeq) return;
    open({ data }, { name: nameFromUrl(clean), key: clean, page: pm ? +pm[1] : null, req });
  } catch (err) {
    if (req !== openSeq) return;
    openFailed(err.message === 'NOEXT'
      ? 'Brak wtyczki DarkPDF – wybierz plik ręcznie'
      : 'Nie udało się pobrać pliku: ' + err.message);
  }
}
openFromHash();
window.addEventListener('hashchange', openFromHash);

// Plik z sieci otwieramy przez adres (#file=…). Ten sam adres co teraz (np. ponowna próba po błędzie)
// nie wywołuje hashchange – wtedy otwieramy wprost.
function openUrl(url, page = null) {
  const before = location.href;
  location.hash = '#file=' + url + (page ? '#page=' + page : '');
  if (location.href === before) openFromHash();
}

// Pliki lokalne
const picker = document.createElement('input');
picker.type = 'file';
picker.accept = 'application/pdf,.pdf';
picker.hidden = true;
document.body.append(picker);

// Plik z dysku lub z pamięci przeglądarki: adres bez #file=…, inaczej odświeżenie wróciłoby do pliku z sieci
const clearFileHash = () => history.replaceState(null, '', location.pathname);

async function openLocal(f) {
  if (!f) return;
  const req = ++openSeq;
  clearFileHash();
  setEmpty(false);
  flash('Ładowanie…', 0);
  let data;
  try {
    data = new Uint8Array(await f.arrayBuffer());
  } catch (e) {
    if (req === openSeq) openFailed('Nie udało się odczytać pliku: ' + (e?.message || e));
    return;
  }
  if (req !== openSeq) return;
  open({ data }, { name: f.name, key: `local:${f.name}:${f.size}`, blob: f, req });
}
function pickFile() { picker.value = ''; picker.click(); }
picker.addEventListener('change', () => openLocal(picker.files[0]));
const welcome = document.getElementById('welcome');
welcome.querySelector('.pick').addEventListener('click', (e) => { e.stopPropagation(); pickFile(); });

// ---------- ekran startowy: ostatnie pliki i zakładki ----------
// Wiersze na ekranie startowym: ostatnie pliki i zakładki wyglądają tak samo.
function renderList(id, items, onPick) {
  const box = document.getElementById(id);
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

// Plik zapisany w przeglądarce. Uszkodzony wpis (pusty albo nieczytelny blob) usuwamy z listy.
async function openStored(rec, page = null) {
  const req = ++openSeq;
  clearFileHash();
  setEmpty(false);
  let data = null;
  try { if (rec.blob.size) data = new Uint8Array(await rec.blob.arrayBuffer()); } catch {}
  if (req !== openSeq) return;
  if (!data) {
    await forgetFile(rec.key).catch(() => {});
    openFailed('Zapisany plik jest uszkodzony lub niedostępny – otwórz go ponownie z dysku');
    return;
  }
  open({ data }, { name: rec.name, key: rec.key, page, blob: rec.blob, req });
}

function openRecent(rec) {
  if (rec?.url) openUrl(rec.url);
  else if (rec?.blob) openStored(rec);
}

async function openBookmark(m) {
  let rec = null;
  try { rec = await storedFile(m.key); } catch {}
  if (rec?.blob) openStored(rec, m.page);
  else if (isRemoteKey(m.key)) openUrl(m.key, m.page);
  else flash('Ten plik nie jest już zapisany – otwórz go z dysku', 3000);
}

let lastRecent = null;       // Enter na ekranie startowym otwiera ostatni plik
async function renderRecent() {
  let all = [];
  try { all = await recentFiles(); } catch {}
  lastRecent = all[0] || null;
  document.getElementById('recentHint').hidden = all.length === 0;
  renderList('recent', all.map((r) => ({ ...r, page: pref.get('pos:' + r.key, 1), title: r.url || r.name })), openRecent);
}

function setEmpty(v) {
  document.documentElement.classList.toggle('empty', v);
  if (v) {
    if (isCalcOpen()) setCalcOpen(false);
    renderRecent();
    renderList('marks', bookmarks(), openBookmark);
  }
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

menu.addEventListener('mouseenter', () => clearTimeout(menuTimer));
menu.addEventListener('mouseleave', scheduleHide);

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

function updateMenu() {
  if (document.activeElement !== pageInput) pageInput.value = spreadLabel();
  totalSpan.textContent = `/ ${numPages}`;
  syncPopover();

  const btn = (k) => menu.querySelector(`[data-k="${k}"]`);
  // [przycisk, etykieta, czy podświetlony]; skrót klawiszowy (.k) jest na stałe w index.html
  const labels = [
    ['calc', isCalcOpen() ? 'Ukryj kalkulator' : 'Kalkulator', isCalcOpen()],
    ['fit-w', fitMode === 'width' ? 'Szerokość [100%]' : 'Szerokość 100%', fitMode === 'width'],
    ['fit-h', fitMode === 'height' ? 'Wysokość [100%]' : 'Wysokość 100%', fitMode === 'height'],
    ['pages', two ? 'Jedna strona' : 'Dwie strony'],
    ['pairing', pairing === 'odd' ? 'Pary 1–2' : 'Pary 1, 2–3'],
    ['dark', COLOR_LABELS[colorMode]],
    ['theme', PALETTE_LABELS[palette]],
    ['crop', crop ? 'Z marginesami' : 'Przytnij marginesy']
  ];
  for (const [k, text, active] of labels) {
    btn(k).querySelector('.label-text').textContent = text;
    if (active !== undefined) btn(k).classList.toggle('active', active);
  }
  btn('pairing').hidden = !showTwo();              // parowanie nic nie zmienia przy jednej stronie
  btn('pages').hidden = isPortraitPhone();         // telefon w pionie zawsze pokazuje jedną stronę
  btn('full').hidden = !document.fullscreenEnabled; // iPhone i ramki bez zgody nie mają pełnego ekranu
  btn('dark').querySelector('use').setAttribute('href', `#i-mode-${colorMode}`);
  btn('theme').querySelector('use').setAttribute('href', `#i-pal-${palette}`);

  pinBtn.classList.toggle('pinned', pinned);
  pinBtn.querySelector('.icon-unlocked').hidden = pinned;
  pinBtn.querySelector('.icon-locked').hidden = !pinned;
  pinBtn.dataset.tip = pinned ? 'Odblokuj pasek (auto-ukrywanie)' : 'Zablokuj pasek na stałe';
  toggleBtn.classList.toggle('open', popoverOpen);
  toggleBtn.dataset.tip = popoverOpen ? 'Zamknij menu opcji (M)' : 'Otwórz menu opcji (M)';
}

// Skok do strony: automatyczny po 1s lub natychmiastowy po Enter; Esc anuluje
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
  if (e.key === 'Escape') pageInput.value = spreadLabel();   // bez tego blur niżej i tak by skoczył
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
  if (!document.fullscreenEnabled) { flash('Pełny ekran nie jest tu dostępny'); return; }
  const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  p?.catch(() => {});                  // np. przeglądarka odmówiła – nic się nie dzieje
}

// ---------- akcje wspólne dla klawiatury, menu i kalkulatora ----------
const WITHOUT_PDF = new Set(['open', 'pin', 'toggle-menu', 'full', 'dark', 'theme']);   // reszta potrzebuje pliku

function act(k) {
  if (!pdf && !WITHOUT_PDF.has(k)) return;
  switch (k) {
    case 'prev': prev(); break;
    case 'next': next(); break;
    case 'open': pickFile(); break;
    case 'calc': toggleCalc(); break;
    case 'fit-w': setFitMode(fitMode === 'width' ? 'auto' : 'width'); break;
    case 'fit-h':
      // Ręczna szerokość kalkulatora? H najpierw wraca do automatu (tryb wysokości zostaje / włącza się).
      // Dopiero H bez ręcznej szerokości wyłącza tryb wysokości.
      if (fitMode === 'height' && isCalcOpen() && isUserCustomWidth()) {
        snapCalcToHeightFit();
        flash('Szerokość kalkulatora: automatycznie');
      } else {
        setFitMode(fitMode === 'height' ? 'auto' : 'height');
      }
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
      setPopoverOpen(!popoverOpen);
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
  if (e.target.closest('#menu, #calc-sidebar, #pw-dialog')) return;
  act('full');
});

const zoomed = () => (window.visualViewport?.scale || 1) > 1.01;   // przybliżone dwoma palcami: palec przesuwa widok

window.addEventListener('click', (e) => {
  if (!pdf) return;
  if (String(window.getSelection())) return;
  if (e.target.closest('#menu, #calc-sidebar, #calc-resizer, #pw-dialog')) return;
  // Telefon: stuknięcie w lewą / prawą część strony przewraca, środek otwiera pasek.
  // Przybliżona strona przewija się palcem – wtedy stuknięcie tylko otwiera pasek.
  if (isMobile() && !zoomed()) {
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

// Dotyk: szybkie przesunięcie palcem zmienia stronę – w bok (w lewo = dalej) i w pionie (w górę = dalej,
// jak przy przewijaniu). Strona większa niż ekran (Szerokość / Wysokość 100%) najpierw przewija się
// palcem do brzegu, a dopiero kolejne przesunięcie przy brzegu zmienia stronę.
// Kalkulator, pasek i okno hasła przewijają się same – tam gest nie rusza stron.
const SWIPE_PX = 50;      // tyle px ruchu palca to już przesunięcie, a nie stuknięcie
const SWIPE_MS = 700;     // dłuższy ruch to przewijanie albo zaznaczanie, nie przewracanie
let swipe = null;
window.addEventListener('touchstart', (e) => {
  swipe = null;
  if (e.touches.length !== 1 || e.target.closest('#calc-sidebar, #menu, #pw-dialog')) return;
  const t = e.touches[0];
  swipe = {
    x: t.clientX, y: t.clientY, at: Date.now(),
    // czy strona była już przewinięta do brzegu, zanim palec ruszył
    left: stage.scrollLeft <= 2, right: stage.scrollLeft + stage.clientWidth >= stage.scrollWidth - 2,
    top: stage.scrollTop <= 2, bottom: stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2
  };
}, { passive: true });
window.addEventListener('touchend', (e) => {
  const s = swipe;
  swipe = null;
  if (!pdf || !s || String(window.getSelection()) || pwDialog.open) return;
  if (Date.now() - s.at > SWIPE_MS) return;
  if (zoomed()) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - s.x, dy = t.clientY - s.y;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax >= SWIPE_PX && ax >= ay * 1.5) {
    if (dx < 0 && s.right) next();
    else if (dx > 0 && s.left) prev();
  } else if (ay >= SWIPE_PX && ay >= ax * 1.5) {
    if (dy < 0 && s.bottom) next();
    else if (dy > 0 && s.top) prev();
  }
}, { passive: true });

// ---------- kółko myszy i gesty ----------
let lastWheel = 0, notch = 100, acc = 0;
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return;
  if (e.target.closest('#calc-sidebar, #pw-dialog')) return;
  if (!pdf) return;
  // W trybie blokady szerokości pozwól na naturalne przewijanie, jeśli strona wystaje pionowo
  if (fitMode === 'width' && stage.scrollHeight > stage.clientHeight + 10) {
    const atTop = stage.scrollTop <= 2;
    const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
    if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return;   // naturalne przewijanie strony
  }
  // Tryb wysokości: jeśli strony wystają w bok, ruch poziomy (touchpad, kółko przechylane) przewija je w bok,
  // a kółko w pionie dalej przerzuca strony
  if (fitMode === 'height' && stage.scrollWidth > stage.clientWidth + 2 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    e.preventDefault();
    stage.scrollLeft += e.deltaX * (e.deltaMode === 1 ? 40 : 1);
    return;
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
const KEY_ACTIONS = {
  d: 'dark', t: 'theme', p: 'pages', o: 'pairing', f: 'full', c: 'crop', r: 'rotate',
  k: 'calc', w: 'fit-w', h: 'fit-h', m: 'toggle-menu'
};
const HELP = '→ ↓ Spacja PgDn  następne\n← ↑ PgUp  poprzednie\nHome / End  początek / koniec\n' +
  'numer (lub Enter)  skok do strony\nShift + strzałka / scroll  skok o 10\nB  zakładka na tej stronie\n' +
  'M  menu opcji\nK  kalkulator z boku\nW  zablokuj szerokość 100%\nH  zablokuj wysokość 100%\n' +
  'C  przycinanie marginesów\nR  obrót o 90°\n' +
  'P  jedna / dwie strony\nD  tryb: ciemny / jasny / auto\nT  motyw: Gemini / systemowy\nO  pary nieparzyste / parzyste\n' +
  'F  pełny ekran\ndwuklik  pełny ekran\nCtrl+O  otwórz plik\nkliknięcie  pasek z przyciskami';

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (document.activeElement === pageInput) return;
  if (e.target.closest('#pw-dialog')) return;
  if (e.target.closest('#calc-sidebar') && e.key.length === 1 && !/^[a-z?]$/i.test(e.key)) return;   // cyfry i działania z panelu idą do kalkulatora
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); pickFile(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;

  if (k === 'Escape') {
    if (popoverOpen && !menu.hidden) {     // schowany pasek = schowane menu opcji; Esc idzie dalej
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

  // Enter na ekranie startowym otwiera ostatni plik – chyba że przycisk jest zaznaczony (Tab), wtedy działa on
  if (!pdf && k === 'Enter' && lastRecent && !e.target.closest('button')) { e.preventDefault(); openRecent(lastRecent); return; }

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

  const action = k.length === 1 && KEY_ACTIONS[k.toLowerCase()];
  if (action) { act(action); e.preventDefault(); return; }

  if (!pdf && k !== '?') return;       // bez pliku strzałki i spacja przewijają ekran startowy
  const jump = e.shiftKey ? 10 : 1;   // Shift = skok o 10 rozkładówek
  if (['ArrowRight', 'ArrowDown', 'PageDown', 'j', 'l'].includes(k)) { flip(jump); e.preventDefault(); return; }
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) { flip(-jump); e.preventDefault(); return; }
  if (k === ' ') { e.shiftKey ? prev() : next(); e.preventDefault(); return; }
  if (k === 'b' || k === 'B') { toggleMark(); e.preventDefault(); return; }
  if (k === 'Home') { go(1); e.preventDefault(); return; }
  if (k === 'End') { go(spreadStartOf(numPages)); e.preventDefault(); return; }
  if (k === '?') { flash(HELP, 6000); e.preventDefault(); }
});

// ---------- dopasowanie i skalowanie okna ----------
function fitNow() {
  const l = layoutSpreadSync(start);
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
  centerX();
}

// Tryb wysokości: gdy strony wystają w bok, ustaw widok na środek (a nie na lewą krawędź)
function centerX() {
  stage.scrollLeft = fitMode === 'height' ? Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2) : 0;
}

window.addEventListener('resize', () => {
  document.documentElement.classList.toggle('mobile', isMobile());
  handleCalcResize();
  if (!pdf) return;
  fitNow();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const isMob = isMobile();
    const mobChanged = isMob !== lastMobileState;
    lastMobileState = isMob;
    const l = layoutSpreadSync(start);
    const dpr = window.devicePixelRatio || 1;
    const dprChanged = Math.abs(dpr - lastRenderedDpr) > 1e-3;
    const scaleChanged = !l || Math.abs((l.scale || 0) - (lastRenderedScale || 0)) > 1e-4;
    if (scaleChanged || mobChanged || dprChanged) {
      clearRenderCaches();
      show(spreadStartOf(start));
    }
    updateMenu();
  }, 180);
});
