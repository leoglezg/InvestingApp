# ADR 005 — Noticias y macro: decisión deliberadamente diferida

**Estado:** DIFERIDO — bloqueante de FASE 2
**Fecha:** 2026-09-14

## Contexto

Dos categorías quedan sin proveedor:

- **Noticias** — Twelve Data rechazado con evidencia (ADR 003). Sin fuente no hay
  capa 1, y sin capa 1 no hay producto.
- **Macro** — ninguna fuente evaluada. Es la categoría con los dos bloqueantes más
  duros de la spec: **MA-1** (historial de revisiones) y **MA-2**
  (`release_timestamp`).

La política de red del entorno deniega todo dominio externo salvo GitHub, registros
de paquetes y los MCP autorizados. Se comprobó con dos intentos reales, ambos
`403 CONNECT (policy denial)`. Ver `PROVIDER_EVALUATION.md` §0.

## Decisión

**No se elige proveedor para ninguna de las dos categorías.** La decisión se difiere
hasta poder ejecutar llamadas reales.

## Justificación

Es tentador cerrar estas categorías por reputación —FRED es el estándar de facto para
macro *vintage*; SEC EDGAR es Tier 1 indiscutible— y seguir avanzando. Se rechaza esa
vía por tres motivos:

**1 · Es el antipatrón explícito de la spec.** *"Elegir proveedor porque aparece
nombrado en este documento → arquitectura secuestrada por una API."* FASE 1 es
categórica: *"Do not choose a provider merely because it is named in this prompt."*
Elegir por prestigio es la misma falta con mejor justificación aparente.

**2 · El requisito decisivo no es verificable por documentación.** Lo que el sistema
necesita de una fuente macro no es cobertura: es el **dato *vintage***. Poder
preguntar *"¿qué valor de PIB estaba publicado el 2024-03-15?"* y recibir la cifra
vigente **entonces**. Un proveedor puede documentar "datos históricos completos" y
entregar sólo la serie revisada — que es inservible y, peor, **silenciosamente
inservible**: no falla, sólo produce backtests mejores de lo que la realidad
permitía. Distinguirlo exige una llamada real.

**3 · El precedente de esta misma sesión.** Twelve Data y Neon se conectaron por
conveniencia antes de FASE 1, incurriendo en ese antipatrón. La evaluación posterior
mostró que Twelve Data **es excelente para precios y sorpresa, e inservible para
noticias** — un matiz que ninguna lectura de documentación habría anticipado, y que
sólo apareció al mirar las respuestas crudas. Repetir el atajo en la categoría con los
bloqueantes más duros sería no haber aprendido nada.

## Consecuencia

🔴 **FASE 2 queda bloqueada.** Conforme a la Regla 3 (*"si un requisito de datos no se
puede satisfacer, ESCALA — no improvises un workaround. Un workaround silencioso en la
capa de datos invalida todo el sistema aguas arriba"*), no se construye pipeline sobre
una capa de datos sin resolver.

## Candidatos registrados — todos `NO VERIFICADO`

Se listan para no perder el trabajo de identificación. **Ninguno está elegido.**

### Noticias

Se necesitan **dos capacidades distintas**, que pueden venir de proveedores distintos:

| Capacidad | Para qué |
|---|---|
| Flujo diario | Alimentar el sistema día a día (OP-1..5) |
| Archivo histórico | Sembrar el matching para que funcione desde el día 1 |

| Candidato | Perfil | Riesgo a verificar primero |
|---|---|---|
| SEC EDGAR | Tier 1 | Cubre filings, no noticias; sólo emisores US |
| Feeds oficiales (Fed, BLS) | Tier 1 | Volumen bajo, formatos heterogéneos |
| GDELT | Archivo + flujo | Calidad heterogénea, ruido alto |
| Agregadores comerciales | Flujo | 🔴 **NR-4: licencia de almacenamiento** |

> **NR-4 se verifica antes que cualquier prueba técnica.** Varios agregadores permiten
> mostrar pero no **retener** el texto. Este sistema construye un archivo por diseño:
> si la licencia lo prohíbe, el proveedor es inviable por bien que encajen sus datos.

### Macro

| Candidato | Por qué | Qué verificar |
|---|---|---|
| FRED / ALFRED | ALFRED existe específicamente para series *vintage* | Que devuelva el valor **as-of** y no el revisado |

> #### Actualización 2026-09-15 — evidencia documental sobre FRED/ALFRED
>
> La red sigue bloqueada (6/6 hosts rechazados; `WebFetch` también usa el mismo
> proxy de egress). Pero la **búsqueda web sí funciona**, y permite reducir la
> incertidumbre sobre si MA-1 es siquiera satisfacible.
>
> Según la documentación oficial, cada observación de FRED lleva tres fechas:
> `date` (el periodo al que se refiere), `realtime_start` y `realtime_end` (el
> intervalo en que ese valor estuvo vigente). Y el parámetro `output_type` admite:
>
> | valor | significado |
> |---|---|
> | `1` | Observations **by Real-Time Period** |
> | `2` | Observations by Vintage Date, all observations |
> | `3` | Observations by Vintage Date, **new and revised only** |
> | `4` | Observations, **Initial Release Only** |
>
> Existe además el endpoint `fred/series/vintagedates`, que devuelve las fechas en
> que una serie fue revisada.
>
> **Lectura:** `output_type=4` es literalmente **MA-1** (valor del release
> inicial), y `output_type=1` es literalmente la semántica de `asOf(T)`. El
> modelo `realtime_start`/`realtime_end` se corresponde uno a uno con la
> bitemporalidad que ya impone `macro_observations`.
>
> **Estado: sigue `NO VERIFICADO` y el ADR sigue DIFERIDO.** Esto es
> documentación, no una llamada real, y la spec es explícita en que la
> documentación no cuenta como evidencia. Lo que cambia es el perfil de riesgo:
> ya no es incierto *si existe* una fuente capaz de satisfacer el bloqueante más
> duro, sólo falta poder alcanzarla y comprobarlo con respuestas crudas en
> `/fixtures`.
>
> Fuente: [FRED API — series/observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html) ·
> [ALFRED — Download Data Help](https://alfred.stlouisfed.org/help/downloaddata)
| Fuentes primarias (BLS, BEA, Fed H.15) | Origen del dato; calendarios oficiales | Precisión de `release_timestamp` |
| Comerciales de macro | Cobertura integrada | Costo; licencia |

## Cómo se desbloquea

| Opción | Implica |
|---|---|
| **A.** Ampliar la política de red a los dominios candidatos | Permite completar A2 aquí mismo |
| **B.** Conectar MCPs que cubran noticias y/o macro | Ruta ya probada con Twelve Data |
| **C.** Aportar API keys + habilitar sus dominios | Equivale a A, por proveedor |

## Criterio de revisión

Este ADR se cierra cuando exista, con evidencia en `/fixtures`:

- [ ] una fuente de noticias con `published_at` intradía, densidad diaria real y tier
      identificable;
- [ ] una fuente macro que satisfaga **MA-1** y **MA-2**;
- [ ] verificación de licencia de almacenamiento (**NR-4**) para ambas.

Si tras evaluar candidatos reales **ninguno** satisface MA-1, se escala de nuevo: ese
sí sería el escenario que la spec previó, y obligaría a replantear el alcance del
backtesting antes que a relajar la ley.
