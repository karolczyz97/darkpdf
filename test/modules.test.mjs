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
  hideMenu
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

  // viewer.js jest odchudzony o ponad 700 linii
  const lineCount = viewerJs.split('\n').length;
  assert.ok(lineCount < 800, `viewer.js powinien być zwięzły (<800 linii), ma ${lineCount}`);
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
