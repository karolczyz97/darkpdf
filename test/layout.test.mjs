// Testy geometrii czytnika (layout.js) i narzędzi (util.js) – uruchom w katalogu repo: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spreadStartOf, spreadOf, nextStart, prevStart, spreadLabel, pickScale, fitSpread, heightFitWidth,
  isFullBleed, cutsContent, cropCandidatePages, commonBox, contentBounds
} from '../layout.js';
import { lru, mapConcurrent } from '../util.js';

const odd = (numPages) => ({ numPages, two: true, pairing: 'odd' });
const even = (numPages) => ({ numPages, two: true, pairing: 'even' });
const single = (numPages) => ({ numPages, two: false, pairing: 'odd' });

test('rozkładówki: pary 1–2, 3–4…', () => {
  const o = odd(10);
  assert.deepEqual([1, 2, 3, 4, 9, 10].map((p) => spreadStartOf(p, o)), [1, 1, 3, 3, 9, 9]);
  assert.deepEqual(spreadOf(1, o), [1, 2]);
  assert.deepEqual(spreadOf(9, o), [9, 10]);
  assert.deepEqual(spreadOf(9, odd(9)), [9, null]);          // ostatnia strona sama
  assert.equal(nextStart(1, o), 3);
  assert.equal(nextStart(9, o), null);
  assert.equal(prevStart(3, o), 1);
  assert.equal(prevStart(1, o), null);
  assert.equal(spreadStartOf(99, o), 9);                      // numer spoza dokumentu → ostatnia rozkładówka
  assert.equal(spreadStartOf(-5, o), 1);
});

test('rozkładówki: pary 1, 2–3, 4–5… (okładka sama)', () => {
  const o = even(10);
  assert.deepEqual([1, 2, 3, 4, 5, 10].map((p) => spreadStartOf(p, o)), [1, 2, 2, 4, 4, 10]);
  assert.deepEqual(spreadOf(1, o), [null, 1]);
  assert.deepEqual(spreadOf(2, o), [2, 3]);
  assert.deepEqual(spreadOf(10, o), [10, null]);
  assert.equal(nextStart(1, o), 2);
  assert.equal(nextStart(2, o), 4);
  assert.equal(prevStart(2, o), 1);
  assert.equal(prevStart(4, o), 2);
});

test('rozkładówki: jedna strona', () => {
  const o = single(10);
  assert.equal(spreadStartOf(6, o), 6);
  assert.deepEqual(spreadOf(6, o), [6, null]);
  assert.equal(nextStart(10, o), null);
  assert.equal(prevStart(6, o), 5);
});

test('przewracanie od początku do końca pokazuje każdą stronę dokładnie raz', () => {
  for (const mode of [odd, even, single]) {
    for (let n = 1; n <= 9; n++) {
      const o = mode(n);
      const seen = [];
      for (let s = 1; s != null; s = nextStart(s, o)) seen.push(...spreadOf(s, o).filter(Boolean));
      assert.deepEqual(seen, Array.from({ length: n }, (_, i) => i + 1), `${o.pairing}/${o.two} przy ${n} stronach`);
      // i z powrotem: prevStart wraca po tych samych rozkładówkach
      const starts = [];
      for (let s = 1; s != null; s = nextStart(s, o)) starts.push(s);
      const back = [];
      for (let s = starts.at(-1); s != null; s = prevStart(s, o)) back.push(s);
      assert.deepEqual(back, [...starts].reverse());
    }
  }
});

test('napis rozkładówki', () => {
  assert.equal(spreadLabel([7, 8]), '7–8');
  assert.equal(spreadLabel([7, null]), '7');
  assert.equal(spreadLabel([null, 1]), '1');
});

test('skala strony w trybach auto / szerokość / wysokość', () => {
  assert.equal(pickScale(4, 1.5, 'auto'), 1.5);
  assert.equal(pickScale(4, 1.5, 'width'), 4);
  assert.equal(pickScale(4, 1.5, 'height'), 1.5);
  const p = { w: 100, h: 200 };
  assert.deepEqual(fitSpread(p, null, { W: 400, H: 300, two: false, fitMode: 'auto' }), { scale: 1.5, L: p, R: p, single: true });
  assert.equal(fitSpread(p, null, { W: 400, H: 300, two: false, fitMode: 'width' }).scale, 4);
  assert.equal(fitSpread(p, p, { W: 400, H: 300, two: true, fitMode: 'width' }).scale, 2);
  // samotna strona w trybie dwóch stron zajmuje pół szerokości – obok jest puste miejsce
  assert.equal(fitSpread(p, null, { W: 400, H: 900, two: true, fitMode: 'auto' }).scale, 2);
  assert.equal(fitSpread(null, p, { W: 400, H: 900, two: true, fitMode: 'auto' }).scale, 2);
  // różne wysokości: decyduje wyższa strona
  assert.equal(fitSpread(p, { w: 100, h: 300 }, { W: 1000, H: 300, two: true, fitMode: 'auto' }).scale, 1);
  // brak wymiarów strony nie wywraca obliczeń
  assert.equal(fitSpread(null, null, { W: 400, H: 300, two: true, fitMode: 'auto' }).scale, 1);
  assert.equal(fitSpread({ w: 0, h: 0 }, null, { W: 400, H: 300, two: false, fitMode: 'auto' }).scale, 1);
});

test('szerokość PDF-a dopasowanego do wysokości (panel kalkulatora)', () => {
  const p = { w: 100, h: 200 };
  assert.equal(heightFitWidth(p, null, { H: 400, two: false, gap: 4 }), 200);
  assert.equal(heightFitWidth(p, { w: 150, h: 200 }, { H: 400, two: true, gap: 4 }), 504);
  assert.equal(heightFitWidth(p, null, { H: 400, two: true, gap: 4 }), 404);    // samotna strona + puste miejsce
  assert.equal(heightFitWidth(null, null, { H: 400, two: true, gap: 4 }), null);
});

const FULL = { width: 600, height: 800 };
const box = (x, y, r, bt) => ({ x, y, r, bt });

test('strona na całą stronę i ucinanie treści', () => {
  assert.ok(isFullBleed(box(0, 0, 600, 800), FULL));
  assert.ok(!isFullBleed(box(50, 50, 550, 750), FULL));
  const common = { x: 50, y: 50, w: 500, h: 700 };
  assert.ok(!cutsContent(box(55, 60, 545, 740), common, FULL));
  assert.ok(!cutsContent(box(45, 45, 555, 755), common, FULL));   // w tolerancji 1,5%
  assert.ok(cutsContent(box(10, 60, 545, 740), common, FULL));    // rysunek w lewym marginesie
  assert.ok(cutsContent(box(0, 0, 600, 800), common, FULL));      // zdjęcie na całą stronę
});

test('strony do ustalenia wspólnego przycięcia', () => {
  assert.deepEqual(cropCandidatePages(3, 0, 28), []);
  assert.deepEqual(cropCandidatePages(3, 10, 28), [1, 3, 5, 7, 9]);
  assert.deepEqual(cropCandidatePages(2, 10, 28), [2, 4, 6, 8, 10]);
  assert.deepEqual(cropCandidatePages(1, 1, 28), [1]);
  assert.deepEqual(cropCandidatePages(50, 10, 28), [2, 4, 6, 8, 10]);   // numer spoza dokumentu
  const pages = cropCandidatePages(500, 1000, 28);
  assert.equal(pages.length, 28);
  assert.ok(pages.every((p) => p % 2 === 0 && p >= 1 && p <= 1000));
  assert.deepEqual(pages, [...new Set(pages)].sort((a, b) => a - b));
  for (const p of [498, 500, 502]) assert.ok(pages.includes(p));      // sąsiedztwo bieżącej strony
  assert.ok(pages[0] < 100 && pages.at(-1) > 900);                     // i cały dokument
  assert.equal(cropCandidatePages(7, 1000, 6).length, 6);
});

test('wspólne pole treści grupy stron', () => {
  assert.equal(commonBox([], FULL), null);
  assert.equal(commonBox([null, null], FULL), null);
  assert.deepEqual(commonBox([box(60, 70, 540, 730), box(50, 80, 550, 720)], FULL), { x: 50, y: 70, w: 500, h: 660 });
  // okładka na całą stronę nie psuje przycięcia reszty
  const normal = [box(60, 70, 540, 730), box(55, 75, 545, 725), box(58, 72, 542, 728)];
  assert.deepEqual(commonBox([box(0, 0, 600, 800), ...normal], FULL), { x: 55, y: 70, w: 490, h: 660 });
  // przy 10+ stronach jedna skrajna (pieczątka w marginesie) nie rozszerza przycięcia
  const many = Array.from({ length: 12 }, () => box(60, 70, 540, 730));
  many[3] = box(5, 70, 540, 730);
  assert.deepEqual(commonBox(many, FULL), { x: 60, y: 70, w: 480, h: 660 });
  // podejrzanie mało treści – lepiej nie przycinać
  assert.equal(commonBox([box(280, 380, 320, 420)], FULL), null);
});

test('pole treści z pikseli miniatury', () => {
  const W = 20, H = 10;
  const img = () => new Uint8ClampedArray(W * H * 4).fill(255);
  const dark = (d, x, y) => { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; };
  const d = img();
  for (let y = 2; y <= 5; y++) for (let x = 4; x <= 9; x++) dark(d, x, y);
  assert.deepEqual(contentBounds(d, W, H, { step: 1 }), { x0: 4, x1: 9, y0: 2, y1: 5 });
  assert.equal(contentBounds(img(), W, H, { step: 1 }), null);          // pusta strona
  const dust = img();
  dark(dust, 15, 8);                                                    // pojedyncza kropka ze skanu
  assert.equal(contentBounds(dust, W, H, { step: 1 }), null);
});

test('pamięć LRU wyrzuca najdawniej używane i sprząta po nich', () => {
  const gone = [];
  let max = 2;
  const c = lru(() => max, (v) => gone.push(v));
  c.set('a', 1); c.set('b', 2);
  c.get('a');                    // „a” świeżo użyte, więc wypada „b”
  c.set('c', 3);
  assert.deepEqual(gone, [2]);
  assert.ok(c.has('a') && c.has('c') && !c.has('b'));
  c.set('a', 10);                // podmiana wartości – stara idzie do sprzątania
  assert.deepEqual(gone, [2, 1]);
  max = 1;                       // limit zależny od urządzenia (telefon)
  c.set('d', 4);
  assert.deepEqual(gone, [2, 1, 3, 10]);
  c.clear();
  assert.deepEqual(gone, [2, 1, 3, 10, 4]);
});

test('równoległe zadania z limitem', async () => {
  let running = 0, peak = 0;
  const out = await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    if (x === 4) throw new Error('uszkodzona strona');
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, null, 10, 12, 14]);   // błąd jednej strony nie przerywa reszty
  assert.equal(peak, 3);
  assert.deepEqual(await mapConcurrent([], 3, async (x) => x), []);
});
