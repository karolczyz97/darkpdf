// doc-loader.js – otwieranie plików (z dysku, z bazy IndexedDB, z sieci przez wtyczkę), okno hasła i ekran startowy.

import { pref } from './util.js';
import * as geo from './layout.js';
import { fileRoute, fileHash } from './doc-url.js';
import { loadViaExtension } from './extension-loader.js';
import {
  isRemoteKey,
  rememberFile,
  identifyLocalFile,
  recentFiles,
  storedFile,
  forgetFile,
  bookmarks,
  toggleBookmark
} from './library.js';

let ctx = null;
let openSeq = 0;
let openController = null;
let loadingTask = null;
let lastRecent = null;

let pwDialog = null;
let pwInput = null;
let picker = null;
let welcome = null;

export const getLastRecent = () => lastRecent;
export const isPasswordOpen = () => Boolean(pwDialog?.open);
export const isDocumentLoading = () => openController !== null;

export function cancelDocumentLoad() {
  openSeq++;
  openController?.abort();
  openController = null;
  loadingTask?.destroy().catch(() => {});
  loadingTask = null;
  if (pwDialog?.open) pwDialog.close();
}

function beginLoad() {
  cancelDocumentLoad();
  openController = new AbortController();
  return { req: openSeq, signal: openController.signal };
}

function finishLoad(req) {
  if (req === openSeq) openController = null;
}

function nameFromUrl(u) {
  try {
    const last = new URL(u).pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || 'PDF');
  } catch { return 'PDF'; }
}

function openFailed(msg) {
  setEmpty(!ctx.isPdfLoaded());
  ctx.flash(msg, 4000);
}

function askPassword(wrong) {
  document.getElementById('pw-msg').textContent = wrong ? 'Nieprawidłowe hasło – spróbuj jeszcze raz.' : 'Ten plik jest chroniony hasłem.';
  pwInput.value = '';
  pwDialog.returnValue = '';
  pwDialog.showModal();
  pwInput.focus();
  return new Promise((resolve) =>
    pwDialog.addEventListener('close', () => resolve(pwDialog.returnValue === 'ok' ? pwInput.value : null), { once: true })
  );
}

export function extractPageStats(vp, tc) {
  const width = vp.width;
  const height = vp.height;
  if (!tc || !tc.items) return { width, height, textLength: 0, wordCount: 0, numbers: [] };

  let textLength = 0;
  let wordCount = 0;
  const numbers = [];

  for (const item of tc.items) {
    const s = (item.str || '').trim();
    if (!s) continue;
    textLength += s.length;
    wordCount += s.split(/\s+/).length;

    const rawX = item.transform?.[4] ?? 0;
    const rawY = item.transform?.[5] ?? 0;
    const [x, y] = vp.convertToViewportPoint ? vp.convertToViewportPoint(rawX, rawY) : [rawX, rawY];
    const inHeaderOrFooter = (y < height * 0.15) || (y > height * 0.85);
    if (inHeaderOrFooter) {
      const m = s.match(/^(?:[-—–\s]*|p(?:age|\.)\s*)(\d+)(?:[-—–\s]*)$/i);
      if (m) {
        numbers.push({
          value: parseInt(m[1], 10),
          x,
          side: x < width * 0.4 ? 'left' : (x > width * 0.6 ? 'right' : 'center')
        });
      }
    }
  }

  return { width, height, textLength, wordCount, numbers };
}

async function detectDocumentLayout(doc) {
  if (!doc) return { pairing: 'odd', two: true };
  if (doc.numPages <= 1) return { pairing: 'odd', two: false };

  try {
    let pageLayout = null;
    try { pageLayout = await doc.getPageLayout(); } catch {}

    let pageLabels = null;
    try { pageLabels = await doc.getPageLabels(); } catch {}

    let outlineTitles = [];
    try {
      const outline = await doc.getOutline();
      if (Array.isArray(outline)) {
        outlineTitles = outline.slice(0, 5).map((item) => item?.title || '');
      }
    } catch {}

    const p1 = await doc.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    const tc1 = await p1.getTextContent().catch(() => null);

    let p2Info = null;
    if (doc.numPages >= 2) {
      const p2 = await doc.getPage(2);
      const vp2 = p2.getViewport({ scale: 1 });
      const tc2 = await p2.getTextContent().catch(() => null);
      p2Info = extractPageStats(vp2, tc2);
    }

    const p1Info = extractPageStats(vp1, tc1);

    const pairing = geo.inferPairing({
      pageLayout,
      pageLabels,
      outlineTitles,
      numPages: doc.numPages,
      page1: p1Info,
      page2: p2Info
    });

    const two = geo.inferTwoPages({
      numPages: doc.numPages,
      page1: p1Info,
      page2: p2Info
    });

    return { pairing, two };
  } catch (err) {
    console.warn('Błąd detekcji układu dokumentu:', err);
    return { pairing: 'odd', two: true };
  }
}

// src – źródło dla pdf.js ({ data }); blob – oryginalny plik z dysku do zapamiętania; req – numer żądania
export async function openDocument(src, { name, key, page = null, blob = null, legacyKey = null, req }) {
  ctx.flash('Ładowanie…', 0);
  let doc, task, cancelled = false, installed = false, activating = false;
  try {
    task = ctx.pdfjsLib.getDocument({
      ...src,
      cMapUrl: ctx.PDFJS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: ctx.PDFJS + 'standard_fonts/',
      isEvalSupported: false
    });
    loadingTask = task;
    // PDF z hasłem: pdf.js pyta przez task.onPassword (ta sama nazwa jako opcja getDocument() jest ignorowana)
    task.onPassword = (update, reason) => {
      if (req !== openSeq) return;
      ctx.hideHint();
      askPassword(reason === ctx.pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (req !== openSeq) return;
        if (pw === null) { cancelled = true; update(new Error('Anulowano')); return; }
        ctx.flash('Ładowanie…', 0);
        update(pw);
      });
    };
    doc = await task.promise;
    if (req !== openSeq) return;
    const layoutHint = await detectDocumentLayout(doc);
    if (req !== openSeq) return;
    const saved = await rememberFile(key, name, blob, legacyKey);
    if (req !== openSeq) return;
    if (saved && legacyKey && history.state?.key === legacyKey) {
      history.replaceState({ ...history.state, key }, '', location.href);
    }
    activating = true;
    await ctx.onDocumentReady({ doc, name, key, page, blob, layoutHint });
    installed = true;
    if (req !== openSeq) return;
    ctx.hideHint();
    if (!saved) ctx.flash('Plik otwarto, ale nie udało się zapisać go w historii. Otwórz go ponownie z dysku, jeśli będzie potrzebny offline.', 5000);
  } catch (error) {
    if (req !== openSeq) return;
    if (cancelled) {
      ctx.hideHint();
      setEmpty(!ctx.isPdfLoaded());
    } else {
      if (activating) ctx.closeDocument();
      openFailed('Nie udało się otworzyć pliku: ' + (error?.message || error));
    }
  } finally {
    if (loadingTask === task) loadingTask = null;
    if (!installed) {
      if (doc) doc.destroy().catch(() => {});
      else task?.destroy().catch(() => {});
    }
    finishLoad(req);
  }
}

// Adres z wtyczki: …/darkpdf/#file=https://…/plik.pdf#page=12
export async function openFromHash() {
  const route = fileRoute(location.hash);
  if (!route) {
    if (location.hash === '#doc') {
      if (history.state?.key) {
        if (ctx.isPdfLoaded() && ctx.getFileKey?.() === history.state.key) return;
        return openStoredKey(history.state.key);
      }
      history.replaceState?.({ welcome: true }, '', location.pathname);
    }
    ctx.closeDocument();
    setEmpty(true);
    return;
  }
  const { req, signal } = beginLoad();
  const { url: clean, page } = route;
  setEmpty(false);
  ctx.flash('Ładowanie…', 0);
  try {
    const data = await loadViaExtension(clean, { signal, onProgress: (m) => {
      if (req !== openSeq) return;
      ctx.flash(m.total
        ? `Ładowanie… ${Math.min(99, Math.round(m.loaded / m.total * 100))}%`
        : `Ładowanie… ${(m.loaded / 1048576).toFixed(1)} MB`, 0);
    } });
    if (req !== openSeq) return;
    await openDocument({ data }, { name: nameFromUrl(clean), key: clean, page, req });
  } catch (err) {
    if (req !== openSeq) return;
    const messages = {
      NOEXT: 'Brak wtyczki DarkPDF – wybierz plik ręcznie',
      EXTTIMEOUT: 'Pobieranie zatrzymało się. Odśwież stronę przed ponowną próbą lub wybierz plik ręcznie.',
      EXTUPDATE: 'Wtyczka nie rozpoznaje przerwanych żądań. Odśwież stronę przed ponowną próbą lub wybierz plik ręcznie.'
    };
    openFailed(messages[err.message] || 'Nie udało się pobrać pliku: ' + err.message);
  } finally { finishLoad(req); }
}

// Zapis trasy i rozpoczęcie żądania są synchroniczne: Escape może anulować je już w tym samym kroku.
export function openUrl(url, page = null) {
  const hash = fileHash(url, page);
  if (location.hash !== hash) history.pushState({ doc: true, key: url }, '', location.pathname + hash);
  return openFromHash();
}

export async function openLocal(f) {
  if (!f) return;
  const { req } = beginLoad();
  setEmpty(false);
  ctx.flash('Ładowanie…', 0);
  try {
    const data = new Uint8Array(await f.arrayBuffer());
    if (req !== openSeq) return;
    const identity = await identifyLocalFile(f.name, data);
    if (req !== openSeq) return;
    await openDocument({ data }, { name: f.name, ...identity, blob: f, req });
  } catch (e) {
    if (req === openSeq) openFailed('Nie udało się otworzyć pliku: ' + (e?.message || e));
  } finally { finishLoad(req); }
}

export async function pickFile() {
  if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Pliki PDF', accept: { 'application/pdf': ['.pdf'] } }],
        multiple: false
      });
      if (handle) {
        const file = await handle.getFile();
        await openLocal(file);
        return;
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  if (!picker) return;
  picker.value = '';
  picker.click();
}

// Wiersze na ekranie startowym: ostatnie pliki i zakładki z możliwością usunięcia wpisu.
function renderList(id, items, onPick, onDelete = null) {
  const box = document.getElementById(id);
  if (!box) return;
  box.replaceChildren();
  box.hidden = items.length === 0;
  if (box.dataset.title && items.length) {
    const title = document.createElement('div');
    title.className = 'list-title';
    title.textContent = box.dataset.title;
    box.append(title);
  }
  for (const it of items.slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'recent-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-btn';
    btn.innerHTML = '<span class="rn"></span><span class="rp"></span>';
    btn.querySelector('.rn').textContent = it.name;
    btn.querySelector('.rp').textContent = `str. ${it.page}`;
    btn.title = it.title || it.name;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onPick(it); });
    row.append(btn);

    if (onDelete) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'recent-del';
      del.title = 'Usuń z listy';
      del.setAttribute('aria-label', `Usuń ${it.name} z listy`);
      del.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete(it);
      });
      row.append(del);
    }

    box.append(row);
  }
}

// Plik zapisany w przeglądarce. Uszkodzony wpis (pusty albo nieczytelny blob) usuwamy z listy.
export async function openStoredKey(key, page = null) {
  const load = beginLoad();
  try {
    const rec = await storedFile(key);
    if (load.req !== openSeq) return;
    if (rec?.blob) await openStored(rec, page, load);
    else if (isRemoteKey(key)) return openUrl(key, page);
    else ctx.flash('Ten plik nie jest już zapisany – otwórz go z dysku', 3000);
  } catch (error) {
    if (load.req === openSeq) openFailed('Nie udało się odczytać historii: ' + (error?.message || error));
  } finally { finishLoad(load.req); }
}

export async function openStored(rec, page = null, load = beginLoad()) {
  const { req } = load;
  setEmpty(false);
  try {
    let data = null;
    try { if (rec.blob.size) data = new Uint8Array(await rec.blob.arrayBuffer()); } catch {}
    if (req !== openSeq) return;
    if (!data) {
      await forgetFile(rec.key).catch(() => {});
      if (req === openSeq) openFailed('Zapisany plik jest uszkodzony lub niedostępny – otwórz go ponownie z dysku');
      return;
    }
    const identity = await identifyLocalFile(rec.name, data, rec.key);
    if (req !== openSeq) return;
    await openDocument({ data }, { name: rec.name, ...identity, page, blob: rec.blob, req });
  } catch (e) {
    if (req === openSeq) openFailed('Nie udało się otworzyć pliku: ' + (e?.message || e));
  } finally { finishLoad(req); }
}

export function openRecent(rec) {
  if (rec?.url) return openUrl(rec.url);
  if (rec?.blob) return openStored(rec);
}

async function deleteRecent(rec) {
  try { await forgetFile(rec.key); } catch (e) { console.warn('Nie udało się usunąć pliku:', e); }
  pref.remove('pos:' + rec.key);
  pref.remove('rot:' + rec.key);
  pref.remove('two:' + rec.key);
  pref.remove('pairing:' + rec.key);
  await renderRecent();
  ctx.flash('Usunięto z listy', 1200);
}

function deleteBookmark(m) {
  toggleBookmark(m.key, m.name, m.page);
  renderBookmarks();
  ctx.flash('Usunięto zakładkę', 1200);
}

function openBookmark(m) {
  return openStoredKey(m.key, m.page);
}

export async function renderRecent() {
  let all = [];
  try { all = await recentFiles(); } catch {}
  lastRecent = all[0] || null;
  const hintEl = document.getElementById('recentHint');
  if (hintEl) hintEl.hidden = all.length === 0;
  renderList('recent', all.map((r) => ({ ...r, page: pref.get('pos:' + r.key, 1), title: r.url || r.name })), openRecent, deleteRecent);
}

export function renderBookmarks() {
  renderList('marks', bookmarks(), openBookmark, deleteBookmark);
}

export function setEmpty(v) {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('empty', v);
    if (v) document.documentElement.classList.remove('nocursor');
  }
  if (v) {
    if (ctx?.isCalcOpen?.()) ctx.setCalcOpen(false);
    ctx?.resetCursor?.();
    renderRecent();
    renderBookmarks();
  }
}

export function initDocLoader(context) {
  ctx = context;

  pwDialog = document.getElementById('pw-dialog');
  pwInput = document.getElementById('pw-input');
  document.getElementById('pw-ok').addEventListener('click', () => pwDialog.close('ok'));
  document.getElementById('pw-cancel').addEventListener('click', () => pwDialog.close());
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pwDialog.close('ok'); } });

  picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'application/pdf,.pdf';
  picker.hidden = true;
  document.body.append(picker);
  picker.addEventListener('change', () => openLocal(picker.files[0]));

  welcome = document.getElementById('welcome');
  welcome.querySelector('.pick').addEventListener('click', (e) => { e.stopPropagation(); pickFile(); });

  let dragCount = 0;
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      if (++dragCount === 1) {
        welcome?.classList.add('drag');
        document.body.classList.add('dragging-file');
      }
    }
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (--dragCount <= 0) {
      dragCount = 0;
      welcome?.classList.remove('drag');
      document.body.classList.remove('dragging-file');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCount = 0;
    welcome?.classList.remove('drag');
    document.body.classList.remove('dragging-file');
    const f = e.dataTransfer?.files?.[0];
    if (f) openLocal(f);
  });

  window.addEventListener('hashchange', openFromHash);
}
