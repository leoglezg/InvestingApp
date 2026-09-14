/**
 * LEY 1 — NO LOOK-AHEAD BIAS
 *
 * En el instante de análisis T, el sistema sólo puede usar información que
 * era públicamente conocida en T o antes.
 *
 * Esta es la ÚNICA puerta de acceso a datos históricos. Ningún módulo debe
 * importar `pg` ni construir consultas por su cuenta: el test de arquitectura
 * en tests/architecture.test.ts falla si alguien lo intenta.
 *
 * El código auditado (AUDIT.md V-1) exportaba una función `query()` cruda que
 * seis módulos llamaban directamente, sin una sola cláusula temporal. Su
 * consulta de matching devolvía patrones de 2025 al analizar un evento de
 * 2023, y los ordenaba por un contador que se incrementaba con eventos
 * futuros. Este módulo existe para que eso sea imposible por construcción.
 */

import type { Pool, QueryResultRow } from 'pg';

export class LookAheadViolationError extends Error {
  readonly availableAt: Date;
  readonly analysisTimestamp: Date;

  constructor(availableAt: Date, analysisTimestamp: Date, context?: string) {
    super(
      `LookAheadViolation: dato con available_at=${availableAt.toISOString()} ` +
      `no puede usarse en un análisis en T=${analysisTimestamp.toISOString()}` +
      (context ? ` (${context})` : '')
    );
    this.name = 'LookAheadViolationError';
    this.availableAt = availableAt;
    this.analysisTimestamp = analysisTimestamp;
  }
}

export class MissingClockError extends Error {
  constructor(context: string) {
    super(
      `LEY 6: registro sin available_at en ${context}. ` +
      `Un dato sin reloj no se persiste ni se lee.`
    );
    this.name = 'MissingClockError';
  }
}

export interface Timestamped {
  available_at: Date;
}

/**
 * Contrato mínimo de la spec §1. Lanza excepción — nunca devuelve null.
 *
 * Devolver null ante una violación la volvería indistinguible de "no hay
 * datos", y el sistema seguiría adelante con un hueco silencioso. El fallo
 * tiene que ser ruidoso.
 */
export function assertNoLookAhead(
  dataPoint: { available_at: Date | null | undefined },
  analysisTimestamp: Date,
  context = 'desconocido'
): void {
  if (dataPoint.available_at == null) {
    throw new MissingClockError(context);
  }
  if (dataPoint.available_at > analysisTimestamp) {
    throw new LookAheadViolationError(dataPoint.available_at, analysisTimestamp, context);
  }
}

/**
 * Acceso a datos anclado a un instante T.
 *
 * Toda consulta recibe T como parámetro y DEBE filtrar por él. La validación
 * posterior de cada fila es defensa en profundidad: si alguien escribe una
 * consulta sin la cláusula temporal, el error salta aquí en vez de propagarse
 * como un resultado plausible.
 */
export class AsOfContext {
  readonly t: Date;
  private readonly pool: Pool;

  constructor(pool: Pool, analysisTimestamp: Date) {
    if (!(analysisTimestamp instanceof Date) || Number.isNaN(analysisTimestamp.getTime())) {
      throw new TypeError('AsOfContext requiere un instante de análisis válido');
    }
    this.pool = pool;
    this.t = analysisTimestamp;
  }

  /**
   * Ejecuta una consulta y verifica cada fila devuelta.
   *
   * `$1` queda reservado para T y se inyecta siempre, de modo que la consulta
   * no pueda omitirlo: se escribe `WHERE available_at <= $1` y los parámetros
   * propios empiezan en `$2`.
   */
  async query<R extends QueryResultRow & Partial<Timestamped>>(
    sql: string,
    params: unknown[] = [],
    context = 'query'
  ): Promise<R[]> {
    if (!/\$1\b/.test(sql)) {
      throw new Error(
        `LEY 1: la consulta en '${context}' no usa $1 (el instante T). ` +
        `Toda consulta histórica debe filtrar por available_at <= $1.`
      );
    }

    const result = await this.pool.query<R>(sql, [this.t, ...params]);

    for (const row of result.rows) {
      if ('available_at' in row) {
        assertNoLookAhead(row as Timestamped, this.t, context);
      }
    }
    return result.rows;
  }

  /**
   * Valor macro vigente en T: el último release con available_at <= T.
   *
   * LEY 2: NO el valor revisado que conocemos hoy. El PIB de un trimestre se
   * publica varias veces con cifras distintas; usar la final en un backtest
   * de fecha anterior es look-ahead disfrazado.
   */
  async macroAsOf(metric: string): Promise<MacroValue | null> {
    const rows = await this.query<MacroValue & QueryResultRow>(
      `SELECT metric, reference_period, value, release_type,
              revision_number, available_at, is_proxied
       FROM market.macro_as_of($2, $1)
       LIMIT 1`,
      [metric],
      `macroAsOf(${metric})`
    );
    return rows[0] ?? null;
  }

  /** Deriva un contexto anclado a un instante anterior. Nunca posterior. */
  rewindTo(earlier: Date): AsOfContext {
    if (earlier > this.t) {
      throw new LookAheadViolationError(earlier, this.t, 'rewindTo sólo admite ir hacia atrás');
    }
    return new AsOfContext(this.pool, earlier);
  }
}

export interface MacroValue {
  metric: string;
  reference_period: Date;
  value: number;
  release_type: 'initial' | 'revision';
  revision_number: number;
  available_at: Date;
  is_proxied: boolean;
}

/** Punto de entrada. Nombrado igual que en la spec. */
export function asOf(pool: Pool, analysisTimestamp: Date): AsOfContext {
  return new AsOfContext(pool, analysisTimestamp);
}
