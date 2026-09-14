# ADR 002 — Twelve Data como fuente de sorpresa de earnings

**Estado:** ACEPTADO (con gaps explícitos)
**Fecha:** 2026-09-14
**Evidencia:** `fixtures/twelvedata/earnings.csv`

## Contexto

La spec §2 declara la sorpresa vs expectativa *"un campo de primera clase del evento,
no un extra"*. La auditoría la encontró **totalmente ausente** en el código previo
(`AUDIT.md` V-7). Sin ella, el sistema no distingue *"CPI 3.4% vs consenso 3.2%"* de
*"CPI 3.4% vs consenso 3.6%"* — eventos con reacción opuesta.

## Decisión

Se adopta **Twelve Data `get_earnings`** como fuente de expectativas y sorpresa para
`event_type: EARNINGS`.

## Justificación

La respuesta real mapea **1:1** contra el contrato `EventExpectations` de la spec:

```
date;time;eps_estimate;eps_actual;difference;surprise_prc
2026-01-29;After Hours;2.67;2.84;0.17;6.37
```

| Contrato de la spec | Campo del proveedor |
|---|---|
| `consensus_value` | `eps_estimate` |
| `actual_value` | `eps_actual` |
| `surprise_absolute` | `difference` |
| `surprise_percent` | `surprise_prc` |

La sorpresa viene **calculada por el proveedor**, no inferida por nosotros. Esto
desbloquea por completo el tipo de evento EARNINGS, que era inalcanzable.

El campo `time` (`After Hours` / `Before Market`) indica el momento del reporte
respecto al cierre — dato directamente útil para fechar el `available_at` del
resultado con la precisión que exige OP-6.

## Gaps aceptados (explícitos, por exigencia de FASE 1)

| Gap | ID | Consecuencia | Decisión |
|---|---|---|---|
| Falta `consensus_available_at` | **EX-2** | No se sabe cuándo se formó el consenso | Se mitiga con ADR 004 (captura diaria) hacia adelante. Para el histórico, se marca el campo como `null` y **nunca se imputa**. |
| Falta `consensus_source` | EX-3 | Menor auditabilidad | Aceptado |
| Falta dispersión de estimaciones | EX-5 | `surprise_zscore` no calculable | Aceptado: se emitirá `surprise_absolute` y `surprise_percent`; el z-score queda `undefined`, nunca aproximado |

## Alcance — límite importante

Este ADR cubre **únicamente el consenso de earnings**. El **consenso macro** (CPI,
nóminas, decisiones de tipos) **no está cubierto por ninguna fuente evaluada** y sigue
abierto (ver ADR 005).

Consecuencia operativa: los eventos macro entrarán al sistema **sin dimensión de
sorpresa**, y conforme a `DATA_REQUIREMENTS.md` §4.2 deben marcarse
`surprise_available: false` y **no compararse** contra eventos que sí la tienen — el
signo de sorpresa es filtro duro, y un evento sin sorpresa no tiene signo que filtrar.

**Prohibido** imputar, estimar o inferir un consenso ausente: un consenso inventado se
propaga al matching como si fuera un hecho.
