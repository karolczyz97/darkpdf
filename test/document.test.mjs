import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import { fileRoute, fileHash } from '../doc-url.js';
import { localFileKey, identifyLocalFile, rememberFile, recentFiles, storedFile, forgetFile, bookmarks, toggleBookmark, removeFromRecent } from '../library.js';
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
  assert.equal(fileRoute('#file='), null);              // pusty adres nie jest trasą
  assert.equal(fileRoute('#file=#page=3'), null);
  assert.equal(fileRoute('#file=   '), null);
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

test('pusty plik i plik, który nie jest PDF-em, dostają komunikat po polsku', async (t) => {
  const { initDocLoader, openLocal } = await import('../doc-loader.js');
  const old = { document: globalThis.document, window: globalThis.window };
  const element = { addEventListener() {}, querySelector() { return element; }, classList: { toggle() {}, remove() {} }, append() {} };
  globalThis.document = { getElementById: () => element, createElement: () => element, documentElement: element, body: element };
  globalThis.window = { addEventListener() {} };
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const messages = [];
  const invalid = Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' });
  initDocLoader({
    PDFJS: '', flash: (text) => messages.push(text), hideHint() {}, isPdfLoaded: () => true,
    pdfjsLib: { getDocument: () => ({ promise: Promise.reject(invalid), destroy: async () => {} }) },
    onDocumentReady: async () => {}
  });
  await openLocal({ name: 'pusty.pdf', arrayBuffer: async () => new ArrayBuffer(0) });
  assert.equal(messages.at(-1), 'Nie udało się otworzyć pliku: plik jest pusty');
  await openLocal({ name: 'notatka.txt', arrayBuffer: async () => data('to nie PDF').buffer });
  assert.equal(messages.at(-1), 'Nie udało się otworzyć pliku: to nie jest plik PDF albo plik jest uszkodzony');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, tries = 50) {
  for (let i = 0; i < tries; i++) { if (await check()) return true; await sleep(5); }
  return false;
}
async function clearLibrary() {
  for (const key of ['local:marked', 'local:plain', ...Array.from({ length: 12 }, (_, i) => 'local:n' + i)]) await forgetFile(key);
  for (const rec of await recentFiles()) await forgetFile(rec.key);
  pref.setJson('bookmarks', []);
}

test('plik z zakładką zostaje w bazie po otwarciu ponad ośmiu nowszych PDF-ów', async () => {
  await clearLibrary();
  await rememberFile('local:marked', 'marked.pdf', new Blob(['MARK']));
  pref.setJson('bookmarks', [{ key: 'local:marked', name: 'marked.pdf', page: 5 }]);
  for (let i = 0; i < 9; i++) { await sleep(3); await rememberFile('local:n' + i, `n${i}.pdf`, new Blob(['PDF'])); }
  const visible = await recentFiles();
  assert.equal(visible.length, 8, 'lista „Ostatnie” ma osiem wpisów');
  assert.ok(!visible.some((r) => r.key === 'local:marked'), 'plik z zakładką nie jest już na liście');
  assert.equal(await storedFile('local:n0'), undefined, 'najstarszy plik bez zakładki wypada');
  const kept = await storedFile('local:marked');
  assert.equal(kept.hiddenFromRecent, true);
  assert.equal(await kept.blob.text(), 'MARK', 'zakładka nadal ma plik do otwarcia');
});

test('usunięcie ostatniej zakładki sprząta ukryty plik, a zakładki innej strony go zostawiają', async () => {
  await clearLibrary();
  await rememberFile('local:marked', 'marked.pdf', new Blob(['MARK']));
  pref.setJson('bookmarks', [{ key: 'local:marked', name: 'marked.pdf', page: 1 }, { key: 'local:marked', name: 'marked.pdf', page: 2 }]);
  assert.equal(await removeFromRecent('local:marked'), true);
  assert.equal((await storedFile('local:marked')).hiddenFromRecent, true);
  assert.equal((await recentFiles()).length, 0);
  assert.equal(toggleBookmark('local:marked', 'marked.pdf', 1), false);          // zostaje zakładka na stronie 2
  await sleep(30);
  assert.ok(await storedFile('local:marked'), 'jeszcze jedna zakładka – plik zostaje');
  assert.equal(toggleBookmark('local:marked', 'marked.pdf', 2), false);          // ostatnia
  assert.ok(await until(async () => (await storedFile('local:marked')) === undefined), 'plik bez zakładek znika z bazy');
});

test('usunięcie z listy „Ostatnie” bez zakładki kasuje plik i jego ustawienia', async () => {
  await clearLibrary();
  await rememberFile('local:plain', 'plain.pdf', new Blob(['PLAIN']));
  pref.set('pos:local:plain', 7);
  assert.equal(await removeFromRecent('local:plain'), false);
  assert.equal(await storedFile('local:plain'), undefined);
  assert.equal(pref.get('pos:local:plain'), undefined);
});

test('ukryty plik bez zakładek (np. po przekroczeniu limitu zakładek) znika przy następnym zapisie', async () => {
  await clearLibrary();
  await rememberFile('local:marked', 'marked.pdf', new Blob(['MARK']));
  pref.setJson('bookmarks', [{ key: 'local:marked', name: 'marked.pdf', page: 1 }]);
  await removeFromRecent('local:marked');
  pref.setJson('bookmarks', []);
  await rememberFile('local:plain', 'plain.pdf', new Blob(['PLAIN']));
  assert.equal(await storedFile('local:marked'), undefined);
  assert.ok(await storedFile('local:plain'));
  await clearLibrary();
});
