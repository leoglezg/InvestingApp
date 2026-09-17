/**
 * Planificador de ingesta.
 *
 * El universo de símbolos NO está en el código: sale de la tabla `symbols`.
 * Añadir un ticker con `portfolio track` lo incluye en la siguiente ejecución;
 * `untrack` lo excluye. Este módulo sólo decide QUÉ tarea corresponde a cada
 * símbolo según sus capacidades, y esa decisión es lógica pura y testeable.
 *
 * Las tareas que no dependen de símbolos (macro, noticias generales) se
 * planifican siempre: el régimen macro es contexto de todo el análisis, exista
 * o no una cartera.
 */

import type { SymbolInfo } from '../portfolio/positions.ts';

export type TaskKind =
  | 'sec_filings'      // eventos corporativos — sólo con CIK
  | 'prices'           // OHLCV de cierre
  | 'quote'            // precio en vivo
  | 'earnings_consensus' // eps_trend, para el archivo as-of (ADR 004)
  | 'macro_vintage'    // FRED — independiente de símbolos
  | 'general_news';    // GDELT — independiente de símbolos

export interface IngestTask {
  kind: TaskKind;
  /** null en las tareas que no son por símbolo. */
  symbol: string | null;
  cik?: string | null;
  /** Orden de ejecución: menor primero. */
  priority: number;
  reason: string;
}

export interface PlanOptions {
  /** Instante de referencia del plan. */
  now: Date;
  /** Incluir la captura de precio en vivo. */
  includeQuotes?: boolean;
  /** Métricas macro a refrescar. Vacío = ninguna. */
  macroMetrics?: readonly string[];
  /** Consultas de noticias generales. */
  newsQueries?: readonly string[];
}

export interface IngestPlan {
  tasks: IngestTask[];
  /** Símbolos considerados, tras filtrar los no seguidos. */
  trackedSymbols: string[];
  /** Símbolos excluidos de SEC por no tener CIK, con su motivo. */
  skippedSec: { symbol: string; reason: string }[];
  createdAt: Date;
}

/**
 * Construye el plan a partir de los símbolos registrados.
 *
 * No recibe ninguna lista fija: lo que entra es lo que haya en la base.
 */
export function planDailyIngest(
  symbols: readonly SymbolInfo[],
  opts: PlanOptions
): IngestPlan {
  const tracked = symbols.filter(s => s.isTracked);
  const tasks: IngestTask[] = [];
  const skippedSec: { symbol: string; reason: string }[] = [];

  // 1. Macro primero: el régimen es el contexto contra el que se interpreta
  //    todo lo demás, así que conviene tenerlo antes que los eventos.
  for (const metric of opts.macroMetrics ?? []) {
    tasks.push({
      kind: 'macro_vintage', symbol: null, priority: 10,
      reason: `régimen macro: ${metric}`,
    });
  }

  // 2. Eventos corporativos, sólo para quien presenta filings.
  for (const s of tracked) {
    if (s.cik) {
      tasks.push({
        kind: 'sec_filings', symbol: s.symbol, cik: s.cik, priority: 20,
        reason: `filings de ${s.symbol}`,
      });
    } else {
      // No es un fallo: los ETF no son emisores. Se registra para que la
      // cobertura parcial sea visible en vez de pasar por "sin eventos".
      skippedSec.push({
        symbol: s.symbol,
        reason: `${s.assetType} sin CIK: no presenta filings propios`,
      });
    }
  }

  // 3. Precios: para todos, sin excepción.
  for (const s of tracked) {
    tasks.push({
      kind: 'prices', symbol: s.symbol, priority: 30,
      reason: `cierres de ${s.symbol}`,
    });
  }

  // 4. Consenso: sólo acciones. Un ETF no tiene estimación de beneficios.
  for (const s of tracked) {
    if (s.assetType === 'stock') {
      tasks.push({
        kind: 'earnings_consensus', symbol: s.symbol, priority: 40,
        reason: `consenso de ${s.symbol} — archivo as-of (ADR 004)`,
      });
    }
  }

  // 5. Noticias generales.
  for (const q of opts.newsQueries ?? []) {
    tasks.push({
      kind: 'general_news', symbol: null, priority: 50,
      reason: `noticias: «${q}»`,
    });
  }

  // 6. Quotes al final: es lo más volátil y lo menos crítico si falla.
  if (opts.includeQuotes) {
    for (const s of tracked) {
      tasks.push({
        kind: 'quote', symbol: s.symbol, priority: 60,
        reason: `precio en vivo de ${s.symbol}`,
      });
    }
  }

  tasks.sort((a, b) => a.priority - b.priority || (a.symbol ?? '').localeCompare(b.symbol ?? ''));

  return {
    tasks,
    trackedSymbols: tracked.map(s => s.symbol),
    skippedSec,
    createdAt: opts.now,
  };
}

/**
 * Ventana a ingerir.
 *
 * Si la última ejecución con éxito fue hace más de un día, la ventana se
 * extiende hacia atrás para recuperar el hueco (OP-2). Un fallo del martes no
 * debe dejar un agujero permanente: el miércoles recupera ambos días.
 */
export function computeWindow(
  lastSuccessfulEnd: Date | null,
  now: Date,
  maxLookbackDays = 30
): { start: Date; end: Date; recoveringGap: boolean; gapDays: number } {
  const end = now;
  const oneDay = 24 * 60 * 60 * 1000;

  if (!lastSuccessfulEnd) {
    return { start: new Date(now.getTime() - oneDay), end, recoveringGap: false, gapDays: 0 };
  }

  const gapMs = now.getTime() - lastSuccessfulEnd.getTime();
  const gapDays = Math.floor(gapMs / oneDay);
  const cappedStart = new Date(Math.max(
    lastSuccessfulEnd.getTime(),
    now.getTime() - maxLookbackDays * oneDay
  ));

  return { start: cappedStart, end, recoveringGap: gapDays >= 1, gapDays };
}

export interface TaskOutcome {
  task: IngestTask;
  status: 'ok' | 'failed' | 'skipped';
  rows: number;
  error?: string;
}

export interface RunSummary {
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  rows: number;
  /** 'ok' sólo si no falló ninguna: un fallo parcial NO es un éxito. */
  status: 'ok' | 'partial' | 'failed';
  failures: { kind: TaskKind; symbol: string | null; error: string }[];
}

/**
 * Resume una ejecución.
 *
 * Un fallo parcial se marca como 'partial', nunca como 'ok'. Si se redondeara
 * a éxito, el hueco quedaría invisible y la siguiente ejecución no intentaría
 * recuperarlo — que es exactamente cómo se pierde un día para siempre.
 */
export function summarize(outcomes: readonly TaskOutcome[]): RunSummary {
  let ok = 0, failed = 0, skipped = 0, rows = 0;
  const failures: RunSummary['failures'] = [];

  for (const o of outcomes) {
    rows += o.rows;
    if (o.status === 'ok') ok++;
    else if (o.status === 'skipped') skipped++;
    else {
      failed++;
      failures.push({ kind: o.task.kind, symbol: o.task.symbol, error: o.error ?? 'desconocido' });
    }
  }

  const status: RunSummary['status'] =
    failed === 0 ? 'ok' : ok === 0 ? 'failed' : 'partial';

  return { total: outcomes.length, ok, failed, skipped, rows, status, failures };
}
