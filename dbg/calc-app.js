// calc-app.js – Silnik i interfejs kalkulatora naukowego
// Działa jako samodzielna aplikacja oraz osadzony komponent w DarkPDF

export class CalcError extends Error {}
const err = (m) => new CalcError(m);

// ================= Jednostki =================
const BASE = ['kg', 'm', 's', 'A', 'K', 'mol', 'cd'];
const ORDER = ['kg', 'm', 's', 'A', 'K', 'mol', 'cd'];
const SUP_DIGIT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };
const supNum = (n) => String(n).replace(/[-0-9]/g, (c) => ({ '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }[c]));

const uMul = (a, b, sg = 1) => {
  const r = { ...a };
  for (const [k, e] of Object.entries(b)) {
    const v = (r[k] || 0) + sg * e;
    if (Math.abs(v) > 1e-9) r[k] = v;
    else delete r[k];
  }
  return r;
};

const uPow = (u, n) => {
  const r = {};
  for (const [k, e] of Object.entries(u)) {
    const v = e * n;
    if (Math.abs(v - Math.round(v * 2) / 2) > 1e-9) throw err('Nie da się podnieść jednostki do takiej potęgi');
    if (Math.abs(v) > 1e-9) r[k] = Math.round(v * 1e6) / 1e6;
  }
  return r;
};

const uNone = (u) => !u || Object.keys(u).length === 0;
const uEq = (a, b) => {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (Math.abs(((a && a[k]) || 0) - ((b && b[k]) || 0)) > 1e-9) return false;
  }
  return true;
};

const DERIVED = {
  N: 'kg*m/s^2', J: 'N*m', W: 'J/s', Pa: 'N/m^2', C: 'A*s', V: 'W/A',
  'Ω': 'V/A', S: 'A/V', F: 'C/V', Wb: 'V*s', T: 'Wb/m^2', H: 'Wb/A',
  Hz: '1/s', Bq: '1/s', Gy: 'J/kg', Sv: 'J/kg', rad: '1', sr: '1'
};

const EXTRA = {
  g: ['kg', 1e-3], t: ['kg', 1e3], L: ['m^3', 1e-3], l: ['m^3', 1e-3],
  min: ['s', 60], h: ['s', 3600], godz: ['s', 3600], d: ['s', 86400],
  ha: ['m^2', 1e4], bar: ['Pa', 1e5], atm: ['Pa', 101325],
  eV: ['J', 1.602176634e-19], u: ['kg', 1.66053906660e-27], au: ['m', 1.495978707e11],
  ly: ['m', 9.4607304725808e15], pc: ['m', 3.0856775814914e16],
  kmh: ['m/s', 1 / 3.6], Wh: ['J', 3600], kWh: ['J', 3.6e6], MWh: ['J', 3.6e9]
};

const PREFIX = {
  Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 10,
  d: 1e-1, c: 1e-2, m: 1e-3, µ: 1e-6, μ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18
};

function symbolUnit(name) {
  if (name === '1') return { u: {}, f: 1 };
  if (BASE.includes(name)) return { u: { [name]: 1 }, f: 1 };
  if (name in DERIVED) return parseUnit(DERIVED[name]);
  if (name in EXTRA) {
    const [str, f] = EXTRA[name];
    const p = parseUnit(str);
    return { u: p.u, f: p.f * f };
  }
  if (name.length > 2 && name.startsWith('da')) {
    const inner = symbolUnit(name.slice(2));
    return { u: inner.u, f: inner.f * 10 };
  }
  if (name.length > 1) {
    const p = name[0];
    if (p in PREFIX) {
      try {
        const inner = symbolUnit(name.slice(1));
        return { u: inner.u, f: inner.f * PREFIX[p] };
      } catch {}
    }
  }
  throw err(`Nieznana jednostka: ${name}`);
}

function parseUnit(str) {
  const SUPS = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/g;
  const src = str.replace(/·/g, '*').replace(SUPS, (c) => (c === '⁻' ? '^-' : '^' + SUP_DIGIT[c]))
                 .replace(/\^(-?)(\d)\^(\d)/g, '^$1$2$3');
  let i = 0;
  const skip = () => { while (src[i] === ' ') i++; };
  function atom() {
    skip();
    if (src[i] === '(') {
      i++;
      const r = expr();
      skip();
      if (src[i] === ')') i++;
      return r;
    }
    const m = /^[A-Za-zΩµμ]+/.exec(src.slice(i));
    if (!m) {
      const n = /^\d+/.exec(src.slice(i));
      if (n) { i += n[0].length; return { u: {}, f: 1 }; }
      throw err(`Zła jednostka: ${str}`);
    }
    i += m[0].length;
    return symbolUnit(m[0]);
  }
  function term() {
    let r = atom();
    skip();
    if (src[i] === '^') {
      i++;
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i));
      if (!m) throw err(`Zła jednostka: ${str}`);
      i += m[0].length;
      const n = parseFloat(m[0]);
      r = { u: uPow(r.u, n), f: Math.pow(r.f, n) };
    }
    return r;
  }
  function expr() {
    let r = term();
    for (;;) {
      skip();
      const op = src[i];
      if (op !== '*' && op !== '/') return r;
      i++;
      const b = term();
      r = { u: uMul(r.u, b.u, op === '*' ? 1 : -1), f: op === '*' ? r.f * b.f : r.f / b.f };
    }
  }
  return expr();
}

function uSplit(u, part) {
  const keys = Object.keys(u || {}).filter((k) => Math.abs(u[k]) > 1e-9).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return {
    top: keys.filter((k) => u[k] > 0).map((k) => part(k, u[k])),
    bot: keys.filter((k) => u[k] < 0).map((k) => part(k, -u[k]))
  };
}

function uText(u) {
  const { top, bot } = uSplit(u, (k, e) => k + (e === 1 ? '' : supNum(e)));
  if (!top.length && !bot.length) return '';
  if (!bot.length) return top.join('·');
  const den = bot.length > 1 ? `(${bot.join('·')})` : bot[0];
  return `${top.length ? top.join('·') : '1'}/${den}`;
}

function uTex(u) {
  const { top, bot } = uSplit(u, (k, e) =>
    e === 1 ? `\\text{${k}}` : e === 0.5 ? `\\sqrt{\\text{${k}}}` : `\\text{${k}}^{${e}}`);
  if (!top.length && !bot.length) return '';
  if (!bot.length) return top.join(' \\cdot ');
  const num = top.length ? top.join(' \\cdot ') : '1';
  const den = bot.join(' \\cdot ');
  return `\\frac{${num}}{${den}}`;
}

function formatProductTex(s) {
  if (!s) return '';
  const tokens = s.split(/[*·\s]+/).filter(Boolean);
  const parts = tokens.map((tok) => {
    if (tok.startsWith('(') && tok.endsWith(')')) {
      return `(${rawToTex(tok.slice(1, -1))})`;
    }
    const m = /^([A-Za-zΩµμ]+)(?:\^(-?\d+(?:\.\d+)?))?$/.exec(tok);
    if (m) {
      const u = m[1];
      const exp = m[2];
      return `\\text{${u}}` + (exp ? `^{${exp}}` : '');
    }
    if (/^\d+$/.test(tok)) return tok;
    return `\\text{${tok}}`;
  });
  return parts.join(' \\cdot ');
}

function rawToTex(s) {
  if (!s) return '';
  let str = s.trim()
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (m) => '^' + [...m].map((c) => SUP_DIGIT[c]).join(''));
  const slashIdx = str.indexOf('/');
  if (slashIdx !== -1) {
    let num = str.slice(0, slashIdx).trim();
    let den = str.slice(slashIdx + 1).trim();
    if (den.startsWith('(') && den.endsWith(')')) den = den.slice(1, -1).trim();
    return `\\frac{${formatProductTex(num) || '1'}}{${formatProductTex(den) || '1'}}`;
  }
  return formatProductTex(str);
}

const NAMED_PAIRS = [
  ['N', 'kg*m/s^2'], ['J', 'kg*m^2/s^2'], ['W', 'kg*m^2/s^3'], ['Pa', 'kg/(m*s^2)'],
  ['C', 'A*s'], ['V', 'kg*m^2/(s^3*A)'], ['Ω', 'kg*m^2/(s^3*A^2)'], ['F', 's^4*A^2/(kg*m^2)'],
  ['T', 'kg/(s^2*A)'], ['Wb', 'kg*m^2/(s^2*A)'], ['H', 'kg*m^2/(s^2*A^2)'], ['S', 's^3*A^2/(kg*m^2)'],
  ['Hz', '1/s']
].map(([n, d]) => [n, parseUnit(d).u]);

const uName = (u) => {
  if (!u || uNone(u)) return null;
  const match = NAMED_PAIRS.find(([, d]) => uEq(d, u));
  return match ? match[0] : null;
};

const uInline = (u) => {
  if (!u || uNone(u)) return '';
  const name = uName(u);
  if (name) return name;
  return uText(u)
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (m) => '^' + [...m].map((c) => SUP_DIGIT[c]).join(''))
    .replace(/·/g, '*');
};

// ================= Stałe =================
const CONSTS = [
  ['c', 'c', 'prędkość światła w próżni', 299792458, 'm/s', 'Podstawowe'],
  ['G', 'G', 'stała grawitacji', 6.67430e-11, 'N·m²/kg²', 'Podstawowe'],
  ['h', 'h', 'stała Plancka', 6.62607015e-34, 'J·s', 'Podstawowe'],
  ['hbar', 'ħ', 'zredukowana stała Plancka (h/2π)', 1.054571817e-34, 'J·s', 'Podstawowe', ['ħ']],
  ['qe', 'e', 'ładunek elementarny', 1.602176634e-19, 'C', 'Podstawowe', ['q_e']],
  ['kB', 'k<sub>B</sub>', 'stała Boltzmanna', 1.380649e-23, 'J/K', 'Podstawowe', ['k_B']],
  ['NA', 'N<sub>A</sub>', 'liczba Avogadra', 6.02214076e23, '1/mol', 'Podstawowe', ['N_A']],
  ['R', 'R', 'uniwersalna stała gazowa', 8.314462618, 'J/(mol·K)', 'Podstawowe'],

  ['g', 'g', 'przyspieszenie ziemskie (szkolne)', 9.81, 'm/s²', 'Mechanika'],
  ['gn', 'g<sub>n</sub>', 'przyspieszenie ziemskie normalne', 9.80665, 'm/s²', 'Mechanika', ['g_n']],
  ['vdz', 'v<sub>dź</sub>', 'prędkość dźwięku w powietrzu (≈20 °C)', 343, 'm/s', 'Mechanika', ['v_dz']],
  ['rhow', 'ρ<sub>w</sub>', 'gęstość wody', 1000, 'kg/m³', 'Mechanika', ['rho_w']],
  ['rhop', 'ρ<sub>p</sub>', 'gęstość powietrza (0 °C, 1 atm)', 1.29, 'kg/m³', 'Mechanika', ['rho_p']],
  ['rholod', 'ρ<sub>lodu</sub>', 'gęstość lodu', 917, 'kg/m³', 'Mechanika'],
  ['rhoHg', 'ρ<sub>Hg</sub>', 'gęstość rtęci', 13550, 'kg/m³', 'Mechanika'],
  ['rhoFe', 'ρ<sub>Fe</sub>', 'gęstość żelaza', 7860, 'kg/m³', 'Mechanika'],
  ['rhoAlu', 'ρ<sub>Al</sub>', 'gęstość aluminium', 2700, 'kg/m³', 'Mechanika'],

  ['muB', 'μ<sub>B</sub>', 'magneton Bohra', 9.2740100783e-24, 'J/T', 'Elektryczność i magnetyzm', ['μB']],
  ['rhoCu', 'ρ<sub>Cu</sub>', 'opór właściwy miedzi (20 °C)', 1.68e-8, 'Ω·m', 'Elektryczność i magnetyzm'],
  ['rhoAl', 'ρ<sub>Al</sub>', 'opór właściwy aluminium (20 °C)', 2.65e-8, 'Ω·m', 'Elektryczność i magnetyzm'],
  ['k', 'k', 'stała Coulomba 1/(4πε₀)', 8.9875517923e9, 'N·m²/C²', 'Elektryczność i magnetyzm'],

  ['eps0', 'ε<sub>0</sub>', 'przenikalność elektryczna próżni', 8.8541878128e-12, 'F/m', 'Elektryczność i magnetyzm', ['ε0', 'ε_0']],
  ['mu0', 'μ<sub>0</sub>', 'przenikalność magnetyczna próżni', 1.25663706212e-6, 'N/A²', 'Elektryczność i magnetyzm', ['μ0', 'μ_0']],

  ['T0', 'T<sub>0</sub>', 'temperatura 0 °C', 273.15, 'K', 'Termodynamika', ['T_0']],
  ['p0', 'p<sub>0</sub>', 'ciśnienie normalne', 101325, 'Pa', 'Termodynamika', ['p_0']],
  ['cw', 'c<sub>w</sub>', 'ciepło właściwe wody', 4190, 'J/(kg·K)', 'Termodynamika', ['c_w']],
  ['cl', 'c<sub>l</sub>', 'ciepło właściwe lodu', 2100, 'J/(kg·K)', 'Termodynamika', ['c_l']],
  ['ctw', 'c<sub>t,w</sub>', 'ciepło topnienia lodu', 333700, 'J/kg', 'Termodynamika', ['c_tw']],
  ['cpar', 'c<sub>p,w</sub>', 'ciepło parowania wody (100 °C)', 2257000, 'J/kg', 'Termodynamika', ['c_par']],
  ['sigma', 'σ', 'stała Stefana-Boltzmanna', 5.670374419e-8, 'W/(m²·K⁴)', 'Termodynamika'],
  ['bWien', 'b', 'stała Wiena', 2.897771955e-3, 'm·K', 'Termodynamika', ['b_Wien']],

  ['me', 'm<sub>e</sub>', 'masa spoczynkowa elektronu', 9.1093837015e-31, 'kg', 'Atom i kwanty', ['m_e']],
  ['mp', 'm<sub>p</sub>', 'masa spoczynkowa protonu', 1.67262192369e-27, 'kg', 'Atom i kwanty', ['m_p']],
  ['mn', 'm<sub>n</sub>', 'masa spoczynkowa neutronu', 1.67492749804e-27, 'kg', 'Atom i kwanty', ['m_n']],
  ['u', 'u', 'unifikowana jednostka masy atomowej', 1.66053906660e-27, 'kg', 'Atom i kwanty'],
  ['a0', 'a<sub>0</sub>', 'promień Bohra', 5.29177210903e-11, 'm', 'Atom i kwanty', ['a_0']],
  ['Rinf', 'R<sub>∞</sub>', 'stała Rydberga', 10973731.568160, '1/m', 'Atom i kwanty', ['R_inf']],

  ['MZ', 'M<sub>Z</sub>', 'masa Ziemi', 5.9722e24, 'kg', 'Astronomia', ['M_Z']],
  ['RZ', 'R<sub>Z</sub>', 'średni promień Ziemi', 6371000, 'm', 'Astronomia', ['R_Z']],
  ['MS', 'M<sub>S</sub>', 'masa Słońca', 1.9885e30, 'kg', 'Astronomia', ['M_S']],
  ['RS', 'R<sub>S</sub>', 'promień Słońca', 695700000, 'm', 'Astronomia', ['R_S']],
  ['MK', 'M<sub>K</sub>', 'masa Księżyca', 7.342e22, 'kg', 'Astronomia', ['M_K']],
  ['RK', 'R<sub>K</sub>', 'promień Księżyca', 1737400, 'm', 'Astronomia', ['R_K']],
  ['dZK', 'd<sub>ZK</sub>', 'średnia odległość Ziemia–Księżyc', 384400000, 'm', 'Astronomia', ['d_ZK']],
  ['au', 'au', 'jednostka astronomiczna (Ziemia–Słońce)', 149597870700, 'm', 'Astronomia'],
  ['ly', 'ly', 'rok świetlny', 9.4607304725808e15, 'm', 'Astronomia'],
  ['pc', 'pc', 'parsek', 3.0856775814914e16, 'm', 'Astronomia'],

  ['MMer', 'M<sub>Merkury</sub>', 'masa Merkurego', 3.301e+23, 'kg', 'Układ Słoneczny'],
  ['RMer', 'R<sub>Merkury</sub>', 'promień Merkurego', 2439700.0, 'm', 'Układ Słoneczny'],
  ['aMer', 'a<sub>Merkury</sub>', 'promień orbity Merkurego', 57910000000.0, 'm', 'Układ Słoneczny'],
  ['TMer', 'T<sub>Merkury</sub>', 'okres obiegu Merkurego', 7600500.0, 's', 'Układ Słoneczny'],
  ['MWen', 'M<sub>Wenus</sub>', 'masa Wenus', 4.867e+24, 'kg', 'Układ Słoneczny'],
  ['RWen', 'R<sub>Wenus</sub>', 'promień Wenus', 6051800.0, 'm', 'Układ Słoneczny'],
  ['aWen', 'a<sub>Wenus</sub>', 'promień orbity Wenus', 108210000000.0, 'm', 'Układ Słoneczny'],
  ['TWen', 'T<sub>Wenus</sub>', 'okres obiegu Wenus', 19414000.0, 's', 'Układ Słoneczny'],
  ['MMar', 'M<sub>Mars</sub>', 'masa Marsa', 6.417e+23, 'kg', 'Układ Słoneczny'],
  ['RMar', 'R<sub>Mars</sub>', 'promień Marsa', 3389500.0, 'm', 'Układ Słoneczny'],
  ['aMar', 'a<sub>Mars</sub>', 'promień orbity Marsa', 227920000000.0, 'm', 'Układ Słoneczny'],
  ['TMar', 'T<sub>Mars</sub>', 'okres obiegu Marsa', 59355000.0, 's', 'Układ Słoneczny'],
  ['MJow', 'M<sub>Jowisz</sub>', 'masa Jowisza', 1.898e+27, 'kg', 'Układ Słoneczny'],
  ['RJow', 'R<sub>Jowisz</sub>', 'promień Jowisza', 69911000.0, 'm', 'Układ Słoneczny'],
  ['aJow', 'a<sub>Jowisz</sub>', 'promień orbity Jowisza', 778500000000.0, 'm', 'Układ Słoneczny'],
  ['TJow', 'T<sub>Jowisz</sub>', 'okres obiegu Jowisza', 374350000.0, 's', 'Układ Słoneczny'],
  ['MSat', 'M<sub>Saturn</sub>', 'masa Saturna', 5.683e+26, 'kg', 'Układ Słoneczny'],
  ['RSat', 'R<sub>Saturn</sub>', 'promień Saturna', 58232000.0, 'm', 'Układ Słoneczny'],
  ['aSat', 'a<sub>Saturn</sub>', 'promień orbity Saturna', 1433500000000.0, 'm', 'Układ Słoneczny'],
  ['TSat', 'T<sub>Saturn</sub>', 'okres obiegu Saturna', 929290000.0, 's', 'Układ Słoneczny'],
  ['MUra', 'M<sub>Uran</sub>', 'masa Urana', 8.681e+25, 'kg', 'Układ Słoneczny'],
  ['RUra', 'R<sub>Uran</sub>', 'promień Urana', 25362000.0, 'm', 'Układ Słoneczny'],
  ['aUra', 'a<sub>Uran</sub>', 'promień orbity Urana', 2872500000000.0, 'm', 'Układ Słoneczny'],
  ['TUra', 'T<sub>Uran</sub>', 'okres obiegu Urana', 2651200000.0, 's', 'Układ Słoneczny'],
  ['MNep', 'M<sub>Neptun</sub>', 'masa Neptuna', 1.024e+26, 'kg', 'Układ Słoneczny'],
  ['RNep', 'R<sub>Neptun</sub>', 'promień Neptuna', 24622000.0, 'm', 'Układ Słoneczny'],
  ['aNep', 'a<sub>Neptun</sub>', 'promień orbity Neptuna', 4495100000000.0, 'm', 'Układ Słoneczny'],
  ['TNep', 'T<sub>Neptun</sub>', 'okres obiegu Neptuna', 5200400000.0, 's', 'Układ Słoneczny'],
  ['vZ', 'v<sub>Z</sub>', 'prędkość orbitalna Ziemi', 29780, 'm/s', 'Układ Słoneczny'],
  ['v1Z', 'v<sub>I</sub>', 'pierwsza prędkość kosmiczna', 7910, 'm/s', 'Układ Słoneczny'],
  ['v2Z', 'v<sub>II</sub>', 'druga prędkość kosmiczna (ucieczki)', 11186, 'm/s', 'Układ Słoneczny'],
  ['LS', 'L<sub>S</sub>', 'moc promieniowania Słońca', 3.828e26, 'W', 'Układ Słoneczny'],
  ['S0', 'S<sub>0</sub>', 'stała słoneczna (na orbicie Ziemi)', 1361, 'W/m²', 'Układ Słoneczny'],

  ['kWh', 'kWh', 'kilowatogodzina', 3.6e6, 'J', 'Przeliczniki'],
  ['cal', 'cal', 'kaloria', 4.1868, 'J', 'Przeliczniki'],
  ['bar', 'bar', 'bar', 1e5, 'Pa', 'Przeliczniki'],
  ['atm', 'atm', 'atmosfera', 101325, 'Pa', 'Przeliczniki'],
  ['mmHg', 'mmHg', 'milimetr słupa rtęci (tor)', 133.322, 'Pa', 'Przeliczniki'],
  ['kmh', 'km/h', 'kilometr na godzinę (72 kmh = 20 m/s)', 1 / 3.6, 'm/s', 'Przeliczniki'],
  ['KM', 'KM', 'koń mechaniczny', 735.49875, 'W', 'Przeliczniki'],

  ['pi', 'π', 'liczba pi', Math.PI, '', 'Matematyka', ['π']],
  ['e', 'e', 'liczba Eulera (podstawa ln)', Math.E, '', 'Matematyka'],
  ['phi', 'φ', 'złoty podział', (1 + Math.sqrt(5)) / 2, '', 'Matematyka', ['φ']],
];

const CONST = {};
for (const [id, sym, name, value, unit, group, aliases = []] of CONSTS) {
  let u = {};
  try { u = unit ? parseUnit(unit).u : {}; } catch { u = {}; }
  const c = { id, sym, name, value, unit, group, u };
  CONST[id] = c;
  for (const a of aliases) CONST[a] = c;
}

// ================= Funkcje matematyczne =================
let globalAngle = 'deg';
const toRad = (x) => globalAngle === 'deg' ? x * Math.PI / 180 : x;
const fromRad = (x) => globalAngle === 'deg' ? x * 180 / Math.PI : x;
const clean = (x) => Math.abs(x) < 1e-14 ? 0 : x;
const inUnit = (x, f) => { if (x < -1 || x > 1) throw err(`${f}: argument musi być z przedziału [−1; 1]`); return x; };
const pos = (x, f) => { if (x <= 0) throw err(`${f}: argument musi być dodatni`); return x; };

const tg = (x) => { const r = toRad(x); if (Math.abs(Math.cos(r)) < 1e-12) throw err('tg nieokreślony dla tego kąta'); return clean(Math.tan(r)); };
const ctg = (x) => { const r = toRad(x); if (Math.abs(Math.sin(r)) < 1e-12) throw err('ctg nieokreślony dla tego kąta'); return clean(Math.cos(r) / Math.sin(r)); };

const FUNCS = {
  sin: [1, 1, (x) => clean(Math.sin(toRad(x)))],
  cos: [1, 1, (x) => clean(Math.cos(toRad(x)))],
  tg: [1, 1, tg], tan: [1, 1, tg],
  ctg: [1, 1, ctg], cot: [1, 1, ctg],
  arcsin: [1, 1, (x) => fromRad(Math.asin(inUnit(x, 'arcsin')))],
  arccos: [1, 1, (x) => fromRad(Math.acos(inUnit(x, 'arccos')))],
  arctg: [1, 1, (x) => fromRad(Math.atan(x))],
  arcctg: [1, 1, (x) => fromRad(Math.PI / 2 - Math.atan(x))],
  sinh: [1, 1, Math.sinh], cosh: [1, 1, Math.cosh], tgh: [1, 1, Math.tanh], tanh: [1, 1, Math.tanh],
  sqrt: [1, 1, (x) => { if (x < 0) throw err('Pierwiastek z liczby ujemnej'); return Math.sqrt(x); }],
  cbrt: [1, 1, Math.cbrt],
  root: [2, 2, (x, n) => {
    if (n === 0) throw err('root: stopień nie może być 0');
    if (x < 0) { if (Number.isInteger(n) && n % 2) return -Math.pow(-x, 1 / n); throw err('Pierwiastek parzystego stopnia z liczby ujemnej'); }
    return Math.pow(x, 1 / n);
  }],
  ln: [1, 1, (x) => Math.log(pos(x, 'ln'))],
  log: [1, 2, (x, b) => b === undefined ? Math.log10(pos(x, 'log')) : Math.log(pos(x, 'log')) / Math.log(pos(b, 'log (podstawa)'))],
  log2: [1, 1, (x) => Math.log2(pos(x, 'log2'))],
  exp: [1, 1, Math.exp],
  abs: [1, 1, Math.abs],
  round: [1, 2, (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; }],
  floor: [1, 1, Math.floor], ceil: [1, 1, Math.ceil],
  min: [1, 99, Math.min], max: [1, 99, Math.max],
  rad: [1, 1, (x) => x * Math.PI / 180],
  deg: [1, 1, (x) => x * 180 / Math.PI],
};
FUNCS['√'] = FUNCS.sqrt;

// ================= Tokenizer & Parser =================
const ID_START = /[A-Za-z_\u0370-\u03FF\u0127]/;
const ID_RE = /^[A-Za-z_\u0370-\u03FF][A-Za-z0-9_\u0370-\u03BF\u03C1-\u03FF]*/;
const NUM_RE = /^(\d+(?:[.,]\d+)?|\d+\.|[.,]\d+)(?:[eE][+-]?\d+)?/;
const OP_MAP = { '×': '*', '·': '*', '÷': '/', '−': '-', '–': '-', ';': ',' };

function createTokenizer(vars) {
  const known = (n) => n in FUNCS || n in CONST || n in vars || n === 'ans';

  function readUnit(src, i) {
    const SYM = /^[A-Za-zΩµμ]+/;
    let j = i, u = {}, f = 1, rawParts = [], first = true;
    while (j < src.length && src[j] === ' ') j++;

    for (;;) {
      let sign = 1;
      let savedJ = j;
      if (!first) {
        while (j < src.length && src[j] === ' ') j++;
        const op = src[j];
        if (op !== '*' && op !== '·' && op !== '/') { j = savedJ; break; }
        const nextNonSpace = src.slice(j + 1).replace(/^\s+/, '');
        if (!SYM.test(nextNonSpace)) { j = savedJ; break; }
        sign = op === '/' ? -1 : 1;
        j++;
        while (j < src.length && src[j] === ' ') j++;
      }
      const m = SYM.exec(src.slice(j));
      if (!m) break;
      const sym = m[0];
      if (sym === 'ans' || sym in vars) break;
      if (sym === 'g') break;
      if (sym in FUNCS && src[j + sym.length] === '(') break;
      let part;
      try { part = symbolUnit(sym); } catch { break; }
      j += sym.length;
      let e = 1;
      const sup = /^\^(-?\d+)|^[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/.exec(src.slice(j));
      if (sup) {
        e = sup[1] !== undefined ? parseInt(sup[1], 10)
          : parseInt([...sup[0]].map((c) => SUP_DIGIT[c]).join(''), 10);
        j += sup[0].length;
      }
      u = uMul(u, uPow(part.u, e), sign);
      f = sign > 0 ? f * Math.pow(part.f, e) : f / Math.pow(part.f, e);
      rawParts.push(sign < 0 ? `/${sym}${e !== 1 ? '^' + e : ''}` : `${first ? '' : '·'}${sym}${e !== 1 ? '^' + e : ''}`);
      first = false;
    }
    return first ? null : { u, f, raw: rawParts.join(''), end: j };
  }

  function tokenize(src) {
    const t = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      const rest = src.slice(i);
      if (/[0-9.,]/.test(ch) && NUM_RE.test(rest)) {
        const m = NUM_RE.exec(rest)[0];
        i += m.length;
        const numVal = parseFloat(m.replace(',', '.'));
        const un = readUnit(src, i);
        if (un) {
          t.push({ k: 'num', v: numVal * un.f, u: un.u, rawU: un.raw, origV: numVal });
          i = un.end;
        } else {
          t.push({ k: 'num', v: numVal, u: {}, rawU: '' });
        }
        continue;
      }
      if (ch === ',') throw err('Przecinek to część dziesiętna – argumenty oddzielaj średnikiem ;');
      if (ch === 'π' || ch === 'ħ') { t.push({ k: 'id', v: ch }); i++; continue; }
      if (ID_START.test(ch)) {
        const m = ID_RE.exec(rest)[0];
        const split = /^([A-Za-z]+)(\d+(?:[.,]\d+)?)$/.exec(m);
        if (!known(m) && split && split[1] in FUNCS) {
          t.push({ k: 'id', v: split[1] }, { k: 'num', v: parseFloat(split[2].replace(',', '.')), u: {}, rawU: '' });
        } else t.push({ k: 'id', v: m });
        i += m.length; continue;
      }
      if (ch === '²' || ch === '³') { t.push({ k: 'op', v: '^' }, { k: 'num', v: ch === '²' ? 2 : 3, u: {}, rawU: '' }); i++; continue; }
      const op = OP_MAP[ch] || ch;
      if ('+-*/^()!%=,√'.includes(op)) { t.push({ k: 'op', v: op }); i++; continue; }
      throw err(`Nieznany znak: ${ch}`);
    }
    return t;
  }

  return { tokenize };
}

function parse(tokens, vars) {
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v) => tokens[p] && tokens[p].k === 'op' && tokens[p].v === v;
  const startsValue = (t) => t && (t.k === 'num' || t.k === 'id' || (t.k === 'op' && (t.v === '(' || t.v === '√')));

  function additive() {
    let n = term();
    while (isOp('+') || isOp('-')) { const o = tokens[p++].v; n = { t: 'bin', o, a: n, b: term() }; }
    return n;
  }
  function term() {
    let n = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) { const o = tokens[p++].v; n = { t: 'bin', o, a: n, b: unary() }; }
      else if (startsValue(peek())) n = { t: 'bin', o: '*', a: n, b: unary() };
      else return n;
    }
  }
  function unary() {
    if (isOp('-')) { p++; return { t: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    if (isOp('√')) { p++; return { t: 'call', f: 'sqrt', args: [unary()] }; }
    return power();
  }
  function power() {
    const base = postfix();
    if (isOp('^')) { p++; return { t: 'bin', o: '^', a: base, b: unary() }; }
    return base;
  }
  function postfix() {
    let n = primary();
    while (isOp('!') || isOp('%')) n = { t: tokens[p++].v === '!' ? 'fact' : 'pct', a: n };
    return n;
  }
  function closeParen() {
    if (isOp(')')) { p++; return; }
    if (p < tokens.length) throw err('Brakuje nawiasu )');
  }
  function primary() {
    const tok = tokens[p++];
    if (!tok) throw err('Niedokończone wyrażenie');
    if (tok.k === 'num') return { t: 'num', v: tok.v, u: tok.u || {}, rawU: tok.rawU || '', origV: tok.origV };
    if (tok.k === 'op' && tok.v === '(') { const n = additive(); closeParen(); return n; }
    if (tok.k === 'id') {
      if (tok.v in FUNCS && !(tok.v in vars)) {
        if (isOp('(')) {
          p++;
          const args = [];
          if (!isOp(')')) { args.push(additive()); while (isOp(',')) { p++; args.push(additive()); } }
          closeParen();
          return { t: 'call', f: tok.v, args };
        }
        return { t: 'call', f: tok.v, args: [unary()] };
      }
      return { t: 'var', name: tok.v };
    }
    if (tok.k === 'op' && tok.v === ')') throw err('Nadmiarowy nawias )');
    throw err(`Nieoczekiwany znak: ${tok.v}`);
  }

  let assign = null;
  if (tokens.length >= 2 && tokens[0].k === 'id' && tokens[1].k === 'op' && tokens[1].v === '=') {
    assign = tokens[0].v;
    if (assign in FUNCS) throw err(`„${assign}” to nazwa funkcji – wybierz inną nazwę zmiennej`);
    if (assign === 'ans') throw err('„ans” jest zarezerwowane');
    p = 2;
  }
  if (p >= tokens.length) throw err('Puste wyrażenie');
  const tree = additive();
  if (p < tokens.length) {
    const v = tokens[p].v;
    if (v === '=') throw err('Przypisanie tylko na początku: nazwa = wyrażenie');
    if (v === ',') throw err('Średnik ; tylko między argumentami funkcji w nawiasie, np. root(8; 3). Ułamek dziesiętny pisz z przecinkiem: 9,81');
    if (v === ')') throw err('Nadmiarowy nawias )');
    throw err(`Nieoczekiwany znak: ${v}`);
  }
  return { assign, tree };
}

// ================= Obliczanie drzewa =================
const Q = (v, u = {}) => ({ v, u });
const U_KEEP = new Set(['abs', 'floor', 'ceil', 'round', 'min', 'max']);

function evaluateTree(n, vars, ans) {
  function evq(node) {
    switch (node.t) {
      case 'num': return Q(node.v, node.u || {});
      case 'var': {
        if (node.name in vars) {
          const val = vars[node.name];
          return (typeof val === 'object' && val !== null && 'v' in val) ? val : Q(val, {});
        }
        if (node.name === 'ans') return (typeof ans === 'object' && ans !== null && 'v' in ans) ? ans : Q(ans, {});
        if (node.name in CONST) return Q(CONST[node.name].value, CONST[node.name].u);
        throw err(`Nieznana nazwa: ${node.name}`);
      }
      case 'neg': { const a = evq(node.a); return Q(-a.v, a.u); }
      case 'pct': { const a = evq(node.a); return Q(a.v / 100, a.u); }
      case 'fact': {
        const a = evq(node.a);
        if (!uNone(a.u)) throw err('Silnia działa tylko na liczbach bez jednostki');
        if (!Number.isInteger(a.v) || a.v < 0) throw err('Silnia tylko dla liczb całkowitych ≥ 0');
        if (a.v > 170) return Q(Infinity);
        let r = 1; for (let i = 2; i <= a.v; i++) r *= i; return Q(r);
      }
      case 'bin': {
        const a = evq(node.a), b = evq(node.b);
        switch (node.o) {
          case '+': case '-': {
            if (!uEq(a.u, b.u)) {
              const utA = uText(a.u) || 'bezwymiarowa';
              const utB = uText(b.u) || 'bezwymiarowa';
              throw err(`Nie można ${node.o === '+' ? 'dodać' : 'odjąć'} wielkości o różnych jednostkach: ${utA} i ${utB}`);
            }
            return Q(node.o === '+' ? a.v + b.v : a.v - b.v, a.u);
          }
          case '*': return Q(a.v * b.v, uMul(a.u, b.u, 1));
          case '/': {
            if (b.v === 0) throw err('Dzielenie przez zero');
            return Q(a.v / b.v, uMul(a.u, b.u, -1));
          }
          case '^': {
            if (!uNone(b.u)) throw err('Wykładnik potęgi nie może mieć jednostki');
            if (a.v < 0 && !Number.isInteger(b.v)) throw err('Potęga o niecałkowitym wykładniku z liczby ujemnej');
            return Q(Math.pow(a.v, b.v), uPow(a.u, b.v));
          }
        }
        break;
      }
      case 'call': {
        const [min, max, fn] = FUNCS[node.f];
        if (node.args.length < min || node.args.length > max) {
          throw err(min === max ? `${node.f}: potrzebne ${min} argument(y)` : `${node.f}: od ${min} do ${max} argumentów`);
        }
        const args = node.args.map(evq);
        const v = fn(...args.map((q) => q.v));
        if (node.f === 'sqrt') return Q(v, uPow(args[0].u, 0.5));
        if (node.f === 'cbrt') return Q(v, uPow(args[0].u, 1 / 3));
        if (node.f === 'root') {
          if (!uNone(args[1].u)) throw err('Stopień pierwiastka nie może mieć jednostki');
          return Q(v, uPow(args[0].u, 1 / args[1].v));
        }
        if (U_KEEP.has(node.f)) {
          const u = args[0].u;
          if (!args.every((q) => uEq(q.u, u))) throw err(`${node.f}: argumenty muszą mieć tę samą jednostkę`);
          return Q(v, u);
        }
        const bad = args.find((q) => !uNone(q.u));
        if (bad) throw err(`${node.f}: argument nie może mieć jednostki (${uText(bad.u)})`);
        return Q(v);
      }
    }
    throw err('Błąd wyrażenia');
  }

  return evq(n);
}

// Druga linia: operacje na jednostkach krok po kroku
const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };

function createUnitLineEvaluator(vars, ans) {
  function evq(node) { return evaluateTree(node, vars, ans); }

  function unitWalk(n) {
    const plain = (u) => ({ text: '1', tex: '1', u, bare: true, prec: 9 });
    switch (n.t) {
      case 'num': {
        if (uNone(n.u)) return plain(n.u);
        let txt = uText(n.u);
        let tx = uTex(n.u);
        if (n.rawU) {
          txt = n.rawU.replace(/\^1\b/g, '').replace(/\^2\b/g, '²').replace(/\^3\b/g, '³').replace(/\*/g, '·');
          tx = rawToTex(n.rawU);
        }
        return { text: txt, tex: tx, u: n.u, bare: false, prec: 9 };
      }
      case 'var': {
        const q = evq(n);
        if (uNone(q.u)) return plain(q.u);
        const txt = (n.name in CONST && CONST[n.name].unit) ? CONST[n.name].unit : uText(q.u);
        const tx = (n.name in CONST && CONST[n.name].unit) ? rawToTex(CONST[n.name].unit) : uTex(q.u);
        return { text: txt, tex: tx, u: q.u, bare: false, prec: 9 };
      }
      case 'neg': case 'pct': return unitWalk(n.a);
      case 'fact': return plain({});
      case 'bin': {
        const q = evq(n);
        if (n.o === '^') {
          const a = unitWalk(n.a);
          const expVal = evq(n.b).v;
          if (a.bare) return plain(q.u);
          const aText = a.prec < 3 || a.text.includes('/') ? `(${a.text})` : a.text;
          const expText = supNum(expVal);
          const aTex = a.prec < 3 || a.tex.includes('\\frac') ? `\\left(${a.tex}\\right)` : a.tex;
          const expTex = `^{${expVal}}`;
          return { text: `${aText}${expText}`, tex: `${aTex}${expTex}`, u: q.u, bare: false, prec: 3 };
        }
        const a = unitWalk(n.a), b = unitWalk(n.b);
        if (a.bare && b.bare) return plain(q.u);

        const p = PREC[n.o];
        const op = { '*': ' · ', '/': ' / ', '+': ' + ', '-': ' − ' }[n.o];
        const wrap = (side, min) => (side.prec < min ? `(${side.text})` : side.text);
        let left = wrap(a, p);
        let right = wrap(b, p + (n.o === '/' || n.o === '-' ? 1 : 0));

        let tex;
        if (n.o === '*') {
          const wrapTex = (side, min) => (side.prec < min ? `\\left(${side.tex}\\right)` : side.tex);
          tex = `${wrapTex(a, p)} \\cdot ${wrapTex(b, p)}`;
        } else if (n.o === '/') {
          tex = `\\frac{${a.tex}}{${b.tex}}`;
        } else {
          const opTex = n.o === '+' ? ' + ' : ' - ';
          const wrapTex = (side, min) => (side.prec < min ? `\\left(${side.tex}\\right)` : side.tex);
          tex = `${wrapTex(a, p)}${opTex}${wrapTex(b, p + 1)}`;
        }
        return { text: `${left}${op}${right}`, tex, u: q.u, bare: false, prec: p };
      }
      case 'call': {
        const parts = n.args.map(unitWalk);
        const q = evq(n);
        if (parts.every((x) => x.bare)) return plain(q.u);
        const inner = parts.map((x) => x.text).join('; ');
        const innerTex = parts.map((x) => x.tex).join(', ');
        if (n.f === 'sqrt') return { text: `√(${inner})`, tex: `\\sqrt{${innerTex}}`, u: q.u, bare: false, prec: 9 };
        if (n.f === 'cbrt') return { text: `∛(${inner})`, tex: `\\sqrt[3]{${innerTex}}`, u: q.u, bare: false, prec: 9 };
        return { text: `${n.f}(${inner})`, tex: `\\operatorname{${n.f}}\\left(${innerTex}\\right)`, u: q.u, bare: false, prec: 9 };
      }
    }
    return plain({});
  }

  function unitLine(tree) {
    const w = unitWalk(tree);
    if (w.bare) return null;
    const name = uName(w.u);
    const steps = [[w.text.trim(), w.tex.trim()], [uText(w.u) || '1', uTex(w.u) || '1']];
    if (name) steps.push([name, `\\text{${name}}`]);
    const uniq = steps.filter((st, i) => steps.findIndex((o) => o[0] === st[0]) === i);
    if (uniq.length === 1) return null;
    return { text: uniq.map((st) => st[0]).join(' = '), tex: '\\displaystyle ' + uniq.map((st) => st[1]).join(' = ') };
  }

  return { unitLine };
}

function balance(src) {
  let depth = 0, need = 0;
  for (const ch of src) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth > 0 ? depth-- : need++; }
  }
  let out = src;
  if (need) {
    const m = /^\s*[A-Za-z_\u0370-\u03FF][A-Za-z0-9_\u0370-\u03FF]*\s*=\s*/.exec(out);
    const at = m ? m[0].length : 0;
    out = out.slice(0, at) + '('.repeat(need) + out.slice(at);
  }
  return out + ')'.repeat(depth);
}

// ================= Formatowanie liczb =================
const NNBSP = '\u202f';

function group(intStr) {
  return intStr.length > 4 ? intStr.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP) : intStr;
}

function plain(numStr) {
  let neg = numStr.startsWith('-');
  if (neg) numStr = numStr.slice(1);
  let [i, d] = numStr.split('.');
  return (neg ? '−' : '') + group(i) + (d !== undefined ? ',' + d : '');
}

function fmt(x, sig = 'auto') {
  if (x === 0) return { html: '0', text: '0' };
  const digits = sig === 'auto' ? 10 : +sig;
  let e = Math.floor(Math.log10(Math.abs(x)));
  let m = +(x / 10 ** e).toPrecision(digits);
  if (Math.abs(m) >= 10) { m /= 10; e += 1; m = +m.toPrecision(digits); }
  if (e >= 6 || e <= -4) {
    const ms = sig === 'auto' ? String(m) : m.toFixed(digits - 1);
    return { html: `${plain(ms)} × 10<sup>${String(e).replace('-', '−')}</sup>`, text: `${ms.replace('.', ',')}e${e}` };
  }
  let str;
  if (sig === 'auto') str = String(+x.toPrecision(12));
  else str = e >= digits - 1 ? String(+x.toPrecision(digits)) : x.toPrecision(digits);
  return { html: plain(str), text: str.replace('.', ',') };
}

function toFraction(x, maxDen = 1000) {
  if (!Number.isFinite(x) || Number.isInteger(x) || Math.abs(x) >= 1e9) return null;
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0, y = Math.abs(x);
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(y);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    if (Math.abs(Math.abs(x) - h1 / k1) <= 1e-12 * Math.max(1, Math.abs(x))) {
      return k1 === 1 ? null : { n: Math.sign(x) * h1, d: k1 };
    }
    const frac = y - a;
    if (frac < 1e-15) break;
    y = 1 / frac;
  }
  return null;
}

function fracHtml(f) {
  const stack = (n, d) => `<span class="frac"><span>${n}</span><span>${d}</span></span>`;
  const sign = f.n < 0 ? '−' : '';
  const n = Math.abs(f.n);
  let html = sign + stack(n, f.d);
  if (n > f.d) html += ` = ${sign}${Math.floor(n / f.d)} ${stack(n % f.d, f.d)}`;
  return html;
}

const exactText = (x) => String(+x.toPrecision(15)).replace('.', ',');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => s.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ================= Montowanie komponentu kalkulatora =================
export function mountCalculator(container, options = {}) {
  const isEmbedded = Boolean(options.isEmbedded);

  // Bezpieczny magazyn pamięci lokalnej
  const store = {
    get(k, d) { try { const v = localStorage.getItem('kalk:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('kalk:' + k, JSON.stringify(v)); } catch {} }
  };

  let angle = store.get('angle', 'deg');
  globalAngle = angle;
  let sig = store.get('sig', 'auto');
  let vars = store.get('vars', {});
  let hist = store.get('hist', []);
  let ans = hist.length ? { v: hist[0].v, u: hist[0].u || {} } : { v: 0, u: {} };
  let histPos = -1;
  let closed = new Set(store.get('closedGroups', ['Mechanika', 'Elektryczność i magnetyzm', 'Termodynamika', 'Atom i kwanty', 'Astronomia', 'Układ Słoneczny', 'Przeliczniki', 'Matematyka']));

  // Motyw w trybie samodzielnym
  let colorMode = store.get('colorMode', 'auto');
  let palette = store.get('palette', 'gemini');
  const MODES = ['dark', 'light', 'auto'];
  const MODE_ICON = { dark: '☾', light: '☀', auto: '◐' };
  const MODE_NAME = { dark: 'ciemny', light: 'jasny', auto: 'jak w systemie' };
  const systemDark = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : { matches: true };

  container.classList.add('calc-root');
  if (isEmbedded) container.classList.add('is-embedded');

  // Wstaw markup kalkulatora
  container.innerHTML = `
    <main class="calc-main">
      <section>
        <div class="panel display">
          <div class="bar">
            <div class="seg" id="calc-angle">
              <button data-m="deg" title="Kąty w stopniach">DEG</button>
              <button data-m="rad" title="Kąty w radianach">RAD</button>
            </div>
            <div class="icons">
              <button id="calc-mode-btn" class="icon" aria-label="Tryb jasny / ciemny / systemowy">☾</button>
              <button id="calc-palette-btn" class="icon" aria-label="Paleta standardowa / Gemini">✦</button>
            </div>
            <div class="seg" id="calc-sig" title="Cyfry znaczące wyniku">
              <span style="padding:2px 4px">cyfry:</span>
              <button data-s="auto">auto</button><button data-s="2">2</button><button data-s="3">3</button><button data-s="4">4</button><button data-s="5">5</button>
            </div>
          </div>
          <input id="calc-expr" class="calc-expr mono" autocomplete="off" autocapitalize="off" spellcheck="false"
                 placeholder="np. sqrt(2*g*h)  albo  v = 12">
          <div id="calc-preview" class="calc-preview mono"></div>
          <div id="calc-last-expr" class="calc-last-expr mono"></div>
          <div id="calc-result" class="calc-result mono" title="Kliknij, żeby wstawić do działania · dwuklik kopiuje">0</div>
          <div id="calc-unit-track" class="calc-unit-track mono"></div>
          <div id="calc-result-raw" class="calc-result-raw mono"></div>
        </div>

        <div class="panel keys" id="calc-keys" style="margin-top:14px">
          <button class="fn" data-i="sin(">sin</button>
          <button class="fn" data-i="cos(">cos</button>
          <button class="fn" data-i="tg(">tg</button>
          <button class="fn" data-i="ln(">ln</button>
          <button class="fn" data-i="log(">log</button>
          <button class="fn" data-i="√(">√</button>

          <button class="fn" data-i="arcsin(">sin⁻¹</button>
          <button class="fn" data-i="arccos(">cos⁻¹</button>
          <button class="fn" data-i="arctg(">tg⁻¹</button>
          <button class="fn" data-i="^2">x²</button>
          <button class="fn" data-i="^">xʸ</button>
          <button class="fn" data-i="×10^">×10ⁿ</button>

          <button data-i="7">7</button><button data-i="8">8</button><button data-i="9">9</button>
          <button data-i="(">(</button><button data-i=")">)</button><button data-a="back" title="Usuń znak">⌫</button>

          <button data-i="4">4</button><button data-i="5">5</button><button data-i="6">6</button>
          <button data-i="×">×</button><button data-i="÷">÷</button><button data-a="clear" title="Wyczyść (Esc)">C</button>

          <button data-i="1">1</button><button data-i="2">2</button><button data-i="3">3</button>
          <button data-i="+">+</button><button data-i="−">−</button><button class="fn" data-i="ans">ans</button>

          <button data-i="0">0</button><button data-i=",">,</button><button class="fn" data-i="π">π</button>
          <button class="fn" data-i="!">n!</button><button class="fn" data-i="=" title="Przypisanie do zmiennej, np. v = 12">x=</button>
          <button class="eq" data-a="run" title="Oblicz (Enter)">=</button>
        </div>

        <div class="panel hist" style="margin-top:14px">
          <h2>Historia <button id="calc-clear-hist">wyczyść</button></h2>
          <ol id="calc-hist"></ol>
          <div class="empty" id="calc-hist-empty">Tu pojawią się obliczenia. Kliknij wynik, żeby wstawić go do wyrażenia.</div>
        </div>
        <div class="help">
          <b>Enter</b> oblicz · <b>↑ ↓</b> historia · <b>Esc</b> wyczyść ·
          część dziesiętna po przecinku <code>9,81</code>, argumenty oddziel średnikiem <code>root(8; 3)</code> ·
          zmienne: <code>v = 12m/s</code> ·
          jednostki: <code>5kg*2</code>, <code>5m/s*2</code>, <code>100km/2h</code>, <code>G*MZ/RZ^2</code>
        </div>
      </section>

      <aside class="panel side">
        <div class="vars" id="calc-vars-box" hidden>
          <h2>Zmienne</h2>
          <ol id="calc-vars"></ol>
        </div>
        <h2>Stałe fizyczne</h2>
        <input id="calc-search" class="calc-search" placeholder="Szukaj: masa, ładunek, Ziemia…" autocomplete="off">
        <div class="consts" id="calc-consts"></div>
      </aside>
    </main>
    <div id="calc-hint" class="calc-hint" hidden></div>
  `;

  // Referencje do elementów DOM
  const expr = container.querySelector('#calc-expr');
  const preview = container.querySelector('#calc-preview');
  const result = container.querySelector('#calc-result');
  const resultRaw = container.querySelector('#calc-result-raw');
  const lastExpr = container.querySelector('#calc-last-expr');
  const unitTrack = container.querySelector('#calc-unit-track');
  const keysEl = container.querySelector('#calc-keys');
  const histEl = container.querySelector('#calc-hist');
  const histEmptyEl = container.querySelector('#calc-hist-empty');
  const clearHistBtn = container.querySelector('#calc-clear-hist');
  const varsBoxEl = container.querySelector('#calc-vars-box');
  const varsEl = container.querySelector('#calc-vars');
  const searchEl = container.querySelector('#calc-search');
  const constsEl = container.querySelector('#calc-consts');
  const angleEl = container.querySelector('#calc-angle');
  const sigEl = container.querySelector('#calc-sig');
  const modeBtn = container.querySelector('#calc-mode-btn');
  const paletteBtn = container.querySelector('#calc-palette-btn');
  const hintEl = container.querySelector('#calc-hint');

  const fine = typeof matchMedia !== 'undefined' ? matchMedia('(pointer: fine)').matches : true;
  let hintTimer = null;

  function flash(text, ms = 1200) {
    if (options.onFlash) { options.onFlash(text, ms); return; }
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hintEl.hidden = true; }, ms);
  }

  function renderKatex(el, tex, fallbackHtml) {
    if (!el) return;
    if (typeof window !== 'undefined' && window.katex && tex) {
      try {
        window.katex.render(tex, el, { throwOnError: false, displayMode: false });
        return;
      } catch (e) {}
    }
    el.innerHTML = fallbackHtml !== undefined ? fallbackHtml : (tex || '');
  }

  function calc(raw) {
    const src = balance(raw);
    const { tokenize } = createTokenizer(vars);
    const { assign, tree } = parse(tokenize(src), vars);
    const q = evaluateTree(tree, vars, ans);
    if (Number.isNaN(q.v)) throw err('Wynik nieokreślony');
    if (!Number.isFinite(q.v)) throw err('Wynik poza zakresem');
    const { unitLine } = createUnitLineEvaluator(vars, ans);
    return { assign, v: q.v, u: q.u, src, units: unitLine(tree) };
  }

  let lastSel = null;
  expr.addEventListener('blur', () => { lastSel = [expr.selectionStart, expr.selectionEnd]; });

  function insert(text) {
    const focused = document.activeElement === expr;
    const len = expr.value.length;
    let [s, e] = focused ? [expr.selectionStart, expr.selectionEnd] : (lastSel || [len, len]);
    s = Math.min(s, len); e = Math.min(e, len);
    if (expr.value === '' && /^[+×÷*/^!%]/.test(text) && hist.length) text = 'ans' + text;
    expr.value = expr.value.slice(0, s) + text + expr.value.slice(e);
    const c = s + text.length;
    if (fine) expr.focus();
    expr.setSelectionRange(c, c);
    lastSel = [c, c];
    livePreview();
  }

  function livePreview() {
    preview.classList.remove('err');
    const src = expr.value.trim();
    if (!src) { preview.textContent = ''; return; }
    try {
      const { assign, v, u, src: full, units } = calc(src);
      const fr = toFraction(v);
      const uStr = uName(u) || uText(u);
      const shown = full !== src ? esc(full) + ' ' : '';
      let html = shown + (assign ? esc(assign) + ' ' : '') + '= ' + fmt(v, sig).html + (uStr ? ' ' + esc(uStr) : '') + (fr ? ' = ' + fracHtml(fr) + (uStr ? ' ' + esc(uStr) : '') : '');
      if (units) {
        html += `<div class="preview-units" data-tex="${esc(units.tex)}">${esc(units.text)}</div>`;
      }
      preview.innerHTML = html;
      const prevUnitsEl = preview.querySelector('.preview-units');
      if (prevUnitsEl && window.katex) {
        const tex = prevUnitsEl.getAttribute('data-tex');
        if (tex) {
          try { window.katex.render(tex, prevUnitsEl, { throwOnError: false, displayMode: false }); } catch {}
        }
      }
    } catch {
      preview.textContent = '';
    }
  }

  function showResult(label, v, u = {}, units = null) {
    lastExpr.textContent = label;
    const f = fmt(v, sig);
    const uStr = uName(u) || uText(u);
    result.innerHTML = f.html + (uStr ? `<span class="u">${esc(uStr)}</span>` : '');
    const uIn = uInline(u);
    result.dataset.copy = exactText(v) + (uStr ? ' ' + uStr : '');
    result.dataset.insert = exactText(v) + (uIn ? uIn : '');

    if (unitTrack) {
      if (units) {
        renderKatex(unitTrack, units.tex, esc(units.text));
      } else {
        unitTrack.innerHTML = '';
      }
    }

    const parts = [];
    const fr = toFraction(v);
    if (fr) parts.push('ułamek: ' + fracHtml(fr) + (uStr ? ' ' + esc(uStr) : ''));
    if (!(sig === 'auto' && f.text === exactText(v))) parts.push('dokładnie: ' + esc(exactText(v)) + (uStr ? ' ' + esc(uStr) : ''));
    resultRaw.innerHTML = parts.join(' &nbsp;·&nbsp; ');
  }

  function run() {
    const src = expr.value.trim();
    if (!src) return;
    try {
      const { assign, v, u, src: full, units } = calc(src);
      if (assign) {
        vars[assign] = { v, u };
        store.set('vars', vars);
        renderVars();
      }
      ans = { v, u };
      hist.unshift({ e: full, v, u, units });
      hist = hist.slice(0, 100);
      store.set('hist', hist);
      histPos = -1;
      showResult(full + ' =', v, u, units);
      expr.value = '';
      lastSel = null;
      preview.textContent = '';
      renderHist();
      if (assign && assign in CONST) flash(`${assign} przesłania teraz stałą „${CONST[assign].name}”`, 2500);
    } catch (e) {
      preview.classList.add('err');
      preview.textContent = e instanceof CalcError ? e.message : 'Błąd: ' + e.message;
    }
  }

  function row(cls, left, right, onLeft, onRight) {
    const el = document.createElement('li');
    el.className = cls;
    const a = document.createElement('span');
    a.className = 'e mono';
    const b = document.createElement('span');
    b.className = 'r mono';
    if (typeof left === 'string') a.textContent = left; else a.innerHTML = left.html;
    if (typeof right === 'string') b.textContent = right; else b.innerHTML = right.html;
    if (onLeft) a.onclick = onLeft;
    if (onRight) b.onclick = onRight;
    el.append(a, b);
    return el;
  }

  function insertExpr(text) {
    const m = /^\s*[A-Za-z_\u0370-\u03FF][A-Za-z0-9_\u0370-\u03FF]*\s*=(.*)$/.exec(text);
    let t = m ? m[1].trim() : text;
    const simple = /^[A-Za-z0-9_,.\u0370-\u03FF]+$/.test(t);
    if (expr.value.trim() && !simple) t = '(' + t + ')';
    insert(t);
  }

  function renderHist() {
    histEl.replaceChildren();
    histEmptyEl.hidden = hist.length > 0;
    hist.forEach((h) => {
      const uStr = h.u ? (uName(h.u) || uText(h.u)) : '';
      const resHtml = '= ' + fmt(h.v, sig).html + (uStr ? ' ' + esc(uStr) : '');
      const uIn = h.u ? uInline(h.u) : '';
      const li = row('', h.e, { html: resHtml },
        () => insertExpr(h.e),
        () => insert(exactText(h.v) + (uIn ? uIn : '')));
      li.firstChild.title = h.e + '  (kliknij, żeby wstawić)';
      li.lastChild.title = 'Wstaw wynik w miejsce kursora';
      if (h.units) {
        const sub = document.createElement('div');
        sub.className = 'unit-sub mono';
        renderKatex(sub, h.units.tex, esc(h.units.text));
        li.firstChild.append(sub);
      }
      histEl.append(li);
    });
  }

  function renderVars() {
    const names = Object.keys(vars);
    varsBoxEl.hidden = names.length === 0;
    varsEl.replaceChildren();
    for (const n of names) {
      const val = vars[n];
      const num = (typeof val === 'object' && val !== null && 'v' in val) ? val.v : val;
      const u = (typeof val === 'object' && val !== null && 'u' in val) ? val.u : {};
      const uStr = uName(u) || uText(u);
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'row';
      b.title = `Wstaw: ${n}`;
      const shadow = n in CONST;
      b.innerHTML = `<div class="top"><span class="sym">${esc(n)}</span>` +
        `<span class="name${shadow ? ' shadowed' : ''}">${shadow ? 'przesłania stałą: ' + esc(CONST[n].name) : ''}</span></div>` +
        `<div class="bottom"><span class="val mono">${fmt(num, sig).html}${uStr ? ' ' + esc(uStr) : ''}</span></div>`;
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.onclick = () => insert(n);
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '×'; x.title = 'Usuń zmienną';
      x.addEventListener('pointerdown', (e) => e.preventDefault());
      x.onclick = () => { delete vars[n]; store.set('vars', vars); renderVars(); livePreview(); };
      li.append(b, x);
      varsEl.append(li);
    }
  }

  function constRow(c) {
    const b = document.createElement('button');
    b.className = 'row';
    b.title = `Wstaw: ${c.id}`;
    const up = /^(eV|au|ly|pc|kWh|cal|bar|atm|mmHg|km\/h|KM)$/.test(c.sym) ? ' up' : '';
    b.innerHTML = `<div class="top"><span class="sym${up}">${c.sym}</span><span class="name">${esc(c.name)}</span></div>
      <div class="bottom"><span class="id mono">${esc(c.id)}</span><span class="val mono">${fmt(c.value, 'auto').html}${c.unit ? ' ' + esc(c.unit) : ''}</span></div>`;
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.onclick = () => insert(c.id);
    return b;
  }

  function renderConsts() {
    const q = norm(searchEl.value.trim());
    const box = constsEl;
    box.replaceChildren();

    const groups = new Map();
    for (const [id] of CONSTS) {
      const c = CONST[id];
      if (q && !norm(`${c.name} ${c.id} ${c.group} ${c.sym.replace(/<[^>]+>/g, '')}`).includes(q)) continue;
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group).push(c);
    }
    if (!groups.size) { box.innerHTML = '<div class="empty">Nic nie znaleziono.</div>'; return; }

    for (const [name, list] of groups) {
      const open = !!q || !closed.has(name);
      const head = document.createElement('button');
      head.className = 'group' + (open ? ' open' : '');
      head.innerHTML = `<span class="caret">${open ? '▾' : '▸'}</span><span>${esc(name)}</span><span class="count">${list.length}</span>`;
      head.onclick = () => {
        if (q) return;
        closed.has(name) ? closed.delete(name) : closed.add(name);
        store.set('closedGroups', [...closed]);
        renderConsts();
      };
      box.append(head);
      if (open) for (const c of list) box.append(constRow(c));
    }
  }

  function renderModes() {
    for (const b of angleEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === angle);
    for (const b of sigEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.s === String(sig));
  }

  function applyStandaloneTheme() {
    if (isEmbedded) return;
    const dark = colorMode === 'auto' ? systemDark.matches : colorMode === 'dark';
    document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-palette', palette);
    if (modeBtn) {
      modeBtn.textContent = MODE_ICON[colorMode];
      modeBtn.title = `Tryb: ${MODE_NAME[colorMode]} – kliknij: ciemny / jasny / systemowy (Ctrl+M)`;
    }
    if (paletteBtn) {
      paletteBtn.textContent = palette === 'gemini' ? '✦' : '▣';
      paletteBtn.title = `Kolory: ${palette === 'gemini' ? 'Gemini' : 'standardowe (systemowe)'} – kliknij, żeby zmienić (Ctrl+Shift+M)`;
    }
  }

  function cycleMode() {
    colorMode = MODES[(MODES.indexOf(colorMode) + 1) % MODES.length];
    store.set('colorMode', colorMode);
    applyStandaloneTheme();
    flash(`Tryb: ${MODE_NAME[colorMode]}`);
  }

  function togglePalette() {
    palette = palette === 'gemini' ? 'system' : 'gemini';
    store.set('palette', palette);
    applyStandaloneTheme();
    flash(palette === 'gemini' ? 'Kolory: Gemini' : 'Kolory: standardowe (systemowe)');
  }

  function themeKey(e) {
    if (isEmbedded) return false;
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'm' && e.key !== 'M')) return false;
    e.preventDefault();
    e.shiftKey ? togglePalette() : cycleMode();
    return true;
  }

  // Zdarzenia kontrolek
  expr.addEventListener('input', () => {
    if (/^[+×÷*/^!%]$/.test(expr.value) && hist.length) { expr.value = 'ans' + expr.value; }
    histPos = -1;
    livePreview();
  });

  expr.addEventListener('keydown', (e) => {
    if (themeKey(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    } else if (e.key === 'Escape') {
      if (expr.value) {
        expr.value = '';
        histPos = -1;
        livePreview();
        e.preventDefault();
      } else if (options.onClose) {
        options.onClose();
        e.preventDefault();
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!hist.length) return;
      e.preventDefault();
      histPos = e.key === 'ArrowUp' ? Math.min(hist.length - 1, histPos + 1) : Math.max(-1, histPos - 1);
      expr.value = histPos < 0 ? '' : hist[histPos].e;
      livePreview();
    }
  });

  histEl.addEventListener('pointerdown', (e) => { if (e.target.closest('.e, .r')) e.preventDefault(); });
  keysEl.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  keysEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.i !== undefined) {
      let t = b.dataset.i;
      if (t === '=') t = expr.value.includes('=') ? '' : ' = ';
      insert(t);
      return;
    }
    const a = b.dataset.a;
    if (a === 'run') run();
    else if (a === 'clear') { expr.value = ''; livePreview(); }
    else if (a === 'back') {
      const focused = document.activeElement === expr;
      const s = focused ? expr.selectionStart : expr.value.length;
      const en = focused ? expr.selectionEnd : s;
      if (s !== en) {
        expr.value = expr.value.slice(0, s) + expr.value.slice(en);
        expr.setSelectionRange(s, s);
      } else if (s > 0) {
        const m = /[A-Za-z√]+\($|.$/u.exec(expr.value.slice(0, s));
        const cut = m ? m[0].length : 1;
        expr.value = expr.value.slice(0, s - cut) + expr.value.slice(s);
        expr.setSelectionRange(s - cut, s - cut);
      }
      livePreview();
    }
  });

  angleEl.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    angle = b.dataset.m;
    globalAngle = angle;
    store.set('angle', angle);
    renderModes();
    livePreview();
  });

  sigEl.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    sig = b.dataset.s;
    store.set('sig', sig);
    renderModes();
    livePreview();
    renderHist();
    renderVars();
    if (hist.length) showResult(lastExpr.textContent || hist[0].e + ' =', hist[0].v, hist[0].u, hist[0].units);
  });

  if (!isEmbedded) {
    modeBtn.addEventListener('click', cycleMode);
    paletteBtn.addEventListener('click', togglePalette);
    systemDark.addEventListener?.('change', () => { if (colorMode === 'auto') applyStandaloneTheme(); });
  }

  searchEl.addEventListener('input', renderConsts);
  clearHistBtn.addEventListener('click', () => { hist = []; store.set('hist', hist); renderHist(); });

  let resultClickTimer = null;
  result.addEventListener('click', () => {
    if (!result.dataset.copy || resultClickTimer) return;
    resultClickTimer = setTimeout(() => {
      resultClickTimer = null;
      insert(result.dataset.insert || result.dataset.copy);
    }, 220);
  });

  result.addEventListener('dblclick', async () => {
    clearTimeout(resultClickTimer);
    resultClickTimer = null;
    const t = result.dataset.copy;
    if (!t) return;
    try { await navigator.clipboard.writeText(t); flash('Skopiowano: ' + t); } catch {}
  });

  const onDocKeyDown = (e) => {
    if (themeKey(e)) return;
    if (document.activeElement === expr || document.activeElement === searchEl) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEmbedded && !container.contains(document.activeElement)) return;
    if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') {
      expr.focus();
    }
  };
  document.addEventListener('keydown', onDocKeyDown);

  // Re-renderowanie KaTeX po załadowaniu
  const onKatexReady = () => {
    livePreview();
    if (hist.length) {
      showResult(lastExpr.textContent || (hist[0].e + ' ='), hist[0].v, hist[0].u, hist[0].units);
      renderHist();
    }
  };
  if (typeof window !== 'undefined') {
    window.onKatexLoaded = onKatexReady;
  }

  // Inicjalizacja widoku
  applyStandaloneTheme();
  renderModes();
  renderHist();
  renderVars();
  renderConsts();
  if (hist.length) showResult(hist[0].e + ' =', hist[0].v, hist[0].u, hist[0].units);

  return {
    focus() { expr.focus(); },
    run(expression) {
      if (expression) expr.value = expression;
      run();
    },
    setExpression(val) {
      expr.value = val;
      livePreview();
    },
    destroy() {
      document.removeEventListener('keydown', onDocKeyDown);
    }
  };
}
