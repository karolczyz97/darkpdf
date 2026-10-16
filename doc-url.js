// Jeden format adresu dla historii, wtyczki i zakładek; czytamy też dawne, niekodowane linki.
export function fileRoute(hash) {
  if (!hash.startsWith('#file=')) return null;
  let value = hash.slice(6);
  if (/^[a-z]+%3A/i.test(value)) {
    try { value = decodeURIComponent(value); } catch {}
  }
  const page = /#page=(\d+)/.exec(value);
  return { url: value.split('#')[0], page: page ? Number(page[1]) : null };
}

export const fileHash = (url, page = null) => '#file=' + encodeURIComponent(url) + (page ? '#page=' + page : '');
