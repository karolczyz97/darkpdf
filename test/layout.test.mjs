// Testy geometrii czytnika (layout.js) i narzędzi (util.js) – uruchom w katalogu repo: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spreadStartOf, spreadOf, nextStart, prevStart, spreadLabel, pickScale, fitSpread, heightFitWidth,
  paperColor, inferPairing, inferTwoPages
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

test('auto: szerokość zaokrąglona do piksela nie zmniejsza skali na wysokość', () => {
  const p = { w: 595, h: 842 };
  const H = 708;
  const W = heightFitWidth(p, null, { H, two: false, gap: 4 });   // tyle miejsca daje panel dla strony na wysokość
  const { scale } = fitSpread(p, null, { W, H, two: false, fitMode: 'auto' });
  assert.equal(scale, H / p.h);                                   // wysokość strony = H co do piksela, odstępy równe
  // za wąskie o cały piksel: skala spada do szerokości
  assert.ok(fitSpread(p, null, { W: W - 1, H, two: false, fitMode: 'auto' }).scale < H / p.h);
});

test('szerokość PDF-a dopasowanego do wysokości (panel kalkulatora)', () => {
  const p = { w: 100, h: 200 };
  assert.equal(heightFitWidth(p, null, { H: 400, two: false, gap: 0 }), 200);
  assert.equal(heightFitWidth(p, { w: 150, h: 200 }, { H: 400, two: true, gap: 0 }), 500);
  assert.equal(heightFitWidth(p, null, { H: 400, two: true, gap: 0 }), 400);    // samotna strona + puste miejsce
  assert.equal(heightFitWidth(p, null, { H: 400, two: false, gap: 4 }), 200);
  assert.equal(heightFitWidth(p, { w: 150, h: 200 }, { H: 400, two: true, gap: 4 }), 504);
  assert.equal(heightFitWidth(p, null, { H: 400, two: true, gap: 4 }), 404);    // samotna strona + puste miejsce
  assert.equal(heightFitWidth(null, null, { H: 400, two: true, gap: 4 }), null);
});


test('kolor kartki do wyrównania przed odwróceniem kolorów', () => {
  const page = (fill) => {
    const d = new Uint8ClampedArray(40 * 40 * 4);
    for (let i = 0; i < d.length; i += 4) { d.set(fill(i / 4), i); d[i + 3] = 255; }
    return d;
  };
  const ink = (i) => i % 7 === 0;                                                    // co siódmy piksel to druk
  assert.equal(paperColor(page((i) => (ink(i) ? [20, 20, 20] : [255, 255, 255]))), null);              // biała kartka – bez zmian
  assert.deepEqual(paperColor(page((i) => (ink(i) ? [20, 20, 20] : [240, 234, 220]))), [240, 234, 220]); // żółtawy skan
  assert.deepEqual(paperColor(page((i) => (ink(i) ? [20, 20, 20] : [200, 200, 200]))), [200, 200, 200]); // szare tło
  // szum skanu (225–235): kolor z dolnej części rozkładu, żeby większość ziaren wyszła biała
  const noisy = paperColor(page((i) => { const v = 225 + (i * 10) % 11; return ink(i) ? [30, 30, 30] : [v, v, v]; }));
  assert.ok(noisy[0] >= 225 && noisy[0] <= 229 && noisy[0] === noisy[2], String(noisy));
  assert.equal(paperColor(page(() => [60, 50, 40])), null);                                            // ciemne zdjęcie
  assert.equal(paperColor(page((i) => (ink(i) ? [0, 0, 0] : [255, 245, 160]))), null);                 // mocno żółte tło
  assert.equal(paperColor(page((i) => (i % 10 === 0 ? [255, 255, 255] : [215, 215, 215]))), null);    // białe pola na szarym
  assert.equal(paperColor(page((i) => [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256])), null);      // bez wyraźnej kartki
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

test('automatyczne wykrywanie parowania stron (okładka vs rozkładówka)', () => {
  // 1 strona -> odd
  assert.equal(inferPairing({ numPages: 1 }), 'odd');

  // Jawny wpis w katalogu PDF
  assert.equal(inferPairing({ numPages: 10, pageLayout: 'TwoPageRight' }), 'even');
  assert.equal(inferPairing({ numPages: 10, pageLayout: 'TwoPageLeft' }), 'odd');

  // Etykiety stron
  assert.equal(inferPairing({ numPages: 10, pageLabels: ['Cover', '1', '2'] }), 'even');
  assert.equal(inferPairing({ numPages: 10, pageLabels: ['', '1', '2'] }), 'even');
  assert.equal(inferPairing({ numPages: 10, pageLabels: ['i', 'ii', '1'] }), 'even');

  // Spis treści / zakładki
  assert.equal(inferPairing({ numPages: 10, outlineTitles: ['Okładka', 'Rozdział 1'] }), 'even');
  assert.equal(inferPairing({ numPages: 10, outlineTitles: ['Cover Page', 'Introduction'] }), 'even');

  // Geometria: okładka w pionie, wnętrze w poziomie (rozkładówki)
  assert.equal(inferPairing({
    numPages: 10,
    page1: { width: 600, height: 800 },
    page2: { width: 1200, height: 800 }
  }), 'even');

  // Numeracja stron: strona 2 ma numer 1
  assert.equal(inferPairing({
    numPages: 10,
    page1: { width: 600, height: 800, textLength: 100, wordCount: 20 },
    page2: { width: 600, height: 800, textLength: 800, wordCount: 150, numbers: [{ value: 1, side: 'center' }] }
  }), 'even');

  // Numeracja stron: strona 2 ma numer 2 po lewej stronie (verso)
  assert.equal(inferPairing({
    numPages: 10,
    page1: { width: 600, height: 800, textLength: 100, wordCount: 20 },
    page2: { width: 600, height: 800, textLength: 800, wordCount: 150, numbers: [{ value: 2, side: 'left' }] }
  }), 'even');

  // Gęstość tekstu: okładka (mało tekstu) vs gęsta treść na stronie 2
  assert.equal(inferPairing({
    numPages: 10,
    page1: { width: 600, height: 800, textLength: 50, wordCount: 8 },
    page2: { width: 600, height: 800, textLength: 900, wordCount: 160 }
  }), 'even');

  // Artykuł / raport bez okładki: dużo tekstu na stronie 1 i 2
  assert.equal(inferPairing({
    numPages: 10,
    page1: { width: 600, height: 800, textLength: 1200, wordCount: 220 },
    page2: { width: 600, height: 800, textLength: 1400, wordCount: 250 }
  }), 'odd');
});

test('wykrywanie trybu jednej lub dwóch stron', () => {
  assert.equal(inferTwoPages({ numPages: 1 }), false);
  // Slajdy w poziomie (np. prezentacja 16:9)
  assert.equal(inferTwoPages({
    numPages: 15,
    page1: { width: 1920, height: 1080 },
    page2: { width: 1920, height: 1080 }
  }), false);
  // Książka w pionie (np. A4)
  assert.equal(inferTwoPages({
    numPages: 15,
    page1: { width: 595, height: 842 },
    page2: { width: 595, height: 842 }
  }), true);
});
