// library.js – ostatnio otwierane pliki i zakładki z ekranu startowego.
// Pliki z dysku trzymamy w IndexedDB przeglądarki, więc otwierają się bez pytania o dysk.
// Dla plików z sieci pamiętamy sam adres i pobieramy je ponownie przez wtyczkę.
import { pref } from './util.js';

const RECENT_MAX = 8;     // tyle plików pokazuje lista „Ostatnie”
const MARKS_MAX = 30;     // tyle zakładek pamiętamy

// Klucz pliku z sieci to jego adres; lokalny plik identyfikuje skrót jego zawartości.
export const isRemoteKey = (key) => /^(https?|file):/i.test(key);

export async function localFileKey(data) {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return 'local:sha256:' + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function identifyLocalFile(name, data, oldKey = `local:${name}:${data.byteLength}`) {
  const key = await localFileKey(data);
  let legacyKey = null;
  if (oldKey !== key) {
    try {
      const old = await storedFile(oldKey);
      if (old?.blob && await localFileKey(await old.blob.arrayBuffer()) === key) legacyKey = oldKey;
    } catch {}                 // brak dostępu do bazy nie blokuje odczytania PDF-a
  }
  return { key, legacyKey };
}

function migratePreferences(oldKey, key) {
  for (const prefix of ['pos:', 'rot:', 'two:', 'pairing:']) {
    const value = pref.get(prefix + oldKey);
    if (value !== undefined && pref.get(prefix + key) === undefined) pref.set(prefix + key, value);
    pref.remove(prefix + oldKey);
  }
  const marks = bookmarks().map((m) => m.key === oldKey ? { ...m, key } : m);
  pref.setJson('bookmarks', marks.filter((m, i) => marks.findIndex((other) => other.key === m.key && other.page === m.page) === i));
}

// ---------- IndexedDB ----------
let dbPromise = null;     // jedno połączenie na całą sesję
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('darkpdf', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('recent', { keyPath: 'key' });
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => { d.close(); dbPromise = null; };   // inna karta chce nowszej wersji bazy
      resolve(d);
    };
    r.onerror = () => reject(r.error);
  }).catch((e) => { dbPromise = null; throw e; });                  // następna próba otworzy na nowo
  return dbPromise;
}

// Jedna transakcja: fn(store) zwraca żądanie IndexedDB, a my – jego wynik po zakończeniu transakcji
async function transaction(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('recent', mode);
    const req = fn(tx.objectStore('recent'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// Zapamiętuje plik (blob z dysku albo sam adres z sieci). Lista „Ostatnie” ma najwyżej RECENT_MAX wpisów;
// starszy plik, który ma zakładkę, nie jest kasowany – zostaje w bazie z hiddenFromRecent (otwiera go zakładka),
// a bez zakładki wypada. Ukryty plik, który stracił zakładki, też wypada.
export async function rememberFile(key, name, blob, legacyKey = null) {
  try {
    const rec = { key, name, ts: Date.now() };
    if (isRemoteKey(key)) rec.url = key;
    else if (blob?.size) rec.blob = blob;
    else return false;
    const marked = new Set(bookmarks().map((b) => b.key));
    await transaction('readwrite', (st) => {
      const put = st.put(rec);
      if (legacyKey) st.delete(legacyKey);
      const all = st.getAll();
      all.onsuccess = () => {
        const others = all.result.filter((r) => r.key !== key);
        for (const hidden of others.filter((r) => r.hiddenFromRecent && !marked.has(r.key))) st.delete(hidden.key);
        const visible = others.filter((r) => !r.hiddenFromRecent).sort((a, b) => b.ts - a.ts);
        for (const old of visible.slice(RECENT_MAX - 1)) {
          if (old.blob && marked.has(old.key)) st.put({ ...old, hiddenFromRecent: true });
          else st.delete(old.key);
        }
      };
      return put;
    });
    if (legacyKey) migratePreferences(legacyKey, key);
    return true;
  } catch { return false; }
}

// Pliki z listy „Ostatnie”, najnowsze pierwsze (bez tych, które trzyma tylko zakładka)
export async function recentFiles() {
  const all = await transaction('readonly', (st) => st.getAll());
  return (all || []).filter((r) => !r.hiddenFromRecent).sort((a, b) => b.ts - a.ts);
}

export const storedFile = (key) => transaction('readonly', (st) => st.get(key));
export const forgetFile = (key) => transaction('readwrite', (st) => st.delete(key));

// Usuwa plik z listy „Ostatnie”: z zakładką zostaje w bazie (ukryty), bez niej znika razem z ustawieniami strony.
// Zwraca true, gdy plik został w bazie dla zakładki.
export async function removeFromRecent(key) {
  const rec = await storedFile(key);
  if (rec?.blob && bookmarks().some((m) => m.key === key)) {
    await transaction('readwrite', (st) => st.put({ ...rec, hiddenFromRecent: true }));
    return true;
  }
  await forgetDocument(key);
  return false;
}

export async function forgetDocument(key) {
  await forgetFile(key);
  for (const prefix of ['pos:', 'rot:', 'two:', 'pairing:']) pref.remove(prefix + key);
}

// Ukryty plik, który stracił ostatnią zakładkę, nie ma już po co zajmować miejsca w bazie
export async function forgetIfOrphaned(key) {
  try {
    const rec = await storedFile(key);
    if (rec?.hiddenFromRecent && !bookmarks().some((m) => m.key === key)) await forgetDocument(key);
  } catch {}               // brak dostępu do bazy nie blokuje zakładek; osieroconego pliku pozbędzie się rememberFile()
}

// ---------- zakładki ----------
// [{ key, name, page, ts }], najnowsze pierwsze
export const bookmarks = () => {
  const value = pref.json('bookmarks', []);
  return Array.isArray(value) ? value.filter((m) => m && typeof m.key === 'string' && typeof m.name === 'string' && Number.isInteger(m.page) && m.page > 0) : [];
};

// Dodaje albo usuwa zakładkę; zwraca true, gdy dodano
export function toggleBookmark(key, name, page) {
  const all = bookmarks();
  const had = all.some((m) => m.key === key && m.page === page);
  const rest = all.filter((m) => m.key !== key || m.page !== page);
  if (!had) rest.unshift({ key, name, page, ts: Date.now() });
  pref.setJson('bookmarks', rest.slice(0, MARKS_MAX));
  if (had) void forgetIfOrphaned(key);
  return !had;
}
