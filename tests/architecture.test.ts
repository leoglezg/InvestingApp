import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
/** Única frontera autorizada a hablar con la base de datos. */
const CAPA_DE_DATOS = join('src', 'data');

function archivosFuente(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...archivosFuente(full));
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('Arquitectura — LEY 1 no puede depender de la disciplina del programador', () => {
  test('ningún módulo fuera de src/data importa el driver de base de datos', () => {
    // El defecto raíz del código auditado (AUDIT.md V-1) fue exportar una
    // función query() cruda que seis módulos llamaban sin filtro temporal.
    // Que esto sea un test, y no una convención, es lo que impide repetirlo.
    const infractores: string[] = [];

    for (const file of archivosFuente(SRC)) {
      const rel = relative(ROOT, file);
      if (rel.startsWith(CAPA_DE_DATOS)) continue;

      const src = readFileSync(file, 'utf8');
      if (/from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\)/.test(src)) {
        infractores.push(rel);
      }
    }

    assert.deepEqual(
      infractores, [],
      `Estos módulos acceden al driver saltándose asOf(T):\n  ${infractores.join('\n  ')}\n` +
      `Todo acceso a datos históricos debe pasar por src/data/asOf.ts.`
    );
  });

  test('no quedan restos de la capa de recomendaciones, fuera de alcance', () => {
    // spec §5 FUERA DE ALCANCE: optimizar alrededor de señales no validadas
    // amplifica el error en lugar de reducirlo. El código auditado dedicaba
    // 244 líneas a esto (AUDIT.md V-9).
    const prohibidos = /recommendationEngine|generateRecommendations|determineAction|assessRiskLevel/;
    const infractores = archivosFuente(SRC)
      .filter(f => prohibidos.test(readFileSync(f, 'utf8')))
      .map(f => relative(ROOT, f));

    assert.deepEqual(
      infractores, [],
      `Capa fuera de alcance reintroducida en:\n  ${infractores.join('\n  ')}`
    );
  });
});

describe('LEY 4 — los pesos son configuración, no código', () => {
  const cfg = JSON.parse(
    readFileSync(join(ROOT, 'config', 'similarity.weights.json'), 'utf8')
  );

  test('los pesos suman 1', () => {
    const suma = Object.values(cfg.weights as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(suma - 1) < 1e-9, `los pesos suman ${suma}, deberían sumar 1`);
  });

  test('cubre los 7 componentes del contrato SimilarityMatch', () => {
    const esperados = [
      'event_type', 'surprise_alignment', 'sentiment', 'magnitude',
      'asset_overlap', 'macro_distance', 'volatility_regime',
    ].sort();
    assert.deepEqual(Object.keys(cfg.weights).sort(), esperados);
  });

  test('el estado de validación es explícito y honesto', () => {
    assert.ok(['hypothesis', 'preliminary', 'validated'].includes(cfg.validation_status));
    if (cfg.validation_status === 'hypothesis') {
      assert.equal(
        cfg.last_validated_at, null,
        'un set marcado hypothesis no puede declarar fecha de validación'
      );
    }
  });

  test('el filtro duro de signo de sorpresa está activo (spec §2)', () => {
    assert.equal(cfg.hard_filters.surprise_sign_must_match, true);
    assert.equal(cfg.hard_filters.surprise_availability_must_match, true);
  });

  test('no se emite proyección por debajo del tamaño mínimo de muestra', () => {
    assert.ok(
      cfg.adaptive_threshold.min_sample_for_output >= 5,
      'una frecuencia sobre 3 casos no es evidencia'
    );
  });

  test('el umbral es más exigente cuanto menor es la muestra', () => {
    const reglas = cfg.adaptive_threshold.rules as { min_sample_size: number; threshold: number }[];
    const ordenadas = [...reglas].sort((a, b) => a.min_sample_size - b.min_sample_size);
    for (let i = 1; i < ordenadas.length; i++) {
      assert.ok(
        ordenadas[i].threshold <= ordenadas[i - 1].threshold,
        'con menos muestra debe exigirse MÁS similitud, no menos'
      );
    }
  });
});
