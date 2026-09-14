# ADR 004 — La captura diaria construye el archivo de consenso *as-of*

**Estado:** ACEPTADO
**Fecha:** 2026-09-14
**Evidencia:** `fixtures/twelvedata/eps_trend.json`
**Origen:** requisito del usuario — *"las noticias deben obtenerse y buscarse diariamente"*

## Contexto

**EX-4** exige el consenso *vigente entonces*, no el reconstruido hoy. Es el requisito
que más proveedores incumplen **en silencio**: exponen el consenso actual y, al
consultar una fecha pasada, devuelven el de hoy. Es look-ahead puro y no se detecta
leyendo documentación.

`eps_trend` devuelve la estimación actual y la de 7/30/60/90 días atrás:

```json
{"period": "current_quarter", "current_estimate": 1.97754,
 "7_days_ago": 1.97656, "30_days_ago": 1.97656,
 "60_days_ago": 2.00825, "90_days_ago": 2.00801}
```

Prueba que el proveedor **retiene** consenso pasado — la estimación se movió de 2.008
a 1.977 en 90 días. Pero es una **ventana rodante relativa a hoy**: no se puede
preguntar *"¿cuál era el consenso el 2024-03-15?"*.

## Decisión

**El job diario captura y persiste `eps_trend` (y el consenso disponible) además de
las noticias. Cada captura se almacena como fila nueva, append-only, fechada con el
día de captura como `available_at`.**

El sistema **construye su propio archivo de consenso *as-of***.

## Justificación

El requisito de cadencia diaria del usuario, planteado para las noticias, resuelve de
paso un problema metodológico distinto y más difícil.

Un consenso capturado el día D y guardado con `available_at = D` está fechado **por
observación directa**. No depende de que un tercero reconstruya correctamente el
pasado — que es exactamente donde se cuela el look-ahead silencioso de EX-4.

Esto **satisface EX-4 hacia adelante** de la forma más limpia posible: el dato es
nuestro, su fecha es real, y es auditable.

## Consecuencia de primer orden

> **La captura diaria deja de ser una tarea operativa y pasa a ser un requisito de
> arquitectura.**
>
> Cada día no capturado es un **agujero permanente e irrecuperable** en el archivo de
> consenso. A diferencia de las noticias —que a veces pueden recuperarse consultando
> una ventana pasada (OP-2)— el consenso de ayer **no se puede volver a observar**.

Requisitos derivados para FASE 2:

1. El job diario debe tener **monitorización de fallos** y alertar si no corre.
2. Debe ser **idempotente** (OP-3): reejecutar el mismo día no duplica filas.
3. El almacenamiento es **append-only**, nunca `UPDATE` — misma disciplina bitemporal
   que LEY 2 impone al macro.
4. Un hueco debe quedar **registrado y visible**, no rellenado por interpolación.

## Alcance

Cubre consenso de **earnings**. No resuelve:

- el **consenso macro**, que sigue sin fuente (ADR 005);
- el **histórico anterior** al arranque del sistema — el problema de arranque en frío
  (`DATA_REQUIREMENTS.md` §1.2) permanece intacto.

## Gap aceptado

Los eventos anteriores al arranque del sistema **no tendrán consenso *as-of***. Deben
marcarse explícitamente y **no** compararse con eventos que sí lo tengan.
**Prohibido** rellenar el pasado con el consenso actual: sería el look-ahead exacto
que este ADR existe para evitar.
