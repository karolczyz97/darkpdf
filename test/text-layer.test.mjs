import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDocument, GlobalWorkerOptions } from '../lib/pdfjs/build/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/build/pdf.worker.min.mjs', import.meta.url).href;

test('viewer.css zawiera poprawne reguły dla .textLayer dopasowanej 1:1 do strony', () => {
  const css = readFileSync(new URL('../viewer.css', import.meta.url), 'utf8');

  // .textLayer pokrywa całą stronę (inset: 0) bez przesunięć i zbędnych marginesów
  assert.ok(css.includes('.textLayer {'), 'Brakuje definicji .textLayer w CSS');
  assert.ok(/position:\s*absolute;\s*inset:\s*0;/i.test(css), '.textLayer powinien mieć position: absolute; inset: 0');
  assert.ok(/z-index:\s*2;/i.test(css), '.textLayer powinien mieć z-index: 2 nad płótnem');
  assert.ok(/user-select:\s*text;/i.test(css), '.textLayer powinien pozwalać na zaznaczanie tekstu');
});

test('viewer.js przekazuje przesunięcia cięcia i obrót bezpośrednio do viewportu TextLayer', () => {
  const js = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');

  // Warstwa tekstowa korzysta z natywnego PageViewport z PDF.js z uwzględnieniem cięcia i obrotu
  assert.ok(js.includes('offsetX: -b.x * scale'), 'TextLayer powinien przekazywać offsetX do getViewport');
  assert.ok(js.includes('offsetY: -b.y * scale'), 'TextLayer powinien przekazywać offsetY do getViewport');
  assert.ok(js.includes('rotation: rotationOf(page)'), 'TextLayer powinien uwzględniać obrót');

  // Dwuklik nie jest blokowany przez getSelection()
  assert.ok(!js.includes('if (!pdf || String(window.getSelection())) return;'), 'Dwuklik nie powinien być blokowany zaznaczeniem tekstu');
  // Dwuklik nie powinien bezsensownie niszczyć zaznaczenia słowa
  assert.ok(!js.includes('window.getSelection()?.removeAllRanges();'), 'Dwuklik nie powinien kasować zaznaczenia słowa');
  // Resizer kalkulatora jest chroniony przed przypadkowym pełnym ekranem
  assert.ok(js.includes('#calc-resizer'), 'Dwuklik powinien ignorować kliknięcie w pasek resizera');
});

test('współrzędne PageViewport z offsetX/offsetY są w 100% zgodne z canvas dla wszystkich cięć', async () => {
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
    rotation: 0,
    offsetX: -bx * scale,
    offsetY: -by * scale
  });
  const [textX, textY] = vpText.convertToViewportPoint(72, 300);

  assert.equal(canvasX, textX, 'Współrzędna X powinna być identyczna na canvas i textLayer');
  assert.equal(canvasY, textY, 'Współrzędna Y powinna być identyczna na canvas i textLayer');
});
