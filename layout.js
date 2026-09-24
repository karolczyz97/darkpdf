// layout.js – czysta geometria czytnika: rozkładówki, skala strony, wspólne przycięcie marginesów.
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

// ---------- przycinanie marginesów ----------
// Pole treści strony: { x, y, r, bt } (lewo, góra, prawo, dół) w jednostkach strony; full = { width, height }

// Treść na prawie całej stronie: okładka, zdjęcie na całą stronę
export const isFullBleed = (b, full) => (b.r - b.x) > full.width * 0.96 && (b.bt - b.y) > full.height * 0.96;

// Czy wspólne przycięcie box = { x, y, w, h } ucięłoby treść tej strony? Tolerancja ~1,5%
export function cutsContent(own, box, full) {
  const tx = full.width * 0.015, ty = full.height * 0.015;
  return isFullBleed(own, full) ||
    own.x < box.x - tx || own.y < box.y - ty ||
    own.r > box.x + box.w + tx || own.bt > box.y + box.h + ty;
}

// Strony tej samej parzystości co n, z których ustalamy wspólne przycięcie: w krótkim dokumencie wszystkie,
// w długim sąsiedztwo bieżącej strony i reszta równo po całym dokumencie (od 1 strony do tysięcy)
export function cropCandidatePages(n, total, max) {
  if (!total) return [];
  n = Math.max(1, Math.min(total, n || 1));
  const all = [];
  for (let p = n % 2 || 2; p <= total; p += 2) all.push(p);
  if (all.length <= max) return all;
  const pages = new Set([n]);
  for (let d = 2; d <= 24 && pages.size < Math.min(8, max); d += 2) {   // sąsiedztwo bieżącej strony
    if (n + d <= total) pages.add(n + d);
    if (n - d >= 1 && pages.size < max) pages.add(n - d);               // nie więcej niż max
  }
  const rest = max - pages.size;                                        // reszta równo po dokumencie
  for (let i = 0; i < rest; i++) pages.add(all[Math.floor(((i + 0.5) / rest) * all.length)]);
  for (const p of all) { if (pages.size >= max) break; pages.add(p); }  // dopełnienie po kolizjach
  return [...pages].sort((x, y) => x - y);
}

// Wspólne pole treści grupy stron → { x, y, w, h } albo null (za mało treści – lepiej nie przycinać).
// Okładki i zdjęcia na całą stronę nie psują przycięcia reszty, a brzeg bierzemy „prawie najszerszy”:
// przy dużej próbce pomijamy po jednej skrajnej stronie (pieczątka, rysunek w marginesie).
export function commonBox(boxes, full) {
  const valid = boxes.filter(Boolean);
  if (!valid.length) return null;
  let usable = valid;
  if (valid.length >= 3) {
    const normal = valid.filter((b) => !isFullBleed(b, full));
    if (normal.length >= Math.ceil(valid.length * 0.5)) usable = normal;
  }
  const skip = usable.length >= 10 ? 1 : 0;
  const low = (key) => usable.map((b) => b[key]).sort((a, b) => a - b)[skip];
  const high = (key) => usable.map((b) => b[key]).sort((a, b) => b - a)[skip];
  const x = low('x'), y = low('y');
  const w = high('r') - x, h = high('bt') - y;
  if (w < full.width * 0.3 || h < full.height * 0.3) return null;       // podejrzanie mało treści
  return { x, y, w, h };
}

// Pierwszy i ostatni wiersz oraz kolumna z dość ciemnymi pikselami (pojedyncze kropki ze skanu pomijamy).
// data – RGBA z getImageData; wynik w pikselach { x0, x1, y0, y1 } albo null (pusta strona)
export function contentBounds(data, width, height, { step = 2, threshold = 235 } = {}) {
  const rows = new Uint32Array(height), cols = new Uint32Array(width);
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) { rows[y]++; cols[x]++; }
    }
  }
  const span = (arr, len) => {
    const min = Math.max(2, Math.round(len * 0.004 / step));
    let a = 0, b = arr.length - 1;
    while (a < arr.length && arr[a] < min) a++;
    while (b > a && arr[b] < min) b--;
    return a <= b ? [a, b] : null;
  };
  const ys = span(rows, width), xs = span(cols, height);
  return ys && xs ? { x0: xs[0], x1: xs[1], y0: ys[0], y1: ys[1] } : null;
}
