/**
 * Clasificación de escenarios — spec §4.
 *
 * Tres clases mutuamente excluyentes y exhaustivas. El código auditado emitía
 * cinco ('bullish', 'bearish', 'consolidation', 'volatile', 'stable'), lo que
 * hacía el Brier multiclase incalculable: 'volatile' no es direccional y por
 * tanto no particiona el espacio de retornos.
 */

export type ScenarioClass = 'bearish' | 'neutral' | 'bullish';

export const SCENARIO_CLASSES: readonly ScenarioClass[] = ['bearish', 'neutral', 'bullish'];

/**
 * Umbral en desviaciones típicas del régimen.
 *
 * DELIBERADAMENTE NO ESTÁ EN CONFIG, y conviene justificarlo porque parece
 * contradecir la LEY 4.
 *
 * La LEY 4 exige que sean configurables los parámetros que son HIPÓTESIS a
 * validar: pesos de similitud, umbrales de matching. Este no lo es: es la
 * DEFINICIÓN de la medida. La spec §4 es explícita en que debe ser
 * "fija, documentada y no ajustable post-hoc".
 *
 * Si se pudiera mover, alguien acabaría ajustándola hasta que el Brier
 * mejorase — que es el antipatrón de overfitting, sólo que disfrazado de
 * configuración. Cambiarla invalida TODO el histórico de validación, porque
 * las clases dejarían de significar lo mismo.
 */
export const SCENARIO_SIGMA_THRESHOLD = 0.5;

export class InvalidSigmaError extends Error {
  constructor(sigma: number) {
    super(
      `σ del régimen debe ser > 0 para clasificar un escenario, recibido ${sigma}. ` +
      `Sin dispersión no hay escala contra la que medir el retorno.`
    );
    this.name = 'InvalidSigmaError';
  }
}

/**
 * Clasifica un retorno realizado contra la volatilidad de su régimen.
 *
 *   bearish : retorno <  -0.5σ
 *   neutral : dentro de ±0.5σ
 *   bullish : retorno >  +0.5σ
 *
 * @param realizedReturn Retorno observado, en la misma unidad que sigma.
 * @param regimeSigma    Volatilidad realizada del activo en el régimen vigente,
 *                       calculada SIEMPRE con datos previos a T (LEY 1).
 *                       Usar datos posteriores a T aquí sería look-ahead, y
 *                       además especialmente insidioso: contaminaría la propia
 *                       vara de medir con la que se juzga al sistema.
 */
export function classifyScenario(realizedReturn: number, regimeSigma: number): ScenarioClass {
  if (!Number.isFinite(regimeSigma) || regimeSigma <= 0) {
    throw new InvalidSigmaError(regimeSigma);
  }
  if (!Number.isFinite(realizedReturn)) {
    throw new TypeError(`realizedReturn debe ser finito, recibido ${realizedReturn}`);
  }

  const band = SCENARIO_SIGMA_THRESHOLD * regimeSigma;

  if (realizedReturn < -band) return 'bearish';
  if (realizedReturn > band) return 'bullish';
  return 'neutral';
}

/** Distribución sobre las tres clases. */
export type ScenarioDistribution = Record<ScenarioClass, number>;

/** Vector one-hot del escenario observado, para evaluar contra él. */
export function toOneHot(observed: ScenarioClass): ScenarioDistribution {
  return {
    bearish: observed === 'bearish' ? 1 : 0,
    neutral: observed === 'neutral' ? 1 : 0,
    bullish: observed === 'bullish' ? 1 : 0,
  };
}

/**
 * Frecuencias observadas a partir de una muestra de comparables históricos.
 *
 * LEY 3: esto es una OBSERVACIÓN DESCRIPTIVA — "de 23 casos, 16 fueron
 * negativos" —, no una afirmación de probabilidad. Sólo puede llamarse
 * probabilidad cuando la validación out-of-sample lo respalde, y el esquema
 * impide guardarla como tal antes de eso.
 */
export function historicalFrequencies(sample: readonly ScenarioClass[]): {
  frequencies: ScenarioDistribution;
  sampleSize: number;
} {
  const counts: ScenarioDistribution = { bearish: 0, neutral: 0, bullish: 0 };
  for (const s of sample) counts[s]++;

  const n = sample.length;
  if (n === 0) {
    return { frequencies: { bearish: 0, neutral: 0, bullish: 0 }, sampleSize: 0 };
  }

  return {
    frequencies: {
      bearish: counts.bearish / n,
      neutral: counts.neutral / n,
      bullish: counts.bullish / n,
    },
    sampleSize: n,
  };
}
