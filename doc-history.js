// doc-history.js – historia przeglądarki (#file=…, #doc), obsługa przycisku Wstecz i powrotu na ekran startowy.

import { isRemoteKey, storedFile } from './library.js';

let hadWelcomeState = false;
let ctx = null;

export function updateDocHistory(key) {
  const targetHash = isRemoteKey(key) ? '#file=' + encodeURI(key) : '#doc';
  const targetUrl = location.pathname + targetHash;
  if (!history.state?.doc || history.state?.key !== key) {
    history.pushState({ doc: true, key }, '', targetUrl);
  }
}

export function goHome() {
  if (!ctx?.isPdfLoaded()) return;
  if (history.state?.doc && hadWelcomeState) {
    history.back();
  } else {
    ctx.closeDocument();
    ctx.setEmpty(true);
    history.replaceState({ welcome: true }, '', location.pathname);
    hadWelcomeState = true;
  }
}

export function hasWelcomeState() {
  return hadWelcomeState;
}

export function initDocHistory(context) {
  ctx = context;

  if (!location.hash || location.hash === '#') {
    history.replaceState({ welcome: true }, '', location.pathname);
    hadWelcomeState = true;
  } else if (location.hash === '#doc') {
    if (!history.state?.key) {
      history.replaceState({ welcome: true }, '', location.pathname);
      hadWelcomeState = true;
    }
  } else if (location.hash.startsWith('#file=')) {
    const key = location.hash.slice(6).split('#')[0];
    history.replaceState({ doc: true, key }, '', location.href);
  }

  window.addEventListener('popstate', async (e) => {
    const state = e.state;
    const isDoc = Boolean(state?.doc || (location.hash && location.hash.startsWith('#file=')) || location.hash === '#doc');

    if (!isDoc) {
      if (ctx.isPdfLoaded()) {
        ctx.closeDocument();
        ctx.setEmpty(true);
      }
      return;
    }

    if (state?.doc && state?.key) {
      if (state.key === ctx.getFileKey() && ctx.isPdfLoaded()) return;
      if (isRemoteKey(state.key)) {
        ctx.openUrl(state.key);
      } else {
        try {
          const rec = await storedFile(state.key);
          if (rec?.blob) ctx.openStored(rec);
        } catch {}
      }
    }
  });
}
