// test/browser-cdp.mjs – weryfikacja czytnika w rzeczywistej przeglądarce Chrome/Edge przez CDP
import http from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const chromePath = CHROME_PATHS.find(p => fs.existsSync(p));

test('rzeczywista przeglądarka: ładowanie viewer.js bez błędów, obsługa klawiszy, PDF i menu', async (t) => {
  if (!chromePath) {
    t.skip('Brak przeglądarki Chrome/Edge w systemie');
    return;
  }

  const PORT = 8089;
  const DEBUG_PORT = 9223;

  process.env.PORT = String(PORT);
  const serverProc = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  await new Promise(r => setTimeout(r, 600));

  const chromeProc = spawn(chromePath, [
    '--headless',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-gpu',
    `http://localhost:${PORT}/darkpdf/`
  ], { stdio: 'ignore' });

  const cleanup = () => {
    chromeProc.kill();
    serverProc.kill();
  };

  try {
    await new Promise(r => setTimeout(r, 1200));
    const tabsRes = await fetch(`http://localhost:${DEBUG_PORT}/json`);
    const tabs = await tabsRes.json();
    const tab = tabs.find(t => t.url.includes('darkpdf'));
    assert.ok(tab, 'Karta z DarkPDF powinna być otwarta w przeglądarce');

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
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

    // 1. Sprawdzamy inicjalizację aplikacji
    const r1 = await send('Runtime.evaluate', {
      expression: '({ title: document.title, empty: document.documentElement.classList.contains("empty") })',
      returnByValue: true
    });
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
      const bytes = new TextEncoder().encode(pdfData);
      const file = new File([bytes], 'test-doc.pdf', { type: 'application/pdf' });
      const { openLocal } = await import('./doc-loader.js');
      await openLocal(file);
      await new Promise(r => setTimeout(r, 600));
      return {
        empty: document.documentElement.classList.contains('empty'),
        hasCanvas: Boolean(document.querySelector('#stage canvas')),
        title: document.title
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

    // 5. Otwieranie i zamykanie kalkulatora (klawisz K)
    const rCalc = await send('Runtime.evaluate', {
      expression: '(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" })); return document.documentElement.classList.contains("calc-open"); })()',
      returnByValue: true
    });
    assert.equal(rCalc.result.value, true, 'Klawisz K powinien otworzyć panel kalkulatora');

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
          menuHidden: document.getElementById('menu').hidden
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    assert.equal(rHome.result.value.empty, true, 'Po Esc aplikacja powinna wrócić do ekranu startowego');
    assert.equal(rHome.result.value.menuHidden, true, 'Menu powinno być ukryte na ekranie startowym nawet po przypięciu');

    // 7. Brak jakichkolwiek wyjątków w trakcie całego cyklu
    assert.equal(exceptions.length, 0, `Nie powinno być żadnych wyjątków JS w przeglądarce: ${JSON.stringify(exceptions)}`);

    ws.close();
  } finally {
    cleanup();
  }
});
