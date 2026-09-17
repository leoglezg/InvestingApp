import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuote, fetchQuotes, QuoteUnavailableError } from '../src/ingest/prices.ts';

function mockFetch(responses: { status?: number; body?: unknown }[]) {
  const calls: string[] = [];
  let i = 0;
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const quoteOk = {
  symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X',
  close: '42.18', previous_close: '41.05',
  timestamp: 1789661460, is_market_open: true,
};

describe('fetchQuote', () => {
  test('devuelve el precio y el instante DEL PROVEEDOR', async () => {
    const m = mockFetch([{ body: quoteOk }]);
    const q = await fetchQuote('SOXL', 'KEY', m.impl);
    assert.equal(q.price, 42.18);
    assert.equal(q.symbol, 'SOXL');
    // No la hora de nuestra petición: la del dato.
    assert.equal(q.quotedAt.getTime(), 1789661460 * 1000);
    assert.equal(q.isMarketOpen, true);
    assert.equal(q.previousClose, 41.05);
  });

  test('no envía la clave en la ruta, sino como parámetro', async () => {
    const m = mockFetch([{ body: quoteOk }]);
    await fetchQuote('SOXL', 'SECRETA', m.impl);
    const u = new URL(m.calls[0]);
    assert.equal(u.searchParams.get('apikey'), 'SECRETA');
    assert.equal(u.searchParams.get('symbol'), 'SOXL');
  });

  test('sin clave falla con un mensaje que dice qué hacer', async () => {
    await assert.rejects(
      () => fetchQuote('SOXL', ''),
      (e: Error) => /TWELVEDATA_API_KEY/.test(e.message)
    );
  });

  test('detecta el error que el proveedor devuelve con código 200', async () => {
    // Un símbolo inexistente o el límite de llamadas agotado NO llegan como
    // código HTTP: vienen en el cuerpo de una respuesta correcta. Ignorarlo
    // haría que un límite agotado pareciera un precio ausente.
    const m = mockFetch([{ body: { status: 'error', code: 404, message: 'symbol not found' } }]);
    await assert.rejects(
      () => fetchQuote('NOEXISTE', 'KEY', m.impl),
      (e: Error) => e instanceof QuoteUnavailableError && /symbol not found/.test(e.message)
    );
  });

  test('rechaza un precio de cero o negativo', async () => {
    for (const close of ['0', '-5']) {
      const m = mockFetch([{ body: { ...quoteOk, close } }]);
      await assert.rejects(() => fetchQuote('X', 'KEY', m.impl), QuoteUnavailableError);
    }
  });

  test('rechaza un precio no numérico en vez de propagar NaN', async () => {
    const m = mockFetch([{ body: { ...quoteOk, close: 'n/d' } }]);
    await assert.rejects(() => fetchQuote('X', 'KEY', m.impl), QuoteUnavailableError);
  });

  test('propaga un error HTTP', async () => {
    const m = mockFetch([{ status: 500 }]);
    await assert.rejects(() => fetchQuote('X', 'KEY', m.impl), /HTTP 500/);
  });

  test('sin timestamp usa la hora actual sin romperse', async () => {
    const { timestamp, ...sinTs } = quoteOk;
    const m = mockFetch([{ body: sinTs }]);
    const q = await fetchQuote('X', 'KEY', m.impl);
    assert.ok(Number.isFinite(q.quotedAt.getTime()));
  });
});

describe('fetchQuotes — un fallo no arrastra al resto', () => {
  const noSleep = async () => {};

  test('un símbolo que falla no cancela los demás', async () => {
    const m = mockFetch([
      { body: quoteOk },
      { body: { status: 'error', message: 'símbolo desconocido' } },
      { body: { ...quoteOk, symbol: 'AAPL', close: '330.16' } },
    ]);
    const r = await fetchQuotes(['SOXL', 'MALO', 'AAPL'], 'KEY', { fetchImpl: m.impl, sleep: noSleep });

    assert.equal(r.length, 3);
    assert.equal(r[0].quote?.price, 42.18);
    assert.match(r[1].error!, /desconocido/);
    assert.equal(r[2].quote?.price, 330.16);
  });

  test('cada resultado conserva el símbolo solicitado', async () => {
    const m = mockFetch([{ body: { status: 'error', message: 'x' } }]);
    const r = await fetchQuotes(['UNO', 'DOS'], 'KEY', { fetchImpl: m.impl, sleep: noSleep });
    assert.deepEqual(r.map(x => x.symbol), ['UNO', 'DOS']);
  });

  test('espacia las llamadas: el plan gratuito limita por minuto', async () => {
    // En paralelo se agota el límite y fallan todas. Secuencial y con pausa.
    const esperas: number[] = [];
    const m = mockFetch([{ body: quoteOk }]);
    await fetchQuotes(['A', 'B', 'C'], 'KEY', {
      fetchImpl: m.impl, delayMs: 200,
      sleep: async ms => { esperas.push(ms); },
    });
    assert.deepEqual(esperas, [200, 200], 'una pausa entre llamadas, no antes de la primera');
  });

  test('lista vacía no llama a nada', async () => {
    const m = mockFetch([{ body: quoteOk }]);
    assert.deepEqual(await fetchQuotes([], 'KEY', { fetchImpl: m.impl, sleep: noSleep }), []);
    assert.equal(m.calls.length, 0);
  });
});
