// calc-panel.js – panel boczny kalkulatora w DarkPDF (rozmiar, rozdzielacz, montowanie komponentu DOM)

import { mountCalculator } from '../calc/calc-app.js?v=3';   // jedno źródło: repo calc

export const CALC_MIN_W = 320;         // najwęższy sensowny kalkulator
export const PDF_MIN_W = 140;          // tyle miejsca zostawiamy zawsze na PDF

export const clampCalcW = (w) => {
  const max = Math.max(CALC_MIN_W, window.innerWidth - PDF_MIN_W);
  return Math.max(CALC_MIN_W, Math.min(max, Math.round(w)));
};

let ctx = null;
let calcOpen = false;
let calcWidth = 440;
let targetPdfWidth = null;
let userCustomWidth = false;

let calcSidebar = null;
let calcContainer = null;
let calcResizer = null;
let calcInstance = null;

// KaTeX (ładne wzory w drugiej linii) ładujemy dopiero przy pierwszym otwarciu kalkulatora,
// żeby nie spowalniał otwierania samego PDF-a
const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';
function loadKatex() {
  if (window.katex || document.getElementById('katex-js')) return;
  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: KATEX + 'katex.min.css', crossOrigin: 'anonymous' });
  const js = Object.assign(document.createElement('script'), { id: 'katex-js', src: KATEX + 'katex.min.js', crossOrigin: 'anonymous', defer: true });
  js.onload = () => window.onKatexLoaded?.();
  document.head.append(css, js);
}

function ensureCalcMounted() {
  loadKatex();
  if (!calcInstance && calcContainer) {
    calcInstance = mountCalculator(calcContainer, {
      isEmbedded: true,
      onClose: () => setCalcOpen(false),
      onFlash: (text, ms) => ctx?.flash?.(text, ms)
    });
  }
}

export function isCalcOpen() { return calcOpen; }
export function getCalcWidth() { return calcWidth; }
export function getCalcStageWidth() {
  return (calcOpen && !ctx?.isMobile?.()) ? (calcWidth + 9) : 0;
}
export function resetUserCustomWidth() { userCustomWidth = false; }
export function isUserCustomWidth() { return userCustomWidth; }

export function updateCalcWidth(w, updateTargetPdf = true) {
  calcWidth = clampCalcW(w);
  document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
  ctx.pref.set('calcWidth', calcWidth);
  if (updateTargetPdf) {
    targetPdfWidth = Math.max(PDF_MIN_W, window.innerWidth - (calcWidth + 9));
  }
}

export function getNeededPdfWidth() {
  if (!ctx?.isPdfLoaded?.()) return null;
  const [a, b] = ctx.spreadOf(ctx.getStartPage());
  const sa = a ? ctx.getPageSize(a) : null;
  const sb = b ? ctx.getPageSize(b) : null;
  if (!sa && !sb) return null;

  const H = Math.max(120, window.innerHeight - 2 * ctx.MARGIN);
  if (!ctx.showTwo()) {
    const size = sa || sb;
    const scaleH = H / size.h;
    const w = Math.ceil(size.w * scaleH);
    return w + 2 * ctx.MARGIN + 4;
  } else {
    const L = sa || sb, R = sb || sa;
    const maxH = Math.max(L.h, R.h);
    const scaleH = H / maxH;
    const hasBoth = Boolean(sa && sb);
    const totalPagesW = hasBoth
      ? (Math.ceil(L.w * scaleH) + Math.ceil(R.w * scaleH) + ctx.GAP)
      : Math.ceil(L.w * scaleH);
    return totalPagesW + 2 * ctx.MARGIN + 4;
  }
}

export async function getOptimalCalcWidthForHeightFit() {
  const neededW = getNeededPdfWidth();
  if (neededW == null) return null;
  return clampCalcW(window.innerWidth - neededW - 9);
}

export async function snapCalcToHeightFit() {
  handleCalcResize();
  ctx?.fitNow?.();
}

export function setCalcOpen(open) {
  if (open && !ctx?.isPdfLoaded?.()) return;
  calcOpen = !!open;
  ctx.pref.set('calcOpen', calcOpen);
  document.documentElement.classList.add('calc-animating');
  setTimeout(() => document.documentElement.classList.remove('calc-animating'), 250);
  document.documentElement.classList.toggle('calc-open', calcOpen);

  if (calcOpen) {
    handleCalcResize();
    ensureCalcMounted();
    setTimeout(() => calcInstance?.focus(), 50);
  }
  window.focus();
  ctx.updateMenu();
  if (ctx.isPdfLoaded()) {
    ctx.fitNow();
    ctx.rerenderSoon();
  }
}

export function toggleCalc() {
  setCalcOpen(!calcOpen);
}

export function handleCalcResize() {
  if (!calcOpen || ctx?.isMobile?.()) return;

  const neededW = getNeededPdfWidth();
  if (neededW != null) {
    const desiredCalcW = window.innerWidth - neededW - 9;
    calcWidth = clampCalcW(desiredCalcW);
    document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
  }
}

export function initCalcPanel(context) {
  ctx = context;
  calcWidth = clampCalcW(ctx.pref.get('calcWidth', 440));
  targetPdfWidth = null;

  calcSidebar = document.getElementById('calc-sidebar');
  calcContainer = document.getElementById('calc-container');
  calcResizer = document.getElementById('calc-resizer');

  document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');

  if (calcResizer) {
    let startX = 0, initialW = 0, isDragging = false;
    calcResizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      startX = e.clientX;
      initialW = calcWidth;
      calcResizer.classList.add('dragging');
      calcSidebar.style.transition = 'none';
      ctx.stage.style.transition = 'none';
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
      if (calcContainer) calcContainer.style.pointerEvents = 'none';
      try { calcResizer.setPointerCapture(e.pointerId); } catch {}
      isDragging = true;
    });

    const onPointerMove = (ev) => {
      if (!isDragging) return;
      userCustomWidth = true;
      const delta = ev.clientX - startX;
      updateCalcWidth(initialW + delta, true);
      ctx.fitNow();
    };

    const onPointerUp = (ev) => {
      if (!isDragging) return;
      isDragging = false;
      calcResizer.classList.remove('dragging');
      calcSidebar.style.transition = '';
      ctx.stage.style.transition = '';
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (calcContainer) calcContainer.style.pointerEvents = '';
      try { calcResizer.releasePointerCapture(ev.pointerId); } catch {}
      ctx.fitNow();
      ctx.rerenderSoon();
    };

    calcResizer.addEventListener('pointermove', onPointerMove);
    calcResizer.addEventListener('pointerup', onPointerUp);
    calcResizer.addEventListener('pointercancel', onPointerUp);
  }

  document.getElementById('calc-close')?.addEventListener('click', () => setCalcOpen(false));
}
