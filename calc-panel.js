// calc-panel.js – panel boczny kalkulatora w DarkPDF (rozmiar, rozdzielacz, synchronizacja)

export const CALC_MIN_W = 320;         // najwęższy sensowny kalkulator
export const PDF_MIN_W = 140;          // tyle miejsca zostawiamy zawsze na PDF

export const clampCalcW = (w) => Math.max(CALC_MIN_W, Math.min(Math.max(CALC_MIN_W, window.innerWidth - PDF_MIN_W), Math.round(w)));

let ctx = null;
let calcOpen = false;
let calcWidth = 440;
let targetPdfWidth = null;
let userCustomWidth = false;

let calcSidebar = null;
let calcFrame = null;
let calcResizer = null;

function calcOrigin() {
  try { return new URL(calcFrame.src, location.href).origin; } catch { return '*'; }
}

function getCalcUrl() {
  const { isDark, palette } = ctx.getTheme();
  const custom = ctx.pref.get('calcUrl', null) || window.DARKPDF_CALC_URL;
  let base = custom;
  if (!base) {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      base = '/calc/index.html';
    } else if (location.hostname.endsWith('github.io')) {
      const user = location.hostname.split('.')[0];
      base = `https://${user}.github.io/calc/`;
    } else {
      base = '../calc/index.html';
    }
  }
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}embed=1&side=1&mode=${isDark ? 'dark' : 'light'}&palette=${palette}&v=51`;
}

export function isCalcOpen() { return calcOpen; }
export function getCalcWidth() { return calcWidth; }
export function getCalcStageWidth() {
  return (calcOpen && !ctx?.isMobile?.()) ? (calcWidth + 9) : 0;
}
export function resetUserCustomWidth() { userCustomWidth = false; }
export function isUserCustomWidth() { return userCustomWidth; }

export function sendThemeToCalc(isDark, palette) {
  if (calcFrame && calcFrame.src && calcFrame.src !== 'about:blank') {
    try {
      calcFrame.contentWindow?.postMessage({
        type: 'darkpdf_theme',
        mode: isDark ? 'dark' : 'light',
        palette
      }, calcOrigin());
    } catch {}
  }
}

export function updateCalcWidth(w, updateTargetPdf = true) {
  calcWidth = clampCalcW(w);
  document.documentElement.style.setProperty('--calc-w', calcWidth + 'px');
  ctx.pref.set('calcWidth', calcWidth);
  if (updateTargetPdf) {
    targetPdfWidth = Math.max(120, window.innerWidth - (calcWidth + 9));
    ctx.pref.set('targetPdfWidth', targetPdfWidth);
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
    } else if (!targetPdfWidth) {
      targetPdfWidth = Math.max(120, window.innerWidth - (calcWidth + 9));
      ctx.pref.set('targetPdfWidth', targetPdfWidth);
    } else {
      updateCalcWidth(window.innerWidth - targetPdfWidth - 9, false);
    }
    if (!calcFrame.src || calcFrame.src === 'about:blank') {
      calcFrame.src = getCalcUrl();
    }
  }
  window.focus();
  ctx.updateMenu();
  ctx.fitNow();
  ctx.rerenderSoon();
}

export function toggleCalc() {
  setCalcOpen(!calcOpen);
}

export function handleCalcResize() {
  if (calcOpen) {
    if (ctx.getFitMode() === 'height' && !userCustomWidth) {
      snapCalcToHeightFit();
    } else if (targetPdfWidth) {
      updateCalcWidth(window.innerWidth - targetPdfWidth - 9, false);
    } else if (calcWidth > window.innerWidth - PDF_MIN_W) {
      updateCalcWidth(calcWidth, true);
    }
  }
}

export function initCalcPanel(context) {
  ctx = context;
  calcWidth = ctx.pref.get('calcWidth', 440);
  targetPdfWidth = ctx.pref.get('targetPdfWidth', null);

  calcSidebar = document.getElementById('calc-sidebar');
  calcFrame = document.getElementById('calc-frame');
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
      if (calcFrame) calcFrame.style.pointerEvents = 'none';
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
      if (calcFrame) calcFrame.style.pointerEvents = '';
      try { calcResizer.releasePointerCapture(ev.pointerId); } catch {}
      ctx.fitNow();
      ctx.rerenderSoon();
    };

    calcResizer.addEventListener('pointermove', onPointerMove);
    calcResizer.addEventListener('pointerup', onPointerUp);
    calcResizer.addEventListener('pointercancel', onPointerUp);
  }

  document.getElementById('calc-close')?.addEventListener('click', () => setCalcOpen(false));

  window.addEventListener('message', (e) => {
    if (!calcFrame || e.source !== calcFrame.contentWindow) return;
    if (e.data && e.data.type === 'darkpdf_close_calc') {
      setCalcOpen(false);
    }
    if (e.data && e.data.type === 'darkpdf_key' && typeof e.data.key === 'string') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: e.data.key, shiftKey: !!e.data.shiftKey }));
    }
  });
}
