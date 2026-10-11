import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDocument, GlobalWorkerOptions } from '../lib/pdfjs/build/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/build/pdf.worker.min.mjs', import.meta.url).href;

test('viewer.css zawiera poprawne reguły dla .textLayer i obrotów dokumentu', () => {
  const css = readFileSync(new URL('../viewer.css', import.meta.url), 'utf8');

  // .textLayer ma top: 0 i left: 0 (zamiast sztywnego inset: 0 blokującego dynamiczne przesunięcie cięcia)
  assert.ok(css.includes('.textLayer {'), 'Brakuje definicji .textLayer w CSS');
  assert.ok(/position:\s*absolute;\s*top:\s*0;\s*left:\s*0;/i.test(css), '.textLayer powinien zaczynać się od top: 0; left: 0');

  // Reguły obrotu warstwy tekstowej dla data-main-rotation
  assert.ok(css.includes('.textLayer[data-main-rotation="90"]'), 'Brakuje reguły obrotu 90° dla .textLayer');
  assert.ok(css.includes('rotate(90deg) translateY(-100%)'), 'Niepoprawna transformacja 90°');

  assert.ok(css.includes('.textLayer[data-main-rotation="180"]'), 'Brakuje reguły obrotu 180° dla .textLayer');
  assert.ok(css.includes('rotate(180deg) translate(-100%, -100%)'), 'Niepoprawna transformacja 180°');

  assert.ok(css.includes('.textLayer[data-main-rotation="270"]'), 'Brakuje reguły obrotu 270° dla .textLayer');
  assert.ok(css.includes('rotate(270deg) translateX(-100%)'), 'Niepoprawna transformacja 270°');
});

test('viewer.js przesuwa warstwę tekstową wg przycięcia marginesów i obsługuje dwuklik bez niszczenia zaznaczenia', () => {
  const js = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');

  // Warstwa tekstowa dostaje dynamiczne przesunięcie zależne od przycięcia strony (-bx, -by) i skali
  assert.ok(js.includes('calc(var(--scale-factor) * ${-bx}px)'), 'Warstwa tekstowa powinna mieć left uwzględniający bx');
  assert.ok(js.includes('calc(var(--scale-factor) * ${-by}px)'), 'Warstwa tekstowa powinna mieć top uwzględniający by');

  // Dwuklik nie jest blokowany przez getSelection()
  assert.ok(!js.includes('if (!pdf || String(window.getSelection())) return;'), 'Dwuklik nie powinien być blokowany zaznaczeniem tekstu');
  // Dwuklik nie powinien bezsensownie niszczyć zaznaczenia słowa
  assert.ok(!js.includes('window.getSelection()?.removeAllRanges();'), 'Dwuklik nie powinien kasować zaznaczenia słowa');
  // Resizer kalkulatora jest chroniony przed przypadkowym pełnym ekranem
  assert.ok(js.includes('#calc-resizer'), 'Dwuklik powinien ignorować kliknięcie w pasek resizera');
});

test('współrzędne PageViewport i warstwy CSS textLayer są w 100% zgodne dla wszystkich obrotów i przycięć', async () => {
  const pdfData = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 300 400]/Parent 2 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT\n/F1 12 Tf\n72 300 Td\n(Hello world) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000105 00000 n \n0000000244 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n336\n%%EOF';
  const doc = await getDocument({ data: new Uint8Array(Buffer.from(pdfData)) }).promise;
  const page = await doc.getPage(1);

  const vp0 = page.getViewport({ scale: 1, rotation: 0 });
  const [x0, y0] = vp0.convertToViewportPoint(72, 300);

  const bx = 25, by = 35; // przykładowe przycięcie marginesów

  for (const rot of [0, 90, 180, 270]) {
    const vp = page.getViewport({ scale: 1, rotation: rot });
    const [canvasX, canvasY] = vp.convertToViewportPoint(72, 300);
    const canvasPos = [canvasX - bx, canvasY - by];

    let tx = x0, ty = y0;
    if (rot === 0) {
      // brak transformacji
    } else if (rot === 90) {
      // rotate(90deg) translateY(-100%) na div o wysokości 400px
      const ty_trans = ty - 400;
      tx = -ty_trans;
      ty = x0;
    } else if (rot === 180) {
      // rotate(180deg) translate(-100%, -100%) na div o wymiarach 300x400
      const tx_trans = tx - 300;
      const ty_trans = ty - 400;
      tx = -tx_trans;
      ty = -ty_trans;
    } else if (rot === 270) {
      // rotate(270deg) translateX(-100%) na div o szerokości 300px
      const tx_trans = tx - 300;
      const new_tx = ty;
      const new_ty = -tx_trans;
      tx = new_tx;
      ty = new_ty;
    }
    const textLayerPos = [tx - bx, ty - by];
    assert.deepEqual(textLayerPos, canvasPos, `Niezgodność pozycji tekstu przy obrocie ${rot}°`);
  }
});
