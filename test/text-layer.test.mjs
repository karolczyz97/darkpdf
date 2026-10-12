import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDocument, GlobalWorkerOptions } from '../lib/pdfjs/build/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/build/pdf.worker.min.mjs', import.meta.url).href;

test('viewer.css zawiera poprawne reguły dla .textLayer i obrotów stron', () => {
  const css = readFileSync(new URL('../viewer.css', import.meta.url), 'utf8');

  assert.ok(css.includes('.textLayer {'), 'Brakuje definicji .textLayer w CSS');
  assert.ok(/position:\s*absolute/i.test(css), '.textLayer powinien mieć position: absolute');
  assert.ok(/z-index:\s*2;/i.test(css), '.textLayer powinien mieć z-index: 2 nad płótnem');
  assert.ok(/user-select:\s*text;/i.test(css), '.textLayer powinien pozwalać na zaznaczanie tekstu');
  assert.ok(css.includes('[data-main-rotation="90"]'), 'CSS powinien obsługiwać obrót 90 stopni');
  assert.ok(css.includes('[data-main-rotation="180"]'), 'CSS powinien obsługiwać obrót 180 stopni');
  assert.ok(css.includes('[data-main-rotation="270"]'), 'CSS powinien obsługiwać obrót 270 stopni');
  assert.ok(css.includes('.textLayer br::selection') && css.includes('transparent !important'), 'br::selection powinien być transparentny w każdym motywie');
});

test('viewer.js przekazuje --scale-factor, przesunięcia cięcia i obrót do TextLayer', () => {
  const js = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');

  // Warstwa tekstowa ustawia --scale-factor wymagany przez pdf.js 4.x
  assert.ok(js.includes("'--scale-factor'"), 'TextLayer powinien przekazywać --scale-factor');
  assert.ok(js.includes('(-bx * scale)'), 'TextLayer powinien przesuwać left o cięcie marginesu');
  assert.ok(js.includes('(-by * scale)'), 'TextLayer powinien przesuwać top o cięcie marginesu');
  assert.ok(js.includes('rotation: rotationOf(page)'), 'TextLayer powinien uwzględniać obrót');

  // Dwuklik nie jest blokowany przez getSelection()
  assert.ok(!js.includes('if (!pdf || String(window.getSelection())) return;'), 'Dwuklik nie powinien być blokowany zaznaczeniem tekstu');
  // Dwuklik nie powinien bezsensownie niszczyć zaznaczenia słowa
  assert.ok(!js.includes('window.getSelection()?.removeAllRanges();'), 'Dwuklik nie powinien kasować zaznaczenia słowa');
  // Resizer kalkulatora jest chroniony przed przypadkowym pełnym ekranem
  assert.ok(js.includes('#calc-resizer'), 'Dwuklik powinien ignorować kliknięcie w pasek resizera');
});

test('współrzędne TextLayer z przesunięciem marginesu są w 100% zgodne z canvas', async () => {
  const pdfData = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 300 400]/Parent 2 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT\n/F1 12 Tf\n72 300 Td\n(Hello world) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000105 00000 n \n0000000244 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n336\n%%EOF';
  const doc = await getDocument({ data: new Uint8Array(Buffer.from(pdfData)) }).promise;
  const page = await doc.getPage(1);

  const bx = 25, by = 35; // przykładowe przycięcie marginesów
  const scale = 1.5;

  const vpCanvas = page.getViewport({
    scale,
    rotation: 0,
    offsetX: -bx * scale,
    offsetY: -by * scale
  });
  const [canvasX, canvasY] = vpCanvas.convertToViewportPoint(72, 300);

  const vpText = page.getViewport({
    scale,
    rotation: 0
  });
  const [untrimmedX, untrimmedY] = vpText.convertToViewportPoint(72, 300);
  const textX = untrimmedX - bx * scale;
  const textY = untrimmedY - by * scale;

  assert.equal(canvasX, textX, 'Współrzędna X powinna być identyczna na canvas i textLayer');
  assert.equal(canvasY, textY, 'Współrzędna Y powinna być identyczna na canvas i textLayer');
});
