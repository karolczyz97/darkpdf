// theme.js – wygląd: tryb ciemny/jasny/auto, paleta Gemini/systemowa oraz filtry SVG (odwracanie barw i wyrównanie kartki).

import { pref } from './util.js';
import { paperColor } from './layout.js';

export const COLOR_MODES = ['dark', 'light', 'auto'];
export const COLOR_LABELS = { dark: 'Tryb: Ciemny', light: 'Tryb: Jasny', auto: 'Tryb: Auto' };
export const PALETTE_LABELS = { gemini: 'Motyw: Gemini', system: 'Motyw: Systemowy' };

const SVG_NS = 'http://www.w3.org/2000/svg';

let colorMode = pref.get('colorMode', 'dark');
if (!COLOR_MODES.includes(colorMode)) colorMode = 'dark';
let palette = pref.get('palette', 'gemini');
if (!(palette in PALETTE_LABELS)) palette = 'gemini';

const systemDark = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : { matches: false, addEventListener() {} };
const paperFilters = new Map();      // 'r-g-b' -> 'url(#paper-r-g-b)'
const paperCache = new Map();        // nr strony -> filtr wyrównujący kartkę ('url(#paper-…)' albo '')

let pageFilters = null;
let notifyChange = null;
let flashMsg = null;

let probeEl = null;

function cssRgb(name) {
  if (typeof document === 'undefined') return [0, 0, 0];
  if (!probeEl) {
    probeEl = document.createElement('i');
    probeEl.style.display = 'none';
  }
  if (!probeEl.isConnected) {
    (document.body || document.documentElement)?.append(probeEl);
  }
  probeEl.style.color = `var(${name})`;
  const m = getComputedStyle(probeEl).color.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}

// Odwrócona kartka ma dokładnie kolor tła, a czarny druk kolor tekstu motywu. Kolory bierzemy z CSS
// (--ui-stage-bg, --page-ink), więc wystarczy zmienić je w arkuszu. feColorMatrix, nie feComponentTransfer:
// ten drugi Chrome liczy tabelą z obcięciem i kartka wychodziła o jeden poziom ciemniejsza od tła.
function syncPageColors() {
  if (!pageFilters) return;
  const bg = cssRgb('--ui-stage-bg'), ink = cssRgb('--page-ink');
  // kartka (0 po odwróceniu) → tło, druk (1) → tekst; +0,25 poziomu: ten sam wynik przy zaokrąglaniu i obcinaniu
  const row = (c) => [0, 1, 2].map((j) => (j === c ? (ink[c] - bg[c]) / 255 : 0)).concat(0, (bg[c] + 0.25) / 255);
  const values = [...row(0), ...row(1), ...row(2), 0, 0, 0, 1, 0].map((v) => +v.toFixed(6)).join(' ');
  const matrix = pageFilters.querySelector('#page-colors feColorMatrix');
  if (matrix) matrix.setAttribute('values', values);
}

// Kartka, która nie jest biała (skan, szare tło), przed odwróceniem staje się biała, więc po odwróceniu też ma
// kolor tła. Jeden filtr na kolor kartki.
function paperFilter(rgb) {
  const key = rgb.join('-');
  if (!paperFilters.has(key)) {
    const f = document.createElementNS(SVG_NS, 'filter');
    f.id = 'paper-' + key;
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const m = document.createElementNS(SVG_NS, 'feColorMatrix');
    const [r, g, b] = rgb.map((v) => +(255.5 / v).toFixed(6));   // +0,5: kartka na pewno dochodzi do bieli
    m.setAttribute('type', 'matrix');
    m.setAttribute('values', `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`);
    f.append(m);
    pageFilters.append(f);
    paperFilters.set(key, `url(#${f.id})`);
  }
  return paperFilters.get(key);
}

export const isDarkNow = () => (colorMode === 'auto' ? systemDark.matches : colorMode === 'dark');
export const getColorMode = () => colorMode;
export const getPalette = () => palette;

export function applyTheme() {
  const isDark = isDarkNow();
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.classList.toggle('gemini', isDark && palette === 'gemini');
    syncPageColors();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#131314' : '#ffffff');
  }
  if (notifyChange) notifyChange();
}

export function cycleColorMode() {
  colorMode = COLOR_MODES[(COLOR_MODES.indexOf(colorMode) + 1) % COLOR_MODES.length];
  pref.set('colorMode', colorMode);
  applyTheme();
  if (flashMsg) flashMsg(COLOR_LABELS[colorMode]);
}

export function togglePalette() {
  palette = palette === 'gemini' ? 'system' : 'gemini';
  pref.set('palette', palette);
  applyTheme();
  if (flashMsg) flashMsg(PALETTE_LABELS[palette]);
}

// Kolor kartki strony n liczymy raz na plik: szybki podgląd i pełna jakość wyglądają tak samo
export function paperFilterOf(n, canvas) {
  if (!paperCache.has(n)) {
    const w = 48, h = Math.max(1, Math.round((w * canvas.height) / canvas.width));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;   // pojedyncze piksele strony: druk nie rozmywa się z kartką
    ctx.drawImage(canvas, 0, 0, w, h);
    const paper = paperColor(ctx.getImageData(0, 0, w, h).data);
    c.width = c.height = 0;
    paperCache.set(n, paper ? paperFilter(paper) : '');
  }
  return paperCache.get(n);
}

export function clearPaperCache() {
  paperCache.clear();
}

export function prunePaperFilters() {
  const used = new Set(paperCache.values());
  for (const [key, filter] of paperFilters) {
    if (used.has(filter)) continue;
    document.getElementById('paper-' + key)?.remove();
    paperFilters.delete(key);
  }
}

export function initTheme({ onThemeChange = null, flash = null } = {}) {
  pageFilters = document.getElementById('page-filters');
  notifyChange = onThemeChange;
  flashMsg = flash;

  systemDark.addEventListener('change', () => {
    if (colorMode === 'auto') applyTheme();
  });

  applyTheme();
}
