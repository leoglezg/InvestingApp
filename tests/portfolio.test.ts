import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSymbol, validateQuantity, padCik, computeWeights,
  diffPortfolio, analysisCapabilities,
  InvalidSymbolError, InvalidQuantityError,
} from '../src/portfolio/positions.ts';
import { resolveSymbol } from '../src/data/secTickers.ts';

describe('normalizeSymbol', () => {
  test('normaliza a mayúsculas y recorta espacios', () => {
    assert.equal(normalizeSymbol('  aapl '), 'AAPL');
  });

  test('admite clases de acción con punto o guion', () => {
    assert.equal(normalizeSymbol('brk.b'), 'BRK.B');
    assert.equal(normalizeSymbol('brk-b'), 'BRK-B');
  });

  test('admite pares con barra', () => {
    assert.equal(normalizeSymbol('btc/usd'), 'BTC/USD');
  });

  test('rechaza vacío y basura', () => {
    assert.throws(() => normalizeSymbol('   '), InvalidSymbolError);
    assert.throws(() => normalizeSymbol('AA PL'), InvalidSymbolError);
    assert.throws(() => normalizeSymbol('<script>'), InvalidSymbolError);
  });
});

describe('validateQuantity', () => {
  test('acepta fraccionarios, que es lo habitual en brókers modernos', () => {
    assert.equal(validateQuantity(7.42), 7.42);
    assert.equal(validateQuantity('0.3'), 0.3);
  });

  test('acepta 0 — es cerrar la posición, no un error', () => {
    assert.equal(validateQuantity(0), 0);
  });

  test('rechaza negativos y no numéricos', () => {
    assert.throws(() => validateQuantity(-1), InvalidQuantityError);
    assert.throws(() => validateQuantity('muchas'), InvalidQuantityError);
    assert.throws(() => validateQuantity(Number.POSITIVE_INFINITY), InvalidQuantityError);
  });
});

describe('padCik', () => {
  test('rellena a los 10 dígitos que exigen las rutas de EDGAR', () => {
    assert.equal(padCik('320193'), '0000320193');
    assert.equal(padCik('4962'), '0000004962');
  });

  test('no altera uno ya relleno', () => {
    assert.equal(padCik('0000320193'), '0000320193');
  });
});

describe('computeWeights — los precios faltantes deben VERSE', () => {
  test('calcula pesos normales', () => {
    const w = computeWeights([
      { symbol: 'AAPL', quantity: 2, price: 100 },
      { symbol: 'KO', quantity: 10, price: 50 },
    ]);
    assert.equal(w.totalValue, 700);
    assert.equal(w.positions.find(p => p.symbol === 'KO')!.weightPct, 500 / 700);
    assert.equal(w.pricedCoverage, 1);
  });

  test('ordena por valor de mercado descendente', () => {
    const w = computeWeights([
      { symbol: 'PEQUE', quantity: 1, price: 10 },
      { symbol: 'GRANDE', quantity: 1, price: 1000 },
    ]);
    assert.equal(w.positions[0].symbol, 'GRANDE');
  });

  test('NO omite ni redistribuye el peso de un símbolo sin precio', () => {
    // El error que corrompe: si se omitiera la posición sin precio, los pesos
    // de las demás sumarían 100% y la cartera parecería completa sin serlo.
    const w = computeWeights([
      { symbol: 'AAPL', quantity: 2, price: 100 },
      { symbol: 'QQQM', quantity: 7.42, price: null },
    ]);

    assert.equal(w.positions.length, 2, 'la posición sin precio sigue presente');
    const qqqm = w.positions.find(p => p.symbol === 'QQQM')!;
    assert.equal(qqqm.weightPct, null, 'su peso es null, no cero ni inventado');
    assert.equal(qqqm.marketValue, null);
    assert.deepEqual(w.missingPrices, ['QQQM']);
    assert.equal(w.pricedCoverage, 0.5);

    // AAPL pesa 100% de lo VALORADO, y la cobertura avisa de que eso no es
    // el 100% de la cartera.
    assert.equal(w.positions.find(p => p.symbol === 'AAPL')!.weightPct, 1);
    assert.ok(w.pricedCoverage < 1, 'la cobertura parcial debe ser visible');
  });

  test('cartera vacía no divide por cero', () => {
    const w = computeWeights([]);
    assert.equal(w.totalValue, 0);
    assert.equal(w.pricedCoverage, 1);
  });

  test('si ningún precio está disponible, los pesos son null y no NaN', () => {
    const w = computeWeights([{ symbol: 'X', quantity: 1, price: null }]);
    assert.equal(w.positions[0].weightPct, null);
    assert.equal(w.pricedCoverage, 0);
  });
});

describe('diffPortfolio', () => {
  const antes = [{ symbol: 'AAPL', quantity: 2 }, { symbol: 'KO', quantity: 3 }];

  test('detecta apertura, aumento, reducción y cierre', () => {
    const d = diffPortfolio(antes, [
      { symbol: 'AAPL', quantity: 5 },
      { symbol: 'KO', quantity: 1 },
      { symbol: 'MU', quantity: 0.3 },
    ]);
    const by = Object.fromEntries(d.map(c => [c.symbol, c.kind]));
    assert.equal(by.AAPL, 'increased');
    assert.equal(by.KO, 'reduced');
    assert.equal(by.MU, 'opened');
  });

  test('un símbolo ausente después cuenta como cerrado', () => {
    const d = diffPortfolio(antes, [{ symbol: 'AAPL', quantity: 2 }]);
    assert.equal(d.find(c => c.symbol === 'KO')!.kind, 'closed');
  });

  test('cantidad 0 explícita también es cierre', () => {
    const d = diffPortfolio(antes, [{ symbol: 'KO', quantity: 0 }]);
    assert.equal(d.find(c => c.symbol === 'KO')!.kind, 'closed');
  });

  test('sin cambios reporta unchanged', () => {
    assert.ok(diffPortfolio(antes, antes).every(c => c.kind === 'unchanged'));
  });
});

describe('analysisCapabilities — degradar con elegancia', () => {
  test('una acción con CIK tiene todas las capas', () => {
    const c = analysisCapabilities({ symbol: 'AAPL', cik: '320193', assetType: 'stock', isTracked: true });
    assert.equal(c.secFilings, true);
    assert.deepEqual(c.degraded, []);
  });

  test('un ETF sin CIK pierde la capa SEC pero conserva el resto', () => {
    // QQQM es el caso real de esta cartera: no es un fallo, es que los ETF
    // no presentan filings propios.
    const c = analysisCapabilities({ symbol: 'QQQM', cik: null, assetType: 'etf', isTracked: true });
    assert.equal(c.secFilings, false);
    assert.equal(c.prices, true);
    assert.equal(c.macroRegime, true);
    assert.equal(c.generalNews, true);
    assert.equal(c.degraded.length, 1);
    assert.match(c.degraded[0], /sin CIK/);
  });
});

describe('resolveSymbol', () => {
  const catalog = {
    AAPL: { ticker: 'AAPL', cik: '320193', title: 'Apple Inc.' },
    MU: { ticker: 'MU', cik: '723125', title: 'Micron Technology Inc' },
  };

  test('resuelve un emisor conocido', () => {
    const r = resolveSymbol('aapl', catalog);
    assert.equal(r.cik, '320193');
    assert.equal(r.isNonFiler, false);
  });

  test('un símbolo ausente se marca como no-emisor, sin lanzar', () => {
    const r = resolveSymbol('QQQM', catalog);
    assert.equal(r.cik, null);
    assert.equal(r.isNonFiler, true);
  });
});
