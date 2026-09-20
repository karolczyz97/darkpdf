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
const ocrStatusEl = document.getElementById('ocr-status');
const ocrSpinnerEl = ocrStatusEl?.querySelector('.spinner');
const ocrTextEl = ocrStatusEl?.querySelector('.text');
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
const tlCache = new Map();     // klucz -> gotowa warstwa tekstowa (zaznaczanie)
const ocrCache = new Map();    // klucz -> zmapowane słowa OCR

applyDark();
document.documentElement.classList.add('empty');

// ---------- pomocnicze ----------
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

// Skala dobrana tak, żeby rozkładówka wypełniła okno bez przewijania.
function fit(a, b, sa, sb) {
  const H = window.innerHeight - 2 * MARGIN;
  if (!two) {
    const scale = Math.min((window.innerWidth - 2 * MARGIN) / sa.w, H / sa.h);
    return { a, b: null, scale, L: sa, R: sa, single: true };
  }
  const L = sa || sb, R = sb || sa; // pojedyncza strona zachowuje rozmiar jak w parze
  const W = window.innerWidth - 2 * MARGIN - GAP;
  return { a, b, scale: Math.min(W / (L.w + R.w), H / Math.max(L.h, R.h)), L, R, single: false };
}

async function layout(s) {
  const [a, b] = spreadOf(s);
  return fit(a, b, a ? await pageSize(a) : null, b ? await pageSize(b) : null);
}

// To samo bez czekania – przy zmianie rozmiaru okna wymiary stron są już znane.
function layoutSync(s) {
  const [a, b] = spreadOf(s);
  const sa = a ? sizeCache.get(a) : null;
  const sb = b ? sizeCache.get(b) : null;
  if ((a && !sa) || (b && !sb)) return null;
  return fit(a, b, sa, sb);
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

// Strony podmieniane są w całości, bez animacji. Jeśli rozkładówka nie jest jeszcze
// wyrenderowana, najpierw pojawia się szybki podgląd, a ostra wersja zaraz po nim.
// Przy szybkim przewijaniu niepotrzebne już renderowania są przerywane.
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

// ---------- warstwa tekstowa: zaznaczanie i kopiowanie tekstu ----------
function textContent(n) {
  if (!tcCache.has(n)) tcCache.set(n, pdf.getPage(n).then((p) => p.getTextContent()));
  return tcCache.get(n);
}

let ocrWorker = null, ocrWorkerPromise = null;
let ocrQueue = Promise.resolve();
let ocrTimer = null;
let currentOcrPage = null;
let ocrSessionToken = 0;
let lastProgressPct = -1;

function showOcrStatus(text, spinning = true, hideAfterMs = 0) {
  if (!ocrStatusEl) return;
  clearTimeout(ocrTimer);
  if (ocrSpinnerEl) ocrSpinnerEl.hidden = !spinning;
  if (ocrTextEl) ocrTextEl.textContent = text;
  ocrStatusEl.hidden = false;
  if (hideAfterMs > 0) {
    ocrTimer = setTimeout(() => {
      ocrStatusEl.hidden = true;
    }, hideAfterMs);
  }
}

function hideOcrStatus() {
  if (!ocrStatusEl) return;
  clearTimeout(ocrTimer);
  ocrStatusEl.hidden = true;
}

function enqueueOcr(fn) {
  const next = ocrQueue.then(fn, fn);
  ocrQueue = next.catch(() => {});
  return next;
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = (async () => {
    try {
      showOcrStatus('Inicjalizacja silnika OCR…', true);
      const T = window.Tesseract;
      if (!T) throw new Error('Brak biblioteki Tesseract (sprawdź połączenie)');
      const worker = await T.createWorker('pol+eng', 1, {
        logger: m => {
          const prefix = currentOcrPage ? `Strona ${currentOcrPage}: ` : '';
          if (m.status === 'recognizing text') {
            const pct = Math.round((m.progress || 0) * 100);
            if (pct !== lastProgressPct) {
              lastProgressPct = pct;
              showOcrStatus(`${prefix}skanowanie tekstu… ${pct}%`, true);
            }
          } else if (m.status.includes('loading') || m.status.includes('downloading')) {
            showOcrStatus(`${prefix}pobieranie modeli językowych…`, true);
          }
        }
      });
      ocrWorker = worker;
      return worker;
    } catch (err) {
      console.error('Błąd OCR worker:', err);
      showOcrStatus('Błąd OCR: ' + (err.message || err), false, 3500);
      ocrWorkerPromise = null;
      return null;
    }
  })();
  return ocrWorkerPromise;
}

function applyOcrToDiv(blocks, scale, div) {
  if (!div) return;
  const end = div.querySelector('.endOfContent');
  div.replaceChildren();

  // Zgodność wsteczna: obsłuż zarówno tablicę bloków, jak i płaską listę linii
  const normBlocks = (blocks && blocks.length && blocks[0].lines)
    ? blocks
    : [{ lines: blocks || [] }];

  const allItems = [];

  for (const block of normBlocks) {
    const blockEl = document.createElement('div');
    blockEl.className = 'ocr-block';

    for (const line of block.lines) {
      const txt = line.text?.trim();
      if (!txt) continue;

      const span = document.createElement('span');
      span.textContent = txt;

      span.style.left = `${(line.rx * 100).toFixed(4)}%`;
      span.style.top = `${(line.ry * 100).toFixed(4)}%`;
      span.style.transformOrigin = '0% 0%';
      span.style.whiteSpace = 'pre';
      span.style.color = 'transparent';
      span.style.lineHeight = '1';

      blockEl.appendChild(span);

      const br = document.createElement('br');
      blockEl.appendChild(br);

      allItems.push({ span, rw: line.rw, rh: line.rh });
    }

    div.appendChild(blockEl);
  }

  if (end) div.appendChild(end);

  // Dynamiczne rozciąganie scaleX, aby linia tekstu w 100% pokrywała skan od lewej do prawej
  const applyScaling = () => {
    if (!div.isConnected) {
      requestAnimationFrame(applyScaling);
      return;
    }
    const parent = div.parentElement || div;
    const pageW = parent.clientWidth || (window.innerWidth / 2);
    const pageH = parent.clientHeight || window.innerHeight;

    for (const it of allItems) {
      const hPx = Math.max(9, it.rh * pageH);
      it.span.style.fontSize = `${hPx.toFixed(2)}px`;
    }

    const naturalWidths = allItems.map(it => it.span.getBoundingClientRect().width);

    for (let i = 0; i < allItems.length; i++) {
      const nw = naturalWidths[i];
      const targetW = allItems[i].rw * pageW;
      if (nw > 0 && targetW > 0) {
        allItems[i].span.style.transform = `scaleX(${(targetW / nw).toFixed(4)})`;
      }
    }
  };

  requestAnimationFrame(applyScaling);
}

function getRawWords(data) {
  let words = [];
  if (data?.words && data.words.length) {
    words = data.words;
  } else if (data?.lines && data.lines.length) {
    for (const l of data.lines) {
      if (l.words && l.words.length) {
        words.push(...l.words);
      } else if (l.text && l.text.trim()) {
        const t = l.text.trim();
        const bbox = l.bbox || { x0: 0, y0: 0, x1: 100, y1: 20 };
        words.push({ text: t, bbox });
      }
    }
  }
  return words
    .filter(w => w && w.text && w.text.trim())
    .map(w => {
      const text = w.text.trim();
      const x0 = w.bbox ? w.bbox.x0 : 0;
      const x1 = w.bbox ? w.bbox.x1 : 0;
      const y0 = w.bbox ? w.bbox.y0 : 0;
      const y1 = w.bbox ? w.bbox.y1 : 0;
      return {
        text,
        x0, x1, y0, y1,
        w: Math.max(1, x1 - x0),
        h: Math.max(1, y1 - y0)
      };
    });
}

function wordsToSegments(rawWords, cw, ch) {
  if (!rawWords.length) return [];

  // Sortuj słowa pionowo według Y, a przy zbliżonym Y według X
  const sorted = [...rawWords].sort((a, b) => {
    const dy = a.y0 - b.y0;
    const minH = Math.min(a.h, b.h);
    if (Math.abs(dy) > minH * 0.45) return dy;
    return a.x0 - b.x0;
  });

  // Grupuj słowa leżące na tej samej wysokości w linie fizyczne
  const lines = [];
  let curLine = null;
  for (const w of sorted) {
    if (!curLine) {
      curLine = { words: [w], y0: w.y0, y1: w.y1, h: w.h };
      continue;
    }
    const dy = Math.abs(w.y0 - curLine.y0);
    const minH = Math.min(w.h, curLine.h);
    if (dy <= minH * 0.5) {
      curLine.words.push(w);
      curLine.y0 = Math.min(curLine.y0, w.y0);
      curLine.y1 = Math.max(curLine.y1, w.y1);
      curLine.h = curLine.y1 - curLine.y0;
    } else {
      lines.push(curLine);
      curLine = { words: [w], y0: w.y0, y1: w.y1, h: w.h };
    }
  }
  if (curLine) lines.push(curLine);

  // W każdej linii wykryj odstępy kolumnowe / marginesy i podziel na niezależne segmenty
  const segments = [];
  for (const l of lines) {
    const ws = l.words.sort((a, b) => a.x0 - b.x0);
    const gapThresh = Math.max(18, Math.min(cw * 0.025, l.h * 1.8));
    let seg = [ws[0]];

    for (let i = 1; i < ws.length; i++) {
      const prev = ws[i - 1];
      const curW = ws[i];
      if (curW.x0 - prev.x1 > gapThresh) {
        segments.push(seg);
        seg = [curW];
      } else {
        seg.push(curW);
      }
    }
    if (seg.length) segments.push(seg);
  }

  return segments.map(seg => {
    const x0 = seg[0].x0;
    const x1 = seg[seg.length - 1].x1;
    const y0 = Math.min(...seg.map(w => w.y0));
    const y1 = Math.max(...seg.map(w => w.y1));
    const text = seg.map(w => w.text).join(' ');
    const h = Math.max(1, y1 - y0);
    const w = Math.max(1, x1 - x0);
    return {
      text,
      x0, x1, y0, y1,
      w, h,
      rx: x0 / cw,
      ry: y0 / ch,
      rw: w / cw,
      rh: h / ch
    };
  });
}

function clusterSegmentsIntoBlocks(segments, cw) {
  if (!segments.length) return [];

  const sorted = [...segments].sort((a, b) => {
    const dy = a.y0 - b.y0;
    if (Math.abs(dy) > Math.min(a.h, b.h) * 0.4) return dy;
    return a.x0 - b.x0;
  });

  const blocks = [];
  const alignTol = Math.max(28, cw * 0.035);

  for (const seg of sorted) {
    let bestBlock = null;
    let minScore = Infinity;

    for (const b of blocks) {
      const last = b.lines[b.lines.length - 1];
      const gapY = seg.y0 - last.y1;
      const maxGapY = Math.max(last.h, seg.h) * 2.5;

      // Czy leży pod ostatnią linią w rozsądnym odstępie akapitu?
      if (gapY < -Math.min(last.h, seg.h) * 0.4 || gapY > maxGapY) continue;

      // Czy leży w tej samej kolumnie (nakładanie X lub wyrównanie lewej krawędzi)?
      const ovX = Math.min(last.x1, seg.x1) - Math.max(last.x0, seg.x0);
      const alignLeft = Math.abs(last.x0 - seg.x0);
      const sameCol = (ovX > 0) || (alignLeft < alignTol);
      if (!sameCol) continue;

      const bMinX = Math.min(...b.lines.map(l => l.x0));
      const bMaxX = Math.max(...b.lines.map(l => l.x1));
      const blockOvX = Math.min(bMaxX, seg.x1) - Math.max(bMinX, seg.x0);
      if (blockOvX < 0 && alignLeft >= alignTol) continue;

      const score = Math.abs(gapY) * 2 + alignLeft;
      if (score < minScore) {
        minScore = score;
        bestBlock = b;
      }
    }

    if (bestBlock) {
      bestBlock.lines.push(seg);
      bestBlock.y1 = Math.max(bestBlock.y1, seg.y1);
      bestBlock.x0 = Math.min(bestBlock.x0, seg.x0);
      bestBlock.x1 = Math.max(bestBlock.x1, seg.x1);
    } else {
      blocks.push({
        lines: [seg],
        x0: seg.x0, x1: seg.x1,
        y0: seg.y0, y1: seg.y1
      });
    }
  }

  // Sortowanie bloków w naturalnej kolejności czytania (kolumna lewa/margines przed prawą)
  blocks.sort((a, b) => {
    if (a.y1 <= b.y0 + 5) return -1;
    if (b.y1 <= a.y0 + 5) return 1;
    return a.x0 - b.x0;
  });

  return blocks;
}

async function runOcrForPage(n, scale, div) {
  if (!window.Tesseract) return;
  const k = `${fileKey || 'doc'}:ocr:${n}`;
  if (ocrCache.has(k)) {
    applyOcrToDiv(ocrCache.get(k), scale, div);
    return;
  }

  const token = ocrSessionToken;
  const myPdf = pdf;

  return enqueueOcr(async () => {
    // 1. Zabezpieczenie przed zmianą pliku w trakcie kolejkowania
    if (token !== ocrSessionToken || pdf !== myPdf) return;

    // 2. Zabezpieczenie przed niepotrzebnym przetwarzaniem stron, z których użytkownik już przewinął
    const [nowA, nowB] = spreadOf(start);
    if (n !== nowA && n !== nowB) return;

    if (ocrCache.has(k)) {
      applyOcrToDiv(ocrCache.get(k), scale, div);
      return;
    }

    let canvas = canvasCache.get(cacheKey(n, scale));
    if (!canvas) {
      try {
        canvas = await renderPage(n, scale);
      } catch (e) {
        return;
      }
    }
    if (!canvas || token !== ocrSessionToken) return;

    currentOcrPage = n;
    lastProgressPct = -1;
    showOcrStatus(`Strona ${n}: przygotowanie OCR…`, true);
    const worker = await getOcrWorker();
    if (!worker || token !== ocrSessionToken) return;

    try {
      const { data } = await worker.recognize(canvas);
      if (token !== ocrSessionToken) return;

      const rawWords = getRawWords(data);

      if (rawWords.length) {
        const cw = canvas.width || 1;
        const ch = canvas.height || 1;

        const lineItems = wordsToSegments(rawWords, cw, ch);
        const blocks = clusterSegmentsIntoBlocks(lineItems, cw);

        ocrCache.set(k, blocks);
        applyOcrToDiv(blocks, scale, div);

        const fullText = blocks.map(b => b.lines.map(l => l.text).join('\n')).join('\n\n');
        textCache.set(n, fullText || data.text || '');

        const [nowA, nowB] = spreadOf(start);
        if (n === nowA || n === nowB) {
          showOcrStatus(`Strona ${n}: rozpoznano ${lineItems.length} linii w ${blocks.length} blokach`, false, 2500);
        }
      } else {
        const [nowA, nowB] = spreadOf(start);
        if (n === nowA || n === nowB) {
          showOcrStatus(`Strona ${n}: nie wykryto tekstu`, false, 2500);
        }
      }
    } catch (err) {
      console.warn(`Błąd OCR strony ${n}:`, err);
      if (token === ocrSessionToken) {
        showOcrStatus(`Strona ${n}: błąd skanowania`, false, 3000);
      }
    } finally {
      if (currentOcrPage === n) currentOcrPage = null;
    }
  });
}

function forceOcrCurrent() {
  const [a, b] = spreadOf(start);
  const pages = [a, b].filter(Boolean);
  if (!pages.length) return;
  pages.forEach(n => ocrCache.delete(`${fileKey || 'doc'}:ocr:${n}`));
  showOcrStatus(`Rozpoczynam OCR dla: ${pages.map(p => 'strona ' + p).join(', ')}…`, true);
  const curScale = layoutSync(start)?.scale || 1;
  const wrappers = stage.querySelectorAll('.page');
  pages.forEach((n, idx) => {
    const wrapper = wrappers[idx];
    let div = wrapper?.querySelector('.textLayer');
    if (!div && wrapper) {
      div = document.createElement('div');
      div.className = 'textLayer';
      wrapper.append(div);
    }
    runOcrForPage(n, curScale, div);
  });
}

async function textLayerFor(n, scale) {
  const k = cacheKey(n, scale);
  const hit = tlCache.get(k);
  if (hit) return hit;
  const page = await pdf.getPage(n);
  const div = document.createElement('div');
  div.className = 'textLayer';

  const tc = await textContent(n);
  if (tc && tc.items && tc.items.length > 2) {
    const tl = new pdfjsLib.TextLayer({
      textContentSource: tc,
      container: div,
      viewport: page.getViewport({ scale })
    });
    await tl.render();
  } else {
    // Skan lub obraz bez tekstu -> uruchomienie OCR!
    runOcrForPage(n, scale, div);
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
  ocrCache.clear();
  textLayer.replaceChildren();
  pairing = localStorage.getItem('pairing:' + key) || localStorage.getItem('pairing') || 'odd';
  hint.hidden = true;
  hideOcrStatus();
  ocrSessionToken++;

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
  if (i < 0) { setEmpty(true); return; }
  let url = h.slice(i + 6);
  if (/^[a-z]+%3A/i.test(url)) url = decodeURIComponent(url);
  const pm = /#page=(\d+)/.exec(url);
  const clean = url.split('#')[0];
  setEmpty(false);
  flash('Ładowanie…', 0);
  let data;
  try {
    data = await loadViaExtension(clean);
  } catch (err) {
    setEmpty(true);
    flash(err.message === 'NOEXT'
      ? 'Brak wtyczki DarkPDF – wybierz plik ręcznie'
      : 'Nie udało się pobrać pliku: ' + err.message, 4000);
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

// ---------- pasek z przyciskami: pojawia się po kliknięciu / najechaniu ----------
const menu = document.getElementById('menu');
const pinBtn = menu.querySelector('.menu-pin');
const pageInput = menu.querySelector('.page-input');
const totalSpan = menu.querySelector('.total');
const tipEl = document.getElementById('menu-tip');

let pinned = localStorage.getItem('menuPinned') === '1';
let menuTimer = null;
let tipTimer = null;

function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) {
    tipEl.classList.remove('show');
    tipEl.hidden = true;
  }
}

function showTipFor(el) {
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    if (!el || !tipEl || menu.hidden) return;
    const text = el.dataset.tip;
    const key = el.dataset.key;
    if (!text) return;
    tipEl.innerHTML = `${text}${key ? ` <span class="tip-k">${key}</span>` : ''}`;
    tipEl.hidden = false;

    const rect = el.getBoundingClientRect();
    const tipRect = tipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2;
    let top = rect.top - tipRect.height - 8;
    if (top < 6) top = rect.bottom + 8;
    left = Math.max(tipRect.width / 2 + 8, Math.min(window.innerWidth - tipRect.width / 2 - 8, left));

    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
    tipEl.classList.add('show');
  }, 100);
}

// Rozwijanie paska opcji po najechaniu na dymek ze stroną (100ms)
let expandTimer = null;
let collapseTimer = null;

function expandMenu() {
  clearTimeout(collapseTimer);
  menu.classList.add('expanded');
}

function collapseMenu() {
  clearTimeout(expandTimer);
  menu.classList.remove('expanded');
  hideTip();
}

menu.addEventListener('mouseenter', () => {
  clearTimeout(collapseTimer);
  clearTimeout(menuTimer);
  expandTimer = setTimeout(expandMenu, 100);
});

menu.addEventListener('mouseleave', () => {
  clearTimeout(expandTimer);
  collapseTimer = setTimeout(() => {
    if (document.activeElement !== pageInput) {
      collapseMenu();
    }
    if (!pinned && !menu.hidden && document.activeElement !== pageInput) {
      clearTimeout(menuTimer);
      menuTimer = setTimeout(hideMenu, 2500);
    }
  }, 150);
});

// Podpowiedzi do przycisków w menu
menu.addEventListener('pointerover', (e) => {
  const target = e.target.closest('[data-tip]');
  if (target) showTipFor(target);
});

menu.addEventListener('pointerout', (e) => {
  const target = e.target.closest('[data-tip]');
  if (target) hideTip();
});

// Odsłanianie dymka przy najechaniu na dół ekranu (100ms)
let hoverMenuTimer = null;
window.addEventListener('mousemove', (e) => {
  if (!pdf) return;
  if (e.clientY >= window.innerHeight - 30) {
    if (menu.hidden && !hoverMenuTimer) {
      hoverMenuTimer = setTimeout(() => {
        showMenu();
        hoverMenuTimer = null;
      }, 100);
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

// Obsługa ręcznego wpisywania numeru strony
let pageJumpTimer = null;
let digitTriggeredFocus = false;

function schedulePageJump() {
  clearTimeout(pageJumpTimer);
  const val = parseInt(pageInput.value, 10);
  if (val >= 1 && val <= numPages) {
    pageJumpTimer = setTimeout(() => {
      pageJumpTimer = null;
      if (spreadStartOf(val) !== start) {
        go(spreadStartOf(val));
      }
      if (document.activeElement === pageInput) {
        pageInput.blur();
      }
    }, 1000);
  }
}

pageInput.addEventListener('focus', () => {
  clearTimeout(menuTimer);
  clearTimeout(collapseTimer);
  if (digitTriggeredFocus) {
    digitTriggeredFocus = false;
    return;
  }
  setTimeout(() => {
    if (document.activeElement === pageInput) pageInput.select();
  }, 10);
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

pageInput.addEventListener('click', (e) => e.stopPropagation());
pageInput.addEventListener('mousedown', (e) => e.stopPropagation());
pageInput.addEventListener('pointerdown', (e) => e.stopPropagation());
pageInput.addEventListener('keyup', (e) => e.stopPropagation());
pageInput.addEventListener('input', (e) => {
  e.stopPropagation();
  schedulePageJump();
});

const pageSelect = menu.querySelector('.page-select');
pageSelect?.addEventListener('click', (e) => {
  e.stopPropagation();
  pageInput.focus();
});
pageSelect?.addEventListener('mousedown', (e) => e.stopPropagation());
pageSelect?.addEventListener('pointerdown', (e) => e.stopPropagation());

function act(k) {
  switch (k) {
    case 'prev': prev(); break;
    case 'next': next(); break;
    case 'open': pickFile(); break;
    case 'ocr': forceOcrCurrent(); break;
    case 'pin':
      pinned = !pinned;
      localStorage.setItem('menuPinned', pinned ? '1' : '0');
      updateMenu();
      if (pinned) {
        clearTimeout(menuTimer);
        flash('Dymek strony zablokowany (na stałe)', 1200);
      } else {
        if (!menu.matches(':hover')) {
          menuTimer = setTimeout(hideMenu, 2500);
        }
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
  if (String(getSelection())) return;      // nie przeszkadzamy przy zaznaczaniu tekstu
  collapseMenu();
  if (pinned) return;                      // zablokowany dymek nie znika po kliknięciu
  menu.hidden ? showMenu() : hideMenu();
});

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

  hideMenu();
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

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (document.activeElement === pageInput) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); pickFile(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;

  // Skok do strony: wpisanie cyfry przenosi bezpośrednio do pola tekstowego strony
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
    case 'd': case 'D': act('dark'); break;
    case 't': case 'T': act('theme'); break;
    case 'p': case 'P': act('pages'); break;
    case 'o': case 'O': act('pairing'); break;
    case 'f': case 'F': act('full'); break;
    case 'x': case 'X': act('ocr'); break;
    case '?':
      flash('→ ↓ Spacja PgDn  następne\n← ↑ PgUp  poprzednie\nHome / End  początek / koniec\n' +
            'numer + Enter  skok do strony\nCtrl+O  otwórz plik z dysku\nP  jedna / dwie strony\nD  tryb ciemny\nT  motyw zwykły / Gemini\nO  pary nieparzyste / parzyste\nF  pełny ekran\nX  rozpoznaj tekst (OCR)\nkliknięcie  pasek z przyciskami', 5000);
      break;
    default:
      return;
  }
  e.preventDefault();
});

// Zmiana rozmiaru okna: strony skalują się od razu przez CSS,
// a ostre przerysowanie idzie dopiero, gdy przestaniesz ciągnąć.
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
