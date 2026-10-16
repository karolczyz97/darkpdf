import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBDatabase } from 'fake-indexeddb';
import * as loader from '../doc-loader.js';
import { initDocHistory, updateDocHistory, goHome } from '../doc-history.js';
import { rememberFile } from '../library.js';

globalThis.indexedDB = indexedDB;
const bytes = new TextEncoder().encode('PDF B');

function setup(t, stage) {
  loader.cancelDocumentLoad();
  const old = { window: globalThis.window, document: globalThis.document, location: globalThis.location, history: globalThis.history };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const listeners = {};
  const state = { loaded: true, key: 'local:A', empty: false, displayed: [], destroyed: 0, restores: 0 };
  const element = { addEventListener() {}, querySelector() { return element; }, classList: { toggle(name, value) { if (name === 'empty') state.empty = value; }, remove() {} }, append() {} };
  globalThis.document = { getElementById: () => element, createElement: () => element, documentElement: element, body: element };
  globalThis.window = { addEventListener: (name, fn) => listeners[name] = fn };
  globalThis.location = { hash: '', pathname: '/darkpdf/', href: 'https://reader/darkpdf/' };
  const writeHistory = (value, _, target) => {
    history.state = value;
    location.hash = target.includes('#') ? target.slice(target.indexOf('#')) : '';
    location.href = 'https://reader' + target;
  };
  globalThis.history = { state: null, replaceState: writeHistory, pushState: writeHistory, back() {} };
  const closeDocument = () => { loader.cancelDocumentLoad(); state.loaded = false; state.key = null; };
  const doc = {
    numPages: 2,
    getPageLayout: async () => { if (stage === 'layout') { entered.resolve(); await release.promise; } return null; },
    getPageLabels: async () => null, getOutline: async () => [],
    getPage: async () => ({ getViewport: () => ({ width: 300, height: 400 }), getTextContent: async () => ({ items: [] }) }),
    destroy: async () => { state.destroyed++; }
  };
  loader.initDocLoader({
    PDFJS: '', flash() {}, hideHint() {}, closeDocument, isPdfLoaded: () => state.loaded,
    getFileKey: () => state.key,
    pdfjsLib: { getDocument: () => {
      if (stage === 'parse') entered.resolve();
      return { promise: stage === 'parse' ? release.promise.then(() => doc) : Promise.resolve(doc), destroy: async () => { state.destroyed++; } };
    } },
    onDocumentReady: async ({ key }) => { state.displayed.push(key); state.key = key; state.loaded = true; state.empty = false; }
  });
  initDocHistory({
    isPdfLoaded: () => state.loaded, getFileKey: () => state.key, closeDocument,
    setEmpty: (value) => state.empty = value,
    openStored: (rec) => { state.restores++; return loader.openStored(rec); },
    openStoredKey: (key) => loader.openStoredKey(key)
  });
  updateDocHistory('local:A');
  t.after(() => {
    loader.cancelDocumentLoad();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  });
  return { entered, release, state, listeners };
}

// Opóźniamy zakończenie rzeczywistej transakcji fake-indexeddb, nie samą funkcję anulowania.
function delayTransaction(t, matches, entered, release) {
  const transaction = IDBDatabase.prototype.transaction;
  t.mock.method(IDBDatabase.prototype, 'transaction', function (...args) {
    const tx = transaction.apply(this, args);
    let blocked = false;
    return new Proxy(tx, {
      get(target, property) {
        if (property === 'objectStore') return (name) => {
          const store = target.objectStore(name);
          return new Proxy(store, {
            get(targetStore, operation) {
              const value = Reflect.get(targetStore, operation, targetStore);
              if (typeof value !== 'function') return value;
              return (...args) => { if (matches(operation, args[0])) blocked = true; return value.apply(targetStore, args); };
            }
          });
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) {
        if (property === 'oncomplete') {
          target.oncomplete = (event) => {
            if (!blocked) return value(event);
            entered.resolve();
            release.promise.then(() => value(event));
          };
          return true;
        }
        return Reflect.set(target, property, value, target);
      }
    });
  });
}

for (const stage of ['read', 'parse', 'layout', 'save']) {
  test(`PDF A → otwieranie B (${stage}) → ekran główny: B nie wraca`, async (t) => {
    const { entered, release, state } = setup(t, stage);
    const file = Object.assign(new Blob([bytes]), { name: 'B.pdf' });
    if (stage === 'read') file.arrayBuffer = () => { entered.resolve(); return release.promise.then(() => bytes.buffer.slice(0)); };
    if (stage === 'save') delayTransaction(t, (op, value) => op === 'put' && value.name === 'B.pdf', entered, release);
    const opening = loader.openLocal(file);
    await entered.promise;
    goHome();
    release.resolve();
    await opening;
    assert.equal(state.empty, true, 'Powrót powinien natychmiast pokazać ekran główny');
    assert.equal(state.loaded, false);
    assert.deepEqual(state.displayed, [], 'B nie może zostać przekazany do wyświetlenia');
    assert.equal(history.state.welcome, true);
  });
}

test('spóźniony odczyt pliku z historii nie odwraca powrotu na ekran główny', async (t) => {
  const { entered, release, state, listeners } = setup(t);
  const key = 'local:history-B';
  await rememberFile(key, 'B.pdf', new Blob([bytes]));
  delayTransaction(t, (op, value) => op === 'get' && value === key, entered, release);
  history.state = { doc: true, key };
  location.hash = '#doc';
  const restoration = listeners.popstate({ state: history.state });
  await entered.promise;
  goHome();
  release.resolve();
  await restoration;
  assert.equal(state.restores, 0, 'Nieaktualny callback historii nie może rozpocząć nowego otwierania');
  assert.deepEqual(state.displayed, []);
  assert.equal(state.empty, true);
});

test('opóźnione zdarzenie historii nie przywraca trasy opuszczonej przez użytkownika', async (t) => {
  const { state, listeners } = setup(t);
  const key = 'local:queued-history';
  await rememberFile(key, 'B.pdf', new Blob([bytes]));
  goHome();
  await listeners.popstate({ state: { doc: true, key } });
  assert.deepEqual(state.displayed, []);
  assert.equal(state.empty, true);
  assert.equal(history.state.welcome, true);
});
