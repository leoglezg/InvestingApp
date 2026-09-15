# ADR 007 — FRED/ALFRED como fuente macro con datos *vintage*

**Estado:** ACEPTADO
**Fecha:** 2026-09-15
**Evidencia:** `fixtures/fred/`
**Cierra:** MA-1 y MA-2, los dos bloqueantes más duros de la spec

## Contexto

La LEY 2 exige usar el valor macro **vigente en T**, no el revisado después.
`DATA_REQUIREMENTS.md` marcaba MA-1 (historial de revisiones) y MA-2
(`release_timestamp`) como bloqueantes duros: sin ellos, ningún backtest es
válido y la spec ordena escalar antes que construir encima.

El riesgo que hacía esto difícil de resolver: un proveedor puede documentar
"datos históricos completos" y entregar sólo la serie revisada. **No falla — sólo
produce resultados mejores de lo que la realidad permitía.** Sólo se distingue
mirando respuestas crudas.

## Decisión

Se adopta **FRED/ALFRED** (`api.stlouisfed.org`) como fuente de series
macroeconómicas con historial de revisiones.

## Justificación — la prueba decisiva

Se consultó el **mismo dato** (PIB real de EE. UU., `GDPC1`, trimestre
`2025-01-01`) desde dos instantes distintos:

| Consulta | Valor |
|---|---|
| `realtime_start = realtime_end = 2025-06-01` | **23528.047** |
| Sin parámetros de *realtime* (hoy) | **23548.21** |

**Devuelve valores distintos para el mismo trimestre según cuándo se pregunte.**
Eso es exactamente MA-2.

Y el historial completo de ese trimestre:

| Vigente desde | hasta | Valor |
|---|---|---|
| 2025-04-30 | 2025-05-28 | 23526.085 |
| 2025-05-29 | 2025-06-25 | 23528.047 |
| 2025-06-26 | 2025-09-24 | **23512.717** ← revisión **a la baja** |
| 2025-09-25 | (hoy) | 23548.21 |

**Cuatro versiones del mismo hecho.** Un backtest fechado en julio de 2025 que
usara el valor de hoy vería 23548.21 cuando el dato vigente era 23512.717: 35
puntos de diferencia, y con el camino intermedio en dirección contraria. No es un
matiz académico — es la diferencia entre "la economía se aceleró" y "la economía
se frenó" en el momento en que el sistema habría emitido su alerta.

`vintagedates` devolvió además **16 fechas de revisión** desde abril de 2025, lo
que permite reconstruir cualquier instante.

## Correspondencia con el esquema ya desplegado

El modelo de FRED encaja **uno a uno** con `macro_observations`, que se diseñó
antes de poder acceder a la fuente:

| FRED | Nuestro esquema |
|---|---|
| `date` | `reference_period` — el periodo al que se refiere el dato |
| `realtime_start` | `available_at` — desde cuándo ese valor estuvo vigente |
| `realtime_end` | implícito: lo sustituye la siguiente fila |
| orden del vintage | `revision_number` (0 = `initial`) |
| `output_type=4` | `release_type = 'initial'` |

No hay que adaptar nada: la bitemporalidad que ya impone la base de datos es la
misma que la fuente entrega.

## Requisitos operativos

1. **API key obligatoria** (gratuita). Vive en `.env` como `FRED_API_KEY` y
   **nunca** se commitea.
2. **El *realtime period* por defecto es hoy.** Omitirlo devuelve la serie
   revisada — es decir, **el comportamiento por defecto de la API es el que viola
   la LEY 2**. Toda consulta del sistema debe fijar `realtime_start` explícitamente
   a partir de T. Un olvido aquí no produce error: produce look-ahead silencioso.
3. Pedir `output_type=4` sin rango de *realtime* devuelve
   `"No vintage dates exist for the specified real-time period"`. El rango hay que
   abrirlo.

## Gaps aceptados

| Gap | Consecuencia |
|---|---|
| Cobertura de las 11 variables sin verificar una a una | Sólo se probó `GDPC1`. Falta confirmar `vix`, `high_yield_oas` y `yield_curve_2s10s` |
| Rate limits no medidos | Pendiente para dimensionar el job diario |
| No cubre noticias | Fuera de alcance de este ADR |

## Consecuencia

Con este ADR y el 006 (SEC EDGAR), **los bloqueantes que impedían FASE 2 quedan
cerrados**. El sistema puede tener eventos Tier 1 con timestamp exacto y régimen
macro sin look-ahead — que era el requisito mínimo para que cualquier salida sea
defendible.
