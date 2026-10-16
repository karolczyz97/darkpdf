import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import { fileRoute, fileHash } from '../doc-url.js';
import { localFileKey, identifyLocalFile, rememberFile, recentFiles, storedFile, forgetFile, bookmarks } from '../library.js';
import { pref } from '../util.js';
import { initDocHistory, updateDocHistory } from '../doc-history.js';

const data = (text) => new TextEncoder().encode(text);
const storage = new Map();
globalThis.indexedDB = indexedDB;
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };

test('adresy PDF zachowują spacje, procenty, zapytania i numer strony', () => {
  for (const url of ['https://files/a%20b.pdf', 'https://files/żółć.pdf?q=a%26b&v=1', 'file:///C:/a%20b.pdf']) {
    assert.deepEqual(fileRoute(fileHash(url, 12)), { url, page: 12 });
  }
  assert.deepEqual(fileRoute('#file=https://files/a%20b.pdf#page=3'), { url: 'https://files/a%20b.pdf', page: 3 });
  assert.deepEqual(fileRoute('#file=https%3A%2F%2Ffiles%2Fa%2520b.pdf'), { url: 'https://files/a%20b.pdf', page: null });
  assert.equal(fileRoute('#doc'), null);
});

test('zakodowany adres startowy nie dopisuje drugiego wpisu historii', (t) => {
  const old = { window: globalThis.window, location: globalThis.location, history: globalThis.history };
  const url = 'https://files/a%20b.pdf';
  globalThis.location = { hash: fileHash(url), pathname: '/darkpdf/', href: 'https://reader/darkpdf/' + fileHash(url) };
  globalThis.window = { addEventListener() {} };
  let pushes = 0;
  globalThis.history = { state: null, replaceState(state) { this.state = state; }, pushState() { pushes++; } };
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  initDocHistory({});
  updateDocHistory(url);
  assert.equal(pushes, 0);
  assert.equal(history.state.key, url);
});

test('zmiana hash aktualizuje istniejący wpis i zachowuje numer strony', (t) => {
  const old = { location: globalThis.location, history: globalThis.history };
  const url = 'https://files/a%20b.pdf';
  globalThis.location = { hash: fileHash(url, 12), pathname: '/darkpdf/' };
  let pushes = 0, replacedUrl;
  globalThis.history = { state: null, replaceState(state, _, target) { this.state = state; replacedUrl = target; }, pushState() { pushes++; } };
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  updateDocHistory(url);
  assert.equal(pushes, 0);
  assert.equal(replacedUrl, '/darkpdf/' + fileHash(url, 12));
  assert.equal(history.state.key, url);
});

test('ten sam rozmiar i nazwa nie łączą różnych PDF-ów', async () => {
  const a = await identifyLocalFile('same.pdf', data('AAA'));
  const b = await identifyLocalFile('same.pdf', data('BBB'));
  assert.notEqual(a.key, b.key);
  await rememberFile(a.key, 'same.pdf', new Blob(['AAA']));
  await rememberFile(b.key, 'same.pdf', new Blob(['BBB']));
  assert.equal(await (await storedFile(a.key)).blob.text(), 'AAA');
  assert.equal(await (await storedFile(b.key)).blob.text(), 'BBB');
  assert.equal(await localFileKey(data('AAA')), a.key);
});

test('migracja pasującego starego dokumentu zachowuje pozycję i zakładki', async () => {
  const oldKey = 'local:old.pdf:3';
  await rememberFile(oldKey, 'old.pdf', new Blob(['ABC']));
  pref.set('pos:' + oldKey, 12);
  pref.set('rot:' + oldKey, 90);
  pref.setJson('bookmarks', [{ key: oldKey, name: 'old.pdf', page: 12 }]);
  const identity = await identifyLocalFile('old.pdf', data('ABC'));
  assert.equal(identity.legacyKey, oldKey);
  assert.ok(await rememberFile(identity.key, 'old.pdf', new Blob(['ABC']), identity.legacyKey));
  assert.equal(await storedFile(oldKey), undefined);
  assert.equal(pref.get('pos:' + identity.key, 1), 12);
  assert.equal(pref.get('rot:' + identity.key, 0), 90);
  assert.equal(bookmarks()[0].key, identity.key);
});

test('kolizja starego klucza nie przenosi zakładek do innego pliku', async () => {
  const oldKey = 'local:collision.pdf:3';
  await rememberFile(oldKey, 'collision.pdf', new Blob(['AAA']));
  pref.setJson('bookmarks', [{ key: oldKey, name: 'collision.pdf', page: 4 }]);
  const identity = await identifyLocalFile('collision.pdf', data('BBB'));
  assert.equal(identity.legacyKey, null);
  await rememberFile(identity.key, 'collision.pdf', new Blob(['BBB']));
  assert.equal(bookmarks()[0].key, oldKey);
  assert.equal(await (await storedFile(oldKey)).blob.text(), 'AAA');
});

test('historia po równoległych zapisach ma osiem wpisów', async () => {
  for (const rec of await recentFiles()) await forgetFile(rec.key);
  await Promise.all(Array.from({ length: 12 }, (_, i) => rememberFile('local:' + i, String(i), new Blob(['PDF']))));
  const all = await recentFiles();
  assert.equal(all.length, 8);
  assert.ok(all.some((r) => r.key === 'local:11'));
});

test('błąd limitu miejsca jest zgłaszany bez usuwania starych dokumentów', async (t) => {
  const before = (await recentFiles()).map((r) => r.key).sort();
  t.mock.method(IDBObjectStore.prototype, 'put', () => { throw new DOMException('Brak miejsca', 'QuotaExceededError'); });
  assert.equal(await rememberFile('local:new', 'new.pdf', new Blob(['PDF'])), false);
  assert.deepEqual((await recentFiles()).map((r) => r.key).sort(), before);
});

test('uszkodzony zapis zakładek nie psuje ekranu startowego', () => {
  pref.setJson('bookmarks', { unexpected: true });
  assert.deepEqual(bookmarks(), []);
});

test('zamknięcie w trakcie parsowania niszczy zadanie i nie otwiera starego PDF-a', async (t) => {
  const { initDocLoader, openLocal, cancelDocumentLoad } = await import('../doc-loader.js');
  const old = { document: globalThis.document, window: globalThis.window };
  const element = { addEventListener() {}, querySelector() { return element; }, classList: { toggle() {}, remove() {} }, append() {} };
  globalThis.document = { getElementById: () => element, createElement: () => element, documentElement: element, body: element };
  globalThis.window = { addEventListener() {} };
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const started = Promise.withResolvers(), parsed = Promise.withResolvers();
  let destroyed = 0, ready = 0;
  initDocLoader({
    PDFJS: '', flash() {}, hideHint() {}, isPdfLoaded: () => false,
    pdfjsLib: { getDocument: () => {
      started.resolve();
      return { promise: parsed.promise, destroy: async () => { destroyed++; parsed.reject(new Error('Anulowano')); } };
    } },
    onDocumentReady: async () => { ready++; }
  });
  const opening = openLocal({ name: 'cancel.pdf', arrayBuffer: async () => data('PDF').buffer });
  await started.promise;
  cancelDocumentLoad();
  await opening;
  assert.ok(destroyed > 0);
  assert.equal(ready, 0);
});
