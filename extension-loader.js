// Wtyczka powinna odsyłać requestId w każdym progress/data/error.
// Dawny protokół działa kolejno; po przerwaniu wymaga odświeżenia, bo spóźnionej odpowiedzi nie da się przypisać.
let tail = Promise.resolve();
let requireRequestId = false;

export function loadViaExtension(url, { signal, onProgress = () => {} } = {}) {
  const result = tail.then(() => {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      let timer, answered = false;
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error) => { cleanup(); reject(error); };
      const armTimeout = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const message = answered ? 'EXTTIMEOUT' : requireRequestId ? 'EXTUPDATE' : 'NOEXT';
          requireRequestId = true;
          fail(new Error(message));
        }, ms);
      };
      const onAbort = () => {
        requireRequestId = true;
        fail(signal.reason);
      };
      function onMessage(e) {
        const m = e.data;
        if (e.source !== window || e.origin !== location.origin || m?.source !== 'zen-ext') return;
        if (m.requestId != null && m.requestId !== requestId) return;
        if (requireRequestId && m.requestId !== requestId) return;
        if (!['progress', 'data', 'error'].includes(m.type)) return;
        answered = true;
        if (m.type === 'progress') {
          armTimeout(30000);
          onProgress(m);
        } else {
          cleanup();
          if (m.type === 'error') reject(new Error(m.message || 'Błąd pobierania'));
          else {
            if (!(m.buffer instanceof ArrayBuffer) || !m.buffer.byteLength) reject(new Error('Pusta lub nieprawidłowa odpowiedź wtyczki'));
            else resolve(new Uint8Array(m.buffer));
          }
        }
      }
      window.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      armTimeout(3000);
      try { window.postMessage({ source: 'zen-page', type: 'load', url, requestId }, location.origin); }
      catch (error) { requireRequestId = true; fail(error); }
    });
  });
  tail = result.catch(() => {});
  return result;
}
