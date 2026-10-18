// test/browser-cdp.mjs – weryfikacja czytnika w rzeczywistej przeglądarce Chrome/Edge przez CDP
import http from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

const chromePath = CHROME_PATHS.find(p => p && fs.existsSync(p));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Nie uruchomiono: ' + url);
}

test('rzeczywista przeglądarka: ładowanie viewer.js bez błędów, obsługa klawiszy, PDF i menu', async (t) => {
  if (!chromePath) {
    t.skip('Brak przeglądarki Chrome/Edge w systemie');
    return;
  }

  const PORT = await freePort();
  const DEBUG_PORT = await freePort();
  const profile = fs.mkdtempSync(path.join(tmpdir(), 'darkpdf-test-'));

  process.env.PORT = String(PORT);
  const serverProc = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  await waitFor(`http://127.0.0.1:${PORT}/darkpdf/`);

  const chromeProc = spawn(chromePath, [
    '--headless',
    '--window-size=1280,900',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-gpu',
    `http://localhost:${PORT}/darkpdf/`
  ], { stdio: 'ignore' });

  const cleanup = async () => {
    await Promise.all([chromeProc, serverProc].map((proc) => new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once('exit', resolve);
      proc.kill();
    })));
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('darkpdf-test-')) throw new Error('Nieprawidłowy katalog testu');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  let ws;

  try {
    const tabsRes = await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json`);
    const tabs = await tabsRes.json();
    const tab = tabs.find(t => t.url.includes('darkpdf'));
    assert.ok(tab, 'Karta z DarkPDF powinna być otwarta w przeglądarce');

    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });

    let idCounter = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = idCounter++;
      const handler = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    const exceptions = [];
    ws.addEventListener('message', (msg) => {
      const data = JSON.parse(msg.data);
      if (data.method === 'Runtime.exceptionThrown') {
        exceptions.push(data.params.exceptionDetails);
      }
    });

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Runtime.evaluate', { expression: 'import("./viewer.js")', awaitPromise: true });

    // 1. Sprawdzamy inicjalizację aplikacji
    let r1;
    for (let i = 0; i < 25; i++) {
      r1 = await send('Runtime.evaluate', {
        expression: '({ title: document.title, empty: document.documentElement.classList.contains("empty") })',
        returnByValue: true
      });
      if (r1.result.value.title === 'DarkPDF' && r1.result.value.empty) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(r1.result.value.title, 'DarkPDF');
    assert.equal(r1.result.value.empty, true, 'Ekran startowy powinien mieć klasę empty');

    // 2. Klawisz '?' powinien wyświetlić pomoc skrótów
    await send('Runtime.evaluate', {
      expression: 'window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))'
    });
    const r2 = await send('Runtime.evaluate', {
      expression: 'document.getElementById("hint").textContent',
      returnByValue: true
    });
    assert.ok(r2.result.value.includes('Esc'), 'Podpowiedź pomocy powinna zawierać skróty');

    // 3. Cykl trybu ciemnego (klawisz 'd')
    const r3 = await send('Runtime.evaluate', {
      expression: '(() => { const was = document.documentElement.classList.contains("dark"); window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" })); return { was, now: document.documentElement.classList.contains("dark") }; })()',
      returnByValue: true
    });
    assert.notEqual(r3.result.value.was, r3.result.value.now, 'Klawisz d powinien zmienić tryb kolorów');

    // 4. Załadowanie przykładowego pliku PDF przez import doc-loader
    const loadPdfExpr = `(async () => {
      const pdfData = '%PDF-1.4\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\\n3 0 obj<</Type/Page/MediaBox[0 0 300 400]/Parent 2 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Contents 4 0 R>>endobj\\n4 0 obj<</Length 44>>stream\\nBT\\n/F1 12 Tf\\n72 300 Td\\n(Hello world) Tj\\nET\\nendstream\\nendobj\\nxref\\n0 5\\n0000000000 65535 f \\n0000000009 00000 n \\n0000000052 00000 n \\n0000000105 00000 n \\n0000000244 00000 n \\ntrailer<</Size 5/Root 1 0 R>>\\nstartxref\\n336\\n%%EOF';
      const bytes = new TextEncoder().encode(pdfData.replace('BT', '0.7 g 0 0 300 400 re f\\n0 g\\nBT'));
      const file = new File([bytes], 'test-doc.pdf', { type: 'application/pdf' });
      const { openLocal } = await import('./doc-loader.js');
      await openLocal(file);
      await new Promise(r => setTimeout(r, 600));
      return {
        empty: document.documentElement.classList.contains('empty'),
        hasCanvas: Boolean(document.querySelector('#stage canvas')),
        title: document.title,
        paperFilters: document.querySelectorAll('#page-filters filter[id^="paper-"]').length
      };
    })()`;

    const rPdf = await send('Runtime.evaluate', {
      expression: loadPdfExpr,
      awaitPromise: true,
      returnByValue: true
    });
    assert.equal(rPdf.result.value.empty, false, 'Po załadowaniu PDF klasa empty powinna zniknąć');
    assert.equal(rPdf.result.value.hasCanvas, true, 'Na scenie powinno wyrenderować się płótno PDF');
    assert.ok(rPdf.result.value.title.includes('test-doc.pdf'), 'Tytuł powinien zawierać nazwę otwartego pliku');
    assert.ok(rPdf.result.value.paperFilters > 0, 'Szare tło PDF-a powinno utworzyć filtr koloru kartki');

    // 4a. Warstwa tekstowa jest wyrównana z płótnem i zawiera tekst
    const rTl = await send('Runtime.evaluate', {
      expression: `(() => {
        const p = document.querySelector('#stage .page');
        const c = p?.querySelector('canvas');
        const tl = p?.querySelector('.textLayer');
        const span = tl?.querySelector('span');
        const cRect = c?.getBoundingClientRect();
        const tlRect = tl?.getBoundingClientRect();
        const sRect = span?.getBoundingClientRect();
        return {
          hasTl: Boolean(tl),
          hasSpan: Boolean(span),
          spanText: span?.textContent,
          tlMatchesCanvas: cRect && tlRect && Math.abs(tlRect.left - cRect.left) < 2 && Math.abs(tlRect.top - cRect.top) < 2,
          withinBounds: cRect && sRect && sRect.left >= cRect.left - 5 && sRect.right <= cRect.right + 5
        };
      })()`,
      returnByValue: true
    });
    assert.equal(rTl.result.value.hasTl, true, 'Powinna istnieć warstwa tekstowa');
    assert.equal(rTl.result.value.hasSpan, true, 'Powinien istnieć span tekstowy');
    assert.equal(rTl.result.value.spanText, 'Hello world', 'Tekst w warstwie powinien odpowiadać PDF');
    assert.equal(rTl.result.value.tlMatchesCanvas, true, 'Warstwa tekstowa powinna pokrywać płótno');
    assert.equal(rTl.result.value.withinBounds, true, 'Span powinien mieścić się w obszarze strony');

    // 4b. Popover menu nie wyświetla się w lewym górnym rogu (0, 0)
    const rPopPos = await send('Runtime.evaluate', {
      expression: `(() => {
        document.getElementById('stage').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400 }));
        const pop = document.getElementById('menu-popover');
        const nav = document.querySelector('.menu-nav');
        const pRect = pop.getBoundingClientRect();
        const nRect = nav.getBoundingClientRect();
        return {
          notAtZero: pRect.top > 0 || pRect.left > 0,
          aboveNav: pRect.bottom <= nRect.top + 10,
          maxHeightSet: window.getComputedStyle(pop).maxHeight !== 'none'
        };
      })()`,
      returnByValue: true
    });
    assert.equal(rPopPos.result.value.notAtZero, true, 'Popover nie może być w lewym górnym rogu (0, 0)');
    assert.equal(rPopPos.result.value.maxHeightSet, true, 'Popover powinien mieć zdefiniowany max-height');

    // 4c. Natywne zaznaczanie słowa i dwuklik z przeciąganiem nie uruchamiają pełnego ekranu.
    await send('Runtime.evaluate', {
      expression: `(() => {
        window.fullscreenProbe = { calls: 0, doubleClicks: 0 };
        window.fullscreenProbe.original = document.documentElement.requestFullscreen;
        document.documentElement.requestFullscreen = () => { window.fullscreenProbe.calls++; return Promise.resolve(); };
        window.fullscreenProbe.onDoubleClick = () => window.fullscreenProbe.doubleClicks++;
        window.addEventListener('dblclick', window.fullscreenProbe.onDoubleClick);
      })()`
    });
    try {
      for (const drag of [false, true]) {
        const textBounds = await send('Runtime.evaluate', {
          expression: `(() => {
            window.getSelection().removeAllRanges();
            const rect = document.querySelector('#stage .textLayer span').getBoundingClientRect();
            return { x: rect.left + 3, endX: rect.right - 3, y: rect.top + rect.height / 2 };
          })()`, returnByValue: true
        });
        const { x, endX, y } = textBounds.result.value;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        for (const clickCount of [1, 2]) {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
          if (drag && clickCount === 2) {
            await new Promise(resolve => setTimeout(resolve, 600));
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y, button: 'left', buttons: 1 });
          }
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: drag && clickCount === 2 ? endX : x, y, button: 'left', buttons: 0, clickCount
          });
        }
        const selection = await send('Runtime.evaluate', {
          expression: '({ text: String(window.getSelection()), calls: window.fullscreenProbe.calls, doubleClicks: window.fullscreenProbe.doubleClicks })',
          returnByValue: true
        });
        assert.ok(selection.result.value.text.length > 0, 'Gest myszy powinien zaznaczyć tekst PDF');
        assert.equal(selection.result.value.doubleClicks, drag ? 2 : 1, 'Przeglądarka powinna wygenerować dwuklik po puszczeniu myszy');
        assert.equal(selection.result.value.calls, 0, 'Zaznaczanie tekstu nie może uruchamiać pełnego ekranu');
      }

      // Przytrzymanie drugiego kliknięcia na pustym obszarze też nie jest skrótem pełnego ekranu.
      const blankBounds = await send('Runtime.evaluate', {
        expression: `(() => {
          window.getSelection().removeAllRanges();
          // Jak w skanie PDF: brak dostępnego tekstu do zaznaczenia.
          document.querySelector('#stage .textLayer').style.visibility = 'hidden';
          const rect = document.querySelector('#stage .page').getBoundingClientRect();
          return { x: rect.left + 20, y: rect.top + 20 };
        })()`, returnByValue: true
      });
      const blank = blankBounds.result.value;
      for (const hold of [true, false]) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...blank });
        for (const clickCount of [1, 2]) {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...blank, button: 'left', buttons: 1, clickCount });
          if (hold && clickCount === 2) await new Promise(resolve => setTimeout(resolve, 600));
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...blank, button: 'left', buttons: 0, clickCount });
        }
        const gesture = await send('Runtime.evaluate', {
          expression: '({ text: String(window.getSelection()), calls: window.fullscreenProbe.calls, doubleClicks: window.fullscreenProbe.doubleClicks })',
          returnByValue: true
        });
        assert.equal(gesture.result.value.text, '', 'Na pustym obszarze nie powinno być zaznaczenia');
        assert.equal(gesture.result.value.doubleClicks, hold ? 3 : 4, 'Przeglądarka powinna wygenerować dwuklik także po przytrzymaniu');
        assert.equal(gesture.result.value.calls, hold ? 0 : 1,
          hold ? 'Przytrzymanie bez zaznaczenia nie może uruchamiać pełnego ekranu' : 'Szybki dwuklik po przytrzymaniu powinien nadal działać');
      }
      await send('Runtime.evaluate', {
        expression: "document.querySelector('#stage .textLayer').style.removeProperty('visibility')"
      });

      // Bez zaznaczenia skrót dwukliku nadal działa, a kontrolki są pomijane.
      const fullscreen = await send('Runtime.evaluate', {
        expression: `(() => {
          window.getSelection().removeAllRanges();
          document.getElementById('calc-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          const afterControl = window.fullscreenProbe.calls;
          document.getElementById('stage').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          const afterPage = window.fullscreenProbe.calls;
          const menuHidden = document.getElementById('menu').hidden;
          const text = document.querySelector('#stage .textLayer span');
          const range = document.createRange();
          range.selectNodeContents(text);
          window.getSelection().addRange(range);
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
          return { afterControl, afterPage, afterKey: window.fullscreenProbe.calls, menuHidden };
        })()`, returnByValue: true
      });
      assert.deepEqual(fullscreen.result.value, { afterControl: 1, afterPage: 2, afterKey: 3, menuHidden: true },
        'Dwuklik poza tekstem i klawisz F powinny nadal uruchamiać pełny ekran');
    } finally {
      await send('Runtime.evaluate', {
        expression: `(() => {
          document.documentElement.requestFullscreen = window.fullscreenProbe.original;
          window.removeEventListener('dblclick', window.fullscreenProbe.onDoubleClick);
          delete window.fullscreenProbe;
          window.getSelection().removeAllRanges();
          document.querySelector('#stage .textLayer').style.removeProperty('visibility');
        })()`
      });
    }

    // 5. Otwieranie i zamykanie kalkulatora (klawisz K)
    const rCalc = await send('Runtime.evaluate', {
      expression: '(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" })); return document.documentElement.classList.contains("calc-open"); })()',
      returnByValue: true
    });
    assert.equal(rCalc.result.value, true, 'Klawisz K powinien otworzyć panel kalkulatora');

    // Skalowanie podczas przeciągania: warstwa tekstowa zmienia się natychmiast, przed kolejnym renderem.
    const rResize = await send('Runtime.evaluate', {
      expression: `(async () => {
        // Dopasowanie do szerokości gwarantuje zmianę skali wraz z szerokością panelu.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
        for (let i = 0; i < 30; i++) {
          if (document.querySelector('#stage .textLayer span')) break;
          await new Promise(r => setTimeout(r, 50));
        }
        const resizer = document.getElementById('calc-resizer');
        const page = document.querySelector('#stage .page');
        const before = page.querySelector('.textLayer').style.getPropertyValue('--scale-factor');
        resizer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 400 }));
        resizer.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 500 }));
        const c = page.querySelector('canvas').getBoundingClientRect();
        const text = page.querySelector('.textLayer');
        const tr = text.getBoundingClientRect();
        const after = text.style.getPropertyValue('--scale-factor');
        resizer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
        return { before, after, widthDiff: Math.abs(c.width - tr.width), heightDiff: Math.abs(c.height - tr.height) };
      })()`, awaitPromise: true, returnByValue: true
    });
    assert.notEqual(rResize.result.value.before, rResize.result.value.after, 'Przeciąganie powinno zmienić skalę');
    assert.ok(rResize.result.value.widthDiff < 2 && rResize.result.value.heightDiff < 2, 'Tekst powinien nadążać za płótnem');

    const rResultKey = await send('Runtime.evaluate', {
      expression: `(() => {
        const expr = document.getElementById('calc-expr');
        expr.value = '2+3';
        expr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const result = document.getElementById('calc-result');
        result.focus();
        result.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return { value: expr.value, focusable: result.tabIndex === 0 };
      })()`, returnByValue: true
    });
    assert.equal(rResultKey.result.value.value, '5', 'Enter na wyniku powinien wstawić go do działania');
    assert.equal(rResultKey.result.value.focusable, true);

    const rCopyKey = await send('Runtime.evaluate', {
      expression: `(async () => {
        let copied = null;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; } } });
        const result = document.getElementById('calc-result');
        result.focus();
        result.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
        await Promise.resolve();
        return copied;
      })()`, awaitPromise: true, returnByValue: true
    });
    assert.equal(rCopyKey.result.value, '5', 'Ctrl+C na wyniku powinno użyć jego wartości');

    // Fokus w polu kalkulatora nie jest potrzebny do dalszych skrótów czytnika.
    await send('Runtime.evaluate', { expression: 'document.activeElement?.blur()' });

    // Zamknięcie kalkulatora klawiszem Esc
    const rCalcClose = await send('Runtime.evaluate', {
      expression: '(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return document.documentElement.classList.contains("calc-open"); })()',
      returnByValue: true
    });
    assert.equal(rCalcClose.result.value, false, 'Klawisz Esc powinien zamknąć kalkulator');

    // 6. Test przypięcia paska (pin) i powrotu do ekranu powitalnego (Esc)
    const rPin = await send('Runtime.evaluate', {
      expression: `(() => {
        document.getElementById('stage').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400 }));
        const pinBtn = document.querySelector('.menu-pin');
        pinBtn.click();
        const pinned = pinBtn.classList.contains('pinned');
        const menuVisible = !document.getElementById('menu').hidden;
        return { pinned, menuVisible };
      })()`,
      returnByValue: true
    });
    assert.equal(rPin.result.value.pinned, true, 'Przycisk pin powinien przypiąć pasek');
    assert.equal(rPin.result.value.menuVisible, true, 'Przypięty pasek powinien być widoczny');

    // Teraz Esc: pierwszy zamyka popover, drugi wraca do ekranu powitalnego
    const rHome = await send('Runtime.evaluate', {
      expression: `(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await new Promise(r => setTimeout(r, 400));
        return {
          empty: document.documentElement.classList.contains('empty'),
          menuHidden: document.getElementById('menu').hidden,
          paperFilters: document.querySelectorAll('#page-filters filter[id^="paper-"]').length
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    assert.equal(rHome.result.value.empty, true, 'Po Esc aplikacja powinna wrócić do ekranu startowego');
    assert.equal(rHome.result.value.menuHidden, true, 'Menu powinno być ukryte na ekranie startowym nawet po przypięciu');
    assert.equal(rHome.result.value.paperFilters, 0, 'Zamknięcie PDF-a powinno usunąć filtry jego kartek');

    const rLateOpen = await send('Runtime.evaluate', {
      expression: `(async () => {
        const loader = await import('./doc-loader.js');
        const { recentFiles } = await import('./library.js');
        const original = (await recentFiles()).find(rec => rec.blob);
        const bytes = await original.blob.arrayBuffer();
        const outcomes = [];
        for (const withDocumentA of [true, false]) {
          if (withDocumentA) await loader.openStored(original);
          const delayed = Promise.withResolvers();
          const b = new File([bytes], 'late-B.pdf', { type: 'application/pdf' });
          b.arrayBuffer = () => delayed.promise;
          const opening = loader.openLocal(b);
          const wasLoading = loader.isDocumentLoading();
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
          const immediateHome = document.documentElement.classList.contains('empty');
          delayed.resolve(bytes.slice(0));
          await opening;
          outcomes.push({
            withDocumentA, wasLoading, immediateHome,
            empty: document.documentElement.classList.contains('empty'),
            hasCanvas: Boolean(document.querySelector('#stage canvas')),
            loading: loader.isDocumentLoading(),
            welcome: history.state?.welcome,
            hintHidden: document.getElementById('hint').hidden
          });
        }
        return outcomes;
      })()`, awaitPromise: true, returnByValue: true
    });
    for (const outcome of rLateOpen.result.value) {
      assert.equal(outcome.wasLoading, true);
      assert.equal(outcome.immediateHome, true, 'Escape musi od razu wrócić na ekran główny');
      assert.equal(outcome.empty, true, 'Spóźniony PDF B nie może otworzyć się po Escape');
      assert.equal(outcome.hasCanvas, false);
      assert.equal(outcome.loading, false);
      assert.equal(outcome.welcome, true);
      assert.equal(outcome.hintHidden, true);
    }

    const rRemoteHome = await send('Runtime.evaluate', {
      expression: `(async () => {
        const loader = await import('./doc-loader.js');
        const { recentFiles } = await import('./library.js');
        const original = (await recentFiles()).find(rec => rec.blob);
        const bytes = await original.blob.arrayBuffer();
        const requested = Promise.withResolvers();
        const onRequest = event => {
          if (event.source === window && event.data?.source === 'zen-page' && event.data?.type === 'load') requested.resolve(event.data);
        };
        window.addEventListener('message', onRequest);
        try {
          const opening = loader.openUrl('https://example.test/deferred.pdf');
          const immediateLoading = loader.isDocumentLoading();
          const request = await requested.promise;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
          window.postMessage({ source: 'zen-ext', type: 'data', requestId: request.requestId, buffer: bytes }, location.origin);
          await opening;
          return {
            immediateLoading, empty: document.documentElement.classList.contains('empty'),
            hasCanvas: Boolean(document.querySelector('#stage canvas')), welcome: history.state?.welcome,
            hash: location.hash, loading: loader.isDocumentLoading()
          };
        } finally { window.removeEventListener('message', onRequest); }
      })()`, awaitPromise: true, returnByValue: true
    });
    assert.equal(rRemoteHome.result.value.immediateLoading, true, 'Adres musi rozpocząć żądanie bez czekania na hashchange');
    assert.equal(rRemoteHome.result.value.empty, true);
    assert.equal(rRemoteHome.result.value.hasCanvas, false);
    assert.equal(rRemoteHome.result.value.welcome, true);
    assert.equal(rRemoteHome.result.value.hash, '');
    assert.equal(rRemoteHome.result.value.loading, false);

    // Oba workery współistnieją; ich zasoby wystarczają do uruchomienia obu aplikacji offline.
    const rCaches = await send('Runtime.evaluate', {
      expression: `(async () => {
        await navigator.serviceWorker.ready;
        const registration = await navigator.serviceWorker.register('/calc/sw.js');
        if (registration.active?.state !== 'activated') await new Promise((resolve, reject) => {
          const worker = registration.installing || registration.waiting || registration.active;
          const timer = setTimeout(() => reject(new Error('Timeout instalacji kalkulatora')), 8000);
          const done = () => { if (worker.state === 'activated') { clearTimeout(timer); worker.removeEventListener('statechange', done); resolve(); } };
          worker.addEventListener('statechange', done); done();
        });
        return caches.keys();
      })()`, awaitPromise: true, returnByValue: true
    });
    assert.ok(rCaches.result.value.some((key) => key.startsWith('darkpdf-')));
    assert.ok(rCaches.result.value.some((key) => key.startsWith('calc-')));
    await send('Network.enable');
    await send('Page.enable');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    for (const app of ['darkpdf', 'calc']) {
      await send('Page.navigate', { url: `http://localhost:${PORT}/${app}/` });
      let ready = false;
      for (let i = 0; i < 100; i++) {
        const state = await send('Runtime.evaluate', {
          expression: `document.readyState === 'complete' && Boolean(document.getElementById('${app === 'darkpdf' ? 'stage' : 'calc-expr'}'))`, returnByValue: true
        });
        if (state.result.value) { ready = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, `${app} powinien uruchomić się offline`);
      const font = await send('Runtime.evaluate', {
        expression: `(async () => {
          const faces = await document.fonts.load('400 14px "Google Sans Flex"', 'Zażółć gęślą jaźń');
          return { count: faces.length, loaded: faces.every(face => face.status === 'loaded') };
        })()`, awaitPromise: true, returnByValue: true
      });
      assert.ok(font.result.value?.count >= 2 && font.result.value.loaded,
        `${app}: lokalny font z polskimi znakami powinien ładować się offline`);
    }
    const rOfflineCalc = await send('Runtime.evaluate', {
      expression: `(() => {
        const expr = document.getElementById('calc-expr');
        expr.value = '7+1';
        expr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return document.getElementById('calc-result').textContent;
      })()`, returnByValue: true
    });
    assert.equal(rOfflineCalc.result.value, '8');

    // Brak jakichkolwiek wyjątków w trakcie całego cyklu
    assert.equal(exceptions.length, 0, `Nie powinno być żadnych wyjątków JS w przeglądarce: ${JSON.stringify(exceptions)}`);

    ws.close();
  } finally {
    ws?.close();
    await cleanup();
  }
});
