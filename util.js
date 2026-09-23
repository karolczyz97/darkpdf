// util.js – drobne narzędzia czytnika: ustawienia w localStorage, pamięć LRU, równoległe zadania z limitem.

// Ustawienia trzymane w przeglądarce; typ bierzemy z wartości domyślnej. Brak dostępu do localStorage
// (tryb prywatny, zablokowane ciasteczka) nie psuje czytnika – wtedy obowiązują wartości domyślne.
export const pref = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      if (v === null) return d;
      if (typeof d === 'boolean') return v === '1';
      if (typeof d === 'number') return parseInt(v, 10) || d;
      return v;
    } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)); } catch {} },
  json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  setJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// Mapa, która sama wyrzuca najdawniej używany wpis po przekroczeniu limitu.
// max – liczba albo funkcja (limit może zależeć od urządzenia); onEvict(v) – sprzątanie po wyrzuconym wpisie.
export function lru(max = Infinity, onEvict = null) {
  const m = new Map();
  const limit = typeof max === 'function' ? max : () => max;
  const evict = (v) => { if (onEvict && v !== undefined) onEvict(v); };
  return {
    has: (k) => m.has(k),
    get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) {
      const old = m.get(k);
      m.delete(k);
      m.set(k, v);
      if (old !== v) evict(old);
      while (m.size > limit()) {
        const first = m.keys().next().value;
        const gone = m.get(first);
        m.delete(first);
        evict(gone);
      }
      return v;
    },
    clear() { const all = [...m.values()]; m.clear(); all.forEach(evict); }
  };
}

// fn dla każdego elementu, najwyżej limit naraz; błąd pojedynczego elementu daje null zamiast przerywać całość
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const cur = index++;
      try { results[cur] = await fn(items[cur]); } catch { results[cur] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
