// calc-panel.js – panel boczny kalkulatora w DarkPDF (rozmiar, rozdzielacz, montowanie komponentu DOM)

import { mountCalculator } from '../calc/calc-app.js?v=4';   // jedno źródło: repo calc

export const CALC_MIN_W = 320;         // najwęższy sensowny kalkulator
export const PDF_MIN_W = 400;          // tyle miejsca zostawiamy zawsze na PDF (żeby tekst był czytelny)

export const clampCalcW = (w) => {
  const max = Math.max(CALC_MIN_W, window.innerWidth - PDF_MIN_W - 9);
  return Math.max(CALC_MIN_W, Math.min(max, Math.round(w)));
};

let ctx = null;
let calcOpen = false;
let calcWidth = 440;
let userCustomWidth = false;
let fixedW = null;                    // tryb szerokości: kalkulator stoi w miejscu, PDF bierze resztę
let userCalcW = null;                 // szerokość z rozdzielacza (bez przycinania do okna – żeby nie „zjadało” jej zwężanie)
let autoCollapsed = false;
let lastNarrow = false;               // czy przy poprzednim sprawdzeniu okno było „mobilne”

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
      onClose: () => setCalcOpen(false, true),
      onFlash: (text, ms) => ctx?.flash?.(text, ms)
    });
  }
}

export function isCalcOpen() { return calcOpen; }
export function getCalcWidth() { return calcWidth; }
export function getCalcStageWidth() {
  return (calcOpen && !ctx?.isMobile?.()) ? (calcWidth + 9) : 0;
}
export function resetUserCustomWidth() { userCustomWidth = false; userCalcW = null; }
export function isUserCustomWidth() { return userCustomWidth; }

export function updateCalcWidth(w) {
  calcWidth = clampCalcW(w);
  document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
  ctx.pref.set('calcWidth', calcWidth);
}

export function getNeededPdfWidth() {
  if (!ctx?.isPdfLoaded?.()) return null;
  const [a, b] = ctx.spreadOf(ctx.getStartPage());
  // ref = wspólne przycięcie grupy; strona-wyjątek (pełnoekranowy obrazek) nie zmienia szerokości panelu
  const ref = (s) => s?.ref || s;
  const sa = a ? ref(ctx.getPageSize(a)) : null;
  const sb = b ? ref(ctx.getPageSize(b)) : null;
  if (!sa && !sb) return null;

  const H = Math.max(120, window.innerHeight - 2 * ctx.MARGIN);
  if (!ctx.showTwo()) {
    const size = sa || sb;
    if (!size || !size.h || !size.w) return null;
    const scaleH = H / size.h;
    const w = Math.ceil(size.w * scaleH);
    return w + 2 * ctx.MARGIN + 4;
  } else {
    const L = sa || sb, R = sb || sa;
    if (!L || !L.h || !L.w) return null;
    const maxH = Math.max(L.h, R?.h || L.h);
    const scaleH = H / maxH;
    // Zawsze dwie strony + odstęp: samotna strona (okładka, ostatnia) ma obok pusty placeholder, tak jak w fit()
    const totalPagesW = Math.ceil(L.w * scaleH) + Math.ceil(R.w * scaleH) + ctx.GAP;
    return totalPagesW + 2 * ctx.MARGIN + 4;
  }
}

export async function snapCalcToHeightFit() {
  resetUserCustomWidth();
  handleCalcResize();
  ctx?.fitNow?.();
}

export function setCalcOpen(open, fromUser = false) {
  if (fromUser) {
    autoCollapsed = false;
    lastNarrow = Boolean(ctx?.isMobile?.());
  }
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

export function toggleCalc(fromUser = true) {
  setCalcOpen(!calcOpen, fromUser);
}

// Ręczna szerokość z rozdzielacza zostaje (przewijanie, zmiana okna) aż do H – wtedy resetUserCustomWidth().
export function handleCalcResize() {
  const narrow = Boolean(ctx?.isMobile?.());
  const wasNarrow = lastNarrow;
  lastNarrow = narrow;

  // Zwijanie/przywracanie po tym samym warunku co klasa .mobile – bez rozjazdu przy 800 px
  if (calcOpen && !autoCollapsed && !wasNarrow && narrow) {
    autoCollapsed = true;
    setCalcOpen(false, false);
    return;
  }
  if (!calcOpen && autoCollapsed && wasNarrow && !narrow) {
    autoCollapsed = false;
    setCalcOpen(true, false);
    return;
  }

  if (!calcOpen || narrow) return;
  let w = userCalcW ?? calcWidth;
  if (!userCustomWidth && ctx.getFitMode() === 'width') {
    // Szerokość 100%: nie dopasowujemy kalkulatora do strony – zostaje tak szeroki, jak był,
    // a przy zmianie okna zmienia się tylko PDF
    if (fixedW == null) fixedW = calcWidth;
    w = fixedW;
  } else if (!userCustomWidth) {
    fixedW = null;
    const neededW = getNeededPdfWidth();
    if (neededW != null) w = window.innerWidth - neededW - 9;
  }
  calcWidth = clampCalcW(w);
  document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
}

export function initCalcPanel(context) {
  ctx = context;
  lastNarrow = Boolean(ctx.isMobile());
  calcWidth = clampCalcW(ctx.pref.get('calcWidth', 440));

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
      userCalcW = calcWidth;
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

  document.getElementById('calc-close')?.addEventListener('click', () => setCalcOpen(false, true));
}
