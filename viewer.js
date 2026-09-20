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

let dark = localStorage.getItem('dark') === '1';
let theme = localStorage.getItem('theme') || 'normal';   // 'normal' | 'gemini'
let two = localStorage.getItem('two') !== '0';           // dwie strony obok siebie czy jedna
let pairing = 'odd';      // 'odd' = 1–2, 3–4…   'even' = 1, 2–3, 4–5…
let pdf = null, numPages = 0, start = 1;
let fileKey = null, fileName = 'PDF';
let showToken = 0;

const sizeCache = new Map();   // nr strony -> {w, h}
const canvasCache = new Map(); // klucz -> canvas (kolejność = LRU)
const pending = new Map();     // klucz -> Promise<canvas>
const textCache = new Map();   // nr strony -> tekst
const tcCache = new Map();     // nr strony -> Promise<textContent>
const tlCache = new Map();     // klucz -> gotowa warstwa tekstowa
const loCache = new Map();     // szybkie podglądy niskiej rozdzielczości

applyDark();
document.documentElement.classList.add('empty');

function applyDark() {
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('gemini', dark && theme === 'gemini');
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

async function pageSize(n) {
  let s = sizeCache.get(n);
  if (!s) {
    const v = (await pdf.getPage(n)).getViewport({ scale: 1 });
    s = { w: v.width, h: v.height };
    sizeCache.set(n, s);
  }
  return s;
}

function fit(a, b, sa, sb) {
  const H = window.innerHeight - 2 * MARGIN;
  if (!two) {
    const scale = Math.min((window.innerWidth - 2 * MARGIN) / sa.w, H / sa.h);
    return { a, b: null, scale, L: sa, R: sa, single: true };
  }
  const L = sa || sb, R = sb || sa;
  const W = window.innerWidth - 2 * MARGIN - GAP;
  return { a, b, scale: Math.min(W / (L.w + R.w), H / Math.max(L.h, R.h)), L, R, single: false };
}

async function layout(s) {
  const [a, b] = spreadOf(s);
  return fit(a, b, a ? await pageSize(a) : null, b ? await pageSize(b) : null);
}

function layoutSync(s) {
  const [a, b] = spreadOf(s);
  const sa = a ? sizeCache.get(a) : null;
  const sb = b ? sizeCache.get(b) : null;
  if ((a && !sa) || (b && !sb)) return null;
  return fit(a, b, sa, sb);
}

// ---------- renderowanie ----------
function cacheKey(n, scale, q = 1) { return `${n}|${scale.toFixed(5)}|${q === 1 ? devicePixelRatio : 'lo'}`; }
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
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    task = page.render({ canvasContext: ctx, viewport: vp });
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
    const range = a && b ? `${a}–${b}` : `${a || b}`;
    document.title = `${range} / ${numPages} – ${fileName}`;
    if (!menu.hidden) updateMenu();
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
    const tl = new pdfjsLib.TextLayer({
      textContentSource: tc,
      container: div,
      viewport: page.getViewport({ scale })
    });
    await tl.render();
  }

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
  if (i < 0) { setEmpty(true); return; }
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

const welcome = document.getElementById('welcome');
function setEmpty(v) { document.documentElement.classList.toggle('empty', v); }
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

let pinned = localStorage.getItem('menuPinned') === '1';
let menuTimer = null, tipTimer = null, expandTimer = null, collapseTimer = null, hoverMenuTimer = null;

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

menu.addEventListener('mouseenter', () => {
  clearTimeout(collapseTimer);
  clearTimeout(menuTimer);
  expandTimer = setTimeout(expandMenu, 100);
});
menu.addEventListener('mouseleave', () => {
  clearTimeout(expandTimer);
  collapseTimer = setTimeout(() => {
    if (document.activeElement !== pageInput) collapseMenu();
    if (!pinned && !menu.hidden && document.activeElement !== pageInput) {
      clearTimeout(menuTimer);
      menuTimer = setTimeout(hideMenu, 2500);
    }
  }, 150);
});

menu.addEventListener('pointerover', (e) => { const t = e.target.closest('[data-tip]'); if (t) showTipFor(t); });
menu.addEventListener('pointerout', (e) => { const t = e.target.closest('[data-tip]'); if (t) hideTip(); });

window.addEventListener('mousemove', (e) => {
  if (!pdf) return;
  if (e.clientY >= window.innerHeight - 30) {
    if (menu.hidden && !hoverMenuTimer) {
      hoverMenuTimer = setTimeout(() => { showMenu(); hoverMenuTimer = null; }, 100);
    }
  } else {
    clearTimeout(hoverMenuTimer);
    hoverMenuTimer = null;
  }
});

function hideMenu() {
  collapseMenu();
  if (pinned) return;
  menu.hidden = true;
  clearTimeout(menuTimer);
  hideTip();
}

function showMenu() {
  if (!pdf) return;
  updateMenu();
  menu.hidden = false;
  clearTimeout(menuTimer);
  if (!pinned && !menu.matches(':hover')) menuTimer = setTimeout(hideMenu, 4000);
}

const label = (text, key) => `${text} <span class="k">(${key})</span>`;

function updateMenu() {
  const [a, b] = spreadOf(start);
  if (document.activeElement !== pageInput) {
    pageInput.value = (a && b ? `${a}–${b}` : `${a || b}`);
  }
  if (totalSpan) totalSpan.textContent = `/ ${numPages}`;
  menu.querySelector('[data-k="pages"]').innerHTML = label(two ? 'Jedna strona' : 'Dwie strony', 'P');
  const pr = menu.querySelector('[data-k="pairing"]');
  pr.innerHTML = label(pairing === 'odd' ? 'Pary 1–2' : 'Pary 1, 2–3', 'O');
  pr.hidden = !two;
  menu.querySelector('[data-k="theme"]').innerHTML = label(theme === 'gemini' ? 'Motyw Gemini' : 'Motyw zwykły', 'T');
  menu.querySelector('[data-k="dark"]').innerHTML = label(dark ? 'Ciemny' : 'Jasny', 'D');

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

pageInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(pageJumpTimer);
    pageJumpTimer = null;
    const val = parseInt(pageInput.value, 10);
    if (val >= 1 && val <= numPages) {
      if (spreadStartOf(val) !== start) go(spreadStartOf(val));
      else updateMenu();
    } else {
      updateMenu();
    }
    pageInput.blur();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    clearTimeout(pageJumpTimer);
    pageJumpTimer = null;
    updateMenu();
    pageInput.blur();
  }
});

pageInput.addEventListener('blur', () => {
  clearTimeout(pageJumpTimer);
  pageJumpTimer = null;
  const val = parseInt(pageInput.value, 10);
  if (val >= 1 && val <= numPages && spreadStartOf(val) !== start) {
    go(spreadStartOf(val));
  } else {
    updateMenu();
  }
  if (!menu.matches(':hover')) {
    collapseMenu();
    if (!pinned) menuTimer = setTimeout(hideMenu, 2500);
  }
});

['click', 'mousedown', 'pointerdown', 'keyup'].forEach(ev => pageInput.addEventListener(ev, e => e.stopPropagation()));
pageInput.addEventListener('input', (e) => { e.stopPropagation(); schedulePageJump(); });

const pageSelect = menu.querySelector('.page-select');
['click', 'mousedown', 'pointerdown'].forEach(ev => pageSelect?.addEventListener(ev, e => {
  e.stopPropagation();
  if (ev === 'click') pageInput.focus();
}));

function act(k) {
  switch (k) {
    case 'prev': prev(); break;
    case 'next': next(); break;
    case 'open': pickFile(); break;
    case 'pin':
      pinned = !pinned;
      localStorage.setItem('menuPinned', pinned ? '1' : '0');
      updateMenu();
      if (pinned) {
        clearTimeout(menuTimer);
        flash('Dymek strony zablokowany (na stałe)', 1200);
      } else {
        if (!menu.matches(':hover')) menuTimer = setTimeout(hideMenu, 2500);
        flash('Auto-ukrywanie dymka włączone', 1200);
      }
      break;
    case 'full':
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      break;
    case 'dark':
      dark = !dark;
      localStorage.setItem('dark', dark ? '1' : '0');
      applyDark();
      break;
    case 'theme':
      if (!dark) { dark = true; theme = 'gemini'; }
      else theme = theme === 'gemini' ? 'normal' : 'gemini';
      localStorage.setItem('dark', '1');
      localStorage.setItem('theme', theme);
      applyDark();
      flash(theme === 'gemini' ? 'Motyw: Gemini' : 'Motyw: zwykły ciemny');
      break;
    case 'pages': {
      if (!pdf) break;
      const anchor = spreadOf(start).find(Boolean);
      two = !two;
      localStorage.setItem('two', two ? '1' : '0');
      flash(two ? 'Dwie strony' : 'Jedna strona');
      go(spreadStartOf(anchor));
      break;
    }
    case 'pairing': {
      if (!pdf || !two) break;
      const anchor = spreadOf(start).find(Boolean);
      pairing = pairing === 'odd' ? 'even' : 'odd';
      localStorage.setItem('pairing', pairing);
      if (fileKey) localStorage.setItem('pairing:' + fileKey, pairing);
      flash(pairing === 'odd' ? 'Pary: 1–2, 3–4, 5–6…' : 'Pary: 1, 2–3, 4–5…');
      go(spreadStartOf(anchor));
      break;
    }
  }
  if (!menu.hidden) showMenu();
}

menu.addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('button');
  if (b) act(b.dataset.k);
});

window.addEventListener('click', () => {
  if (!pdf) { pickFile(); return; }
  if (String(getSelection())) return;
  collapseMenu();
  if (pinned) return;
  menu.hidden ? showMenu() : hideMenu();
});

// ---------- kółko myszy i gesty ----------
let lastWheel = 0, notch = 100, acc = 0;
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return;
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

  if (/^[0-9]$/.test(k)) {
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
    f: 'full', F: 'full'
  };
  if (keyActions[k]) { act(keyActions[k]); e.preventDefault(); return; }

  if (['ArrowRight', 'ArrowDown', 'PageDown', 'j', 'l'].includes(k)) { next(); e.preventDefault(); return; }
  if (['ArrowLeft', 'ArrowUp', 'PageUp', 'k', 'h'].includes(k)) { prev(); e.preventDefault(); return; }
  if (k === ' ') { e.shiftKey ? prev() : next(); e.preventDefault(); return; }
  if (k === 'Home') { go(1); e.preventDefault(); return; }
  if (k === 'End') { if (pdf) go(spreadStartOf(numPages)); e.preventDefault(); return; }
  if (k === '?') {
    flash('→ ↓ Spacja PgDn  następne\n← ↑ PgUp  poprzednie\nHome / End  początek / koniec\n' +
          'numer (lub Enter)  skok do strony\nCtrl+O  otwórz plik z dysku\nP  jedna / dwie strony\nD  tryb ciemny\nT  motyw zwykły / Gemini\nO  pary nieparzyste / parzyste\nF  pełny ekran\nkliknięcie  pasek z przyciskami', 5000);
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
