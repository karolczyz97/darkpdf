// library.js – ostatnio otwierane pliki i zakładki z ekranu startowego.
// Pliki z dysku trzymamy w IndexedDB przeglądarki, więc otwierają się bez pytania o dysk.
// Dla plików z sieci pamiętamy sam adres i pobieramy je ponownie przez wtyczkę.
import { pref } from './util.js';

const RECENT_MAX = 8;     // tyle plików trzymamy w pamięci przeglądarki
const MARKS_MAX = 30;     // tyle zakładek pamiętamy

// Klucz pliku z sieci to jego adres; plik z dysku ma klucz „local:nazwa:rozmiar”
export const isRemoteKey = (key) => /^(https?|file):/i.test(key);

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

// Zapamiętuje plik (blob z dysku albo sam adres z sieci); najstarsze ponad RECENT_MAX wypadają
export async function rememberFile(key, name, blob) {
  try {
    const rec = { key, name, ts: Date.now() };
    if (isRemoteKey(key)) rec.url = key;
    else if (blob?.size) rec.blob = blob;
    else return;                             // pusty plik nie ma czego pamiętać
    await transaction('readwrite', (st) => st.put(rec));
    for (const old of (await recentFiles()).slice(RECENT_MAX)) await forgetFile(old.key);
  } catch {}
}

// Zapamiętane pliki, najnowsze pierwsze
export async function recentFiles() {
  const all = await transaction('readonly', (st) => st.getAll());
  return (all || []).sort((a, b) => b.ts - a.ts);
}

export const storedFile = (key) => transaction('readonly', (st) => st.get(key));
export const forgetFile = (key) => transaction('readwrite', (st) => st.delete(key));

// ---------- zakładki ----------
// [{ key, name, page, ts }], najnowsze pierwsze
export const bookmarks = () => pref.json('bookmarks', []);

// Dodaje albo usuwa zakładkę; zwraca true, gdy dodano
export function toggleBookmark(key, name, page) {
  const all = bookmarks();
  const had = all.some((m) => m.key === key && m.page === page);
  const rest = all.filter((m) => m.key !== key || m.page !== page);
  if (!had) rest.unshift({ key, name, page, ts: Date.now() });
  pref.setJson('bookmarks', rest.slice(0, MARKS_MAX));
  return !had;
}
