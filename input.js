// input.js – obsługa klawiatury, kółka myszy, touchpada, gestów dotykowych i chowania kursora.

const NOTCH_MIN_PX = 40;      // zdarzenie kółka >= tyle px = ząbek myszy (każdy ząbek = rozkładówka)
const TOUCHPAD_PX = 100;      // tyle px ruchu touchpada = jedna rozkładówka
const SWIPE_PX = 50;          // tyle px ruchu palca to już przesunięcie, a nie stuknięcie
const SWIPE_MS = 700;         // dłuższy ruch to przewijanie albo zaznaczanie, nie przewracanie

const KEY_ACTIONS = {
  d: 'dark', t: 'theme', p: 'pages', o: 'pairing', f: 'full', c: 'crop', r: 'rotate',
  k: 'calc', w: 'fit-w', h: 'fit-h', m: 'toggle-menu'
};

const HELP = 'Esc  strona główna\n→ ↓ Spacja PgDn  następne\n← ↑ PgUp  poprzednie\nHome / End  początek / koniec\n' +
  'numer (lub Enter)  skok do strony\nShift + strzałka / scroll  skok o 10\nB  zakładka na tej stronie\n' +
  'M  menu opcji\nK  kalkulator z boku\nW  zablokuj szerokość 100%\nH  zablokuj wysokość 100%\n' +
  'C  przycinanie marginesów\nR  obrót o 90°\n' +
  'P  jedna / dwie strony\nD  tryb: ciemny / jasny / auto\nT  motyw: Gemini / systemowy\nO  pary nieparzyste / parzyste\n' +
  'F  pełny ekran\ndwuklik  pełny ekran\nCtrl+O  otwórz plik\nkliknięcie  pasek z przyciskami';

export const zoomed = () => (typeof window !== 'undefined' ? (window.visualViewport?.scale || 1) > 1.01 : false);

let cursorTimer = null;

export function resetCursor() {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('nocursor');
  }
  clearTimeout(cursorTimer);
  cursorTimer = null;
}

export function initInput(ctx) {
  function wakeCursor() {
    resetCursor();
    if (ctx.isPdfLoaded()) {
      cursorTimer = setTimeout(() => {
        if (ctx.isPdfLoaded() && typeof document !== 'undefined') {
          document.documentElement.classList.add('nocursor');
        }
      }, 2000);
    }
  }

  ['mousemove', 'mousedown', 'wheel', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, wakeCursor, { passive: true }));

  // ---------- klawisze ----------
  window.addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (ctx.isPageInputFocused()) return;
    if (e.target?.closest?.('#pw-dialog')) return;
    if (e.target?.closest?.('#calc-sidebar') && e.key.length === 1 && !/^[a-z?]$/i.test(e.key)) return;   // cyfry i działania z panelu idą do kalkulatora
    if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); ctx.pickFile(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;

    if (k === 'Escape') {
      if (ctx.isPopoverOpen() && !ctx.isMenuHidden()) {     // schowany pasek = schowane menu opcji; Esc idzie dalej
        ctx.setPopoverOpen(false);
        e.preventDefault();
        return;
      }
      if (ctx.isCalcOpen()) {
        ctx.setCalcOpen(false, true);
        e.preventDefault();
        return;
      }
      if (!ctx.isMenuHidden() && !ctx.isPinned()) {
        ctx.hideMenu();
        e.preventDefault();
        return;
      }
      if (ctx.isPdfLoaded()) {
        ctx.goHome();
        e.preventDefault();
        return;
      }
    }

    // Enter na ekranie startowym otwiera ostatni plik – chyba że przycisk jest zaznaczony (Tab), wtedy działa on
    if (!ctx.isPdfLoaded() && k === 'Enter' && ctx.getLastRecent() && !e.target?.closest?.('button')) {
      e.preventDefault();
      ctx.openRecent(ctx.getLastRecent());
      return;
    }

    if (/^[0-9]$/.test(k) && ctx.isPdfLoaded()) {
      e.preventDefault();
      ctx.focusPageInputWithDigit(k);
      return;
    }

    if (!ctx.isMenuHidden() && !ctx.isPinned()) ctx.scheduleHide();

    const action = k.length === 1 && KEY_ACTIONS[k.toLowerCase()];
    if (action) { ctx.act(action); e.preventDefault(); return; }

    if (!ctx.isPdfLoaded() && k !== '?') return;       // bez pliku strzałki i spacja przewijają ekran startowy
    const jump = e.shiftKey ? 10 : 1;   // Shift = skok o 10 rozkładówek
    if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(k)) { ctx.flip(jump); e.preventDefault(); return; }
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) { ctx.flip(-jump); e.preventDefault(); return; }
    if (k === ' ') { e.shiftKey ? ctx.prev() : ctx.next(); e.preventDefault(); return; }
    if (k === 'b' || k === 'B') { ctx.toggleMark(); e.preventDefault(); return; }
    if (k === 'Home') { ctx.go(1); e.preventDefault(); return; }
    if (k === 'End') { ctx.go(ctx.getSpreadStartOf(ctx.getNumPages())); e.preventDefault(); return; }
    if (k === '?') { ctx.flash(HELP, 6000); e.preventDefault(); }
  });

  // ---------- kliknięcia i stuknięcia w stronę ----------
  window.addEventListener('click', (e) => {
    if (!ctx.isPdfLoaded()) return;
    if (String(window.getSelection())) return;
    if (e.target?.closest?.('#menu, #menu-popover, #calc-sidebar, #calc-resizer, #pw-dialog')) return;
    // Telefon: stuknięcie w lewą / prawą część strony przewraca, środek otwiera pasek.
    // Przybliżona strona przewija się palcem – wtedy stuknięcie tylko otwiera pasek.
    if (ctx.isMobile() && !zoomed()) {
      const x = e.clientX / window.innerWidth;
      if (x < 0.3) { ctx.hideMenu(); ctx.prev(); return; }
      if (x > 0.7) { ctx.hideMenu(); ctx.next(); return; }
    }
    if (ctx.isPinned()) {
      if (ctx.isPopoverOpen()) ctx.setPopoverOpen(false);
      return;
    }
    ctx.isMenuHidden() ? ctx.showMenu() : ctx.hideMenu();
  });

  // ---------- kółko myszy i gesty touchpad ----------
  let lastWheel = 0, notch = 100, acc = 0;
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    if (e.target?.closest?.('#menu, #menu-popover, #calc-sidebar, #calc-resizer, #pw-dialog')) return;
    if (!ctx.isPdfLoaded()) return;

    const stage = ctx.stage;
    // W trybie blokady szerokości pozwól na naturalne przewijanie, jeśli strona wystaje pionowo
    if (ctx.getFitMode() === 'width' && stage.scrollHeight > stage.clientHeight + 10) {
      const atTop = stage.scrollTop <= 2;
      const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
      if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return;   // naturalne przewijanie strony
    }
    // Tryb wysokości: jeśli strony wystają w bok, ruch poziomy (touchpad, kółko przechylane) przewija je w bok,
    // a kółko w pionie dalej przerzuca strony
    if (ctx.getFitMode() === 'height' && stage.scrollWidth > stage.clientWidth + 2 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      stage.scrollLeft += e.deltaX * (e.deltaMode === 1 ? 40 : 1);
      return;
    }
    e.preventDefault();
    let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (e.deltaMode === 1) d *= 40;
    else if (e.deltaMode === 2) d *= window.innerHeight;
    if (!d) return;
    if (!ctx.isMenuHidden() && !ctx.isPinned()) ctx.scheduleHide();
    const now = performance.now(), gap = now - lastWheel;
    lastWheel = now;
    const ad = Math.abs(d);

    const jumpMult = e.shiftKey ? 10 : 1;
    if (ad >= NOTCH_MIN_PX) {
      if (gap > 120) notch = ad;
      acc = 0;
      ctx.flip(Math.sign(d) * Math.max(1, Math.round(ad / notch)) * jumpMult);
      return;
    }
    if (Math.sign(d) !== Math.sign(acc)) acc = 0;
    acc += d;
    const n = Math.trunc(acc / TOUCHPAD_PX);
    if (n) { acc -= n * TOUCHPAD_PX; ctx.flip(n * jumpMult); }
  }, { passive: false });

  // ---------- dotyk: przesunięcie palcem (swipe) ----------
  let swipe = null;
  window.addEventListener('touchstart', (e) => {
    swipe = null;
    if (e.touches.length !== 1 || e.target?.closest?.('#menu, #menu-popover, #calc-sidebar, #calc-resizer, #pw-dialog')) return;
    const t = e.touches[0];
    const stage = ctx.stage;
    swipe = {
      x: t.clientX, y: t.clientY, at: Date.now(),
      // czy strona była już przewinięta do brzegu, zanim palec ruszył
      left: stage.scrollLeft <= 2, right: stage.scrollLeft + stage.clientWidth >= stage.scrollWidth - 2,
      top: stage.scrollTop <= 2, bottom: stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2
    };
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    const s = swipe;
    swipe = null;
    if (!ctx.isPdfLoaded() || !s || String(window.getSelection()) || ctx.isPasswordOpen()) return;
    if (Date.now() - s.at > SWIPE_MS) return;
    if (zoomed()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax >= SWIPE_PX && ax >= ay * 1.5) {
      if (dx < 0 && s.right) ctx.next();
      else if (dx > 0 && s.left) ctx.prev();
    } else if (ay >= SWIPE_PX && ay >= ax * 1.5) {
      if (dy < 0 && s.bottom) ctx.next();
      else if (dy > 0 && s.top) ctx.prev();
    }
  }, { passive: true });
}
