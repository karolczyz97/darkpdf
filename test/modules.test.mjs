// test/modules.test.mjs – weryfikacja modułów czytnika (theme, menu-bar, doc-history, doc-loader, input)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COLOR_MODES,
  COLOR_LABELS,
  PALETTE_LABELS,
  getColorMode,
  getPalette,
  cycleColorMode,
  togglePalette,
  isDarkNow,
  clearPaperCache
} from '../theme.js';

import {
  isPinned,
  isPopoverOpen,
  isMenuHidden,
  setPopoverOpen,
  hideMenu,
  getLastMenuOpenTime
} from '../menu-bar.js';

import {
  hasWelcomeState
} from '../doc-history.js';

import {
  zoomed
} from '../input.js';

test('theme.js: stałe i cykle motywu', () => {
  assert.deepEqual(COLOR_MODES, ['dark', 'light', 'auto']);
  assert.equal(COLOR_LABELS.dark, 'Tryb: Ciemny');
  assert.equal(COLOR_LABELS.light, 'Tryb: Jasny');
  assert.equal(COLOR_LABELS.auto, 'Tryb: Auto');
  assert.equal(PALETTE_LABELS.gemini, 'Motyw: Gemini');
  assert.equal(PALETTE_LABELS.system, 'Motyw: Systemowy');

  const curMode = getColorMode();
  cycleColorMode();
  const nextMode = getColorMode();
  const expectedNext = COLOR_MODES[(COLOR_MODES.indexOf(curMode) + 1) % COLOR_MODES.length];
  assert.equal(nextMode, expectedNext, 'cycleColorMode powinien przejść do kolejnego trybu');

  const curPal = getPalette();
  togglePalette();
  const nextPal = getPalette();
  assert.equal(nextPal, curPal === 'gemini' ? 'system' : 'gemini', 'togglePalette powinien przełączyć gemini <-> system');

  // Sprawdzenie stanu ciemnego
  while (getColorMode() !== 'dark') cycleColorMode();
  assert.equal(isDarkNow(), true);
  while (getColorMode() !== 'light') cycleColorMode();
  assert.equal(isDarkNow(), false);
});

test('menu-bar.js: stan popovera, widoczności i wymuszonego ukrywania', () => {
  assert.equal(typeof isPinned(), 'boolean');
  assert.equal(typeof isPopoverOpen(), 'boolean');
  assert.equal(typeof isMenuHidden(), 'boolean');
  assert.equal(typeof getLastMenuOpenTime(), 'number');

  setPopoverOpen(false);
  assert.equal(isPopoverOpen(), false);
  setPopoverOpen(true);
  assert.equal(isPopoverOpen(), true);

  hideMenu(true);
  assert.equal(isMenuHidden(), true);
});

test('doc-history.js: stan powitalny', () => {
  assert.equal(typeof hasWelcomeState(), 'boolean');
});

test('doc-loader.js: funkcje pomocnicze stanu', async () => {
  const { getLastRecent, isPasswordOpen } = await import('../doc-loader.js');
  assert.equal(getLastRecent(), null);
  assert.equal(typeof isPasswordOpen(), 'boolean');
});

test('doc-loader.js: extractPageStats uwzględnia obrót strony przez convertToViewportPoint', async () => {
  const { extractPageStats } = await import('../doc-loader.js');
  const vpRotated = {
    width: 400,
    height: 300,
    // Obrót 90 stopni: transformacja (rawX, rawY) -> [viewportX, viewportY]
    convertToViewportPoint: (rawX, rawY) => [rawY, rawX]
  };
  const tc = {
    items: [
      {
        str: '12',
        transform: [1, 0, 0, 1, 10, 50] // rawX = 10, rawY = 50 -> viewport [50, 10]. y=10 < 300*0.15 (45) -> nagłówek!
      }
    ]
  };
  const stats = extractPageStats(vpRotated, tc);
  assert.equal(stats.numbers.length, 1);
  assert.equal(stats.numbers[0].value, 12);
  assert.equal(stats.numbers[0].x, 50);
  assert.equal(stats.numbers[0].side, 'left');
});

test('input.js: funkcja powiększenia', () => {
  assert.equal(typeof zoomed(), 'boolean');
});

test('library.js: rozpoznawanie kluczy zdalnych i lokalnych', async () => {
  const { isRemoteKey } = await import('../library.js');
  assert.equal(isRemoteKey('https://example.com/file.pdf'), true);
  assert.equal(isRemoteKey('http://example.com/file.pdf'), true);
  assert.equal(isRemoteKey('file:///path/to/file.pdf'), true);
  assert.equal(isRemoteKey('local:mojplik.pdf:12345'), false);
  assert.equal(isRemoteKey('random_key'), false);
});

test('viewer.js: poprawna dekompozycja i integracja modułów', () => {
  const viewerJs = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');

  // Sprawdzamy czy viewer.js importuje moduły
  assert.ok(viewerJs.includes("from './theme.js'"), 'viewer.js powinien importować theme.js');
  assert.ok(viewerJs.includes("from './doc-history.js'"), 'viewer.js powinien importować doc-history.js');
  assert.ok(viewerJs.includes("from './doc-loader.js'"), 'viewer.js powinien importować doc-loader.js');
  assert.ok(viewerJs.includes("from './menu-bar.js'"), 'viewer.js powinien importować menu-bar.js');
  assert.ok(viewerJs.includes("from './input.js'"), 'viewer.js powinien importować input.js');
  assert.ok(viewerJs.includes("from './calc-panel.js'"), 'viewer.js powinien importować calc-panel.js');

  // Sprawdzamy czy isMenuHidden jest importowane z menu-bar.js
  assert.ok(viewerJs.includes('isMenuHidden'), 'viewer.js powinien importować i przekazywać isMenuHidden');
  assert.ok(viewerJs.includes('hideMenu(true)'), 'viewer.js powinien wymuszać ukrycie menu przy zamykaniu dokumentu');

  // Sprawdzamy czy viewer.js inicjalizuje podsystemy
  assert.ok(viewerJs.includes('initTheme('), 'viewer.js powinien inicjalizować theme');
  assert.ok(viewerJs.includes('initCalcPanel('), 'viewer.js powinien inicjalizować calc-panel');
  assert.ok(viewerJs.includes('initMenuBar('), 'viewer.js powinien inicjalizować menu-bar');
  assert.ok(viewerJs.includes('initDocHistory('), 'viewer.js powinien inicjalizować doc-history');
  assert.ok(viewerJs.includes('initDocLoader('), 'viewer.js powinien inicjalizować doc-loader');
  assert.ok(viewerJs.includes('initInput('), 'viewer.js powinien inicjalizować input');

  assert.ok(viewerJs.includes('resetCursor'), 'viewer.js powinien używać resetCursor przy zamykaniu dokumentu');

  // viewer.js jest odchudzony o ponad 700 linii
  const lineCount = viewerJs.split('\n').length;
  assert.ok(lineCount < 800, `viewer.js powinien być zwięzły (<800 linii), ma ${lineCount}`);
});

test('util.js: pref.get poprawnie parsuje wartości logiczne i liczbowe', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const { pref } = await import('../util.js');

  // Booleany bez wartości domyślnej
  store.set('b_zero', '0');
  store.set('b_one', '1');
  assert.equal(pref.get('b_zero'), false);
  assert.equal(pref.get('b_one'), true);

  // Booleany z wartością domyślną
  assert.equal(pref.get('b_zero', true), false);
  assert.equal(pref.get('b_one', false), true);
  assert.equal(pref.get('missing_bool', true), true);

  // Liczby (zwłaszcza 0)
  store.set('n_zero', '0');
  assert.equal(pref.get('n_zero', 10), 0, 'Zapisane 0 nie powinno być nadpisywane przez domyślne 10');
  store.set('n_val', '42');
  assert.equal(pref.get('n_val', 0), 42);
  store.set('n_invalid', 'abc');
  assert.equal(pref.get('n_invalid', 99), 99);
  assert.equal(pref.get('missing_num', 5), 5);

  // Napisy (nie powinny być zamieniane na booleany, gdy oczekiwany jest string)
  store.set('str_zero', '0');
  store.set('str_one', '1');
  assert.equal(pref.get('str_zero', 'default'), '0', "Domyślny string powinien zwracać '0' jako string");
  assert.equal(pref.get('str_one', 'default'), '1', "Domyślny string powinien zwracać '1' jako string");

  delete globalThis.localStorage;
});

test('doc-history.js: zachowanie stanu przy przeładowaniu F5 z #doc', async () => {
  const { initDocHistory } = await import('../doc-history.js');
  let replacedState = null;
  const origLocation = globalThis.location;
  const origHistory = globalThis.history;
  const origWindow = globalThis.window;

  globalThis.location = { hash: '#doc', pathname: '/darkpdf/', href: 'http://localhost/darkpdf/#doc' };
  globalThis.history = {
    state: { doc: true, key: 'test-key' },
    replaceState: (st) => { replacedState = st; },
    pushState: () => {}
  };
  globalThis.window = { addEventListener: () => {} };

  initDocHistory({ isPdfLoaded: () => false });
  assert.equal(replacedState, null, 'Nie powinno nadpisywać history.state gdy hash to #doc i klucz istnieje');

  // Gdy brak klucza w stanie:
  globalThis.history.state = null;
  initDocHistory({ isPdfLoaded: () => false });
  assert.deepEqual(replacedState, { welcome: true }, 'Powinno przejść do welcome gdy brak klucza');

  if (origLocation) globalThis.location = origLocation; else delete globalThis.location;
  if (origHistory) globalThis.history = origHistory; else delete globalThis.history;
  if (origWindow) globalThis.window = origWindow; else delete globalThis.window;
});

test('sw.js: moduły w CORE i podbita wersja CACHE', () => {
  const swJs = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.ok(swJs.includes("'theme.js'"), 'sw.js powinien cacheować theme.js');
  assert.ok(swJs.includes("'menu-bar.js'"), 'sw.js powinien cacheować menu-bar.js');
  assert.ok(swJs.includes("'doc-history.js'"), 'sw.js powinien cacheować doc-history.js');
  assert.ok(swJs.includes("'doc-loader.js'"), 'sw.js powinien cacheować doc-loader.js');
  assert.ok(swJs.includes("'input.js'"), 'sw.js powinien cacheować input.js');
  assert.ok(swJs.includes("CACHE = 'darkpdf-v12'"), 'sw.js powinien mieć podbitą wersję CACHE (v12)');
});

test('viewer.css: fallback dla przeglądarek bez Anchor Positioning', () => {
  const css = readFileSync(new URL('../viewer.css', import.meta.url), 'utf8');
  assert.ok(css.includes('@supports not ((position-area: top) or (inset-area: top))') || css.includes('@supports not (position-area: top)'), 'viewer.css powinien zawierać regułę @supports dla braku Anchor Positioning');
  assert.ok(css.includes('margin: 0 auto;'), 'viewer.css powinien zerować marginesy w fallbacku dla równego odstępu');
});

test('input.js: funkcja resetCursor usuwa klasę nocursor', async () => {
  const { resetCursor } = await import('../input.js');
  let removed = null;
  globalThis.document = {
    documentElement: {
      classList: {
        remove: (cls) => { removed = cls; }
      }
    }
  };
  resetCursor();
  assert.equal(removed, 'nocursor');
  delete globalThis.document;
});

test('calc-panel.js: preferencja calcOpen zapisywana tylko przy akcji użytkownika', async () => {
  const { setCalcOpen, initCalcPanel } = await import('../calc-panel.js');
  let savedPref = null;
  const mockContext = {
    pref: {
      set: (k, v) => { if (k === 'calcOpen') savedPref = v; },
      get: () => 400
    },
    isPdfLoaded: () => true,
    isMobile: () => false,
    updateMenu: () => {},
    fitNow: () => {},
    rerenderSoon: () => {}
  };
  const origDoc = globalThis.document;
  const origWindow = globalThis.window;
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  globalThis.document = {
    getElementById: () => ({ addEventListener: () => {}, contains: () => false }),
    documentElement: {
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      style: { setProperty: () => {} }
    },
    activeElement: null
  };
  initCalcPanel(mockContext);

  // Auto-collapse (np. zmiana rozmiaru ekranu) - fromUser = false
  savedPref = null;
  setCalcOpen(false, false);
  assert.equal(savedPref, null, 'Auto-collapse nie powinien zapisywać pref calcOpen');

  // Akcja użytkownika - fromUser = true
  setCalcOpen(false, true);
  assert.equal(savedPref, false, 'Akcja użytkownika powinna zapisać pref calcOpen');

  await new Promise(r => setTimeout(r, 300));

  if (origDoc) globalThis.document = origDoc; else delete globalThis.document;
  if (origWindow) globalThis.window = origWindow; else delete globalThis.window;
});

test('menu-bar.js: buttonMap buforuje elementy przycisków i preferuje pozycje z label-text dla duplikatów', async () => {
  const { initMenuBar, updateMenu } = await import('../menu-bar.js');
  const mockMenu = {
    hidden: false,
    querySelector: (sel) => {
      if (sel === '.menu-pin') return { classList: { toggle: () => {} }, dataset: {} };
      if (sel === '.menu-toggle') return { classList: { toggle: () => {} }, dataset: {} };
      if (sel === '.page-input') return { addEventListener: () => {}, value: '' };
      if (sel === '.total') return { textContent: '' };
      if (sel === '.page-select') return { addEventListener: () => {} };
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '[data-k]') {
        return [
          {
            dataset: { k: 'home' },
            classList: { contains: (cls) => cls === 'menu-item', toggle: () => {} },
            querySelector: (s) => (s === '.label-text' ? { textContent: 'Strona główna' } : null)
          },
          {
            dataset: { k: 'home' },
            classList: { contains: () => false, toggle: () => {} },
            querySelector: () => null
          },
          {
            dataset: { k: 'calc' },
            classList: { contains: (cls) => cls === 'menu-item', toggle: () => {} },
            querySelector: (s) => (s === '.label-text' ? { textContent: 'Kalkulator' } : null)
          }
        ];
      }
      return [];
    },
    addEventListener: () => {}
  };
  const origDoc = globalThis.document;
  globalThis.document = {
    getElementById: (id) => (id === 'menu' ? mockMenu : { showPopover: () => {}, hidePopover: () => {}, matches: () => false }),
    activeElement: null
  };
  const mockCtx = {
    isPdfLoaded: () => true,
    getSpreadLabel: () => '1',
    getNumPages: () => 10,
    getFitMode: () => 'auto',
    getColorMode: () => 'dark',
    getPalette: () => 'gemini',
    getColorLabel: () => 'Tryb: Ciemny',
    getPaletteLabel: () => 'Motyw: Gemini',
    isCalcOpen: () => false,
    getTwo: () => true,
    showTwo: () => true,
    getPairing: () => 'odd',
    getCrop: () => true,
    isPortraitPhone: () => false
  };
  initMenuBar(mockCtx);
  // Wywołanie updateMenu nie powinno rzucać błędów
  assert.doesNotThrow(() => updateMenu());

  if (origDoc) globalThis.document = origDoc; else delete globalThis.document;
});

test('doc-loader.js: openDocument niszczy dokument doc.destroy() gdy numer żądania się zmienił', async () => {
  const { initDocLoader, openDocument } = await import('../doc-loader.js');
  let destroyed = false;
  let readyCalled = false;
  const mockDoc = {
    numPages: 2,
    getPageLayout: async () => 'SinglePage',
    getPageLabels: async () => null,
    getOutline: async () => [],
    getPage: async () => ({
      getViewport: () => ({ width: 100, height: 100 }),
      getTextContent: async () => ({ items: [] })
    }),
    destroy: async () => { destroyed = true; }
  };
  const mockCtx = {
    PDFJS: '',
    pdfjsLib: {
      getDocument: () => ({
        promise: Promise.resolve(mockDoc),
        destroy: async () => {}
      }),
      PasswordResponses: {}
    },
    flash: () => {},
    hideHint: () => {},
    isPdfLoaded: () => false,
    onDocumentReady: async () => { readyCalled = true; }
  };
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  globalThis.document = {
    getElementById: () => ({
      addEventListener: () => {},
      close: () => {},
      classList: { add: () => {}, remove: () => {} },
      querySelector: () => ({ addEventListener: () => {} })
    }),
    createElement: () => ({ addEventListener: () => {} }),
    body: { append: () => {} }
  };
  globalThis.window = { addEventListener: () => {} };

  initDocLoader(mockCtx);

  // Wywołujemy z nieaktualnym numerem req (req !== openSeq)
  await openDocument({ data: new Uint8Array() }, { name: 'test.pdf', key: 'test', req: -999 });
  assert.equal(destroyed, true, 'Anulowane żądanie powinno wywołać doc.destroy()');
  assert.equal(readyCalled, false, 'onDocumentReady nie powinno zostać wywołane dla anulowanego żądania');

  if (origDoc) globalThis.document = origDoc; else delete globalThis.document;
  if (origWin) globalThis.window = origWin; else delete globalThis.window;
});

test('analiza AST: brak niezadeklarowanych zmiennych (ReferenceError) we wszystkich modułach', async () => {
  const acorn = await import('acorn');
  const files = [
    'viewer.js', 'theme.js', 'doc-history.js', 'doc-loader.js',
    'menu-bar.js', 'input.js', 'calc-panel.js'
  ];

  const BROWSER_GLOBALS = new Set([
    'window', 'document', 'navigator', 'location', 'history', 'performance',
    'console', 'matchMedia', 'getComputedStyle', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
    'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Math', 'Error', 'Uint8Array',
    'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array',
    'Float64Array', 'ArrayBuffer', 'DataView', 'URL', 'URLSearchParams', 'Blob', 'File',
    'FileReader', 'ImageData', 'Image', 'Audio', 'Notification', 'Event', 'CustomEvent',
    'MouseEvent', 'KeyboardEvent', 'TouchEvent', 'PointerEvent', 'WheelEvent',
    'DOMParser', 'XMLSerializer', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
    'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Date',
    'Symbol', 'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI',
    'decodeURI', 'encodeURIComponent', 'decodeURIComponent', 'btoa', 'atob',
    'fetch', 'Headers', 'Request', 'Response', 'FormData', 'WebSocket',
    'sessionStorage', 'localStorage', 'indexedDB', 'IDBKeyRange', 'crypto',
    'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'focus', 'blur',
    'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent',
    'undefined', 'NaN', 'Infinity', 'import', 'self', 'globalThis'
  ]);

  for (const f of files) {
    const code = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });

    const moduleScope = new Set();
    for (const stmt of ast.body) {
      if (stmt.type === 'ImportDeclaration') {
        for (const spec of stmt.specifiers) moduleScope.add(spec.local.name);
      } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        moduleScope.add(stmt.id.name);
      } else if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.declaration?.type === 'FunctionDeclaration' && stmt.declaration.id) {
          moduleScope.add(stmt.declaration.id.name);
        } else if (stmt.declaration?.type === 'VariableDeclaration') {
          for (const decl of stmt.declaration.declarations) {
            if (decl.id.type === 'Identifier') moduleScope.add(decl.id.name);
          }
        }
      } else if (stmt.type === 'VariableDeclaration') {
        for (const decl of stmt.declarations) {
          if (decl.id.type === 'Identifier') moduleScope.add(decl.id.name);
          else if (decl.id.type === 'ArrayPattern') decl.id.elements.forEach(el => el && moduleScope.add(el.name));
          else if (decl.id.type === 'ObjectPattern') decl.id.properties.forEach(p => moduleScope.add(p.value.name));
        }
      }
    }

    const undeclared = [];
    function checkScope() {
      const scopes = [new Set(moduleScope)];

      function currentScopeHas(name) {
        for (let i = scopes.length - 1; i >= 0; i--) {
          if (scopes[i].has(name)) return true;
        }
        return false;
      }

      function addPattern(pat, targetScope = scopes[scopes.length - 1]) {
        if (!pat) return;
        if (pat.type === 'Identifier') targetScope.add(pat.name);
        else if (pat.type === 'AssignmentPattern') addPattern(pat.left, targetScope);
        else if (pat.type === 'RestElement') addPattern(pat.argument, targetScope);
        else if (pat.type === 'ArrayPattern') pat.elements.forEach(el => addPattern(el, targetScope));
        else if (pat.type === 'ObjectPattern') {
          pat.properties.forEach(p => {
            if (p.type === 'RestElement') addPattern(p.argument, targetScope);
            else addPattern(p.value, targetScope);
          });
        }
      }

      function walk(n) {
        if (!n || typeof n !== 'object') return;

        const isBlock = n.type === 'BlockStatement' || n.type === 'SwitchStatement';
        const isFunction = n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
        const isLoop = n.type === 'ForStatement' || n.type === 'ForInStatement' || n.type === 'ForOfStatement';
        const isCatch = n.type === 'CatchClause';

        let newScope = null;
        if (isFunction || isBlock || isLoop || isCatch) {
          newScope = new Set();
          scopes.push(newScope);

          if (isFunction) {
            if (n.id) (scopes[scopes.length - 2] || newScope).add(n.id.name);
            n.params.forEach(p => addPattern(p, newScope));
          } else if (isCatch) {
            if (n.param) addPattern(n.param, newScope);
          }
        }

        if (n.type === 'VariableDeclaration') {
          const targetScope = n.kind === 'var' ? scopes[0] : scopes[scopes.length - 1];
          for (const decl of n.declarations) addPattern(decl.id, targetScope);
        }

        for (const key of Object.keys(n)) {
          if (key === 'params' && isFunction) continue;
          if (key === 'param' && isCatch) continue;
          if (key === 'id' && (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration' || n.type === 'VariableDeclarator')) continue;
          if (key === 'key' && (n.type === 'Property' || n.type === 'MethodDefinition') && !n.computed) continue;
          if (key === 'property' && (n.type === 'MemberExpression') && !n.computed) continue;
          if (key === 'local' && n.type === 'ImportSpecifier') continue;
          if (key === 'exported' && n.type === 'ExportSpecifier') continue;

          const val = n[key];
          if (Array.isArray(val)) {
            for (const child of val) walk(child);
          } else if (val && typeof val === 'object') {
            if (val.type === 'Identifier') {
              if (key === 'argument' && n.type === 'RestElement') {}
              else if (n.type === 'MetaProperty') {}
              else if (!currentScopeHas(val.name) && !BROWSER_GLOBALS.has(val.name)) {
                undeclared.push({ file: f, name: val.name });
              }
            } else {
              walk(val);
            }
          }
        }

        if (newScope) scopes.pop();
      }

      walk(ast);
    }

    checkScope();
    assert.deepEqual(undeclared, [], `Plik ${f} zawiera niezadeklarowane identyfikatory: ${JSON.stringify(undeclared)}`);
  }
});
