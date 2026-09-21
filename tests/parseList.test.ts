import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortfolioText } from '../src/portfolio/parseList.ts';

describe('parsePortfolioText — formatos que uno pega de verdad', () => {
  test('una posición por línea con la palabra "shares"', () => {
    const r = parsePortfolioText(`
      QQQM 7.42 shares
      LLY 0.88 shares
      AAPL 2.24 shares
      AXP 1 share
      KO 3.56 shares
      MU 0.3 shares
    `);
    assert.equal(r.failures.length, 0);
    assert.deepEqual(
      r.entries.map(e => [e.symbol, e.quantity]),
      [['QQQM', 7.42], ['LLY', 0.88], ['AAPL', 2.24], ['AXP', 1], ['KO', 3.56], ['MU', 0.3]]
    );
  });

  test('todo en una línea separado por comas', () => {
    const r = parsePortfolioText('QQQM 7.42, LLY 0.88, AAPL 2.24');
    assert.equal(r.failures.length, 0);
    assert.deepEqual(r.entries.map(e => e.symbol), ['QQQM', 'LLY', 'AAPL']);
  });

  test('la coma decimal no parte la entrada en dos', () => {
    // "LLY 0,88" es una posición, no "LLY 0" y "88". La diferencia está en lo
    // que sigue a la coma: un dígito es decimal, una letra es otra entrada.
    const r = parsePortfolioText('LLY 0,88, AAPL 2,24');
    assert.equal(r.failures.length, 0);
    assert.deepEqual(
      r.entries.map(e => [e.symbol, e.quantity]),
      [['LLY', 0.88], ['AAPL', 2.24]]
    );
  });

  test('admite dos puntos, igual, tabulador y el $ delante', () => {
    // El tabulador separa ticker de cantidad, no una entrada de la siguiente:
    // si separase entradas, "MU<tab>0.3" daría un ticker "MU" sin cantidad y
    // otro ticker llamado "0.3".
    const r = parsePortfolioText('$AAPL: 2.24\nKO = 3.56\nMU\t0.3');
    assert.equal(r.failures.length, 0);
    assert.deepEqual(
      r.entries.map(e => [e.symbol, e.quantity]),
      [['AAPL', 2.24], ['KO', 3.56], ['MU', 0.3]]
    );
  });

  test('un número suelto no se convierte en ticker', () => {
    const r = parsePortfolioText('AAPL 2.24\n0.3');
    assert.deepEqual(r.entries.map(e => e.symbol), ['AAPL']);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].reason, /número suelto/);
  });

  test('ignora la cabecera de una tabla exportada', () => {
    const r = parsePortfolioText('Symbol Quantity\nAAPL 2.24');
    assert.deepEqual(r.entries.map(e => e.symbol), ['AAPL']);
    assert.equal(r.failures.length, 0);
  });

  test('sólo el ticker deja la cantidad en null: es seguimiento, no posición', () => {
    // Registrar 0 sería afirmar que no se tiene nada, que no es lo mismo que
    // no haberlo dicho.
    const r = parsePortfolioText('NVDA\nAAPL 2.24');
    assert.equal(r.entries[0].quantity, null);
    assert.equal(r.entries[1].quantity, 2.24);
  });

  test('sobra lo que venga detrás de la cantidad', () => {
    const r = parsePortfolioText('AAPL 2.24 USD 739.56');
    assert.equal(r.entries[0].quantity, 2.24);
  });
});

describe('parsePortfolioText — lo que no entiende lo dice', () => {
  test('una línea ilegible se devuelve, no se salta', () => {
    // Saltarla en silencio perdería una posición y la cartera parecería
    // completa. Ése es el fallo que este módulo existe para no cometer.
    const r = parsePortfolioText('AAPL 2.24\n???? ????\nKO 3.56');
    assert.deepEqual(r.entries.map(e => e.symbol), ['AAPL', 'KO']);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].line, 2);
    assert.match(r.failures[0].raw, /\?\?\?\?/);
  });

  test('un ticker sin cantidad legible no se cuela como cantidad nula', () => {
    const r = parsePortfolioText('AAPL muchas');
    assert.equal(r.entries.length, 0);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].reason, /cantidad/);
  });

  test('una cantidad negativa se rechaza con su motivo', () => {
    const r = parsePortfolioText('AAPL -3');
    assert.equal(r.entries.length, 0);
    assert.equal(r.failures.length, 1);
  });

  test('un ticker repetido vale la última vez, y se avisa', () => {
    const r = parsePortfolioText('AAPL 1\nKO 3\nAAPL 2.24');
    assert.equal(r.entries.find(e => e.symbol === 'AAPL')!.quantity, 2.24);
    assert.deepEqual(r.duplicates, [{ symbol: 'AAPL', lines: [1, 3] }]);
  });

  test('texto vacío no es un error, simplemente no hay nada', () => {
    const r = parsePortfolioText('\n  \n');
    assert.deepEqual(r.entries, []);
    assert.deepEqual(r.failures, []);
  });

  test('las líneas de comentario se ignoran', () => {
    const r = parsePortfolioText('# mi cartera\nAAPL 2.24');
    assert.deepEqual(r.entries.map(e => e.symbol), ['AAPL']);
    assert.equal(r.failures.length, 0);
  });
});
