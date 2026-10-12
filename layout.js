// layout.js – czysta geometria czytnika: rozkładówki i skala strony.
// Bez DOM i bez stanu – viewer.js podaje wszystko w parametrach, więc to samo sprawdzają testy (npm test).

// ---------- rozkładówki ----------
// o = { numPages, two, pairing }: two – dwie strony obok siebie,
// pairing 'odd' – pary 1–2, 3–4…   'even' – 1, 2–3, 4–5… (okładka sama)

// Pierwsza strona rozkładówki, na której leży strona p
export function spreadStartOf(p, { numPages, two, pairing }) {
  p = Math.min(Math.max(1, p), numPages);
  if (!two) return p;
  if (pairing === 'odd') return p % 2 ? p : p - 1;
  return p === 1 ? 1 : (p % 2 ? p - 1 : p);
}

// Strony rozkładówki zaczynającej się od s: [lewa, prawa]; null = puste miejsce
export function spreadOf(s, { numPages, two, pairing }) {
  if (!two) return [s, null];
  if (pairing === 'even' && s === 1) return [null, 1];   // okładka sama, po prawej
  return [s, s + 1 <= numPages ? s + 1 : null];
}

export function nextStart(s, { numPages, two, pairing }) {
  const n = !two ? s + 1 : (pairing === 'even' && s === 1) ? 2 : s + 2;
  return n <= numPages ? n : null;
}

export function prevStart(s, o) { return s <= 1 ? null : spreadStartOf(s - 1, o); }

// Napis rozkładówki: „7–8” albo „7”
export const spreadLabel = ([a, b]) => (a && b ? `${a}–${b}` : `${a || b}`);

// Rozpoznawanie, czy dokument zaczyna się pojedynczą okładką ('even': 1, 2–3…),
// czy od razu parą stron ('odd': 1–2, 3–4…).
export function inferPairing({
  pageLayout = null,
  pageLabels = null,
  outlineTitles = [],
  numPages = 0,
  page1 = null,
  page2 = null
} = {}) {
  if (numPages <= 1) return 'odd';

  // 1. Jawny wpis PageLayout w katalogu PDF
  if (pageLayout === 'TwoPageRight' || pageLayout === 'TwoColumnRight') return 'even';
  if (pageLayout === 'TwoPageLeft' || pageLayout === 'TwoColumnLeft') return 'odd';

  // 2. Etykiety stron (/PageLabels): jeśli strona 2 lub 3 ma etykietę '1', to strona 1 to okładka
  if (Array.isArray(pageLabels) && pageLabels.length >= 2) {
    const l0 = String(pageLabels[0] || '').trim().toLowerCase();
    const l1 = String(pageLabels[1] || '').trim().toLowerCase();
    const l2 = String(pageLabels[2] || '').trim().toLowerCase();
    if (l1 === '1' || l2 === '1' || /^(cover|okładka|front)\b/i.test(l0)) return 'even';
  }

  // 3. Spis treści / zakładki: pierwsza pozycja to okładka
  if (Array.isArray(outlineTitles) && outlineTitles.length > 0) {
    const t0 = String(outlineTitles[0] || '').trim().toLowerCase();
    if (/^(cover|okładka|front\s*cover|strona\s*tytułowa|title\s*page)\b/i.test(t0)) return 'even';
  }

  // 4. Geometria stron: proporcje boków
  if (page1 && page2 && page1.height > 0 && page2.height > 0) {
    const ar1 = page1.width / page1.height;
    const ar2 = page2.width / page2.height;
    // Strona 1 to pojedyncza strona w pionie, a strona 2 to podwójna rozkładówka w poziomie
    if (ar1 < 0.95 && ar2 > 1.15) return 'even';
    // Strona 1 to pełna rozkładówka okładki w poziomie, a strona 2 to pojedyncza strona w pionie
    if (ar1 > 1.15 && ar2 < 0.95) return 'even';
  }

  // 5. Numery stron w nagłówkach/stopkach
  if (page2?.numbers?.length) {
    // Strona 2 ma numer 1 (ciało książki numerowane od 1 po okładce)
    if (page2.numbers.some((n) => n.value === 1)) return 'even';
    // Strona 2 ma numer 2 po lewej stronie (verso = lewa strona rozkładówki)
    if (page2.numbers.some((n) => n.value === 2 && n.side === 'left')) return 'even';
  }
  if (page1?.numbers?.length) {
    // Strona 1 ma numer 1 po lewej stronie -> para 1-2
    if (page1.numbers.some((n) => n.value === 1 && n.side === 'left')) return 'odd';
  }

  // 6. Gęstość tekstu: okładka (mało tekstu lub obrazek) vs strona z treścią (dużo tekstu)
  if (page1 && page2) {
    const p1Sparse = (page1.textLength ?? 0) < 140 && (page1.wordCount ?? 0) < 30;
    const p2Dense = (page2.textLength ?? 0) > 240 && (page2.wordCount ?? 0) > 35;
    if (p1Sparse && p2Dense) return 'even';
  }

  return 'odd';
}

// Rozpoznawanie, czy dokument powinien domyślnie otworzyć się w trybie dwóch stron,
// czy pojedynczej strony (np. slajdy prezentacji w poziomie lub dokument 1-stronicowy).
export function inferTwoPages({
  numPages = 0,
  page1 = null,
  page2 = null
} = {}) {
  if (numPages <= 1) return false;
  if (page1 && page1.height > 0) {
    const ar1 = page1.width / page1.height;
    const ar2 = page2 && page2.height > 0 ? page2.width / page2.height : ar1;
    // Slajdy prezentacji lub szerokie arkusze w poziomie
    if (ar1 > 1.15 && ar2 > 1.15) return false;
  }
  return true;
}

// ---------- skala ----------
// fitMode: 'auto' – cała strona zawsze widoczna, 'width' – pełna szerokość (reszta przewijana w pionie),
// 'height' – pełna wysokość (nadmiar przewija się w bok)
export function pickScale(scaleW, scaleH, fitMode) {
  if (fitMode === 'width') return scaleW;
  if (fitMode === 'height') return scaleH;
  return Math.min(scaleW, scaleH);
}

// Skala rozkładówki w obszarze W×H px. sa, sb – pola stron { w, h } (null = brak strony).
// W trybie dwóch stron samotna strona ma obok puste miejsce tej samej wielkości.
export function fitSpread(sa, sb, { W, H, two, fitMode }) {
  // Auto: gdy strony przy skali „na wysokość” mieszczą się w W co do piksela, bierzemy tę skalę –
  // inaczej ułamek piksela z zaokrąglenia szerokości ucinałby wysokość o piksel i odstępy góra/dół rozjeżdżałyby się
  const pick = (scaleW, scaleH, widthAt) =>
    fitMode === 'auto' && scaleW < scaleH && W >= widthAt(scaleH) ? scaleH : pickScale(scaleW, scaleH, fitMode);
  if (!two) {
    const s = sa || sb;
    if (!s || !s.w || !s.h) return { scale: 1, L: s, R: s, single: true };
    return { scale: pick(W / s.w, H / s.h, (k) => pagePx(s.w * k)), L: s, R: s, single: true };
  }
  const L = sa || sb, R = sb || sa;
  if (!L || !L.w || !L.h) return { scale: 1, L, R, single: false };
  const totalW = L.w + (R.w || L.w);
  const maxH = Math.max(L.h, R.h || L.h);
  const widthAt = (k) => pagePx(L.w * k) + pagePx((R.w || L.w) * k);
  return { scale: pick(W / totalW, H / maxH, widthAt), L, R, single: false };
}

// Rozmiar strony na ekranie w pełnych pikselach. Ta sama reguła w rysowaniu i w liczeniu miejsca na PDF,
// żeby odstępy po bokach wychodziły równe (bez połówek piksela); 1e-6 chroni przed błędem zmiennoprzecinkowym
export const pagePx = (x) => Math.floor(x + 1e-6);

// Szerokość stron (px) przy dopasowaniu do wysokości H – tyle miejsca potrzebuje PDF obok kalkulatora
export function heightFitWidth(sa, sb, { H, two, gap }) {
  if (!two) {
    const s = sa || sb;
    if (!s || !s.w || !s.h) return null;
    return pagePx(s.w * (H / s.h));
  }
  const L = sa || sb, R = sb || sa;
  if (!L || !L.w || !L.h) return null;
  const scale = H / Math.max(L.h, R.h || L.h);
  return pagePx(L.w * scale) + pagePx(R.w * scale) + gap;   // samotna strona też ma obok puste miejsce
}


// ---------- kolor kartki ----------
// Kartka strony do wyrównania przed odwróceniem kolorów: najczęstszy kolor miniatury (razem z szumem skanu)
// → [r, g, b] albo null, gdy nie ma czego wyrównywać: kartka biała, za mało jej (zdjęcie, okładka), za ciemna,
// za mocno zabarwiona (żółta ramka na pół strony) albo są na niej wyraźnie jaśniejsze pola (białe ramki na szarym
// tle zlałyby się z kartką). data – RGBA z getImageData
export function paperColor(data, { minShare = 0.3, minLevel = 160, maxTint = 60, maxLighter = 0.04 } = {}) {
  const n = data.length / 4;
  const counts = new Map();
  let top = 0, topN = 0;
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);   // przedziały po 8 poziomów
    const c = (counts.get(k) || 0) + 1;
    counts.set(k, c);
    if (c > topN) { top = k; topN = c; }
  }
  const kr = top >> 10, kg = (top >> 5) & 31, kb = top & 31;
  const near = (v, k) => Math.abs((v >> 3) - k) <= 1;                  // sąsiednie przedziały: szum skanu
  const ch = [[], [], []];
  for (let i = 0; i < data.length; i += 4) {
    if (near(data[i], kr) && near(data[i + 1], kg) && near(data[i + 2], kb)) {
      ch[0].push(data[i]); ch[1].push(data[i + 1]); ch[2].push(data[i + 2]);
    }
  }
  if (!n || ch[0].length < n * minShare) return null;
  // Dolna część rozkładu: po wyrównaniu większość ziaren kartki jest biała, czyli po odwróceniu dokładnie w kolorze tła
  const paper = ch.map((a) => a.sort((x, y) => x - y)[Math.floor(a.length * 0.2)]);
  const lo = Math.min(...paper), hi = Math.max(...paper);
  if (lo >= 253 || lo < minLevel || hi - lo > maxTint) return null;
  let lighter = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= paper[0] + 16 && data[i + 1] >= paper[1] + 16 && data[i + 2] >= paper[2] + 16) lighter++;
  }
  return lighter > n * maxLighter ? null : paper;
}
