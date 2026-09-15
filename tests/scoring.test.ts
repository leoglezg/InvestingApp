import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScenario,
  historicalFrequencies,
  toOneHot,
  InvalidSigmaError,
  SCENARIO_SIGMA_THRESHOLD,
  type ScenarioClass,
} from '../src/scoring/scenarios.ts';
import {
  brierScore,
  evaluateBrier,
  calibrationCurve,
  accuracy,
  argmaxClass,
  breakdownBy,
  assertValidDistribution,
  InvalidDistributionError,
  BRIER_BASELINE_UNIFORM,
} from '../src/scoring/brier.ts';

const cerca = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `esperado ≈${b}, recibido ${a}`);

describe('classifyScenario — definición fija de spec §4', () => {
  const sigma = 2.0; // banda = ±1.0

  test('bearish por debajo de -0.5σ', () => {
    assert.equal(classifyScenario(-1.5, sigma), 'bearish');
  });

  test('bullish por encima de +0.5σ', () => {
    assert.equal(classifyScenario(1.5, sigma), 'bullish');
  });

  test('neutral dentro de la banda', () => {
    assert.equal(classifyScenario(0, sigma), 'neutral');
    assert.equal(classifyScenario(0.9, sigma), 'neutral');
    assert.equal(classifyScenario(-0.9, sigma), 'neutral');
  });

  test('los límites exactos son neutral (la banda es cerrada)', () => {
    // Importa fijarlo: si el límite fuera abierto, el mismo retorno podría
    // clasificarse distinto según errores de redondeo.
    assert.equal(classifyScenario(1.0, sigma), 'neutral');
    assert.equal(classifyScenario(-1.0, sigma), 'neutral');
  });

  test('las tres clases son exhaustivas y excluyentes', () => {
    const vistas = new Set<ScenarioClass>();
    for (let r = -5; r <= 5; r += 0.1) vistas.add(classifyScenario(r, sigma));
    assert.deepEqual([...vistas].sort(), ['bearish', 'bullish', 'neutral']);
  });

  test('escala con σ: el mismo retorno cambia de clase según el régimen', () => {
    // El núcleo del diseño: -1.5% es grave en calma y ruido en pánico.
    assert.equal(classifyScenario(-1.5, 1.0), 'bearish');
    assert.equal(classifyScenario(-1.5, 10.0), 'neutral');
  });

  test('σ inválida lanza en vez de devolver un valor plausible', () => {
    assert.throws(() => classifyScenario(1, 0), InvalidSigmaError);
    assert.throws(() => classifyScenario(1, -1), InvalidSigmaError);
    assert.throws(() => classifyScenario(1, Number.NaN), InvalidSigmaError);
  });

  test('el umbral es 0.5σ, como fija la spec', () => {
    assert.equal(SCENARIO_SIGMA_THRESHOLD, 0.5);
  });
});

describe('brierScore — el ejemplo exacto de la spec §4', () => {
  test('reproduce el cálculo publicado: 0.1586', () => {
    // predicho {bearish:0.68, neutral:0.21, bullish:0.11}, observado bearish
    //   (0.68-1)² + (0.21-0)² + (0.11-0)²
    // = 0.1024 + 0.0441 + 0.0121 = 0.1586
    const b = brierScore({ bearish: 0.68, neutral: 0.21, bullish: 0.11 }, 'bearish');
    cerca(b, 0.1586, 1e-9);
  });

  test('predicción perfecta = 0', () => {
    cerca(brierScore({ bearish: 1, neutral: 0, bullish: 0 }, 'bearish'), 0);
  });

  test('certeza en la clase equivocada = 2 (el peor caso posible)', () => {
    cerca(brierScore({ bearish: 0, neutral: 0, bullish: 1 }, 'bearish'), 2);
  });

  test('el predictor uniforme da exactamente el baseline de la spec', () => {
    const t = 1 / 3;
    cerca(brierScore({ bearish: t, neutral: t, bullish: t }, 'bearish'), BRIER_BASELINE_UNIFORM);
    cerca(BRIER_BASELINE_UNIFORM, 0.6666666666666666, 1e-12);
  });
});

describe('assertValidDistribution', () => {
  test('rechaza distribuciones que no suman 1', () => {
    // El código auditado emitía 0.5 + 0.3 = 0.8, y 0.5 + 0.35 = 0.85.
    assert.throws(
      () => assertValidDistribution({ bearish: 0.5, neutral: 0.3, bullish: 0 }),
      InvalidDistributionError
    );
  });

  test('rechaza probabilidades fuera de [0,1]', () => {
    assert.throws(
      () => assertValidDistribution({ bearish: 1.5, neutral: -0.5, bullish: 0 }),
      InvalidDistributionError
    );
  });

  test('acepta una distribución válida', () => {
    assert.doesNotThrow(() => assertValidDistribution({ bearish: 0.68, neutral: 0.21, bullish: 0.11 }));
  });
});

describe('evaluateBrier — nunca un número suelto', () => {
  const perfectas = Array.from({ length: 40 }, () => ({
    predicted: { bearish: 1, neutral: 0, bullish: 0 },
    observed: 'bearish' as ScenarioClass,
  }));

  test('reporta siempre baseline y n junto al Brier', () => {
    const r = evaluateBrier(perfectas);
    assert.equal(r.baseline, BRIER_BASELINE_UNIFORM);
    assert.equal(r.n, 40);
  });

  test('skillScore = 1 con predicción perfecta', () => {
    cerca(evaluateBrier(perfectas).skillScore, 1);
  });

  test('skillScore = 0 con el predictor uniforme', () => {
    const t = 1 / 3;
    const uniformes = Array.from({ length: 40 }, () => ({
      predicted: { bearish: t, neutral: t, bullish: t },
      observed: 'bullish' as ScenarioClass,
    }));
    cerca(evaluateBrier(uniformes).skillScore, 0, 1e-12);
  });

  test('con n=1 el intervalo es infinito: una muestra no demuestra nada', () => {
    const r = evaluateBrier([{
      predicted: { bearish: 1, neutral: 0, bullish: 0 },
      observed: 'bearish',
    }]);
    assert.equal(r.n, 1);
    assert.equal(r.beatsBaseline, false, 'con n=1 no puede afirmarse superioridad');
  });

  test('no afirma superioridad si el IC solapa el baseline', () => {
    // Mitad aciertos, mitad fallos: media mejor que el baseline pero con
    // dispersión enorme. La media sola engañaría; el IC lo impide.
    const mezcla = Array.from({ length: 10 }, (_, i) => ({
      predicted: { bearish: 1, neutral: 0, bullish: 0 },
      observed: (i % 2 === 0 ? 'bearish' : 'bullish') as ScenarioClass,
    }));
    const r = evaluateBrier(mezcla);
    assert.ok(r.ci95.upper > r.baseline, 'el IC debe solapar el baseline');
    assert.equal(r.beatsBaseline, false);
  });

  test('sí afirma superioridad cuando la evidencia es clara', () => {
    assert.equal(evaluateBrier(perfectas).beatsBaseline, true);
  });

  test('lanza sin predicciones en vez de devolver 0', () => {
    assert.throws(() => evaluateBrier([]), /sin predicciones/);
  });
});

describe('calibrationCurve', () => {
  test('un predictor bien calibrado se alinea con la frecuencia observada', () => {
    // Se dice 'bearish' con 0.7 en 100 casos; ocurre 70 veces.
    const preds = Array.from({ length: 100 }, (_, i) => ({
      predicted: { bearish: 0.7, neutral: 0.2, bullish: 0.1 },
      observed: (i < 70 ? 'bearish' : 'neutral') as ScenarioClass,
    }));

    const bin70 = calibrationCurve(preds).find(b => b.binLower <= 0.7 && 0.7 < b.binUpper);
    assert.ok(bin70, 'debe existir el bin del 0.7');
    cerca(bin70.meanPredicted, 0.7, 1e-9);
    cerca(bin70.observedFrequency, 0.7, 1e-9);
  });

  test('detecta exceso de confianza', () => {
    // Se afirma 0.9 pero sólo acierta el 30%.
    const preds = Array.from({ length: 100 }, (_, i) => ({
      predicted: { bearish: 0.9, neutral: 0.1, bullish: 0.0 },
      observed: (i < 30 ? 'bearish' : 'neutral') as ScenarioClass,
    }));
    const bin = calibrationCurve(preds).find(b => b.binLower <= 0.9 && 0.9 < b.binUpper)!;
    assert.ok(bin.observedFrequency < bin.meanPredicted - 0.3, 'debe revelar el exceso');
  });

  test('omite los bins vacíos', () => {
    assert.ok(calibrationCurve([{
      predicted: { bearish: 1, neutral: 0, bullish: 0 },
      observed: 'bearish',
    }]).every(b => b.count > 0));
  });

  test('rechaza un ancho de bin inválido', () => {
    assert.throws(() => calibrationCurve([], 0), RangeError);
    assert.throws(() => calibrationCurve([], 1.5), RangeError);
  });
});

describe('accuracy — direccional separado del total', () => {
  const preds = [
    { predicted: { bearish: 0.8, neutral: 0.1, bullish: 0.1 }, observed: 'bearish' as ScenarioClass },
    { predicted: { bearish: 0.8, neutral: 0.1, bullish: 0.1 }, observed: 'bullish' as ScenarioClass },
    { predicted: { bearish: 0.1, neutral: 0.8, bullish: 0.1 }, observed: 'neutral' as ScenarioClass },
    { predicted: { bearish: 0.1, neutral: 0.1, bullish: 0.8 }, observed: 'bullish' as ScenarioClass },
  ];

  test('el total cuenta las tres clases', () => {
    const r = accuracy(preds);
    assert.equal(r.overall.correct, 3);
    assert.equal(r.overall.total, 4);
  });

  test('el direccional excluye neutral, que no tiene signo', () => {
    const r = accuracy(preds);
    assert.equal(r.directional.total, 3, 'el caso neutral/neutral no entra');
    assert.equal(r.directional.correct, 2);
  });

  test('un empate no cuenta como predicción', () => {
    const t = 1 / 3;
    assert.equal(argmaxClass({ bearish: t, neutral: t, bullish: t }), null);
    assert.equal(accuracy([{ predicted: { bearish: t, neutral: t, bullish: t }, observed: 'bearish' }]).overall.total, 0);
  });
});

describe('breakdownBy — el agregado puede ocultar un régimen roto', () => {
  test('separa un grupo perfecto de uno pésimo que en agregado parecen medios', () => {
    const preds = [
      ...Array.from({ length: 20 }, () => ({
        predicted: { bearish: 1, neutral: 0, bullish: 0 },
        observed: 'bearish' as ScenarioClass, regimeLabel: 'calma',
      })),
      ...Array.from({ length: 20 }, () => ({
        predicted: { bearish: 1, neutral: 0, bullish: 0 },
        observed: 'bullish' as ScenarioClass, regimeLabel: 'panico',
      })),
    ];

    const porRegimen = breakdownBy(preds, 'regimeLabel');
    cerca(porRegimen.get('calma')!.brier, 0);
    cerca(porRegimen.get('panico')!.brier, 2);

    // En agregado da 1.0: peor que el baseline, pero sin indicar DÓNDE falla.
    cerca(evaluateBrier(preds).brier, 1);
  });

  test('agrupa lo no clasificado en vez de descartarlo', () => {
    const r = breakdownBy([{
      predicted: { bearish: 1, neutral: 0, bullish: 0 }, observed: 'bearish',
    }], 'eventType');
    assert.ok(r.has('(sin clasificar)'));
  });
});

describe('historicalFrequencies — LEY 3: observación, no probabilidad', () => {
  test('cuenta el ejemplo de la spec: 16 de 23 negativos', () => {
    const muestra: ScenarioClass[] = [
      ...Array(16).fill('bearish'), ...Array(5).fill('neutral'), ...Array(2).fill('bullish'),
    ];
    const { frequencies, sampleSize } = historicalFrequencies(muestra);
    assert.equal(sampleSize, 23);
    cerca(frequencies.bearish, 16 / 23, 1e-12);
  });

  test('las frecuencias suman 1 y son una distribución válida', () => {
    const { frequencies } = historicalFrequencies(['bearish', 'bullish', 'neutral', 'bearish']);
    assert.doesNotThrow(() => assertValidDistribution(frequencies));
  });

  test('muestra vacía devuelve ceros y tamaño 0, sin inventar nada', () => {
    const { frequencies, sampleSize } = historicalFrequencies([]);
    assert.equal(sampleSize, 0);
    assert.deepEqual(frequencies, { bearish: 0, neutral: 0, bullish: 0 });
  });
});

describe('toOneHot', () => {
  test('marca sólo la clase observada', () => {
    assert.deepEqual(toOneHot('neutral'), { bearish: 0, neutral: 1, bullish: 0 });
  });
});
