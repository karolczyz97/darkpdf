// doc-loader.js – otwieranie plików (z dysku, z bazy IndexedDB, z sieci przez wtyczkę), okno hasła i ekran startowy.

import { pref } from './util.js';
import * as geo from './layout.js';
import {
  isRemoteKey,
  rememberFile,
  recentFiles,
  storedFile,
  forgetFile,
  bookmarks,
  toggleBookmark
} from './library.js';

let ctx = null;
let openSeq = 0;
let lastRecent = null;

let pwDialog = null;
let pwInput = null;
let picker = null;
let welcome = null;

export const getLastRecent = () => lastRecent;
export const isPasswordOpen = () => Boolean(pwDialog?.open);

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

// Plik z sieci pobiera wtyczka DarkPDF (strona sama nie ominie CORS); odpowiada przez postMessage
function loadViaExtension(url) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const timer = setTimeout(() => {
      if (!answered) { window.removeEventListener('message', onMsg); reject(new Error('NOEXT')); }
    }, 3000);
    function onMsg(e) {
      if (e.source !== window || e.data?.source !== 'zen-ext') return;
      answered = true;
      clearTimeout(timer);
      const m = e.data;
      if (m.type === 'progress') {
        ctx.flash(m.total
          ? `Ładowanie… ${Math.min(99, Math.round(m.loaded / m.total * 100))}%`
          : `Ładowanie… ${(m.loaded / 1048576).toFixed(1)} MB`, 0);
      } else if (m.type === 'data') {
        window.removeEventListener('message', onMsg);
        resolve(new Uint8Array(m.buffer));
      } else if (m.type === 'error') {
        window.removeEventListener('message', onMsg);
        reject(new Error(m.message));
      }
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'zen-page', type: 'load', url }, location.origin);
  });
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
export async function openDocument(src, { name, key, page = null, blob = null, req }) {
  ctx.flash('Ładowanie…', 0);
  let doc, task, cancelled = false;
  try {
    task = ctx.pdfjsLib.getDocument({
      ...src,
      cMapUrl: ctx.PDFJS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: ctx.PDFJS + 'standard_fonts/',
      isEvalSupported: false
    });
    // PDF z hasłem: pdf.js pyta przez task.onPassword (ta sama nazwa jako opcja getDocument() jest ignorowana)
    task.onPassword = (update, reason) => {
      ctx.hideHint();
      askPassword(reason === ctx.pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw === null) { cancelled = true; update(new Error('Anulowano')); return; }
        ctx.flash('Ładowanie…', 0);
        update(pw);
      });
    };
    doc = await task.promise;
  } catch (err) {
    task?.destroy().catch(() => {});
    if (req !== openSeq) return;          // w międzyczasie wybrano inny plik
    if (cancelled) {                      // rezygnacja z hasła to nie błąd – zostaje to, co było otwarte
      ctx.hideHint();
      setEmpty(!ctx.isPdfLoaded());
      return;
    }
    openFailed('Nie udało się otworzyć pliku: ' + (err?.message || err));
    return;
  }
  if (req !== openSeq) { doc.destroy().catch(() => {}); return; }

  try {
    const layoutHint = await detectDocumentLayout(doc);
    if (req !== openSeq) { doc.destroy().catch(() => {}); return; }
    rememberFile(key, name, blob);
    await ctx.onDocumentReady({ doc, name, key, page, blob, layoutHint });
  } catch (e) {
    doc.destroy().catch(() => {});
    console.error('Błąd inicjalizacji PDF:', e);
    ctx.flash('Błąd podczas wyświetlania: ' + (e?.message || e), 4000);
    return;
  }
  ctx.hideHint();
}

// Adres z wtyczki: …/darkpdf/#file=https://…/plik.pdf#page=12
export async function openFromHash() {
  const req = ++openSeq;
  const h = location.href;
  const i = h.indexOf('#file=');
  if (i < 0) {
    if (location.hash === '#doc') {
      if (ctx.isPdfLoaded()) return;
      if (history.state?.key) {
        try {
          const rec = await storedFile(history.state.key);
          if (rec?.blob) { openStored(rec); return; }
        } catch {}
      }
      history.replaceState?.({ welcome: true }, '', location.pathname);
    }
    ctx.closeDocument();
    setEmpty(true);
    return;
  }
  let url = h.slice(i + 6);
  if (/^[a-z]+%3A/i.test(url)) { try { url = decodeURIComponent(url); } catch {} }   // zepsute %… zostawiamy jak są
  const pm = /#page=(\d+)/.exec(url);
  const clean = url.split('#')[0];
  setEmpty(false);
  ctx.flash('Ładowanie…', 0);
  try {
    const data = await loadViaExtension(clean);
    if (req !== openSeq) return;
    openDocument({ data }, { name: nameFromUrl(clean), key: clean, page: pm ? +pm[1] : null, req });
  } catch (err) {
    if (req !== openSeq) return;
    openFailed(err.message === 'NOEXT'
      ? 'Brak wtyczki DarkPDF – wybierz plik ręcznie'
      : 'Nie udało się pobrać pliku: ' + err.message);
  }
}

// Plik z sieci otwieramy przez adres (#file=…). Ten sam adres co teraz (np. ponowna próba po błędzie)
// nie wywołuje hashchange – wtedy otwieramy wprost.
export function openUrl(url, page = null) {
  const before = location.href;
  location.hash = '#file=' + url + (page ? '#page=' + page : '');
  if (location.href === before) openFromHash();
}

export async function openLocal(f) {
  if (!f) return;
  const req = ++openSeq;
  setEmpty(false);
  ctx.flash('Ładowanie…', 0);
  let data;
  try {
    data = new Uint8Array(await f.arrayBuffer());
  } catch (e) {
    if (req === openSeq) openFailed('Nie udało się odczytać pliku: ' + (e?.message || e));
    return;
  }
  if (req !== openSeq) return;
  openDocument({ data }, { name: f.name, key: `local:${f.name}:${f.size}`, blob: f, req });
}

export function pickFile() {
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
      del.innerHTML = '<svg class="ic" aria-hidden="true" style="width:14px;height:14px"><use href="#i-close"/></svg>';
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
export async function openStored(rec, page = null) {
  const req = ++openSeq;
  setEmpty(false);
  let data = null;
  try { if (rec.blob.size) data = new Uint8Array(await rec.blob.arrayBuffer()); } catch {}
  if (req !== openSeq) return;
  if (!data) {
    await forgetFile(rec.key).catch(() => {});
    openFailed('Zapisany plik jest uszkodzony lub niedostępny – otwórz go ponownie z dysku');
    return;
  }
  openDocument({ data }, { name: rec.name, key: rec.key, page, blob: rec.blob, req });
}

export function openRecent(rec) {
  if (rec?.url) openUrl(rec.url);
  else if (rec?.blob) openStored(rec);
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

async function openBookmark(m) {
  let rec = null;
  try { rec = await storedFile(m.key); } catch {}
  if (rec?.blob) openStored(rec, m.page);
  else if (isRemoteKey(m.key)) openUrl(m.key, m.page);
  else ctx.flash('Ten plik nie jest już zapisany – otwórz go z dysku', 3000);
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

  window.addEventListener('dragover', (e) => { e.preventDefault(); welcome.classList.add('drag'); });
  window.addEventListener('dragleave', () => welcome.classList.remove('drag'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    welcome.classList.remove('drag');
    openLocal(e.dataTransfer.files[0]);
  });

  window.addEventListener('hashchange', openFromHash);
}
