// calc-panel.js – panel boczny kalkulatora w DarkPDF (rozmiar, rozdzielacz, montowanie komponentu DOM)

import { mountCalculator } from '../calc/calc-app.js';   // jedno źródło: repo calc
import { heightFitWidth } from './layout.js';

const CALC_MIN_W = 320;         // najwęższy sensowny kalkulator
const PDF_MIN_W = 400;          // tyle miejsca zostawiamy zawsze na PDF (żeby tekst był czytelny)
const RESIZER_W = 9;            // szerokość rozdzielacza – ta sama co --resizer-w w viewer.css

const clampCalcW = (w) => {
  const max = Math.max(CALC_MIN_W, window.innerWidth - PDF_MIN_W - RESIZER_W);
  return Math.max(CALC_MIN_W, Math.min(max, Math.round(w)));
};

let ctx = null;                       // stan i funkcje czytnika z initCalcPanel()
let calcOpen = false;
let calcWidth = 440;
let userCalcW = null;                 // szerokość z rozdzielacza (bez przycinania do okna – żeby nie „zjadało” jej zwężanie)
let fixedW = null;                    // tryb szerokości: kalkulator stoi w miejscu, PDF bierze resztę
let autoCollapsed = false;
let lastNarrow = false;               // czy przy poprzednim sprawdzeniu okno było „mobilne”
let sidebar = null;
let calcContainer = null;
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
  calcInstance ??= mountCalculator(calcContainer, {
    isEmbedded: true,
    onClose: () => setCalcOpen(false, true),
    onFlash: ctx.flash
  });
}

// Szerokość panelu na stronie: zapis do zmiennej CSS (panel, rozdzielacz, przesunięcie PDF-a)
function applyCalcWidth(w) {
  calcWidth = clampCalcW(w);
  document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
}

export const isCalcOpen = () => calcOpen;
export const getCalcStageWidth = () => (calcOpen && !ctx.isMobile() ? calcWidth + RESIZER_W : 0);
export const isUserCustomWidth = () => userCalcW !== null;
export function resetUserCustomWidth() { userCalcW = null; }

// Ile miejsca potrzebuje PDF dopasowany do wysokości okna (px) albo null, gdy strony jeszcze nie znamy
function neededPdfWidth() {
  if (!ctx.isPdfLoaded()) return null;
  const [a, b] = ctx.spreadOf(ctx.getStartPage());
  // ref = wspólne przycięcie grupy; strona-wyjątek (pełnoekranowy obrazek) nie zmienia szerokości panelu
  const ref = (s) => s?.ref || s;
  const sa = a ? ref(ctx.getPageSize(a)) : null;
  const sb = b ? ref(ctx.getPageSize(b)) : null;
  const H = Math.max(120, window.innerHeight - 2 * ctx.MARGIN);
  const w = heightFitWidth(sa, sb, { H, two: ctx.showTwo(), gap: ctx.GAP });
  return w == null ? null : w + 2 * ctx.MARGIN;   // boki i dół mają ten sam odstęp
}

export function snapCalcToHeightFit() {
  resetUserCustomWidth();
  handleCalcResize();
  ctx.fitNow();
}

export function setCalcOpen(open, fromUser = false) {
  if (fromUser) {
    autoCollapsed = false;
    lastNarrow = ctx.isMobile();
  }
  if (open && !ctx.isPdfLoaded()) return;
  calcOpen = !!open;
  ctx.pref.set('calcOpen', calcOpen);
  // Schowany panel tylko odjeżdża w bok: bez tego fokus zostałby w jego polu (Esc zamyka kalkulator,
  // a strzałki dalej nie przewracają stron), a Tab wchodziłby w niewidoczne przyciski
  sidebar.inert = !calcOpen;
  if (!calcOpen && sidebar.contains(document.activeElement)) document.activeElement.blur();
  document.documentElement.classList.add('calc-animating');
  setTimeout(() => document.documentElement.classList.remove('calc-animating'), 250);
  document.documentElement.classList.toggle('calc-open', calcOpen);

  if (calcOpen) {
    handleCalcResize();
    ensureCalcMounted();
    // Fokus tylko po otwarciu przez użytkownika (K, przycisk) i tylko z myszą. Kalkulator otwarty sam
    // (zapamiętany przy wczytaniu pliku) nie zabiera klawiszy czytnikowi, a na dotyku klawiatura
    // ekranowa nie zasłania jego przycisków.
    if (fromUser && matchMedia('(pointer: fine)').matches) setTimeout(() => calcInstance.focus(), 50);
  }
  ctx.updateMenu();
  if (ctx.isPdfLoaded()) {
    ctx.fitNow();
    ctx.rerenderSoon();
  }
}

export function toggleCalc() {
  setCalcOpen(!calcOpen, true);
}

// Ręczna szerokość z rozdzielacza zostaje (przewijanie, zmiana okna) aż do H – wtedy resetUserCustomWidth().
export function handleCalcResize() {
  const narrow = ctx.isMobile();
  const wasNarrow = lastNarrow;
  lastNarrow = narrow;

  // Zwijanie/przywracanie po tym samym warunku co klasa .mobile – bez rozjazdu przy 800 px
  if (calcOpen && !autoCollapsed && !wasNarrow && narrow) {
    autoCollapsed = true;
    setCalcOpen(false);
    return;
  }
  if (!calcOpen && autoCollapsed && wasNarrow && !narrow) {
    autoCollapsed = false;
    setCalcOpen(true);
    return;
  }

  if (!calcOpen || narrow) return;
  let w = userCalcW;
  if (w === null && ctx.getFitMode() === 'width') {
    // Szerokość 100%: nie dopasowujemy kalkulatora do strony – zostaje tak szeroki, jak był,
    // a przy zmianie okna zmienia się tylko PDF
    w = fixedW ??= calcWidth;
  } else if (w === null) {
    fixedW = null;
    const neededW = neededPdfWidth();
    w = neededW == null ? calcWidth : window.innerWidth - neededW - RESIZER_W;
  }
  applyCalcWidth(w);
}

export function initCalcPanel(context) {
  ctx = context;
  lastNarrow = ctx.isMobile();

  sidebar = document.getElementById('calc-sidebar');
  sidebar.inert = true;
  const resizer = document.getElementById('calc-resizer');
  calcContainer = document.getElementById('calc-container');

  applyCalcWidth(ctx.pref.get('calcWidth', 440));

  // Rozdzielacz: przeciąganie zmienia szerokość na żywo, zapis dopiero po puszczeniu
  let startX = 0, initialW = 0, dragging = false;
  const setDragStyles = (on) => {
    resizer.classList.toggle('dragging', on);
    sidebar.style.transition = ctx.stage.style.transition = on ? 'none' : '';
    document.body.style.userSelect = on ? 'none' : '';
    document.body.style.cursor = on ? 'ew-resize' : '';
    calcContainer.style.pointerEvents = on ? 'none' : '';
  };

  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    startX = e.clientX;
    initialW = calcWidth;
    setDragStyles(true);
    try { resizer.setPointerCapture(e.pointerId); } catch {}
    dragging = true;
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applyCalcWidth(initialW + e.clientX - startX);
    userCalcW = calcWidth;
    ctx.fitNow();
  });

  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    setDragStyles(false);
    try { resizer.releasePointerCapture(e.pointerId); } catch {}
    ctx.pref.set('calcWidth', calcWidth);   // zapis raz, po puszczeniu – nie przy każdym ruchu myszy
    ctx.fitNow();
    ctx.rerenderSoon();
  };
  resizer.addEventListener('pointerup', stopDrag);
  resizer.addEventListener('pointercancel', stopDrag);

  document.getElementById('calc-close').addEventListener('click', () => setCalcOpen(false, true));
}
