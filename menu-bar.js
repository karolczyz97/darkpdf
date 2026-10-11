// menu-bar.js – dolny pasek nawigacji, menu opcji (popover) oraz wpisywanie numeru strony.

import { pref } from './util.js';

let ctx = null;

let menu = null;
let popoverEl = null;
let pinBtn = null;
let toggleBtn = null;
let pageInput = null;
let totalSpan = null;
let buttonMap = null;

let pinned = pref.get('menuPinned', false);
let popoverOpen = pref.get('popoverOpen', true);
let lastMenuOpenTime = 0;
let menuTimer = null;
let pageJumpTimer = null;
let digitTriggeredFocus = false;

export const isPinned = () => pinned;
export const isPopoverOpen = () => popoverOpen;
export const isMenuHidden = () => !menu || menu.hidden;
export const getLastMenuOpenTime = () => lastMenuOpenTime;
export const isPageInputFocused = () => (typeof document !== 'undefined' ? document.activeElement === pageInput : false);

// Pasek chowa się po 2 s bezczynności, jeśli nie jest najechany ani zablokowany kłódką
export function scheduleHide() {
  clearTimeout(menuTimer);
  if (!menu || pinned || menu.hidden || menu.matches(':hover') || isPageInputFocused()) return;
  menuTimer = setTimeout(hideMenu, 2000);
}

export function hideMenu(force = false) {
  if (!menu || (pinned && !force)) return;
  menu.hidden = true;
  clearTimeout(menuTimer);
  syncPopover();
}

export function showMenu() {
  if (!menu || !ctx?.isPdfLoaded()) return;
  lastMenuOpenTime = Date.now();
  menu.hidden = false;
  void menu?.offsetHeight;
  updateMenu();
  scheduleHide();
}

// Menu opcji to natywny popover (warstwa nad wszystkim, zakotwiczony nad paskiem).
// Pokazujemy go tylko razem z paskiem; to, czy ma być otwarty, pamiętamy osobno.
export function syncPopover() {
  if (!popoverEl?.showPopover || !menu) return;
  const want = popoverOpen && !menu.hidden;
  if (want !== popoverEl.matches(':popover-open')) {
    if (want) {
      void menu?.offsetHeight;
      try { popoverEl.showPopover(); } catch {}
    } else {
      try { popoverEl.hidePopover(); } catch {}
    }
  }
}

export function setPopoverOpen(open) {
  popoverOpen = !!open;
  pref.set('popoverOpen', popoverOpen);
  updateMenu();
}

export function togglePin() {
  pinned = !pinned;
  pref.set('menuPinned', pinned);
  updateMenu();
  if (pinned) {
    clearTimeout(menuTimer);
    ctx.flash('Pasek zablokowany (na stałe)', 1200);
  } else {
    if (!menu.matches(':hover')) menuTimer = setTimeout(hideMenu, 2000);
    ctx.flash('Auto-ukrywanie paska włączone', 1200);
  }
}

export function updateMenu() {
  if (!menu || !ctx) return;
  if (document.activeElement !== pageInput) pageInput.value = ctx.getSpreadLabel();
  totalSpan.textContent = `/ ${ctx.getNumPages()}`;
  syncPopover();

  const fitMode = ctx.getFitMode();
  const colorMode = ctx.getColorMode();
  const palette = ctx.getPalette();

  // [przycisk, etykieta, czy podświetlony]; skrót klawiszowy (.k) jest na stałe w index.html
  const labels = [
    ['calc', ctx.isCalcOpen() ? 'Ukryj kalkulator' : 'Kalkulator', ctx.isCalcOpen()],
    ['fit-w', fitMode === 'width' ? 'Szerokość [100%]' : 'Szerokość 100%', fitMode === 'width'],
    ['fit-h', fitMode === 'height' ? 'Wysokość [100%]' : 'Wysokość 100%', fitMode === 'height'],
    ['pages', ctx.getTwo() ? 'Jedna strona' : 'Dwie strony'],
    ['pairing', ctx.getPairing() === 'odd' ? 'Pary 1–2' : 'Pary 1, 2–3'],
    ['dark', ctx.getColorLabel(colorMode)],
    ['theme', ctx.getPaletteLabel(palette)],
    ['crop', ctx.getCrop() ? 'Z marginesami' : 'Przytnij marginesy']
  ];
  for (const [k, text, active] of labels) {
    const item = buttonMap?.get(k);
    if (item) {
      if (item.labelText) item.labelText.textContent = text;
      if (active !== undefined) item.el.classList.toggle('active', active);
    }
  }
  const pairingBtn = buttonMap?.get('pairing')?.el;
  if (pairingBtn) pairingBtn.hidden = !ctx.showTwo();              // parowanie nic nie zmienia przy jednej stronie

  const pagesBtn = buttonMap?.get('pages')?.el;
  if (pagesBtn) pagesBtn.hidden = ctx.isPortraitPhone();         // telefon w pionie zawsze pokazuje jedną stronę

  const fullBtn = buttonMap?.get('full')?.el;
  if (fullBtn) fullBtn.hidden = typeof document !== 'undefined' ? !document.fullscreenEnabled : true; // iPhone i ramki bez zgody nie mają pełnego ekranu

  const darkBtn = buttonMap?.get('dark');
  if (darkBtn?.use) darkBtn.use.setAttribute('href', `#i-mode-${colorMode}`);

  const themeBtn = buttonMap?.get('theme');
  if (themeBtn?.use) themeBtn.use.setAttribute('href', `#i-pal-${palette}`);

  pinBtn.classList.toggle('pinned', pinned);
  pinBtn.dataset.tip = pinned ? 'Odblokuj pasek (auto-ukrywanie)' : 'Zablokuj pasek na stałe';
  toggleBtn.classList.toggle('open', popoverOpen);
  toggleBtn.dataset.tip = popoverOpen ? 'Zamknij menu opcji (M)' : 'Otwórz menu opcji (M)';
}

function schedulePageJump() {
  clearTimeout(pageJumpTimer);
  const val = parseInt(pageInput.value, 10);
  const numPages = ctx.getNumPages();
  if (val >= 1 && val <= numPages) {
    pageJumpTimer = setTimeout(() => {
      pageJumpTimer = null;
      const target = ctx.getSpreadStartOf(val);
      if (target !== ctx.getCurrentStart()) ctx.goToSpread(target);
      if (document.activeElement === pageInput) pageInput.blur();
    }, 1000);
  }
}

function applyPageInput(jump) {
  clearTimeout(pageJumpTimer);
  pageJumpTimer = null;
  const val = parseInt(pageInput.value, 10);
  const numPages = ctx.getNumPages();
  const target = ctx.getSpreadStartOf(val);
  if (jump && val >= 1 && val <= numPages && target !== ctx.getCurrentStart()) {
    ctx.goToSpread(target);
  } else {
    updateMenu();
  }
}

export function focusPageInputWithDigit(k) {
  showMenu();
  digitTriggeredFocus = true;
  pageInput.focus();
  pageInput.value = k;
  schedulePageJump();
}

export function initMenuBar(context) {
  ctx = context;

  menu = document.getElementById('menu');
  popoverEl = document.getElementById('menu-popover');
  pinBtn = menu.querySelector('.menu-pin');
  toggleBtn = menu.querySelector('.menu-toggle');
  pageInput = menu.querySelector('.page-input');
  totalSpan = menu.querySelector('.total');

  buttonMap = new Map();
  for (const b of menu.querySelectorAll('[data-k]')) {
    if (!buttonMap.has(b.dataset.k) || b.classList.contains('menu-item')) {
      buttonMap.set(b.dataset.k, {
        el: b,
        labelText: b.querySelector('.label-text'),
        use: b.querySelector('use')
      });
    }
  }

  menu.addEventListener('mouseenter', () => clearTimeout(menuTimer));
  menu.addEventListener('mouseleave', scheduleHide);

  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(menuTimer);
    const b = e.target.closest('button');
    if (b) {
      ctx.onAction(b.dataset.k);
      scheduleHide();
    }
  });

  pageInput.addEventListener('focus', () => {
    clearTimeout(menuTimer);
    if (digitTriggeredFocus) { digitTriggeredFocus = false; return; }
    setTimeout(() => { if (document.activeElement === pageInput) pageInput.select(); }, 10);
  });

  pageInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Escape') pageInput.value = ctx.getSpreadLabel();   // bez tego blur niżej i tak by skoczył
    applyPageInput(e.key === 'Enter');
    pageInput.blur();
  });

  pageInput.addEventListener('blur', () => {
    applyPageInput(true);
    scheduleHide();
  });

  pageInput.addEventListener('input', schedulePageJump);
  menu.querySelector('.page-select').addEventListener('click', () => pageInput.focus());
}
