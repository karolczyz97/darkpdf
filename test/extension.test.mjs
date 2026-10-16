import test from 'node:test';
import assert from 'node:assert/strict';

let imports = 0;
async function setup(t) {
  const original = { window: globalThis.window, location: globalThis.location };
  const listeners = new Set(), sent = [];
  globalThis.location = { origin: 'https://reader' };
  globalThis.window = {
    addEventListener: (name, fn) => { if (name === 'message') listeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === 'message') listeners.delete(fn); },
    postMessage: (message) => sent.push(message)
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { for (const [k, v] of Object.entries(original)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } });
  const { loadViaExtension } = await import(`../extension-loader.js?test=${++imports}`);
  const emit = (message, origin = location.origin) => {
    for (const fn of [...listeners]) fn({ source: window, origin, data: { source: 'zen-ext', ...message } });
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  return { loadViaExtension, listeners, sent, emit, flush };
}

test('odpowiedź A nie trafia do B; pobrania są wykonywane kolejno', async (t) => {
  const { loadViaExtension, sent, emit, flush, listeners } = await setup(t);
  const a = loadViaExtension('https://files/A.pdf');
  const b = loadViaExtension('https://files/B.pdf');
  await flush();
  assert.equal(sent.length, 1);
  emit({ type: 'data', requestId: 'unrelated', buffer: new Uint8Array([99]).buffer });
  emit({ type: 'data', requestId: sent[0].requestId, buffer: new Uint8Array([65]).buffer });
  assert.deepEqual([...await a], [65]);
  await flush();
  assert.equal(sent.length, 2);
  emit({ type: 'data', requestId: sent[0].requestId, buffer: new Uint8Array([65]).buffer });
  emit({ type: 'data', requestId: sent[1].requestId, buffer: new Uint8Array([66]).buffer });
  assert.deepEqual([...await b], [66]);
  assert.equal(listeners.size, 0);
});

test('stara wtyczka może dokończyć pojedyncze pobranie', async (t) => {
  const { loadViaExtension, emit, flush, listeners } = await setup(t);
  const result = loadViaExtension('https://files/A.pdf');
  await flush();
  emit({ type: 'data', buffer: new Uint8Array([65]).buffer });
  assert.deepEqual([...await result], [65]);
  assert.equal(listeners.size, 0);
});

test('anulowanie usuwa listener i nie przyjmuje spóźnionych danych bez identyfikatora', async (t) => {
  const { loadViaExtension, emit, flush, sent, listeners } = await setup(t);
  const controller = new AbortController();
  const a = loadViaExtension('https://files/A.pdf', { signal: controller.signal });
  const rejected = assert.rejects(a, { name: 'AbortError' });
  await flush();
  controller.abort(); await rejected;
  assert.equal(listeners.size, 0);
  const b = loadViaExtension('https://files/B.pdf');
  await flush();
  emit({ type: 'data', buffer: new Uint8Array([65]).buffer });
  emit({ type: 'data', requestId: sent[1].requestId, buffer: new Uint8Array([66]).buffer });
  assert.deepEqual([...await b], [66]);
});

test('postęp odnawia timeout bezczynności, potem odbiornik jest sprzątany', async (t) => {
  const { loadViaExtension, emit, flush, sent, listeners } = await setup(t);
  const result = loadViaExtension('https://files/A.pdf');
  const rejected = assert.rejects(result, /EXTTIMEOUT/);
  await flush();
  emit({ type: 'progress', requestId: sent[0].requestId, loaded: 1 });
  t.mock.timers.tick(29000);
  emit({ type: 'progress', requestId: sent[0].requestId, loaded: 2 });
  t.mock.timers.tick(29000);
  assert.equal(listeners.size, 1);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(listeners.size, 0);
});

test('brak wtyczki kończy się timeoutem, obce pochodzenie komunikatu jest ignorowane', async (t) => {
  const { loadViaExtension, emit, flush, listeners } = await setup(t);
  const result = loadViaExtension('https://files/A.pdf');
  const rejected = assert.rejects(result, /NOEXT/);
  await flush();
  emit({ type: 'data', buffer: new Uint8Array([65]).buffer }, 'https://other');
  t.mock.timers.tick(3000); await rejected;
  assert.equal(listeners.size, 0);
});
