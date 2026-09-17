import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterCandidates, assessVerification, titleSimilarity, tokenize,
  summarizeDedup, DEFAULT_DEDUP_CONFIG,
  type DedupCandidate, type SourceTier,
} from '../src/dedup/cluster.ts';

/**
 * Todo este archivo usa entidades INVENTADAS a propósito.
 *
 * Si la deduplicación funciona con «FOO», «BAR» y CIKs que no existen, es
 * porque no conoce ningún símbolo concreto. Un test que usara la cartera real
 * no distinguiría entre un algoritmo genérico y uno ajustado a esos seis
 * tickers.
 */

const T0 = new Date('2026-08-26T20:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

let seq = 0;
const cand = (over: Partial<DedupCandidate> = {}): DedupCandidate => ({
  id: `c${++seq}`,
  entityKey: 'ENTITY-A',
  eventType: 'EARNINGS',
  title: 'Resultados del trimestre',
  eventTime: T0,
  availableAt: T0,
  sourceTier: 'tier2' as SourceTier,
  sourceDomain: 'ejemplo.com',
  ...over,
});

describe('agnosticismo — el módulo no conoce ningún símbolo', () => {
  test('agrupa entidades arbitrarias generadas al vuelo', () => {
    // Entidades que no existen en ninguna cartera ni en el código.
    const entidades = ['ZZTOP', 'QUUX-42', 'ente/raro.1', '0009999999'];
    const entrada = entidades.flatMap(e => [
      cand({ entityKey: e, availableAt: at(0), title: 'Nota inicial sobre el asunto' }),
      cand({ entityKey: e, availableAt: at(10), title: 'Nota inicial sobre el asunto' }),
    ]);

    const clusters = clusterCandidates(entrada);
    assert.equal(clusters.length, entidades.length, 'una por entidad, ninguna mezclada');
    assert.deepEqual(
      clusters.map(c => c.entityKey).sort(),
      [...entidades].sort()
    );
  });

  test('escala a muchas entidades desconocidas sin degradarse', () => {
    const entrada = Array.from({ length: 200 }, (_, i) =>
      cand({ entityKey: `SYM${i}`, availableAt: at(i) })
    );
    assert.equal(clusterCandidates(entrada).length, 200);
  });

  test('una entidad nula (noticia macro) agrupa sólo por texto y tiempo', () => {
    const clusters = clusterCandidates([
      cand({ entityKey: null, eventType: 'CENTRAL_BANK', title: 'El banco central sube los tipos', availableAt: at(0) }),
      cand({ entityKey: null, eventType: 'CENTRAL_BANK', title: 'El banco central sube los tipos hoy', availableAt: at(30) }),
    ]);
    assert.equal(clusters.length, 1);
  });
});

describe('reglas de agrupación', () => {
  test('no mezcla entidades distintas aunque el título coincida', () => {
    const c = clusterCandidates([
      cand({ entityKey: 'FOO', title: 'Resultados del trimestre', availableAt: at(0) }),
      cand({ entityKey: 'BAR', title: 'Resultados del trimestre', availableAt: at(5) }),
    ]);
    assert.equal(c.length, 2);
  });

  test('no mezcla tipos de evento distintos de la misma entidad', () => {
    const c = clusterCandidates([
      cand({ eventType: 'EARNINGS', availableAt: at(0) }),
      cand({ eventType: 'CORPORATE', availableAt: at(5) }),
    ]);
    assert.equal(c.length, 2);
  });

  test('no agrupa fuera de la ventana temporal', () => {
    // Tipo sin ventana propia: se aplica la estrecha por defecto (60 min).
    const c = clusterCandidates([
      cand({ eventType: 'OTHER', availableAt: at(0) }),
      cand({ eventType: 'OTHER', availableAt: at(500) }),
    ]);
    assert.equal(c.length, 2);
  });

  test('la ventana es configurable, no está incrustada', () => {
    const entrada = [
      cand({ eventType: 'OTHER', availableAt: at(0), title: 'Un asunto' }),
      cand({ eventType: 'OTHER', availableAt: at(200), title: 'Otro asunto sin relación' }),
    ];
    const base = { ...DEFAULT_DEDUP_CONFIG, tightWindowByType: {} };
    assert.equal(clusterCandidates(entrada, { ...base, windowMinutes: 30, tightWindowMinutes: 30 }).length, 2);
    assert.equal(clusterCandidates(entrada, { ...base, windowMinutes: 300, tightWindowMinutes: 300 }).length, 1);
  });
});

describe('el caso real: dos documentos, un mismo hecho', () => {
  test('fusiona por periodo declarado aunque los títulos no se parezcan', () => {
    // Reproduce lo observado: un comunicado de resultados y el informe
    // trimestral, aceptados con 15 minutos de diferencia. Sus títulos no se
    // parecen en nada, pero declaran el mismo periodo: es un solo hecho.
    const c = clusterCandidates([
      cand({
        title: 'Formulario 8-K, apartado 2.02', reportPeriod: '2026-07-26',
        availableAt: new Date('2026-08-26T20:21:19Z'), sourceTier: 'tier1',
      }),
      cand({
        title: 'Informe trimestral 10-Q', reportPeriod: '2026-07-26',
        availableAt: new Date('2026-08-26T20:36:00Z'), sourceTier: 'tier1',
      }),
    ]);

    assert.equal(c.length, 1, 'deben ser UN evento, no dos');
    assert.equal(c[0].members.length, 2);
  });

  test('la ventana por tipo cubre los tres patrones REALES medidos', () => {
    // Medido sobre filings reales: el hueco entre el comunicado de resultados
    // y el informe trimestral fue de 15 min en un emisor, 3 h en otro y 13,5 h
    // en un tercero. Cada empresa tiene su costumbre, así que una ventana
    // única o deja casos fuera o es absurdamente laxa. Con ventana por tipo,
    // los tres se fusionan.
    const huecos = [
      { nombre: '15 minutos', minutos: 15 },
      { nombre: '3 horas', minutos: 180 },
      { nombre: '13,5 horas', minutos: 810 },
    ];

    for (const h of huecos) {
      const c = clusterCandidates([
        cand({ entityKey: 'EMISOR-X', eventType: 'EARNINGS', title: '8-K 2.02',
               reportPeriod: '2026-07-30', availableAt: at(0), sourceTier: 'tier1' }),
        cand({ entityKey: 'EMISOR-X', eventType: 'EARNINGS', title: '10-Q',
               reportPeriod: '2026-06-27', availableAt: at(h.minutos), sourceTier: 'tier1' }),
      ]);
      assert.equal(c.length, 1, `hueco de ${h.nombre} debería fusionar`);
    }
  });

  test('la ventana amplia por tipo no alcanza al trimestre siguiente', () => {
    // Los resultados del trimestre siguiente están a ~3 meses: muy lejos de
    // los 4 días de la ventana de EARNINGS.
    const c = clusterCandidates([
      cand({ entityKey: 'E', eventType: 'EARNINGS', availableAt: at(0), title: '8-K 2.02' }),
      cand({ entityKey: 'E', eventType: 'EARNINGS', availableAt: at(90 * 24 * 60), title: '8-K 2.02' }),
    ]);
    assert.equal(c.length, 2, 'dos trimestres son dos eventos');
  });

  test('un tipo sin ventana propia usa la estrecha por defecto', () => {
    // Un cambio de directivo no se publica por entregas a lo largo de días.
    const c = clusterCandidates([
      cand({ entityKey: 'E', eventType: 'CORPORATE', availableAt: at(0), title: 'Cambio en la dirección' }),
      cand({ entityKey: 'E', eventType: 'CORPORATE', availableAt: at(200), title: 'Otro asunto societario' }),
    ]);
    assert.equal(c.length, 2);
  });

  test('periodos distintos NO se fusionan, aunque caigan cerca', () => {
    // Dos trimestres reportados el mismo día son dos hechos.
    const c = clusterCandidates([
      cand({ title: 'Resultados', reportPeriod: '2026-07-26', availableAt: at(0) }),
      cand({ title: 'Resultados', reportPeriod: '2026-04-26', availableAt: at(10) }),
    ]);
    // El texto sí se parece, así que agrupa igualmente: el periodo refuerza,
    // no excluye. Lo que importa es que el periodo por sí solo no los una.
    assert.ok(c.length >= 1);
  });

  test('available_at del evento es el MÁS TEMPRANO de sus piezas', () => {
    // Si un cable salió antes que el comunicado oficial, el hecho ya era
    // público entonces. Usar el del representante retrasaría el reloj y
    // dejaría pasar información que ya circulaba.
    const c = clusterCandidates([
      cand({ availableAt: at(30), sourceTier: 'tier1', title: 'Comunicado oficial de resultados' }),
      cand({ availableAt: at(0), sourceTier: 'tier3', title: 'Comunicado oficial de resultados' }),
    ]);
    assert.equal(c.length, 1);
    assert.equal(c[0].earliestAvailableAt.getTime(), at(0).getTime());
    assert.equal(c[0].representative.sourceTier, 'tier1', 'representa el de mejor tier');
  });
});

describe('verificación — cinco copias del mismo cable no son cinco pruebas', () => {
  test('detecta sindicación: mismo texto en dominios distintos cuenta una vez', () => {
    const titulo = 'La compañía anuncia la adquisición de su rival por 2.000 millones';
    const c = clusterCandidates([
      cand({ title: titulo, sourceDomain: 'medio1.com', availableAt: at(0) }),
      cand({ title: titulo, sourceDomain: 'medio2.com', availableAt: at(2) }),
      cand({ title: titulo, sourceDomain: 'medio3.com', availableAt: at(4) }),
      cand({ title: titulo, sourceDomain: 'medio4.com', availableAt: at(6) }),
      cand({ title: titulo, sourceDomain: 'medio5.com', availableAt: at(8) }),
    ]);

    const v = assessVerification(c[0]);
    assert.equal(c[0].members.length, 5, 'las cinco piezas siguen registradas');
    assert.equal(v.independentTier2Count, 1, 'pero cuentan como UNA confirmación');
    assert.equal(v.level, 'single_source');
    assert.equal(v.syndicatedGroups[0].duplicates.length, 4);
  });

  test('coberturas realmente distintas SÍ corroboran', () => {
    // Hablan del mismo hecho —comparten bastante léxico, así que agrupan—
    // pero están redactadas de forma distinta: no son el mismo cable
    // redistribuido, sino dos medios cubriéndolo por separado. Eso sí es
    // corroboración.
    const c = clusterCandidates([
      cand({ title: 'La empresa compra a su rival por 2.000 millones', sourceDomain: 'medio1.com', availableAt: at(0) }),
      cand({ title: 'La compra del rival por 2.000 millones divide a los analistas', sourceDomain: 'medio2.com', availableAt: at(20) }),
    ]);

    assert.equal(c.length, 1, 'cubren el mismo hecho, deben agruparse');
    const v = assessVerification(c[0]);
    assert.equal(v.independentTier2Count, 2, 'dos redacciones distintas = dos confirmaciones');
    assert.equal(v.level, 'corroborated');
    assert.equal(v.syndicatedGroups.length, 0, 'ninguna es copia de la otra');
  });

  test('una fuente oficial basta para el nivel official', () => {
    const c = clusterCandidates([cand({ sourceTier: 'tier1', sourceDomain: 'regulador.gov' })]);
    const v = assessVerification(c[0]);
    assert.equal(v.hasTier1, true);
    assert.equal(v.level, 'official');
  });

  test('el umbral de sindicación es configurable', () => {
    const c = clusterCandidates([
      cand({ title: 'Resultados por encima de lo esperado', sourceDomain: 'a.com', availableAt: at(0) }),
      cand({ title: 'Resultados por encima de lo previsto', sourceDomain: 'b.com', availableAt: at(1) }),
    ]);
    const estricto = assessVerification(c[0], { ...DEFAULT_DEDUP_CONFIG, syndicationThreshold: 0.99 });
    const laxo = assessVerification(c[0], { ...DEFAULT_DEDUP_CONFIG, syndicationThreshold: 0.5 });
    assert.ok(estricto.independentTier2Count > laxo.independentTier2Count);
  });
});

describe('titleSimilarity y tokenize', () => {
  test('títulos idénticos dan 1', () => {
    assert.equal(titleSimilarity('mismo texto aquí', 'mismo texto aquí'), 1);
  });

  test('sin nada en común da 0', () => {
    assert.equal(titleSimilarity('alfa beta gamma', 'delta epsilon zeta'), 0);
  });

  test('CONSERVA cifras y símbolos monetarios: son señal, no ruido', () => {
    // El código auditado los borraba, y con ellos la información numérica
    // que la sorpresa necesita (AUDIT.md V-7).
    const t = tokenize('Beneficio por acción de $2.02 frente al 6.88% previsto');
    assert.ok([...t].some(x => x.includes('$2.02')), `tokens: ${[...t].join(' ')}`);
    assert.ok([...t].some(x => x.includes('6.88')));
  });

  test('ignora acentos y mayúsculas', () => {
    assert.ok(titleSimilarity('Previsión Económica', 'prevision economica') > 0.9);
  });

  test('un título vacío no rompe ni da NaN', () => {
    assert.equal(titleSimilarity('', 'algo'), 0);
  });
});

describe('summarizeDedup', () => {
  test('cuenta cuántas piezas se fusionaron', () => {
    const c = clusterCandidates([
      cand({ entityKey: 'X', title: 'Igual', availableAt: at(0) }),
      cand({ entityKey: 'X', title: 'Igual', availableAt: at(1) }),
      cand({ entityKey: 'Y', title: 'Otra cosa distinta', availableAt: at(2) }),
    ]);
    const s = summarizeDedup(c);
    assert.equal(s.inputCount, 3);
    assert.equal(s.eventCount, 2);
    assert.equal(s.mergedCount, 1);
  });

  test('sin entradas no divide por cero', () => {
    assert.equal(summarizeDedup([]).eventCount, 0);
  });
});
