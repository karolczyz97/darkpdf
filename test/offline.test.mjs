import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const app of ['darkpdf', 'calc']) {
  test(`${app}: aktualizacja offline zachowuje cache innych aplikacji`, async () => {
    const handlers = {};
    const keys = new Set(['darkpdf-v1', 'calc-v1', 'unrelated-v1']);
    let current;
    const context = {
      self: { addEventListener: (name, fn) => handlers[name] = fn, skipWaiting: async () => {}, clients: { claim: async () => {} } },
      caches: {
        open: async (key) => { current = key; keys.add(key); return { addAll: async () => {} }; },
        keys: async () => [...keys], delete: async (key) => keys.delete(key)
      }
    };
    vm.runInNewContext(readFileSync(new URL(`../../${app}/sw.js`, import.meta.url), 'utf8'), context);
    let pending;
    const event = { waitUntil: (promise) => pending = promise };
    handlers.install(event); await pending;
    handlers.activate(event); await pending;
    assert.ok(keys.has(current));
    assert.ok(!keys.has(`${app}-v1`));
    assert.ok(keys.has(app === 'darkpdf' ? 'calc-v1' : 'darkpdf-v1'));
    assert.ok(keys.has('unrelated-v1'));
  });
}

for (const app of ['darkpdf', 'calc']) {
  for (const cached of [false, true]) {
    test(`${app}: timeout sieci tylko przy dostępnej kopii offline (${cached})`, async () => {
      const handlers = {};
      const hit = cached ? { marker: 'offline' } : undefined;
      let signal;
      const context = {
        URL, location: { origin: 'https://reader' },
        AbortSignal: { timeout: (ms) => { assert.equal(ms, 2000); return { timeout: ms }; } },
        self: { addEventListener: (name, fn) => handlers[name] = fn },
        caches: { open: async () => ({ match: async () => hit }) },
        fetch: async (_req, options) => { signal = options.signal; throw new Error('Brak sieci'); }
      };
      vm.runInNewContext(readFileSync(new URL(`../../${app}/sw.js`, import.meta.url), 'utf8'), context);
      let response;
      handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: `https://reader/${app}/index.html` }, resultingClientId: 'tab', respondWith: (promise) => response = promise });
      if (cached) {
        assert.equal(await response, hit);
        assert.deepEqual(signal, { timeout: 2000 });
      } else {
        await assert.rejects(response, /Brak sieci/);
        assert.equal(signal, undefined);
      }
    });
  }
}

for (const app of ['darkpdf', 'calc']) {
  test(`${app}: pliki strony bez limitu czasu, a po stronie z cache – też z cache`, async () => {
    const handlers = {};
    const hit = { marker: 'offline' };
    const fetched = [];
    const context = {
      URL, location: { origin: 'https://reader' },
      AbortSignal: { timeout: (ms) => ({ timeout: ms }) },
      self: { addEventListener: (name, fn) => handlers[name] = fn },
      caches: { open: async () => ({ match: async () => hit }) },
      fetch: async (req, options) => { fetched.push([req.url, options.signal]); throw new Error('Brak sieci'); }
    };
    vm.runInNewContext(readFileSync(new URL(`../../${app}/sw.js`, import.meta.url), 'utf8'), context);
    const run = (event) => { let response; handlers.fetch({ ...event, respondWith: (p) => response = p }); return response; };

    // moduł z karty, której strona przyszła z sieci: czekamy na sieć (bez timeoutu), cache tylko przy błędzie
    assert.equal(await run({ request: { method: 'GET', mode: 'cors', url: `https://reader/${app}/a.js` }, clientId: 'fresh' }), hit);
    assert.deepEqual(fetched.pop(), [`https://reader/${app}/a.js`, undefined]);

    // strona z cache → jej moduły od razu z cache, bez pytania sieci
    await run({ request: { method: 'GET', mode: 'navigate', url: `https://reader/${app}/` }, resultingClientId: 'stale' });
    fetched.length = 0;
    assert.equal(await run({ request: { method: 'GET', mode: 'cors', url: `https://reader/${app}/b.js` }, clientId: 'stale' }), hit);
    assert.equal(fetched.length, 0);
  });
}
