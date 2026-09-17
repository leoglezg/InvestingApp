import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planDailyIngest, computeWindow, summarize,
  type TaskOutcome, type IngestTask,
} from '../src/ingest/planner.ts';
import type { SymbolInfo } from '../src/portfolio/positions.ts';

const NOW = new Date('2026-09-17T03:00:00Z');

const sym = (symbol: string, over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  symbol, cik: '123', assetType: 'stock', isTracked: true, ...over,
});

const kinds = (tasks: IngestTask[], symbol: string) =>
  tasks.filter(t => t.symbol === symbol).map(t => t.kind).sort();

describe('planDailyIngest — el universo sale de la base, no del código', () => {
  test('un símbolo recién añadido entra en el plan sin tocar código', () => {
    const antes = planDailyIngest([sym('AAPL')], { now: NOW });
    const despues = planDailyIngest([sym('AAPL'), sym('NVDA')], { now: NOW });

    assert.ok(!antes.trackedSymbols.includes('NVDA'));
    assert.ok(despues.trackedSymbols.includes('NVDA'));
    assert.deepEqual(kinds(despues.tasks, 'NVDA'), ['earnings_consensus', 'prices', 'sec_filings']);
  });

  test('un símbolo no seguido queda fuera por completo', () => {
    const p = planDailyIngest([sym('AAPL'), sym('VIEJO', { isTracked: false })], { now: NOW });
    assert.deepEqual(p.trackedSymbols, ['AAPL']);
    assert.equal(p.tasks.filter(t => t.symbol === 'VIEJO').length, 0);
  });

  test('escala a cualquier número de símbolos', () => {
    const muchos = Array.from({ length: 150 }, (_, i) => sym(`SYM${i}`));
    const p = planDailyIngest(muchos, { now: NOW });
    assert.equal(p.trackedSymbols.length, 150);
    assert.equal(p.tasks.filter(t => t.kind === 'prices').length, 150);
  });
});

describe('capacidades por símbolo', () => {
  test('sin CIK no hay tarea SEC, pero sí precios', () => {
    // El caso real de QQQM: un ETF no presenta filings propios.
    const p = planDailyIngest([sym('QQQM', { cik: null, assetType: 'etf' })], { now: NOW });
    assert.deepEqual(kinds(p.tasks, 'QQQM'), ['prices']);
    assert.equal(p.tasks.filter(t => t.kind === 'sec_filings').length, 0);
  });

  test('la exclusión de SEC se REGISTRA, no se silencia', () => {
    // Si no se reportara, "sin filings" sería indistinguible de "sin eventos".
    const p = planDailyIngest([sym('QQQM', { cik: null, assetType: 'etf' })], { now: NOW });
    assert.equal(p.skippedSec.length, 1);
    assert.equal(p.skippedSec[0].symbol, 'QQQM');
    assert.match(p.skippedSec[0].reason, /sin CIK/);
  });

  test('un ETF no genera tarea de consenso de beneficios', () => {
    const p = planDailyIngest([sym('QQQM', { cik: null, assetType: 'etf' })], { now: NOW });
    assert.equal(p.tasks.filter(t => t.kind === 'earnings_consensus').length, 0);
  });

  test('una cartera mixta reparte las tareas según capacidades', () => {
    const p = planDailyIngest([
      sym('AAPL', { cik: '320193' }),
      sym('QQQM', { cik: null, assetType: 'etf' }),
    ], { now: NOW });

    assert.deepEqual(kinds(p.tasks, 'AAPL'), ['earnings_consensus', 'prices', 'sec_filings']);
    assert.deepEqual(kinds(p.tasks, 'QQQM'), ['prices']);
  });
});

describe('tareas independientes de símbolos', () => {
  test('macro y noticias se planifican aunque no haya ningún símbolo', () => {
    // El régimen macro es el contexto de todo el análisis: existe cartera o no.
    const p = planDailyIngest([], {
      now: NOW, macroMetrics: ['GDPC1', 'CPIAUCSL'], newsQueries: ['federal reserve'],
    });
    assert.equal(p.trackedSymbols.length, 0);
    assert.equal(p.tasks.filter(t => t.kind === 'macro_vintage').length, 2);
    assert.equal(p.tasks.filter(t => t.kind === 'general_news').length, 1);
  });

  test('el macro se planifica antes que los eventos', () => {
    const p = planDailyIngest([sym('AAPL')], { now: NOW, macroMetrics: ['GDPC1'] });
    const iMacro = p.tasks.findIndex(t => t.kind === 'macro_vintage');
    const iSec = p.tasks.findIndex(t => t.kind === 'sec_filings');
    assert.ok(iMacro < iSec, 'el régimen es el contexto y va primero');
  });

  test('los quotes son opcionales y van al final', () => {
    const sin = planDailyIngest([sym('AAPL')], { now: NOW });
    assert.equal(sin.tasks.filter(t => t.kind === 'quote').length, 0);

    const con = planDailyIngest([sym('AAPL')], { now: NOW, includeQuotes: true });
    assert.equal(con.tasks.at(-1)!.kind, 'quote');
  });
});

describe('computeWindow — un fallo no deja un agujero permanente', () => {
  test('la primera ejecución mira un día atrás', () => {
    const w = computeWindow(null, NOW);
    assert.equal(w.recoveringGap, false);
    assert.equal(w.end.getTime() - w.start.getTime(), 24 * 3600 * 1000);
  });

  test('tras un fallo, la ventana se extiende para recuperar el hueco', () => {
    const haceTresDias = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000);
    const w = computeWindow(haceTresDias, NOW);
    assert.equal(w.recoveringGap, true);
    assert.equal(w.gapDays, 3);
    assert.equal(w.start.getTime(), haceTresDias.getTime(), 'arranca donde quedó');
  });

  test('una ejecución reciente no marca recuperación', () => {
    const haceUnaHora = new Date(NOW.getTime() - 3600 * 1000);
    assert.equal(computeWindow(haceUnaHora, NOW).recoveringGap, false);
  });

  test('el retroceso está acotado: un hueco enorme no dispara una consulta infinita', () => {
    const haceUnAno = new Date(NOW.getTime() - 365 * 24 * 3600 * 1000);
    const w = computeWindow(haceUnAno, NOW, 30);
    const dias = (w.end.getTime() - w.start.getTime()) / (24 * 3600 * 1000);
    assert.ok(dias <= 30.001, `la ventana se limitó a ${dias} días`);
    assert.equal(w.recoveringGap, true, 'aun acotada, sigue siendo recuperación');
  });
});

describe('summarize — un fallo parcial NO es un éxito', () => {
  const task = (kind: IngestTask['kind'], symbol: string | null = null): IngestTask =>
    ({ kind, symbol, priority: 1, reason: 'test' });

  const outcome = (s: TaskOutcome['status'], rows = 0, error?: string): TaskOutcome =>
    ({ task: task('prices', 'X'), status: s, rows, error });

  test('todo bien → ok', () => {
    assert.equal(summarize([outcome('ok', 5), outcome('ok', 3)]).status, 'ok');
  });

  test('un solo fallo degrada a partial, no a ok', () => {
    // Si se redondeara a éxito, el hueco quedaría invisible y la siguiente
    // ejecución no intentaría recuperarlo: así se pierde un día para siempre.
    const r = summarize([outcome('ok', 5), outcome('failed', 0, 'HTTP 500')]);
    assert.equal(r.status, 'partial');
    assert.equal(r.failed, 1);
    assert.equal(r.failures[0].error, 'HTTP 500');
  });

  test('todo falla → failed', () => {
    assert.equal(summarize([outcome('failed', 0, 'x'), outcome('failed', 0, 'y')]).status, 'failed');
  });

  test('las omisiones no cuentan como fallo', () => {
    const r = summarize([outcome('ok', 1), outcome('skipped')]);
    assert.equal(r.status, 'ok');
    assert.equal(r.skipped, 1);
  });

  test('acumula las filas ingeridas', () => {
    assert.equal(summarize([outcome('ok', 10), outcome('ok', 7)]).rows, 17);
  });

  test('cada fallo identifica su tarea y símbolo, para poder reintentarla', () => {
    const r = summarize([{
      task: task('sec_filings', 'MU'), status: 'failed', rows: 0, error: 'timeout',
    }]);
    assert.equal(r.failures[0].kind, 'sec_filings');
    assert.equal(r.failures[0].symbol, 'MU');
  });
});
