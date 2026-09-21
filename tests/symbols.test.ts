import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chooseListing, searchSymbol, SymbolSearchError, type Listing } from '../src/ingest/symbols.ts';

function L(p: Partial<Listing>): Listing {
  return {
    symbol: 'X', name: 'X', exchange: 'NASDAQ', micCode: 'XNMS',
    country: 'United States', currency: 'USD', instrumentType: 'Common Stock',
    ...p,
  };
}

// Copiados de /symbol_search real el 2026-09-21.
const SOXL_REAL: Listing[] = [
  L({ symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares', exchange: 'NYSE', micCode: 'ARCX', instrumentType: 'ETF' }),
  L({ symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares', exchange: 'BMV', micCode: 'XMEX', country: 'Mexico', currency: 'MXN', instrumentType: 'ETF' }),
  L({ symbol: 'SOXL', name: 'Leverage Shares 4x Long Semiconductors ETP', exchange: 'LSE', micCode: 'XLON', country: 'United Kingdom', instrumentType: 'ETF' }),
  L({ symbol: 'SOXL', name: 'Leverage Shares 4x Long Semiconductors ETP', exchange: 'MTA', micCode: 'XMIL', country: 'Italy', currency: 'EUR', instrumentType: 'ETF' }),
  L({ symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares', exchange: 'IEX', micCode: 'IEXG', instrumentType: 'ETF' }),
  L({ symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares', exchange: 'NEO', micCode: 'NEOE', country: 'Canada', currency: 'CAD', instrumentType: 'ETF' }),
];

const LLY_REAL: Listing[] = [
  L({ symbol: 'LLETNC', name: 'First National Bank ETN on Eli Lilly & Co.', exchange: 'JSE', micCode: 'XJSE', country: 'South Africa', currency: 'ZAc', instrumentType: 'ETF' }),
  L({ symbol: 'LLY', name: 'Eli Lilly and Company', exchange: 'NYSE', micCode: 'XNYS' }),
  L({ symbol: 'LLY', name: 'Eli Lilly and Company', exchange: 'BMV', micCode: 'XMEX', country: 'Mexico', currency: 'MXN' }),
  L({ symbol: 'LLY', name: 'Eli Lilly and Company', exchange: 'XETR', micCode: 'XETR', country: 'Germany', currency: 'EUR' }),
];

describe('chooseListing — el mismo ticker no es el mismo producto', () => {
  test('SOXL se resuelve al Direxion de EE.UU., no al ETP de Londres', () => {
    // El de LSE es un 4x de otro emisor. Cogerlo daría un precio creíble y
    // equivocado, que es el error que no se nota.
    const r = chooseListing('SOXL', SOXL_REAL);
    assert.equal(r.ambiguous, false);
    assert.match(r.chosen!.name, /Direxion/);
    assert.equal(r.chosen!.country, 'United States');
    assert.equal(r.chosen!.currency, 'USD');
  });

  test('entre NYSE e IEX gana el mercado primario', () => {
    const r = chooseListing('SOXL', SOXL_REAL);
    assert.equal(r.chosen!.micCode, 'ARCX');
  });

  test('LLY no se resuelve a pesos ni a euros', () => {
    const r = chooseListing('LLY', LLY_REAL);
    assert.equal(r.chosen!.exchange, 'NYSE');
    assert.equal(r.chosen!.currency, 'USD');
  });

  test('una búsqueda por LLY no acaba en LLETNC', () => {
    // El ETN sudafricano lleva "Eli Lilly" en el nombre y sale el primero en
    // la respuesta real. Sin coincidencia exacta de símbolo, ganaría.
    const r = chooseListing('LLY', LLY_REAL);
    assert.equal(r.chosen!.symbol, 'LLY');
  });

  test('sin listado en EE.UU. usa el que haya', () => {
    const solo = [L({ symbol: 'SAN', exchange: 'BME', micCode: 'BMEX', country: 'Spain', currency: 'EUR' })];
    const r = chooseListing('SAN', solo);
    assert.equal(r.chosen!.exchange, 'BME');
    assert.equal(r.ambiguous, false);
  });

  test('dos instrumentos distintos e indistinguibles: NO elige', () => {
    // Rendirse es la respuesta correcta. Un desempate automático aquí sería
    // una suposición presentada como dato.
    const empate = [
      L({ symbol: 'ABC', name: 'Alpha Corp', exchange: 'NYSE', micCode: 'XNYS' }),
      L({ symbol: 'ABC', name: 'Beta Industries', exchange: 'NASDAQ', micCode: 'XNMS' }),
    ];
    const r = chooseListing('ABC', empate);
    assert.equal(r.ambiguous, true);
    assert.equal(r.chosen, undefined);
    assert.match(r.reason, /Alpha Corp/);
    assert.match(r.reason, /Beta Industries/);
  });

  test('el mismo instrumento en dos venues del mismo país no es ambiguo', () => {
    const mismo = [
      L({ symbol: 'ABC', name: 'Alpha Corp', exchange: 'NYSE', micCode: 'XNYS' }),
      L({ symbol: 'ABC', name: 'Alpha Corp', exchange: 'NYSE ARCA', micCode: 'ARCX' }),
    ];
    const r = chooseListing('ABC', mismo);
    assert.equal(r.ambiguous, false);
    assert.equal(r.chosen!.name, 'Alpha Corp');
  });

  test('sin resultados lo dice, y no falla', () => {
    const r = chooseListing('ZZQQXX', []);
    assert.equal(r.chosen, undefined);
    assert.equal(r.ambiguous, false);
    assert.match(r.reason, /no conoce/);
  });

  test('un parecido no se hace pasar por una coincidencia', () => {
    const r = chooseListing('QQQM', [L({ symbol: 'QQQM19', name: 'Invesco Nasdaq 100 ETF Trust', country: 'Thailand', currency: 'THB' })]);
    assert.equal(r.chosen, undefined);
    assert.match(r.reason, /QQQM19/);
  });

  test('conserva siempre los candidatos, se elija o no', () => {
    assert.equal(chooseListing('SOXL', SOXL_REAL).candidates.length, 6);
    assert.equal(chooseListing('ZZQQXX', []).candidates.length, 0);
  });
});

describe('searchSymbol', () => {
  function mock(body: unknown, status = 200) {
    return (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
  }

  test('traduce la respuesta del proveedor', async () => {
    const f = mock({ data: [{
      symbol: 'aapl', instrument_name: 'Apple Inc', exchange: 'NASDAQ',
      mic_code: 'XNGS', country: 'United States', currency: 'USD',
      instrument_type: 'Common Stock',
    }] });
    const r = await searchSymbol('AAPL', 'KEY', f);
    assert.equal(r.length, 1);
    assert.equal(r[0].symbol, 'AAPL', 'el símbolo se normaliza a mayúsculas');
    assert.equal(r[0].name, 'Apple Inc');
  });

  test('sin resultados devuelve lista vacía, no lanza', () => {
    return assert.doesNotReject(async () => {
      assert.deepEqual(await searchSymbol('X', 'KEY', mock({ data: [] })), []);
    });
  });

  test('detecta el error que llega con código 200', async () => {
    await assert.rejects(
      () => searchSymbol('X', 'KEY', mock({ status: 'error', message: 'sin créditos' })),
      (e: Error) => e instanceof SymbolSearchError && /sin créditos/.test(e.message)
    );
  });

  test('sin clave dice qué falta', async () => {
    await assert.rejects(() => searchSymbol('X', ''), /TWELVEDATA_API_KEY/);
  });

  test('una consulta vacía no llega a la red', async () => {
    await assert.rejects(() => searchSymbol('   ', 'KEY'), /vacía/);
  });
});
