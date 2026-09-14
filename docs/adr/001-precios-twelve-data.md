# ADR 001 — Twelve Data como fuente de precios

**Estado:** ACEPTADO (condicionado)
**Fecha:** 2026-09-14
**Evidencia:** `fixtures/twelvedata/earliest_timestamp.csv`, `time_series_range.csv`

## Contexto

La capa 9 (observación) necesita precios para medir la reacción real en T+1d/7d/30d,
y §4 de la spec necesita σ del régimen calculada con datos previos a T. Requisitos en
`DATA_REQUIREMENTS.md` §2.

## Decisión

Se adopta **Twelve Data** como fuente de precios (acciones, ETFs, FX, commodities).

## Justificación

Verificado con llamadas reales:

- **Profundidad: 1980-12-12** para AAPL (≈46 años). El requisito PR-2 pedía 10 años.
- **Consulta por rango** (`start_date`/`end_date`) funciona: la ventana
  2026-01-28 → 2026-02-03 devolvió exactamente los días hábiles del intervalo.
  Satisface OP-1 y OP-2 (recuperación de huecos).
- **OHLCV diario** completo; intradía desde 1min ofrecido.

## Consecuencia favorable no buscada

La respuesta **no trae columna de precio ajustado**, sólo OHLCV crudo. Es lo que
PR-4 pide: los precios ajustados se reescriben hacia atrás en cada split, y un
backtest de 2021 ejecutado hoy vería precios que nadie pudo observar en 2021.
Trabajar con la serie cruda + el calendario de splits permite reconstruir lo que
realmente se veía en T.

## Condición de la aceptación 🔴

**Antes de FASE 2** debe verificarse que `close` es efectivamente crudo y no ajustado
en silencio: consultar un símbolo alrededor de un split conocido y comparar contra el
precio nominal de esa fecha. Si resultara ajustado sin anunciarlo, todo cálculo de σ
y de retorno histórico quedaría contaminado (LEY 2) y este ADR debe revisarse.

## Gaps aceptados

| Gap | Impacto | Mitigación |
|---|---|---|
| No cubre índices (VIX, DXY) ni renta fija | No sirve para 4 de las 11 variables macro | Fuera del alcance de este ADR — ver ADR 005 |
| Precio ajustado ausente | Requiere `get_splits` + `get_dividends` para reconstruir | Asumido; es preferible al ajuste retroactivo |

## Alternativas

Ninguna otra evaluada: la política de red del entorno impidió alcanzar otros
candidatos (`PROVIDER_EVALUATION.md` §0). **Esta decisión se toma con un solo
candidato probado** — se documenta como tal, y se revisará si aparece evidencia de
que otra fuente cubre además índices y renta fija, lo que permitiría consolidar
categorías.
