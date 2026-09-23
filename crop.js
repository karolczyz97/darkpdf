// crop.js – automatyczne przycinanie białych marginesów stron.
// Strony lewe i prawe mają w książkach inne marginesy, a strona może mieć inny rozmiar, więc grupujemy
// po parzystości i wymiarach. W obrębie grupy wszystkie strony dostają to samo obcięcie, żeby tekst
// nie skakał przy przewracaniu. Geometria (bez DOM) jest w layout.js.
import { mapConcurrent } from './util.js';
import { commonBox, contentBounds, cropCandidatePages, cutsContent } from './layout.js';

const SAMPLES = 28;       // ile stron badamy, żeby ustalić wspólne obcięcie
const QUICK = 6;          // tyle stron badamy przed pokazaniem pierwszej; pełną próbkę liczymy w tle
const THRESHOLD = 235;    // jaśniejsze piksele uznajemy za pusty margines
const STEP = 2;           // co który piksel miniatury sprawdzamy
const THUMB_W = 240;      // szerokość miniatury do badania treści (px)
const PAD = 8;            // niewielki oddech wokół treści (px miniatury)

// doc() – otwarty dokument pdf.js, rotation() – obrót od użytkownika (0/90/180/270),
// enabled() – czy przycinać, onRefine() – pełna próbka dała inne cięcie niż szybka: trzeba przerysować
export function createCropper({ doc, rotation, enabled, onRefine }) {
  const cropJobs = new Map();   // klucz grupy stron -> Promise<wspólne pole treści albo null>
  const ownJobs = new Map();    // nr strony -> Promise<pole treści tej jednej strony albo null>
  let gen = 0;                  // rośnie przy każdym czyszczeniu – stare obliczenia w tle wtedy przepadają

  const rotationOf = (page) => (page.rotate + rotation() + 360) % 360;
  const viewportOf = (page, scale = 1) => page.getViewport({ scale, rotation: rotationOf(page) });
  const groupKey = (n, full) => `${n % 2}|${Math.round(full.width)}x${Math.round(full.height)}|${rotation()}`;

  // Pole treści jednej strony liczymy raz – przyda się i do wspólnego cięcia, i do sprawdzania wyjątków
  function ownBox(n, page, full) {
    if (!ownJobs.has(n)) ownJobs.set(n, detectContent(page, full));
    return ownJobs.get(n);
  }

  // Obszar strony n do pokazania: { x, y, w, h } w jednostkach strony (po obrocie).
  // Strona, na której wspólne cięcie coś by ucięło (zdjęcie na całą stronę, okładka, rysunek w marginesie),
  // idzie w całości, a w ref zostaje wspólne cięcie (panel kalkulatora mierzy się po nim).
  async function pageBox(n) {
    const pdf = doc();
    if (!pdf || !n || n < 1 || n > pdf.numPages) return null;
    const page = await pdf.getPage(n);
    const full = viewportOf(page);
    const whole = { x: 0, y: 0, w: full.width, h: full.height };
    if (!enabled()) return whole;
    const k = groupKey(n, full);
    if (!cropJobs.has(k)) {
      const quick = groupBox(n, full, k, QUICK);
      cropJobs.set(k, quick);
      refine(n, full, k, quick);
    }
    const common = await cropJobs.get(k);
    if (!common) return whole;
    const own = await ownBox(n, page, full);
    if (own && cutsContent(own, common, full)) return { ...whole, ref: common };
    return common;
  }

  // Pełna próbka w tle. Jeśli dała inne cięcie niż szybka, podmieniamy je raz i przerysowujemy.
  async function refine(n, full, k, quick) {
    const myGen = gen;
    const first = await quick;
    if (myGen !== gen) return;                 // w międzyczasie zmienił się plik lub ustawienia
    const better = await groupBox(n, full, k, SAMPLES);
    if (myGen !== gen || cropJobs.get(k) !== quick) return;
    cropJobs.set(k, Promise.resolve(better));
    const same = (a, b) => (!a && !b) || (a && b && ['x', 'y', 'w', 'h'].every((q) => Math.abs(a[q] - b[q]) < 1));
    if (!same(first, better)) onRefine();
  }

  // Wspólne pole treści grupy k z próbki stron tej samej parzystości i wielkości
  async function groupBox(n, full, k, samples) {
    const pdf = doc();
    if (!pdf) return null;
    const boxes = await mapConcurrent(cropCandidatePages(n, pdf.numPages, samples), 6, async (p) => {
      const page = await pdf.getPage(p);
      const vp = viewportOf(page);
      return groupKey(p, vp) === k ? ownBox(p, page, vp) : null;
    });
    return commonBox(boxes, full);
  }

  // Strona renderowana w miniaturze → pole treści w jednostkach strony albo null (pusta strona, błąd)
  async function detectContent(page, full) {
    const s = Math.min(1, THUMB_W / full.width);
    const vp = viewportOf(page, s);
    const c = document.createElement('canvas');
    try {
      c.width = Math.max(1, Math.ceil(vp.width));
      c.height = Math.max(1, Math.ceil(vp.height));
      const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const b = contentBounds(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { step: STEP, threshold: THRESHOLD });
      if (!b) return null;
      const pad = PAD / s;
      return {
        x: Math.max(0, b.x0 / s - pad),
        y: Math.max(0, b.y0 / s - pad),
        r: Math.min(full.width, (b.x1 + STEP) / s + pad),
        bt: Math.min(full.height, (b.y1 + STEP) / s + pad)
      };
    } catch {
      return null;
    } finally {
      c.width = 0;                           // zwalniamy pamięć płótna od razu (ważne na iPhonie)
      c.height = 0;
    }
  }

  // Nowy plik, przełączenie przycinania lub obrót: liczymy od nowa
  function reset() {
    gen++;
    cropJobs.clear();
    ownJobs.clear();
  }

  return { pageBox, rotationOf, reset };
}
