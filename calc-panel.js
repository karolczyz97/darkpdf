// calc-panel.js – panel boczny kalkulatora w DarkPDF (rozmiar, rozdzielacz, montowanie komponentu DOM)

import { mountCalculator } from '../calc/calc-app.js?v=3';   // jedno źródło: repo calc

export const CALC_MIN_W = 320;         // najwęższy sensowny kalkulator
export const PDF_MIN_W = 140;          // tyle miejsca zostawiamy zawsze na PDF

// Maksymalna szerokość kalkulatora: 720 px (mieści 2 kolumny) i max 45% szerokości okna
export const getMaxCalcW = () => Math.max(CALC_MIN_W, Math.min(720, Math.floor(window.innerWidth * 0.45)));

export const clampCalcW = (w) => {
  const max = Math.max(CALC_MIN_W, Math.min(window.innerWidth - PDF_MIN_W, getMaxCalcW()));
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

export async function getOptimalCalcWidthForHeightFit() {
  if (!ctx.isPdfLoaded()) return null;
  const [a, b] = ctx.spreadOf(ctx.getStartPage());
  let sa = a ? ctx.getPageSize(a) : null;
  let sb = b ? ctx.getPageSize(b) : null;
  if (a && !sa) {
    try { sa = await ctx.getPageBox(a); if (sa) ctx.setPageSize(a, sa); } catch {}
  }
  if (b && !sb) {
    try { sb = await ctx.getPageBox(b); if (sb) ctx.setPageSize(b, sb); } catch {}
  }
  if (!sa && !sb) return null;

  const H = Math.max(120, window.innerHeight - 2 * ctx.MARGIN);
  let neededPdfWidth;

  if (!ctx.showTwo()) {
    const size = sa || sb;
    const scaleH = H / size.h;
    const w = Math.floor(size.w * scaleH);
    neededPdfWidth = w + 2 * ctx.MARGIN + 4;
  } else {
    const L = sa || sb, R = sb || sa;
    const maxH = Math.max(L.h, R.h);
    const scaleH = H / maxH;
    const hasBoth = Boolean(sa && sb);
    const totalPagesW = hasBoth
      ? (Math.floor(L.w * scaleH) + Math.floor(R.w * scaleH) + ctx.GAP)
      : Math.floor(L.w * scaleH);
    neededPdfWidth = totalPagesW + 2 * ctx.MARGIN + 4;
  }

  const desiredCalcW = window.innerWidth - neededPdfWidth - 9;
  if (desiredCalcW < CALC_MIN_W) return null;
  return clampCalcW(desiredCalcW);
}

export async function snapCalcToHeightFit(announce = false) {
  if (!calcOpen || !ctx.isPdfLoaded()) return;
  const optimalW = await getOptimalCalcWidthForHeightFit();
  if (optimalW != null) {
    updateCalcWidth(optimalW, true);
    ctx.fitNow();
  } else if (announce) {
    ctx.flash('Strona w 100% wysokości nie zmieści się obok kalkulatora – szerokość bez zmian', 2500);
  }
}

export function setCalcOpen(open) {
  if (open && !ctx.isPdfLoaded()) return;
  calcOpen = !!open;
  ctx.pref.set('calcOpen', calcOpen);
  document.documentElement.classList.add('calc-animating');
  setTimeout(() => document.documentElement.classList.remove('calc-animating'), 250);
  document.documentElement.classList.toggle('calc-open', calcOpen);

  if (calcOpen) {
    if (ctx.getFitMode() === 'height' && !userCustomWidth) {
      snapCalcToHeightFit();
    } else {
      targetPdfWidth = Math.max(PDF_MIN_W, window.innerWidth - (calcWidth + 9));
      updateCalcWidth(calcWidth, false);
    }
    ensureCalcMounted();
    setTimeout(() => calcInstance?.focus(), 50);
  }
  window.focus();
  ctx.updateMenu();
  ctx.fitNow();
  ctx.rerenderSoon();
}

export function toggleCalc() {
  setCalcOpen(!calcOpen);
}

let lastWindowHeight = typeof window !== 'undefined' ? window.innerHeight : 0;

export function handleCalcResize() {
  if (!calcOpen || ctx?.isMobile?.()) return;

  const currentH = window.innerHeight;
  const heightChanged = Math.abs(currentH - lastWindowHeight) > 1;
  lastWindowHeight = currentH;

  // Gdy zmienia się wysokość okna w trybie 100% wysokości bez ręcznie ustalonej szerokości,
  // dopasowujemy kalkulator do nowej wysokości strony:
  if (heightChanged && ctx.getFitMode() === 'height' && !userCustomWidth) {
    snapCalcToHeightFit();
    return;
  }

  // Przy zmianie szerokości okna: karta z PDF-em zachowuje stałą szerokość,
  // a kalkulator rozciąga się lub kurczy absorbując zmianę szerokości:
  if (!targetPdfWidth) {
    targetPdfWidth = Math.max(PDF_MIN_W, window.innerWidth - (calcWidth + 9));
  }

  const rawDesired = window.innerWidth - targetPdfWidth - 9;
  const clampedW = clampCalcW(rawDesired);

  // Jeśli uderzyliśmy w limit min/max kalkulatora, synchronizujemy targetPdfWidth
  // z realną przestrzenią pozostałą dla PDF-a, zapobiegając blokowaniu przy zmianie kierunku resize:
  if (clampedW !== rawDesired) {
    calcWidth = clampedW;
    document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
    ctx.pref.set('calcWidth', calcWidth);
    targetPdfWidth = Math.max(PDF_MIN_W, window.innerWidth - (calcWidth + 9));
  } else {
    updateCalcWidth(rawDesired, false);
  }
}

export function initCalcPanel(context) {
  ctx = context;
  calcWidth = clampCalcW(ctx.pref.get('calcWidth', 440));
  targetPdfWidth = Math.max(PDF_MIN_W, window.innerWidth - (calcWidth + 9));

  calcSidebar = document.getElementById('calc-sidebar');
  calcContainer = document.getElementById('calc-container');
  calcResizer = document.getElementById('calc-resizer');

  lastWindowHeight = window.innerHeight;
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
