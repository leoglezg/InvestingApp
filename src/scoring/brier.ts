/**
 * Brier multiclase y calibración — spec §4.
 *
 * Esta es la capa 10 (validación), inexistente en el código auditado: había
 * una tabla `learning_feedback` que ningún módulo escribía ni leía. Sin esto
 * el sistema no aprende nada, que era el objetivo declarado del producto.
 *
 * RELACIÓN CON LA LEY 3 — importante:
 * Estas funciones evalúan una distribución sobre las tres clases. Mientras no
 * haya validación, lo que el sistema produce NO son probabilidades sino
 * frecuencias históricas. Evaluarlas con Brier no las convierte en
 * probabilidades: es precisamente el procedimiento que decide si merecen
 * llamarse así. El resultado de esta capa es lo que habilita —o no—
 * `calibrated_probability` en FASE 3.
 */

import type { ScenarioClass, ScenarioDistribution } from './scenarios.ts';
import { SCENARIO_CLASSES, toOneHot } from './scenarios.ts';

/**
 * Brier de un predictor uniforme (1/3, 1/3, 1/3): el baseline a batir.
 *
 *   (1/3 - 1)² + (1/3 - 0)² + (1/3 - 0)² = 4/9 + 1/9 + 1/9 = 2/3
 *
 * Un Brier de 0.4 no significa nada por sí solo. Sólo significa algo frente a
 * este 0.667. Por eso NUNCA se reporta sin él.
 */
export const BRIER_BASELINE_UNIFORM = 2 / 3;

const SUM_TOLERANCE = 1e-6;

export class InvalidDistributionError extends Error {
  constructor(sum: number) {
    super(
      `Una distribución sobre las 3 clases debe sumar 1, suma ${sum}. ` +
      `El código auditado emitía "probabilidades" que sumaban 0.8 o 0.85, ` +
      `lo que las descalificaba incluso como distribución.`
    );
    this.name = 'InvalidDistributionError';
  }
}

export function assertValidDistribution(d: ScenarioDistribution): void {
  let sum = 0;
  for (const c of SCENARIO_CLASSES) {
    const p = d[c];
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new InvalidDistributionError(Number.NaN);
    }
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) throw new InvalidDistributionError(sum);
}

/**
 * Brier multiclase de una sola predicción: Σ (p_i - o_i)² sobre las 3 clases.
 *
 * Rango [0, 2]. 0 = perfecto. 2 = certeza absoluta en la clase equivocada.
 */
export function brierScore(
  predicted: ScenarioDistribution,
  observed: ScenarioClass
): number {
  assertValidDistribution(predicted);
  const o = toOneHot(observed);

  let total = 0;
  for (const c of SCENARIO_CLASSES) {
    const diff = predicted[c] - o[c];
    total += diff * diff;
  }
  return total;
}

export interface Prediction {
  predicted: ScenarioDistribution;
  observed: ScenarioClass;
  /** Para el desglose exigido por §4: un modelo puede estar calibrado en
   *  agregado y roto en un régimen concreto. */
  eventType?: string;
  regimeLabel?: string;
}

export interface BrierEvaluation {
  brier: number;
  baseline: number;
  /** 1 - brier/baseline. Positivo = mejor que el predictor uniforme. */
  skillScore: number;
  n: number;
  /** IC al 95% de la media. Con n pequeño será ancho, y eso debe verse. */
  ci95: { lower: number; upper: number };
  /** false si el IC cruza el baseline: no hay evidencia de batirlo. */
  beatsBaseline: boolean;
}

/**
 * Evalúa un conjunto de predicciones.
 *
 * Reporta SIEMPRE el baseline y n junto al Brier, porque un Brier suelto es
 * un número que no se puede defender.
 */
export function evaluateBrier(predictions: readonly Prediction[]): BrierEvaluation {
  const n = predictions.length;
  if (n === 0) {
    throw new Error('No se puede evaluar calibración sin predicciones.');
  }

  const scores = predictions.map(p => brierScore(p.predicted, p.observed));
  const mean = scores.reduce((a, b) => a + b, 0) / n;

  // Desviación típica muestral (n-1). Con n = 1 no hay dispersión estimable.
  const variance = n > 1
    ? scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / (n - 1)
    : 0;
  const stderr = n > 1 ? Math.sqrt(variance / n) : Number.POSITIVE_INFINITY;

  const margin = Number.isFinite(stderr) ? 1.96 * stderr : Number.POSITIVE_INFINITY;
  const lower = Number.isFinite(margin) ? mean - margin : Number.NEGATIVE_INFINITY;
  const upper = Number.isFinite(margin) ? mean + margin : Number.POSITIVE_INFINITY;

  return {
    brier: mean,
    baseline: BRIER_BASELINE_UNIFORM,
    skillScore: 1 - mean / BRIER_BASELINE_UNIFORM,
    n,
    ci95: { lower, upper },
    // Sólo se afirma superioridad si el intervalo ENTERO queda por debajo del
    // baseline. Una media mejor con IC solapado no es evidencia de nada.
    beatsBaseline: upper < BRIER_BASELINE_UNIFORM,
  };
}

export interface CalibrationBin {
  binLower: number;
  binUpper: number;
  /** Media de las probabilidades predichas que cayeron en el bin. */
  meanPredicted: number;
  /** Fracción de veces que la clase ocurrió de verdad. */
  observedFrequency: number;
  count: number;
}

/**
 * Curva de calibración por bins de 10 puntos porcentuales (spec §4).
 *
 * Bien calibrado significa: de todas las veces que se dijo "30%", ocurrió
 * aproximadamente el 30% de las veces. Un modelo puede tener buen Brier y
 * estar mal calibrado (por ejemplo, siendo sistemáticamente conservador), así
 * que esta curva no es redundante con el Brier: mide otra cosa.
 */
export function calibrationCurve(
  predictions: readonly Prediction[],
  binWidth = 0.1
): CalibrationBin[] {
  if (binWidth <= 0 || binWidth > 1) {
    throw new RangeError(`binWidth debe estar en (0, 1], recibido ${binWidth}`);
  }

  const nBins = Math.ceil(1 / binWidth);
  const buckets = Array.from({ length: nBins }, () => ({ sumPred: 0, hits: 0, count: 0 }));

  // Cada predicción aporta 3 puntos: uno por clase. Así se evalúa la
  // calibración de todo el vector, no sólo de la clase más probable.
  for (const p of predictions) {
    assertValidDistribution(p.predicted);
    for (const c of SCENARIO_CLASSES) {
      const prob = p.predicted[c];
      const idx = Math.min(nBins - 1, Math.floor(prob / binWidth));
      buckets[idx].sumPred += prob;
      buckets[idx].hits += p.observed === c ? 1 : 0;
      buckets[idx].count += 1;
    }
  }

  return buckets
    .map((b, i) => ({
      binLower: i * binWidth,
      binUpper: Math.min(1, (i + 1) * binWidth),
      meanPredicted: b.count ? b.sumPred / b.count : 0,
      observedFrequency: b.count ? b.hits / b.count : 0,
      count: b.count,
    }))
    .filter(b => b.count > 0);
}

/** Clase con mayor probabilidad. Ante empate devuelve null: no hay predicción. */
export function argmaxClass(d: ScenarioDistribution): ScenarioClass | null {
  let best: ScenarioClass | null = null;
  let bestP = -1;
  let tied = false;

  for (const c of SCENARIO_CLASSES) {
    if (d[c] > bestP) { bestP = d[c]; best = c; tied = false; }
    else if (d[c] === bestP) { tied = true; }
  }
  return tied ? null : best;
}

export interface AccuracyReport {
  /** Acierto sobre las 3 clases, 'neutral' incluido. */
  overall: { correct: number; total: number; accuracy: number };
  /**
   * Acierto de SIGNO, excluyendo los casos en que predicción u observación
   * fueron 'neutral'. Se reporta aparte porque 'neutral' no tiene dirección:
   * mezclarlo inflaría o hundiría la cifra sin que signifique lo mismo.
   */
  directional: { correct: number; total: number; accuracy: number };
}

export function accuracy(predictions: readonly Prediction[]): AccuracyReport {
  let correct = 0, total = 0;
  let dirCorrect = 0, dirTotal = 0;

  for (const p of predictions) {
    const pred = argmaxClass(p.predicted);
    if (pred === null) continue;

    total++;
    if (pred === p.observed) correct++;

    if (pred !== 'neutral' && p.observed !== 'neutral') {
      dirTotal++;
      if (pred === p.observed) dirCorrect++;
    }
  }

  return {
    overall: { correct, total, accuracy: total ? correct / total : 0 },
    directional: { correct: dirCorrect, total: dirTotal, accuracy: dirTotal ? dirCorrect / dirTotal : 0 },
  };
}

/**
 * Desglose por tipo de evento y por régimen (spec §4).
 *
 * "Un modelo puede estar calibrado en agregado y roto en un régimen
 * específico." El agregado puede ocultar que el sistema sólo funciona en
 * mercados tranquilos y falla justo cuando más falta hace.
 */
export function breakdownBy(
  predictions: readonly Prediction[],
  key: 'eventType' | 'regimeLabel'
): Map<string, BrierEvaluation> {
  const groups = new Map<string, Prediction[]>();
  for (const p of predictions) {
    const k = p[key] ?? '(sin clasificar)';
    const list = groups.get(k);
    if (list) list.push(p); else groups.set(k, [p]);
  }

  const out = new Map<string, BrierEvaluation>();
  for (const [k, list] of groups) out.set(k, evaluateBrier(list));
  return out;
}
