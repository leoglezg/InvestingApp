import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cikPath, fetchSecFilings, fetchMacroVintage, fetchNews, type FetchDeps,
} from '../src/ingest/sources.ts';

const deps = (fetchImpl: typeof fetch): FetchDeps =>
  ({ secUserAgent: 'Test test@example.com', fredApiKey: 'KEY', fetchImpl });

/** fetch falso que registra las URLs pedidas y devuelve respuestas en cola. */
function mockFetch(responses: { status?: number; body?: unknown }[]) {
  const calls: string[] = [];
  let i = 0;
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('cikPath', () => {
  test('rellena a 10 dígitos, como exige EDGAR', () => {
    assert.equal(cikPath('320193'), 'CIK0000320193');
    assert.equal(cikPath('4962'), 'CIK0000004962');
  });
});

describe('fetchSecFilings', () => {
  const body = {
    filings: {
      recent: {
        accessionNumber: ['0000320193-26-000018', '0000320193-25-000001'],
        form: ['8-K', '10-Q'],
        filingDate: ['2026-07-30', '2025-01-15'],
        reportDate: ['2026-06-27', ''],
        acceptanceDateTime: ['2026-07-30T20:30:28.000Z', '2025-01-15T18:00:00.000Z'],
        items: ['2.02,9.01', ''],
        primaryDocument: ['aapl-20260730.htm', 'aapl-10q.htm'],
      },
    },
  };

  test('identifica al solicitante: la SEC responde 403 sin User-Agent', async () => {
    const m = mockFetch([{ body }]);
    await fetchSecFilings('320193', new Date('2020-01-01'), deps(m.impl));
    assert.match(m.calls[0], /CIK0000320193/);
  });

  test('descarta los anteriores a la ventana', async () => {
    const m = mockFetch([{ body }]);
    const r = await fetchSecFilings('320193', new Date('2026-01-01'), deps(m.impl));
    assert.equal(r.length, 1);
    assert.equal(r[0].form, '8-K');
  });

  test('conserva el acceptanceDateTime completo, no sólo la fecha', async () => {
    // Es el mejor available_at disponible: el instante en que el regulador
    // aceptó el documento. Truncarlo a fecha perdería el orden intradía.
    const m = mockFetch([{ body }]);
    const r = await fetchSecFilings('320193', new Date('2026-01-01'), deps(m.impl));
    assert.equal(r[0].acceptanceDateTime, '2026-07-30T20:30:28.000Z');
  });

  test('conserva los códigos items: taxonomía declarada, no inferida', async () => {
    const m = mockFetch([{ body }]);
    const r = await fetchSecFilings('320193', new Date('2026-01-01'), deps(m.impl));
    assert.equal(r[0].items, '2.02,9.01');
  });

  test('descarta los Form 4: son operaciones de directivos, no eventos', async () => {
    // Medido de verdad: NVDA devolvía 52 filings en 120 días y sólo 9 eran
    // eventos. Sin filtrar, el 83% restante ahogaría la señal y, peor,
    // inflaría el recuento de comparables del matching.
    const conRuido = {
      filings: { recent: {
        accessionNumber: ['a', 'b', 'c'],
        form: ['4', '8-K', '144'],
        filingDate: ['2026-09-11', '2026-09-10', '2026-09-09'],
        reportDate: ['', '', ''],
        acceptanceDateTime: [
          '2026-09-11T21:04:47.000Z', '2026-09-10T20:00:00.000Z', '2026-09-09T20:00:00.000Z',
        ],
        items: ['', '2.02,9.01', ''],
        primaryDocument: ['x.htm', 'y.htm', 'z.htm'],
      } },
    };
    const m = mockFetch([{ body: conRuido }]);
    const r = await fetchSecFilings('1', new Date('2026-01-01'), deps(m.impl));
    assert.equal(r.length, 1);
    assert.equal(r[0].form, '8-K');
  });

  test('una enmienda cuenta como su formulario base: 8-K/A es un 8-K', async () => {
    const m = mockFetch([{ body: { filings: { recent: {
      accessionNumber: ['a'], form: ['8-K/A'], filingDate: ['2026-09-01'],
      reportDate: [''], acceptanceDateTime: ['2026-09-01T20:30:35.000Z'],
      items: ['5.02'], primaryDocument: ['x.htm'],
    } } } }]);
    const r = await fetchSecFilings('1', new Date('2026-01-01'), deps(m.impl));
    assert.equal(r.length, 1);
    assert.equal(r[0].items, '5.02');
  });

  test('un emisor sin filings devuelve lista vacía, no lanza', async () => {
    const m = mockFetch([{ body: { filings: { recent: {} } } }]);
    assert.deepEqual(await fetchSecFilings('1', new Date(0), deps(m.impl)), []);
  });

  test('propaga un error HTTP en vez de devolver vacío', async () => {
    // Un 500 tratado como "sin filings" sería un hueco silencioso.
    const m = mockFetch([{ status: 500 }]);
    await assert.rejects(() => fetchSecFilings('1', new Date(0), deps(m.impl)), /HTTP 500/);
  });
});

describe('fetchMacroVintage — LEY 2', () => {
  const body = {
    observations: [
      { date: '2025-01-01', value: '23528.047', realtime_start: '2025-06-01', realtime_end: '2025-06-01' },
    ],
  };

  test('SIEMPRE fija realtime_start: sin él, FRED devuelve la serie revisada', async () => {
    // Éste es el test que más importa de este archivo. El comportamiento por
    // defecto de la API es el que viola la LEY 2, y omitir el parámetro no da
    // error: da look-ahead silencioso.
    const m = mockFetch([{ body }]);
    await fetchMacroVintage('GDPC1', new Date('2025-06-01T00:00:00Z'), deps(m.impl));

    const u = new URL(m.calls[0]);
    assert.equal(u.searchParams.get('realtime_start'), '2025-06-01');
    assert.equal(u.searchParams.get('realtime_end'), '2025-06-01');
  });

  test('devuelve el valor vigente entonces, con su ventana de vigencia', async () => {
    const m = mockFetch([{ body }]);
    const r = await fetchMacroVintage('GDPC1', new Date('2025-06-01T00:00:00Z'), deps(m.impl));
    assert.equal(r[0].value, 23528.047);
    assert.equal(r[0].realtimeStart, '2025-06-01');
  });

  test('descarta los valores ausentes en vez de convertirlos en 0', async () => {
    // FRED marca los huecos con '.'. Un 0 sería un dato inventado que se
    // propagaría al régimen macro como si fuera real.
    const m = mockFetch([{ body: { observations: [
      { date: '2025-01-01', value: '.', realtime_start: 'x', realtime_end: 'y' },
      { date: '2025-04-01', value: '1.5', realtime_start: 'x', realtime_end: 'y' },
    ] } }]);
    const r = await fetchMacroVintage('X', new Date(), deps(m.impl));
    assert.equal(r.length, 1);
    assert.equal(r[0].value, 1.5);
  });
});

describe('fetchNews — reintentos pacientes', () => {
  const body = { articles: [{
    url: 'https://newsweek.com/x', title: 'Federal Reserve...',
    seendate: '20260303T183000Z', domain: 'newsweek.com',
    language: 'English', sourcecountry: 'US',
  }] };

  const noSleep = async () => {};

  test('reintenta ante 429 y acaba devolviendo los datos', async () => {
    const m = mockFetch([{ status: 429 }, { status: 429 }, { body }]);
    const r = await fetchNews('fed', new Date('2026-03-02'), new Date('2026-03-07'),
      { sleep: noSleep }, m.impl);
    assert.equal(r.length, 1);
    assert.equal(m.calls.length, 3, 'debió reintentar dos veces');
  });

  test('lanza si el 429 persiste, en vez de devolver vacío', async () => {
    // Vacío sería indistinguible de "no hubo noticias", y el día se daría por
    // ingerido sin estarlo.
    const m = mockFetch([{ status: 429 }]);
    await assert.rejects(
      () => fetchNews('fed', new Date('2026-03-02'), new Date('2026-03-07'), { tries: 3, sleep: noSleep }, m.impl),
      /429 persistente/
    );
  });

  test('traduce seendate sin fingir que es la hora de publicación', async () => {
    const m = mockFetch([{ body }]);
    const r = await fetchNews('fed', new Date('2026-03-02'), new Date('2026-03-07'), { sleep: noSleep }, m.impl);
    assert.equal(r[0].seenDate, '20260303T183000Z');
    assert.equal(r[0].domain, 'newsweek.com', 'el dominio permite asignar tier');
  });

  test('envía la ventana de fechas solicitada', async () => {
    const m = mockFetch([{ body }]);
    await fetchNews('fed', new Date('2026-03-02T00:00:00Z'), new Date('2026-03-07T00:00:00Z'),
      { sleep: noSleep }, m.impl);
    const u = new URL(m.calls[0]);
    assert.match(u.searchParams.get('startdatetime')!, /^20260302/);
    assert.match(u.searchParams.get('enddatetime')!, /^20260307/);
  });
});
