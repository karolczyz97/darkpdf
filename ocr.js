// ocr.js - Silnik rozpoznawania tekstu OCR z podziałem na kolumny i marginesy
export const ocrCache = new Map();

let ocrWorker = null;
let ocrWorkerPromise = null;
let ocrQueue = Promise.resolve();
let ocrTimer = null;
let currentOcrPage = null;
let lastProgressPct = -1;

const ocrStatusEl = document.getElementById('ocr-status');
const ocrSpinnerEl = ocrStatusEl?.querySelector('.spinner');
const ocrTextEl = ocrStatusEl?.querySelector('.text');

export function showOcrStatus(text, spinning = true, hideAfterMs = 0) {
  if (!ocrStatusEl) return;
  clearTimeout(ocrTimer);
  if (ocrSpinnerEl) ocrSpinnerEl.hidden = !spinning;
  if (ocrTextEl) ocrTextEl.textContent = text;
  ocrStatusEl.hidden = false;
  if (hideAfterMs > 0) {
    ocrTimer = setTimeout(() => { ocrStatusEl.hidden = true; }, hideAfterMs);
  }
}

export function hideOcrStatus() {
  if (!ocrStatusEl) return;
  clearTimeout(ocrTimer);
  ocrStatusEl.hidden = true;
}

export function enqueueOcr(fn) {
  const next = ocrQueue.then(fn, fn);
  ocrQueue = next.catch(() => {});
  return next;
}

export async function getOcrWorker() {
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

export function applyOcrToDiv(blocks, scale, div) {
  if (!div) return;
  const end = div.querySelector('.endOfContent');
  div.replaceChildren();

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
      blockEl.appendChild(document.createElement('br'));
      allItems.push({ span, rw: line.rw, rh: line.rh });
    }
    div.appendChild(blockEl);
  }

  if (end) div.appendChild(end);

  const applyScaling = () => {
    if (!div.isConnected) {
      requestAnimationFrame(applyScaling);
      return;
    }
    const parent = div.parentElement || div;
    const pageW = parent.clientWidth || (window.innerWidth / 2);
    const pageH = parent.clientHeight || window.innerHeight;

    for (const it of allItems) {
      it.span.style.fontSize = `${Math.max(9, it.rh * pageH).toFixed(2)}px`;
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

export function getRawWords(data) {
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

export function wordsToSegments(rawWords, cw, ch) {
  if (!rawWords.length) return [];

  const sorted = [...rawWords].sort((a, b) => {
    const dy = a.y0 - b.y0;
    const minH = Math.min(a.h, b.h);
    return Math.abs(dy) > minH * 0.45 ? dy : a.x0 - b.x0;
  });

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

  const segments = [];
  for (const l of lines) {
    const ws = l.words.sort((a, b) => a.x0 - b.x0);
    const gapThresh = Math.max(18, Math.min(cw * 0.025, l.h * 1.8));
    let seg = [ws[0]];

    for (let i = 1; i < ws.length; i++) {
      if (ws[i].x0 - ws[i - 1].x1 > gapThresh) {
        segments.push(seg);
        seg = [ws[i]];
      } else {
        seg.push(ws[i]);
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
      text, x0, x1, y0, y1, w, h,
      rx: x0 / cw, ry: y0 / ch,
      rw: w / cw, rh: h / ch
    };
  });
}

export function clusterSegmentsIntoBlocks(segments, cw) {
  if (!segments.length) return [];

  const sorted = [...segments].sort((a, b) => {
    const dy = a.y0 - b.y0;
    return Math.abs(dy) > Math.min(a.h, b.h) * 0.4 ? dy : a.x0 - b.x0;
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

      if (gapY < -Math.min(last.h, seg.h) * 0.4 || gapY > maxGapY) continue;

      const ovX = Math.min(last.x1, seg.x1) - Math.max(last.x0, seg.x0);
      const alignLeft = Math.abs(last.x0 - seg.x0);
      if (ovX <= 0 && alignLeft >= alignTol) continue;

      const bMinX = Math.min(...b.lines.map(l => l.x0));
      const bMaxX = Math.max(...b.lines.map(l => l.x1));
      if (Math.min(bMaxX, seg.x1) - Math.max(bMinX, seg.x0) < 0 && alignLeft >= alignTol) continue;

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

  blocks.sort((a, b) => {
    if (a.y1 <= b.y0 + 5) return -1;
    if (b.y1 <= a.y0 + 5) return 1;
    return a.x0 - b.x0;
  });

  return blocks;
}

let app = null;
export function setOcrContext(ctx) {
  app = ctx;
}

export async function runOcrForPage(n, scale, div) {
  if (!window.Tesseract || !app) return;
  const k = `${app.getFileKey() || 'doc'}:ocr:${n}`;
  if (ocrCache.has(k)) {
    applyOcrToDiv(ocrCache.get(k), scale, div);
    return;
  }

  const token = app.getSessionToken();
  const myPdf = app.getPdf();

  return enqueueOcr(async () => {
    if (token !== app.getSessionToken() || app.getPdf() !== myPdf) return;
    const [nowA, nowB] = app.getCurrentSpread();
    if (n !== nowA && n !== nowB) return;

    if (ocrCache.has(k)) {
      applyOcrToDiv(ocrCache.get(k), scale, div);
      return;
    }

    let canvas = app.getCanvas(n, scale);
    if (!canvas) {
      try {
        canvas = await app.renderPage(n, scale);
      } catch {
        return;
      }
    }
    if (!canvas || token !== app.getSessionToken()) return;

    currentOcrPage = n;
    lastProgressPct = -1;
    showOcrStatus(`Strona ${n}: przygotowanie OCR…`, true);
    const worker = await getOcrWorker();
    if (!worker || token !== app.getSessionToken()) return;

    try {
      const { data } = await worker.recognize(canvas);
      if (token !== app.getSessionToken()) return;

      const rawWords = getRawWords(data);
      if (rawWords.length) {
        const cw = canvas.width || 1, ch = canvas.height || 1;
        const lineItems = wordsToSegments(rawWords, cw, ch);
        const blocks = clusterSegmentsIntoBlocks(lineItems, cw);

        ocrCache.set(k, blocks);
        applyOcrToDiv(blocks, scale, div);

        const fullText = blocks.map(b => b.lines.map(l => l.text).join('\n')).join('\n\n');
        app.setTextCache(n, fullText || data.text || '');

        const [cA, cB] = app.getCurrentSpread();
        if (n === cA || n === cB) {
          showOcrStatus(`Strona ${n}: rozpoznano ${lineItems.length} linii w ${blocks.length} blokach`, false, 2500);
        }
      } else {
        const [cA, cB] = app.getCurrentSpread();
        if (n === cA || n === cB) {
          showOcrStatus(`Strona ${n}: nie wykryto tekstu`, false, 2500);
        }
      }
    } catch (err) {
      console.warn(`Błąd OCR strony ${n}:`, err);
      if (token === app.getSessionToken()) {
        showOcrStatus(`Strona ${n}: błąd skanowania`, false, 3000);
      }
    } finally {
      if (currentOcrPage === n) currentOcrPage = null;
    }
  });
}

export function forceOcrCurrent() {
  if (!app) return;
  const [a, b] = app.getCurrentSpread();
  const pages = [a, b].filter(Boolean);
  if (!pages.length) return;

  const key = app.getFileKey() || 'doc';
  pages.forEach(n => ocrCache.delete(`${key}:ocr:${n}`));
  showOcrStatus(`Rozpoczynam OCR dla: ${pages.map(p => 'strona ' + p).join(', ')}…`, true);

  const curScale = app.getScale() || 1;
  const wrappers = app.getPageWrappers();
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
