import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asOf,
  AsOfContext,
  assertNoLookAhead,
  LookAheadViolationError,
  MissingClockError,
} from '../src/data/asOf.ts';

const T = new Date('2026-06-15T00:00:00Z');
const ANTES = new Date('2026-05-01T00:00:00Z');
const DESPUES = new Date('2026-08-01T00:00:00Z');

/** Pool falso: devuelve filas fijas y registra los parámetros recibidos. */
function fakePool(rows: unknown[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return Promise.resolve({ rows });
    },
  } as never;
}

describe('assertNoLookAhead — contrato mínimo de la spec §1', () => {
  test('LANZA EXCEPCIÓN con un dato posterior a T (test obligatorio)', () => {
    assert.throws(
      () => assertNoLookAhead({ available_at: DESPUES }, T, 'caso-obligatorio'),
      LookAheadViolationError
    );
  });

  test('no devuelve null ante la violación: falla ruidosamente', () => {
    // Devolver null volvería la violación indistinguible de "no hay datos",
    // y el sistema seguiría con un hueco silencioso.
    let resultado: unknown = 'no-lanzó';
    try {
      assertNoLookAhead({ available_at: DESPUES }, T);
    } catch (e) {
      resultado = e;
    }
    assert.ok(resultado instanceof LookAheadViolationError);
    assert.notEqual(resultado, null);
  });

  test('acepta un dato anterior a T', () => {
    assert.doesNotThrow(() => assertNoLookAhead({ available_at: ANTES }, T));
  });

  test('acepta un dato exactamente en T (el límite es inclusivo)', () => {
    assert.doesNotThrow(() => assertNoLookAhead({ available_at: new Date(T) }, T));
  });

  test('LEY 6: lanza si falta available_at', () => {
    assert.throws(() => assertNoLookAhead({ available_at: null }, T), MissingClockError);
    assert.throws(() => assertNoLookAhead({ available_at: undefined }, T), MissingClockError);
  });

  test('el mensaje identifica ambos instantes, para poder depurar', () => {
    try {
      assertNoLookAhead({ available_at: DESPUES }, T, 'matching');
      assert.fail('debió lanzar');
    } catch (e) {
      const msg = (e as Error).message;
      assert.match(msg, /2026-08-01/);
      assert.match(msg, /2026-06-15/);
      assert.match(msg, /matching/);
    }
  });
});

describe('AsOfContext', () => {
  test('rechaza un instante de análisis inválido', () => {
    assert.throws(() => new AsOfContext(fakePool(), new Date('no-es-fecha')), TypeError);
  });

  test('inyecta T como $1 antes que los parámetros propios', async () => {
    const pool = fakePool();
    const ctx = asOf(pool, T);
    await ctx.query('SELECT 1 WHERE available_at <= $1 AND metric = $2', ['cpi']);

    const call = (pool as unknown as { calls: { params: unknown[] }[] }).calls[0];
    assert.equal(call.params[0], T, 'T debe ser siempre $1');
    assert.equal(call.params[1], 'cpi');
  });

  test('rechaza una consulta que no use $1', async () => {
    const ctx = asOf(fakePool(), T);
    await assert.rejects(
      () => ctx.query('SELECT * FROM market.events', [], 'sin-filtro'),
      /no usa \$1/
    );
  });

  test('valida las filas devueltas: detecta una consulta mal escrita', async () => {
    // Defensa en profundidad: aunque la consulta lleve $1, si el WHERE está
    // mal construido y se cuela una fila futura, el error salta aquí en vez
    // de propagarse como un resultado plausible.
    const ctx = asOf(fakePool([{ available_at: DESPUES }]), T);
    await assert.rejects(
      () => ctx.query('SELECT * FROM t WHERE id > $1', [], 'filtro-roto'),
      LookAheadViolationError
    );
  });

  test('acepta filas anteriores a T', async () => {
    const ctx = asOf(fakePool([{ available_at: ANTES }, { available_at: T }]), T);
    const rows = await ctx.query('SELECT * FROM t WHERE available_at <= $1');
    assert.equal(rows.length, 2);
  });

  test('rewindTo permite ir hacia atrás', () => {
    const ctx = asOf(fakePool(), T);
    assert.equal(ctx.rewindTo(ANTES).t, ANTES);
  });

  test('rewindTo NO permite ir hacia adelante', () => {
    const ctx = asOf(fakePool(), T);
    assert.throws(() => ctx.rewindTo(DESPUES), LookAheadViolationError);
  });
});
