// doc-history.js – historia przeglądarki (#file=…, #doc), obsługa przycisku Wstecz i powrotu na ekran startowy.

import { isRemoteKey } from './library.js';
import { fileRoute, fileHash } from './doc-url.js';

let ctx = null;

export function updateDocHistory(key) {
  const route = fileRoute(location.hash || '');
  const currentRoute = isRemoteKey(key) && route?.url === key;
  const targetHash = isRemoteKey(key) ? fileHash(key, currentRoute ? route.page : null) : '#doc';
  const targetUrl = location.pathname + targetHash;
  if (!history.state?.doc || history.state?.key !== key) {
    // Zmiana hash już utworzyła wpis; dopisujemy do niego stan, zamiast tworzyć drugi.
    if (currentRoute) history.replaceState({ doc: true, key }, '', targetUrl);
    else history.pushState({ doc: true, key }, '', targetUrl);
  }
}

export function goHome() {
  if (!ctx) return;
  ctx.closeDocument();
  ctx.setEmpty(true);
  history.replaceState({ welcome: true }, '', location.pathname);
}

export function initDocHistory(context) {
  ctx = context;

  if (!location.hash || location.hash === '#') {
    history.replaceState({ welcome: true }, '', location.pathname);
  } else if (location.hash === '#doc') {
    if (!history.state?.key) {
      history.replaceState({ welcome: true }, '', location.pathname);
    }
  } else if (location.hash.startsWith('#file=')) {
    const key = fileRoute(location.hash).url;
    history.replaceState({ doc: true, key }, '', location.href);
  }

  window.addEventListener('popstate', () => {
    const state = history.state;
    const isDoc = Boolean(state?.doc || (location.hash && location.hash.startsWith('#file=')) || location.hash === '#doc');

    if (!isDoc) {
      ctx.closeDocument();
      ctx.setEmpty(true);
      return;
    }

    if (state?.doc && state?.key) {
      if (state.key === ctx.getFileKey() && ctx.isPdfLoaded()) return;
      if (!isRemoteKey(state.key)) {
        return ctx.openStoredKey(state.key);
      }
    }
  });
}
