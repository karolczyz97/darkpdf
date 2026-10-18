import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


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
  assert.ok(!css.includes('.textLayer br::selection,\nhtml.dark .textLayer br::selection,\nhtml.gemini .textLayer br::selection,\n.textLayer br::-moz-selection'), '::-moz-selection nie może być w tej samej liście selektorów co ::selection');
  assert.ok(css.includes('.textLayer br {') && css.includes('width: 0;') && css.includes('height: 0;'), '.textLayer br powinien mieć zerowe wymiary');
});

test('viewer.js przekazuje --scale-factor i obrót do TextLayer', () => {
  const js = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');

  // Warstwa tekstowa ustawia --scale-factor wymagany przez pdf.js 4.x
  assert.ok(js.includes("'--scale-factor'"), 'TextLayer powinien przekazywać --scale-factor');
  assert.ok(js.includes('rotation: rotationOf(page)'), 'TextLayer powinien uwzględniać obrót');
});
