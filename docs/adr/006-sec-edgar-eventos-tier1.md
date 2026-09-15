# ADR 006 — SEC EDGAR como fuente de eventos Tier 1

**Estado:** ACEPTADO
**Fecha:** 2026-09-15
**Evidencia:** `fixtures/sec-edgar/submissions_AAPL_8K.json`

## Contexto

La capa 1 llevaba bloqueada desde FASE 1: Twelve Data fue rechazado para noticias
(ADR 003) y no había alternativa alcanzable. Tras ampliarse la política de red,
`data.sec.gov` pasó a ser accesible y se evaluó con llamadas reales.

## Decisión

Se adopta **SEC EDGAR** (`data.sec.gov`) como fuente primaria de eventos
corporativos **Tier 1**.

## Justificación

### El mejor `available_at` posible

```
acceptanceDateTime: "2026-09-01T20:30:35.000Z"
```

Precisión de milisegundo con zona horaria. Y lo importante no es la precisión sino
**qué mide**: el instante en que el regulador aceptó el documento, que es cuando el
hecho pasó a ser público. No es la fecha en que un medio lo publicó ni cuándo
nuestro job lo recogió. Es el momento real.

Esto satisface **OP-6** sin las reservas que arrastraban los demás candidatos.

### Resuelve el problema de arranque en frío

Una sola llamada devolvió **1000 filings cubriendo 2015-07-24 → 2026-09-10**:
**11 años de archivo**. `DATA_REQUIREMENTS.md` §1.2 pedía 3–5 años como mínimo
operativo. El matching histórico puede funcionar desde el día uno en lugar de
esperar años acumulando.

### Taxonomía de eventos declarada, no inferida

Los 8-K traen códigos `items` estructurados: `2.02` resultados, `5.02` cambios en
la dirección, `1.01` acuerdo material relevante.

Esto sustituye la clasificación por expresiones regulares del código auditado,
que adivinaba el tipo buscando palabras en el titular. Aquí el tipo lo **declara
el emisor ante el regulador, bajo responsabilidad legal**. No hay inferencia, y
por tanto no hay error de inferencia que arrastrar al matching.

### Licencia sin riesgo

Obra del gobierno de EE. UU.: dominio público. **NR-4 queda resuelto** — es
justamente el riesgo que hacía dudosa la vía de Yahoo, donde construir un archivo
persistente chocaba con los términos de uso.

## Requisitos operativos

1. **Cabecera `User-Agent` identificando al solicitante.** Sin ella, 403.
2. **Consulta por empresa (CIK), no hay feed global.** Para un portafolio de N
   símbolos son N llamadas diarias: viable. El feed global y la búsqueda de texto
   completo están en `www.sec.gov` y `efts.sec.gov`, **fuera de la allowlist**.
3. **Clientes Node necesitan `NODE_USE_ENV_PROXY=1` y `HTTPS_PROXY` con esquema
   `http://`**, o el `fetch` de undici sale por una ruta más restrictiva y recibe
   403 aunque el host esté permitido.

## Gaps aceptados

| Gap | Consecuencia | Mitigación |
|---|---|---|
| Sólo emisores estadounidenses | Sin cobertura de mercados extranjeros | Aceptado: acota el alcance inicial, no lo invalida |
| Filings, no noticias | No cubre eventos geopolíticos ni macro | **La categoría de noticias generales sigue abierta** (ADR 005) |
| Sin feed global | Hay que enumerar los CIK de interés | Se deriva del portafolio del usuario |
| Sin consenso | Los 8-K de resultados no traen la estimación previa | Se cruza con Twelve Data (ADR 002) por fecha |

## Lo que NO resuelve

Este ADR cubre **eventos corporativos**. Siguen abiertos:

- **Noticias generales** (geopolítica, sector, macro comentada) — ADR 005
- **Series macro con revisiones** — MA-1/MA-2, pendientes sólo de la clave de FRED

## Alternativas descartadas en esta ronda

| Candidato | Motivo |
|---|---|
| Yahoo Finance | 429 persistente: rate limiting por IP de datacenter. No es allowlist ni se resuelve reintentando |
| GDELT | 429 persistente; la cuota se comparte con otros usuarios de la IP de salida |
