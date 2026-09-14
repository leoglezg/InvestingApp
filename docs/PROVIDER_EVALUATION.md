# PROVIDER_EVALUATION.md — FASE 1 / Bloque A2

**Fecha:** 2026-09-14
**Requisitos de referencia:** `DATA_REQUIREMENTS.md`
**Evidencia:** `fixtures/twelvedata/` — respuestas crudas de **6 llamadas reales**

> **Regla de evidencia:** sólo se puntúa como verificado lo que se comprobó con una
> llamada real cuya respuesta está guardada en `/fixtures`. La documentación del
> proveedor **no** cuenta. Todo lo demás se marca `NO VERIFICADO` — sin excepción,
> aunque el resultado parezca obvio.

---

## 0. RESTRICCIÓN DEL ENTORNO — LEER ANTES QUE NADA 🔴

La política de red de esta sesión **deniega por defecto todo dominio externo**. Se
comprobó con dos intentos reales:

```
data.sec.gov:443        → 403 CONNECT (policy denial)
api.gdeltproject.org:443 → 403 CONNECT (policy denial)
```

Sólo son alcanzables: GitHub, registros de paquetes (npm/PyPI/crates/Go) y los
**conectores MCP ya autorizados**.

**Consecuencia:** de las 4 categorías, sólo **una** pudo evaluarse con llamadas
reales, porque sólo un candidato es alcanzable desde aquí.

| Categoría | ¿Evaluable en este entorno? |
|---|---|
| Precios | ✅ sí — Twelve Data está conectado |
| Consenso earnings | ✅ sí — Twelve Data |
| **Noticias** | ⚠️ sólo Twelve Data; el resto de candidatos, inalcanzables |
| **Macro** | ❌ **ningún candidato alcanzable** |

Esto **no se resuelve improvisando**. Ver §5 (punto A4).

---

## 1. TWELVE DATA — EVALUACIÓN CON EVIDENCIA REAL

### 1.1 Llamadas ejecutadas

| # | Llamada | Fixture |
|---|---|---|
| 1 | `get_company_news(AAPL, outputsize=3)` | `news_latest.json` |
| 2 | `get_company_news(AAPL, 2026-03-01 → 2026-03-08)` | `news_range_empty.json` |
| 3 | `get_earliest_timestamp(AAPL, 1day)` | `earliest_timestamp.csv` |
| 4 | `get_earnings(AAPL, outputsize=6)` | `earnings.csv` |
| 5 | `get_analyst_data(AAPL, eps_trend)` | `eps_trend.json` |
| 6 | `get_time_series(AAPL, 2026-01-28 → 2026-02-03)` | `time_series_range.csv` |

---

### 1.2 PRECIOS — ✅ **APROBADO**

| Criterio | Resultado | Evidencia |
|---|---|---|
| PR-1 OHLCV diario | ✅ | `open;high;low;close;volume` |
| PR-2 Profundidad ≥10 años | ✅ **1980-12-12 → hoy ≈ 46 años** | fixture 3 |
| OP-1 Rango de fechas | ✅ ventana solicitada devuelta correctamente | fixture 6 |
| OP-2 Ventana pasada arbitraria | ✅ enero 2026 recuperado sin problema | fixture 6 |
| PR-5 Cobertura | ⚠️ acciones/ETF/FX/cripto sí; **índices y renta fija NO** (declarado) | ficha del proveedor |
| PR-6 Intradía | ⭕ `1min…4h` ofrecidos — **NO VERIFICADO** | |

**Hallazgo sobre PR-3/PR-4 (ajuste retroactivo):** la respuesta **no incluye columna
de precio ajustado** — sólo OHLCV crudo. Esto es **favorable**: precios sin ajuste
retroactivo es exactamente lo que PR-4 pide, porque evita reescribir el pasado. Para
reconstruir la serie vigente en T harán falta `get_splits` y `get_dividends`.

> ⚠️ **NO VERIFICADO:** que `close` sea efectivamente crudo y no ajustado en silencio.
> Distinguirlo requiere consultar un símbolo alrededor de un split conocido y
> comparar. **Debe hacerse antes de FASE 2** — si `close` estuviera ajustado sin
> anunciarlo, todo cálculo de σ y de retorno histórico estaría contaminado (LEY 2).

**Veredicto: APROBADO como fuente de precios**, sujeto a la verificación de splits.

---

### 1.3 CONSENSO DE EARNINGS — ✅ **APROBADO CON GAP**

Es el hallazgo **más valioso** de toda la evaluación. La respuesta de `get_earnings`:

```
date;time;eps_estimate;eps_actual;difference;surprise_prc
2026-07-30;After Hours;1.89;2.02;0.13;6.88
2026-01-29;After Hours;2.67;2.84;0.17;6.37
```

Mapea **1:1** contra el contrato `EventExpectations` de la spec §2:

| Campo de la spec | Campo del proveedor | Estado |
|---|---|---|
| `consensus_value` | `eps_estimate` | ✅ |
| `actual_value` | `eps_actual` | ✅ |
| `surprise_absolute` | `difference` | ✅ |
| `surprise_percent` | `surprise_prc` | ✅ |
| `metric_name` | implícito (`EPS`) | ✅ |
| **`consensus_available_at`** | **ausente** | 🔴 **GAP (EX-2)** |
| `consensus_source` | ausente | 🟠 GAP (EX-3) |
| `surprise_zscore` | no hay dispersión | 🟠 requiere EX-5 |

**La sorpresa de earnings — "la pieza que faltaba" de la spec — es obtenible hoy.**
Eso desbloquea `event_type: EARNINGS` por completo.

**Gap EX-2:** no se sabe **cuándo** se formó ese consenso. El campo `time: "After
Hours"` sí indica el momento del *reporte* respecto al cierre de mercado — dato
valioso para fechar `available_at` del resultado — pero **no** fecha el consenso.

---

### 1.4 CONSENSO *AS-OF* (EX-4) — ⚠️ **PARCIAL, con un hallazgo de diseño**

`eps_trend` devuelve la estimación actual y la de 7/30/60/90 días atrás:

```json
{"date": "2026-09-30", "period": "current_quarter",
 "current_estimate": 1.97754, "7_days_ago": 1.97656,
 "30_days_ago": 1.97656, "60_days_ago": 2.00825, "90_days_ago": 2.00801}
```

**Lo que esto ES:** prueba de que el proveedor **retiene** el consenso pasado y no
sólo el actual. La estimación se movió de 2.008 → 1.977 en 90 días; ese movimiento es
real y observable.

**Lo que esto NO es:** un archivo consultable. Es una ventana **rodante de 90 días
relativa a hoy**. No existe forma de preguntar *"¿cuál era el consenso el
2024-03-15?"*. Para un backtest profundo, **EX-4 no se satisface**.

> ### 💡 HALLAZGO: la cadencia diaria convierte esta limitación en capacidad
>
> El requisito del usuario —*"las noticias deben obtenerse y buscarse diariamente"*—
> tiene una consecuencia que va más allá de las noticias:
>
> **Si el job diario captura también `eps_trend`, el sistema construye su propio
> archivo de consenso *as-of*, con un `available_at` que es real y nuestro** (la
> fecha de captura), no uno reconstruido a posteriori por un tercero.
>
> Esto **satisface EX-4 hacia adelante** de la forma metodológicamente más limpia
> posible: el dato queda fechado por observación directa, no por reconstrucción.
>
> **No resuelve el pasado.** El histórico anterior al arranque del sistema sigue
> sujeto al problema de arranque en frío (DATA_REQUIREMENTS §1.2). Pero convierte
> "capturar consenso a diario" de tarea opcional en **requisito de arquitectura**:
> cada día no capturado es un agujero permanente e irrecuperable en el archivo.

---

### 1.5 NOTICIAS — 🔴 **RECHAZADO**

Esta es la conclusión más importante del documento, y la evidencia es inequívoca.

#### Lo que sí cumple

| Criterio | Resultado |
|---|---|
| **OP-6 — timestamp con hora + TZ** | ✅ `"datetime": "2026-05-28T13:45:00Z"` |
| Campo `language` | ✅ presente |
| Rango de fechas aceptado | ✅ el parámetro funciona |

**OP-6 se satisface.** Es el bloqueante nº1 de `DATA_REQUIREMENTS`, y aquí se cumple.

#### Por qué se rechaza igualmente

**(a) Densidad inservible.** Tres llamadas para AAPL —la empresa más cubierta del
planeta— devuelven como **más reciente** una pieza del **2026-05-28**. Hoy es
2026-09-14: **3½ meses sin una sola entrada.** Un sistema de alertas diarias sobre
esta fuente no tendría nada que procesar la inmensa mayoría de los días.

**(b) El archivo histórico está vacío.** La ventana 2026-03-01 → 2026-03-08 devolvió
`"press_releases": []`. No es que falte profundidad: es que **no hay densidad**.

**(c) No son noticias — son comunicados de prensa.** La propia clave de la respuesta
lo dice: `press_releases`. Y el contenido lo confirma:

> `"**_FN Media Group Presents Oilprice.com Market Commentary_**"`

Eso es **publirreportaje pagado**. En la jerarquía de la spec (§3) no alcanza
siquiera Tier 4: un agregador al menos redistribuye periodismo; esto es material
promocional. Usarlo como señal de evento significaría que **cualquiera que pague una
nota de prensa puede disparar una alerta en el portafolio del usuario.**

**(d) La relevancia por símbolo es nominal.** De 3 resultados para `AAPL`:

| Titular | Tema real | Relación con AAPL |
|---|---|---|
| "The Rare Earth Race Has a New Front-Runner" | REalloys (ALOY) | ninguna |
| "Trump zu Staatsbesuch in Beijing eingetroffen" | Viaje de Trump — **en alemán** | ninguna |
| "Why Rare Earth Magnets are the World's Most Dangerous Bottleneck" | REalloys (ALOY) | aparece en una lista de *"companies mentioned"* |

Ninguna de las tres trata sobre Apple. El filtro por símbolo parece ser
coincidencia de texto sobre el cuerpo del comunicado, no atribución real de entidad.
Alimentar el analizador de sentimiento con esto produciría un sentimiento de Apple
derivado de **una nota en alemán sobre geopolítica**.

**(e) Sin tiers ni verificación.** No hay campo de fuente utilizable para la
jerarquía Tier 1–4, ni forma de detectar sindicación (NR-1/NR-2).

#### Veredicto

> **RECHAZADO como fuente de noticias.** No por un gap subsanable, sino porque la
> categoría del dato es otra: es un feed de comunicados promocionales, no de noticias
> de mercado. **Ningún parámetro de configuración lo convierte en lo que el sistema
> necesita.**
>
> El requisito diario del usuario **no se puede satisfacer con este proveedor.**

---

### 1.6 MACRO — ❌ **NO APLICA**

El proveedor declara fuera de alcance: **índices** (VIX, DXY), **renta fija**
(curva 2s10s, spreads high-yield) y opciones. Confirma lo detectado en
`AUDIT.md` CONF-3.

**Cobertura estimada: ~2.5 de 11 variables de régimen** (`oil`, `gold`, y
`sp500_trend_20d` sólo vía proxy SPY).

Y aun para esas: no ofrece `release_type`, `revision_number` ni `release_timestamp`
(MA-1/MA-2), porque **no es un proveedor de series macroeconómicas**. Los dos
bloqueantes duros de la spec quedan **sin cubrir por esta vía**.

---

## 2. TABLA RESUMEN — TWELVE DATA

| Categoría | Veredicto | Bloqueantes satisfechos |
|---|---|---|
| **Precios** | ✅ **APROBADO** (sujeto a verificación de splits) | PR-1, PR-2, OP-1, OP-2 |
| **Consenso earnings** | ✅ **APROBADO con gap** | EX-1 ✅ · EX-2 🔴 · EX-4 ⚠️ parcial |
| **Noticias** | 🔴 **RECHAZADO** | OP-6 ✅ pero densidad, tier y relevancia inviables |
| **Macro** | ❌ **NO APLICA** | MA-1 🔴 · MA-2 🔴 |

---

## 3. CATEGORÍAS SIN EVALUAR — ESTADO HONESTO

> **Estas categorías NO tienen evaluación.** No se presenta ninguna puntuación,
> porque no se ejecutó ninguna llamada. Conforme a la Regla 4 de la spec
> (*"un número que no puedes defender no se imprime"*), una evaluación no realizada
> no se documenta como realizada.

### 3.1 Noticias — candidatos a evaluar

Twelve Data queda descartado, así que **la categoría entera está sin resolver**.

Perfiles necesarios (dos capacidades distintas, §1.2 de los requisitos):

| Necesidad | Qué debe aportar |
|---|---|
| **Flujo diario** | Cobertura densa, `published_at` intradía, consulta por rango |
| **Archivo histórico** | Profundidad 3–5+ años para sembrar el matching |
| **Tier 1** | Fuentes oficiales (Fed, SEC, BLS, emisores) — elevan `verification_level` |

**Candidatos identificados — todos `NO VERIFICADO`, bloqueados por §0:**

| Candidato | Perfil | Atractivo teórico | Riesgo principal |
|---|---|---|---|
| SEC EDGAR (API pública) | Tier 1 | Timestamps de aceptación muy precisos; gratuito | Sólo emisores US; no es "noticia" sino filing |
| Fed / BLS (feeds oficiales) | Tier 1 | Fuente primaria de los eventos macro que más importan | Volumen bajo; formatos heterogéneos |
| GDELT | Archivo + flujo | Histórico masivo, gratuito, consulta por ventana | Calidad heterogénea; tier bajo; ruido alto |
| Agregadores comerciales | Flujo | Cobertura amplia | 🔴 **NR-4**: suelen prohibir el almacenamiento persistente |

> ⚠️ **NR-4 es el riesgo silencioso de esta categoría.** Varios agregadores permiten
> *mostrar* pero no *retener* el texto. Este sistema **construye un archivo por
> diseño**. Si la licencia lo prohíbe, el proveedor es inviable por más que sus datos
> encajen. **Revisar T&C antes que cualquier prueba técnica.**

### 3.2 Macro — candidatos a evaluar

**La categoría con los dos bloqueantes más duros (MA-1 historial de revisiones,
MA-2 `release_timestamp`) no tiene ningún candidato evaluado.**

El requisito diferenciador es el **dato *vintage***: poder preguntar *"¿qué valor de
PIB estaba publicado el 2024-03-15?"* y recibir la cifra vigente **entonces**, no la
revisada después. Un proveedor que sólo entrega la serie actual **es inservible para
backtesting**, por completa que sea.

| Candidato | Por qué es candidato | Estado |
|---|---|---|
| FRED / ALFRED (Reserva Federal de St. Louis) | ALFRED existe **específicamente** para series *vintage* (valores as-of). Cubriría MA-1 y MA-2, y la mayoría de las 11 variables. | 🔴 **NO VERIFICADO** — inalcanzable (§0) |
| Fuentes primarias (BLS, BEA, Fed H.15) | Origen de los datos; calendarios de publicación oficiales | 🔴 **NO VERIFICADO** |
| Proveedores comerciales de macro | Cobertura integrada | 🔴 **NO VERIFICADO** — costo |

> **No se recomienda ninguno todavía.** Elegir ahora repetiría exactamente el
> antipatrón *"arquitectura secuestrada por una API"*. La decisión exige las llamadas
> reales que §0 impide.

---

## 4. ESTADO DE LOS BLOQUEANTES

| ID | Requisito | Estado | Cubierto por |
|---|---|---|---|
| **OP-6** | `available_at` intradía (noticias) | ⚠️ **satisfecho por un proveedor rechazado por otros motivos** | — |
| **MA-1** | Historial de revisiones macro | 🔴 **SIN EVALUAR** | ninguno |
| **MA-2** | `release_timestamp` macro | 🔴 **SIN EVALUAR** | ninguno |
| **EX-1** | Sorpresa de earnings | ✅ **RESUELTO** | Twelve Data |
| **EX-2** | `consensus_available_at` | 🔴 gap abierto | — |
| **EX-4** | Consenso *as-of* | ⚠️ resoluble **hacia adelante** vía captura diaria (§1.4) | Twelve Data + job diario |
| **PR-4** | Sin ajuste retroactivo | ⚠️ indicios favorables, **verificación pendiente** | Twelve Data |
| **§1.2** | Archivo histórico de noticias | 🔴 **SIN RESOLVER** | ninguno |

---

## 5. PUNTO A4 — ESCALAMIENTO 🔴

Se activa el punto de escalamiento de `DATA_REQUIREMENTS.md` §6, **pero conviene ser
preciso sobre su causa**, porque no es la que la spec anticipaba:

> La spec previó *"ningún proveedor satisface el requisito"*.
> La situación real es ***"la evaluación no puede ejecutarse desde este entorno"***.

Son cosas distintas y llevan a decisiones distintas. **No hay evidencia de que los
requisitos sean insatisfacibles** — hay evidencia de que no pueden comprobarse aquí.

### Lo que SÍ quedó resuelto con evidencia

- ✅ Precios: fuente sólida, 46 años de profundidad
- ✅ Sorpresa de earnings: **obtenible hoy**, mapea 1:1 con la spec
- ✅ El requisito diario del usuario **refuerza** la metodología (§1.4), no la estorba
- ✅ Twelve Data descartado como fuente de noticias **con pruebas**, no por sospecha

### Lo que bloquea FASE 2

1. 🔴 **Fuente de noticias** — sin ella no hay capa 1, y sin capa 1 no hay producto.
2. 🔴 **Fuente macro con datos *vintage*** — sin ella, LEY 2 es incumplible y todo
   backtest queda inválido.

Conforme a la Regla 3 (*"si un requisito de datos no se puede satisfacer, ESCALA —
no improvises un workaround"*): **se detiene FASE 2 y se escala al usuario.**

### Lo que se necesita para desbloquear

| Opción | Qué implica |
|---|---|
| **A. Ampliar la política de red** del entorno a los dominios candidatos | Permite ejecutar A2 completo aquí mismo |
| **B. Conectar MCPs** que cubran noticias y/o macro | Ruta ya probada — así se evaluó Twelve Data |
| **C. Aportar API keys** + habilitar sus dominios | Equivale a A, por proveedor |

> **Lo que NO se va a hacer:** elegir proveedor por reputación, construir sobre una
> fuente sin `available_at` verificado, o sembrar el histórico con datos de calidad
> desconocida. Cualquiera de las tres invalidaría el sistema entero desde la capa de
> datos — que es precisamente lo que la Regla 3 previene.

---

## 6. SIGUIENTE

- **A3** — ADRs de lo ya decidible: precios y sorpresa de earnings (decisión con
  evidencia), y el rechazo de Twelve Data para noticias.
- **A2-bis** — completar noticias y macro **cuando se desbloquee el acceso**.
- **FASE 2** — bloqueada hasta cerrar MA-1/MA-2 y la fuente de noticias.
