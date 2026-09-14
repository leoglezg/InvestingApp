# VERIFICATION.md — Bloque B: cimientos temporales

**Fecha:** 2026-09-14
**Base de datos:** Neon PostgreSQL 17 — proyecto `wild-tooth-15263139`
**Estado:** esquema desplegado y **verificado con ejecución real**

---

## 0. POR QUÉ SE AVANZÓ CON EL BLOQUE B ESTANDO FASE 1 ABIERTA

FASE 1 dejó dos categorías sin resolver (noticias y macro) por la política de red
del entorno. La spec bloquea construir *"encima de un dato que no permite
backtesting válido"*. Conviene justificar por qué esto no lo es:

**El Bloque B no elige proveedor ni consume datos de negocio. Define el contrato
que cualquier proveedor deberá cumplir.**

| Argumento | Detalle |
|---|---|
| Es agnóstico al proveedor | `available_at`, bitemporalidad y `asOf(T)` los exigen las LEYES, no una API concreta |
| Invierte el riesgo | El esquema se convierte en el **criterio de aceptación** con el que probar candidatos: una fuente sin `available_at` intradía simplemente no podrá insertar |
| No hay trabajo desechable | Nada aquí cambia según qué proveedor gane |
| Ataca el defecto raíz | La auditoría identificó la ausencia de capa temporal (V-1, V-2, V-6) como el fallo del que dependían todos los demás |

Lo que **no** se ha construido: ingesta, matching, escenarios ni alertas. Esas capas
sí consumen datos de negocio y siguen bloqueadas.

---

## 1. LO DESPLEGADO

Esquema `market`, 13 tablas. Sustituye por completo al auditado, que usaba sintaxis
MySQL de índices y **nunca llegó a ejecutarse** (AUDIT.md §3 C-1).

| Tabla | Capa | Ley que impone |
|---|---|---|
| `sources` | 1 | Jerarquía de tiers |
| `raw_news` | 1 | LEY 6 — tripleta NOT NULL |
| `events`, `event_sources` | 2–3 | LEY 6 · corroboración por tier |
| `event_expectations` | 3 | spec §2 — sorpresa |
| `macro_observations` | 4 | **LEY 2 — append-only** |
| `macro_snapshots` | 4 | Cobertura de régimen visible |
| `market_prices`, `corporate_actions` | 9 | PR-4 — serie cruda |
| `consensus_snapshots` | — | ADR 004 — archivo as-of |
| `ingestion_runs` | — | Huecos visibles |
| `similarity_matches` | 5 | LEY 4 — `weights_version` |
| `scenario_projections` | 6 | **LEY 3 — por constraint** |
| `observed_outcomes` | 9 | spec §4 — clasificación fija |

**Nota de fidelidad:** el despliegue se hizo vía el conector MCP (el puerto 5432
está bloqueado por la política de red — `ETIMEDOUT`), ejecutando las sentencias de
`db/schema/001_temporal_core.sql` de forma equivalente. `scripts/migrate.mjs` queda
listo para aplicar el archivo directamente donde haya acceso al puerto.

---

## 2. VERIFICACIÓN CONTRA LA BASE DE DATOS REAL

> No son afirmaciones: son ejecuciones y sus respuestas literales.

### 2.1 LEY 2 — el dato vigente en T, no el revisado 🟢

Se cargó el PIB de un trimestre con su release inicial y dos revisiones
posteriores, y se consultó `macro_as_of()` en distintos instantes:

| Consulta en T | Valor devuelto | Revisión | Correcto |
|---|---|---|---|
| 2026-04-01 (antes de publicarse) | `NULL` | — | ✅ no existía aún |
| 2026-05-15 (tras release inicial) | **2.1** | 0 | ✅ **no ve el 2.4 ni el 2.6 futuros** |
| 2026-06-15 (tras revisión 1) | **2.4** | 1 | ✅ no ve el 2.6 futuro |
| 2026-09-14 (hoy) | 2.6 | 2 | ✅ ya publicada |

**Esto es la LEY 2 funcionando.** Un backtest fechado el 15 de mayo ve 2.1%, que es
lo único que se sabía entonces. El código auditado no podía hacer esta distinción:
no tenía tabla macro en absoluto.

### 2.2 LEY 2 — append-only 🟢

```sql
UPDATE market.macro_observations SET value = 99.9 WHERE revision_number = 0;
```
```
ERROR: LEY 2: macro_observations es append-only. Intento de UPDATE rechazado.
       Las correcciones se registran como filas nuevas, nunca sobrescribiendo.
```

✅ Rechazado por trigger. Aplica igual a `consensus_snapshots` y `observed_outcomes`.

> **Limitación conocida:** `TRUNCATE` no dispara triggers de fila. El guardián
> protege del error cotidiano (un `UPDATE` descuidado), no de una operación
> deliberada con privilegios. Se documenta antes que presentarlo como infalible.

### 2.3 LEY 3 — frecuencia ≠ probabilidad 🟢

Intento de guardar una "probabilidad calibrada" sin calibración validada — que es
**exactamente lo que el código auditado hacía de rutina**:

```sql
INSERT INTO market.scenario_projections (..., calibrated_probability, calibration_status, ...)
VALUES (..., 0.68, 'uncalibrated', ...);
```
```
ERROR: new row violates check constraint "ley3_no_calibrated_without_validation"
```

✅ Imposible por construcción. La forma correcta **sí** se acepta:

```json
{ "scenario": "bearish", "historical_frequency": 0.6956,
  "historical_sample_size": 23, "calibrated_probability": null,
  "calibration_status": "uncalibrated" }
```

Es decir: *"de 23 casos comparables, 16 terminaron negativos"* — observación
descriptiva. **No** *"hay un 68% de probabilidad"*, que sería afirmación de modelo.

### 2.4 LEY 6 — sin reloj coherente no entra 🟢

```sql
INSERT INTO market.raw_news (... event_time '21:00', available_at '20:00' ...);
```
```
ERROR: new row violates check constraint "ley6_available_after_event"
```

✅ Una noticia no puede estar disponible antes de que ocurra el hecho.

---

## 3. TESTS AUTOMATIZADOS — 21/21 EN VERDE

```
# tests 21
# pass 21
# fail 0
```

Ejecutables con `npm test`, sin base de datos.

### `tests/asOf.test.ts` — LEY 1

- ✅ **Un dato con `available_at > T` LANZA EXCEPCIÓN** ← el test que la spec exige
- ✅ No devuelve `null`: lo verifica explícitamente, porque `null` volvería la
  violación indistinguible de "no hay datos" y el sistema seguiría con un hueco
  silencioso
- ✅ Falta de `available_at` → `MissingClockError` (LEY 6)
- ✅ El límite en T es inclusivo
- ✅ Una consulta que no use `$1` es rechazada
- ✅ Las filas devueltas se revalidan: una consulta mal escrita se detecta aunque
  lleve `$1`
- ✅ `rewindTo` va hacia atrás; hacia adelante lanza

### `tests/architecture.test.ts` — LEY 1 y LEY 4 estructurales

- ✅ **Ningún módulo fuera de `src/data` importa `pg`.** El defecto raíz del código
  auditado fue exportar `query()` cruda que seis módulos llamaban sin filtro
  temporal; que esto sea un test y no una convención es lo que impide repetirlo
- ✅ No hay restos de la capa de recomendaciones (fuera de alcance)
- ✅ Los pesos suman 1 y cubren los 7 componentes del contrato
- ✅ `validation_status: hypothesis` obliga a `last_validated_at: null`
- ✅ Los filtros duros de sorpresa están activos
- ✅ El umbral adaptativo es **más** exigente cuanto menor es la muestra

---

## 4. LO QUE NO SE HA VERIFICADO

| Pendiente | Motivo |
|---|---|
| Tests de integración contra Postgres real | Puerto 5432 bloqueado (`ETIMEDOUT`). Las pruebas de §2 se hicieron vía MCP, manualmente, no como suite reproducible |
| `scripts/migrate.mjs` ejecutado de extremo a extremo | Mismo bloqueo |
| Que `close` de Twelve Data sea crudo y no ajustado | Condición del ADR 001, pendiente antes de FASE 2 |
| Ingesta, matching, escenarios, alertas | No construidos: dependen de proveedores sin decidir |

**Datos de prueba:** las filas cargadas en §2 quedan en la base marcadas con
`TEST-BEA` y `test-aapl-q1-2026`. No se eliminaron porque borrarlas es una
operación destructiva que requiere confirmación, y porque sirven de evidencia viva.

---

## 5. ESTADO DEL DoD

| Criterio (Bloque B del plan de AUDIT.md §5) | Estado |
|---|---|
| B1 — Esquema temporal con tripleta obligatoria y macro bitemporal | ✅ desplegado y verificado |
| B2 — `asOf(T)` + tests de look-ahead, incluido el que lanza | ✅ 21/21 |
| B3 — `query()` cruda deja de exportarse; test de arquitectura | ✅ |
| B4 — Pesos en config con `validation_status` | ✅ |

**Bloqueado para FASE 2:** capas 1 y 4 requieren los proveedores de ADR 005.
