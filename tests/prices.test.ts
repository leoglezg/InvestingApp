import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuote, fetchQuotes, hasProviderInstant, QuoteUnavailableError } from '../src/ingest/prices.ts';

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

// Copiado de una respuesta REAL de la API (SOXL, 2026-09-17): los dos campos
// de tiempo vienen, y no son lo mismo.
const quoteOk = {
  symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares',
  exchange: 'NYSE', mic_code: 'ARCX', currency: 'USD',
  close: '115.25', previous_close: '103.97',
  timestamp: 1789651800,      // 13:30Z — apertura de la sesión (la vela)
  last_quote_at: 1789668420,  // 18:07Z — el cruce de verdad
  is_market_open: true,
};

describe('fetchQuote', () => {
  test('devuelve el precio y el instante DEL PROVEEDOR', async () => {
    const m = mockFetch([{ body: quoteOk }]);
    const q = await fetchQuote('SOXL', 'KEY', m.impl);
    assert.equal(q.price, 115.25);
    assert.equal(q.symbol, 'SOXL');
    assert.equal(q.isMarketOpen, true);
    assert.equal(q.previousClose, 103.97);
    assert.equal(q.currency, 'USD');
    assert.equal(q.exchange, 'NYSE');
  });

  test('fecha el precio con last_quote_at, no con timestamp', async () => {
    // `timestamp` es el instante de la VELA y en la API real es idéntico para
    // todos los símbolos (la apertura). Usarlo fechaba un precio de las 18:07
    // como si existiera a las 13:30: casi cinco horas de adelanto escritas en
    // available_at, justo lo que prohíbe la LEY 1. Además quote_uq es
    // (symbol, quoted_at, provider), así que todos los refrescos del día
    // colisionaban y el precio se congelaba en el primero sin avisar.
    const m = mockFetch([{ body: quoteOk }]);
    const q = await fetchQuote('SOXL', 'KEY', m.impl);
    assert.equal(q.quotedAt.toISOString(), '2026-09-17T18:07:00.000Z');
    assert.equal(q.quotedAtSource, 'last_quote_at');
    assert.ok(hasProviderInstant(q));
  });

  test('sin last_quote_at cae a timestamp, que sigue siendo del proveedor', async () => {
    const { last_quote_at, ...soloTs } = quoteOk;
    const m = mockFetch([{ body: soloTs }]);
    const q = await fetchQuote('SOXL', 'KEY', m.impl);
    assert.equal(q.quotedAt.getTime(), 1789651800 * 1000);
    assert.equal(q.quotedAtSource, 'timestamp');
    assert.ok(hasProviderInstant(q), 'la vela es un instante del proveedor, no nuestro reloj');
  });

  test('dos refrescos distintos no comparten instante', async () => {
    // Si compartieran quoted_at, el segundo chocaría con quote_uq y el
    // ON CONFLICT DO NOTHING lo descartaría en silencio.
    const m = mockFetch([
      { body: quoteOk },
      { body: { ...quoteOk, close: '116.10', last_quote_at: 1789668480 } },
    ]);
    const a = await fetchQuote('SOXL', 'KEY', m.impl);
    const b = await fetchQuote('SOXL', 'KEY', m.impl);
    assert.notEqual(a.quotedAt.getTime(), b.quotedAt.getTime());
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

  test('un ticker desconocido no se confunde con un fallo nuestro', async () => {
    // Texto literal de la API real ante ZZQQXX. Tal cual parece que hemos
    // construido mal la petición; hay que decir lo que de verdad pasa.
    const m = mockFetch([{ body: {
      status: 'error', code: 400,
      message: '**symbol** or **figi** parameter is missing or invalid.',
    } }]);
    await assert.rejects(
      () => fetchQuote('ZZQQXX', 'KEY', m.impl),
      (e: Error) => /no reconoce este ticker/.test(e.message)
    );
  });

  test('el límite agotado se distingue del precio inexistente', async () => {
    const m = mockFetch([{ body: {
      status: 'error', code: 429,
      message: 'You have run out of API credits for the current minute.',
    } }]);
    await assert.rejects(
      () => fetchQuote('AAPL', 'KEY', m.impl),
      (e: Error) => /límite de llamadas/.test(e.message)
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

  test('sin ningún instante del proveedor, lo dice en vez de disimularlo', async () => {
    // Se devuelve el precio (sirve para mirarlo) pero marcado: quien lo vaya a
    // escribir en available_at tiene que poder negarse. Nuestro reloj dice
    // cuándo preguntamos, no cuándo existió el precio.
    const { timestamp, last_quote_at, ...sinTiempo } = quoteOk;
    const m = mockFetch([{ body: sinTiempo }]);
    const q = await fetchQuote('X', 'KEY', m.impl);
    assert.ok(Number.isFinite(q.quotedAt.getTime()));
    assert.equal(q.quotedAtSource, 'request_time');
    assert.equal(hasProviderInstant(q), false);
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
    assert.equal(r[0].quote?.price, 115.25);
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
