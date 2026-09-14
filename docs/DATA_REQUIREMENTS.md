# DATA_REQUIREMENTS.md — FASE 1 / Bloque A1

**Fecha:** 2026-09-14
**Spec:** PROMPT MAESTRO v3.0 — FASE 1
**Estado:** requisitos escritos **antes** de evaluar proveedores (orden exigido por §5/FASE 1)

> **Regla de este documento:** describe lo que el sistema NECESITA, no lo que algún
> proveedor ofrece. Ningún nombre comercial aparece en las secciones 1–6. La
> confrontación con candidatos reales ocurre en `PROVIDER_EVALUATION.md` (A2).

---

## 0. REQUISITO OPERATIVO TRANSVERSAL: CADENCIA DIARIA

**Requisito del usuario:** *"las noticias deben obtenerse y buscarse diariamente
para continuar todos los procesos ya estipulados"*.

Esto no es una preferencia de scheduling: **cambia requisitos duros sobre los datos.**

| ID | Requisito | Por qué |
|---|---|---|
| **OP-1** | Consulta por **rango de fechas explícito** (`desde`/`hasta`), no solo "últimas N noticias" | Un barrido diario debe pedir *exactamente* la ventana del día anterior. Sin rango, no hay forma de recuperar un día perdido. |
| **OP-2** | **Recuperación de huecos**: poder reconsultar una ventana pasada arbitraria | Si el job falla el martes, el miércoles debe poder recuperar martes + miércoles. Sin esto, cada caída deja un agujero **permanente** en el histórico. |
| **OP-3** | **Idempotencia**: reejecutar la misma ventana no debe duplicar eventos | El job puede reintentarse. La dedup (capa 2) debe ser estable ante reingesta. |
| **OP-4** | Rate limits y costo que toleren el **volumen diario sostenido** más picos de recuperación | Recuperar 7 días caídos = 7× el volumen normal en una sola ejecución. El límite debe absorberlo. |
| **OP-5** | Determinismo razonable: la misma ventana consultada dos veces debe devolver *sustancialmente* el mismo conjunto | Si el proveedor reescribe su histórico, el backtest deja de ser reproducible. |

### OP-6 — El requisito que la cadencia diaria vuelve crítico 🔴

> **`available_at` debe provenir del proveedor con precisión intradía. NUNCA puede
> derivarse de la hora en que corre el job de ingesta.**

Con ingesta diaria, `ingested_at` será siempre "03:00 del día siguiente" para todas
las noticias de la jornada. Si se usara ese valor como `available_at`:

- todas las noticias del día colapsarían al **mismo instante**,
- su orden real se perdería,
- y el sistema no podría distinguir una noticia publicada **antes** de la apertura
  de una publicada **después** del cierre.

Para un evento macro intradía (un dato de CPI a las 08:30, una decisión de la Fed a
las 14:00) esa distinción **es** el análisis. Sin ella, la LEY 1 se cumple sólo en
apariencia: el filtro `available_at <= T` pasaría, pero estaría comparando contra un
timestamp fabricado por nuestra infraestructura, no por la realidad.

**Granularidad mínima aceptable: minuto, con zona horaria explícita.**
Una fecha sin hora (`2026-09-14`) es **insuficiente** para noticias y para macro.

---

## 1. CATEGORÍA: NOTICIAS

### 1.1 Campos obligatorios

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `title` | string | ✅ | |
| `body` / `description` | string | ✅ | Debe conservar cifras y símbolos (`$`, `%`, `€`). Ver 1.5. |
| `published_at` | timestamp **con hora + TZ** | ✅ 🔴 | → `available_at`. Ver OP-6. |
| `source_name` | string | ✅ | Para asignar tier (§3 de la spec). |
| `source_domain` | string | ✅ | El nombre no identifica de forma fiable; el dominio sí. |
| `url` | string | ✅ | Clave de dedup y auditoría. |
| `language` | string | ✅ | Filtrado; evita comparar entre idiomas. |
| `tickers` / entidades | array | ⭕ deseable | Si no viene, se extrae localmente (peor calidad). |
| `原` / `is_syndicated` | bool/string | ⭕ deseable | Marca de cable redistribuido. Ver 1.3. |

### 1.2 Profundidad histórica — y el problema de arranque 🔴

El matching histórico (capa 5) necesita **N eventos comparables bajo régimen macro
similar**. Con `minHistoricalEvents` en el orden de 10–30 por tipo de evento, y
considerando que un régimen macro concreto (p. ej. "inflación alta + curva
invertida") puede durar 12–24 meses, la ventana necesaria es de **años, no meses**.

| Horizonte | Veredicto |
|---|---|
| < 3 meses | ❌ inservible para matching |
| 1 año | ⚠️ cubre ~1 régimen macro. Insuficiente para comparar entre regímenes. |
| **3–5 años** | ✅ **mínimo operativo** — cubre varios regímenes |
| 10+ años | ✅ ideal — incluye un ciclo completo de tasas |

> ### ⚠️ HALLAZGO: EL PROBLEMA DE ARRANQUE EN FRÍO
>
> **La ingesta diaria sólo acumula hacia adelante.** Si el proveedor no ofrece
> **archivo histórico consultable**, el sistema arranca con cero comparables y
> tarda *años* en producir su primera salida defendible.
>
> Esto crea un requisito que es fácil pasar por alto: se necesitan **dos
> capacidades distintas**, y un proveedor puede tener una sin la otra.
>
> | Capacidad | Para qué | ¿Sustituible? |
> |---|---|---|
> | **Flujo diario** | Alimentar el sistema día a día (OP-1..5) | No |
> | **Archivo histórico (backfill)** | Sembrar el histórico para que el matching funcione **desde el día 1** | No |
>
> Pueden cubrirse con **proveedores distintos** — pero entonces sus semánticas de
> timestamp deben ser conciliables, o el histórico y el flujo vivirán en escalas de
> tiempo incompatibles y el backtest cruzará peras con manzanas.

### 1.3 Dedup y sindicación

La spec (§3) exige que *"cinco artículos Tier 3 del mismo cable no sean cinco
confirmaciones"*. Requisitos derivados:

- **NR-1:** poder recuperar **múltiples fuentes para el mismo hecho** (si el proveedor
  ya deduplica y entrega una sola copia, se pierde la señal de corroboración —
  y la verificación por tier se vuelve inaplicable).
- **NR-2:** distinguir **originador** de **redistribuidor** cuando sea posible.

> Nota de diseño: un proveedor que "limpia duplicados" es **peor** para este sistema,
> no mejor. La multiplicidad de fuentes es la materia prima de la verificación.

### 1.4 Cobertura de fuentes por tier

Debe alcanzar **Tier 1** (Fed, SEC, BLS, emisores) y **Tier 2** (Reuters, Bloomberg,
FT, WSJ). Un agregador que sólo devuelva Tier 3–4 no permite elevar
`verification_level` por encima de `corroborated`, capando la calidad de toda salida.

### 1.5 Fidelidad del texto

**NR-3:** el texto debe llegar **sin sanitización destructiva**. Los símbolos `$`,
`%`, `€`, `£` y los separadores decimales son la materia prima de la sorpresa (§2).

*Origen del requisito: en la auditoría (AUDIT.md §3/V-7) se detectó que
`cleanText()` los borraba activamente. Se consigna aquí para que no se repita.*

### 1.6 Licencia

**NR-4:** verificar explícitamente si los T&C permiten **almacenar** el texto de forma
persistente. Varios proveedores permiten *mostrar* pero no *retener*. Un sistema que
construye un archivo histórico propio **retiene por diseño** — si la licencia lo
prohíbe, la arquitectura completa es inviable con ese proveedor.

---

## 2. CATEGORÍA: PRECIOS

Necesarios para (a) medir la reacción observada en T+1d/7d/30d (capa 9) y (b) calcular
σ del régimen para clasificar escenarios (§4).

| ID | Requisito | Detalle |
|---|---|---|
| **PR-1** | OHLCV diario | Mínimo. |
| **PR-2** | Profundidad ≥ **10 años** | σ por régimen requiere muchos regímenes. |
| **PR-3** | **Precios ajustados** por splits y dividendos | Un split no ajustado es un −50% ficticio que el sistema leería como reacción bajista. |
| **PR-4** | 🔴 **Ajuste no retroactivo, o splits consultables por separado** | Ver PR-4 ampliado. |
| **PR-5** | Cobertura: acciones US, ETFs, FX, commodities | Los ETFs son el proxy de índices (ver MA-4). |
| **PR-6** | Datos intradía | ⭕ deseable — permitiría medir reacción a horas del evento, no sólo al cierre. |

### PR-4 ampliado — la trampa del ajuste retroactivo 🔴

Los precios ajustados **se reescriben hacia atrás** cada vez que ocurre un split o
dividendo. Un backtest de 2021 ejecutado hoy vería precios que **nadie pudo observar
en 2021**.

Esto es **LEY 2 aplicada a precios**, y es un caso que la spec menciona sólo para
macro. Se consigna explícitamente porque es igual de corrosivo y mucho menos obvio.

**Requisito:** o bien el proveedor entrega precios **sin ajustar** junto con el
**calendario de splits/dividendos con sus fechas** (permitiendo reconstruir la serie
vigente en T), o bien se documenta como gap aceptado y **se prohíbe** usar precios
ajustados en cualquier cálculo que alimente el matching.

---

## 3. CATEGORÍA: MACRO (RÉGIMEN)

Las 11 variables de §3 de la spec. **Esta es la categoría con requisitos más estrictos
y la que la auditoría marcó como peor cubierta (AUDIT.md CONF-3).**

| Variable | Tipo | Criticidad |
|---|---|---|
| `fed_funds_rate` | tasa de política | 🔴 |
| `inflation_yoy` | índice, **revisable** | 🔴 |
| `unemployment` | índice, **revisable** | 🔴 |
| `gdp_growth` | índice, **fuertemente revisable** | 🔴 |
| `yield_curve_2s10s` | derivado de renta fija | 🔴 |
| `vix` | índice de volatilidad | 🔴 |
| `high_yield_oas` | spread de crédito | 🟠 |
| `usd_index` | índice FX | 🟠 |
| `oil`, `gold` | commodities | 🟠 |
| `sp500_trend_20d` | derivado de precios | 🟠 |

### 3.1 Requisitos bloqueantes

| ID | Requisito | Estado spec |
|---|---|---|
| **MA-1** | 🔴 **Historial de revisiones**: valor del *release inicial* + cada revisión con su fecha | **BLOQUEANTE (LEY 2)** |
| **MA-2** | 🔴 **`release_timestamp`** por publicación, con hora | **BLOQUEANTE (LEY 1/6)** |
| **MA-3** | Profundidad ≥ 10 años | |
| **MA-4** | Cobertura de índices y renta fija, o sustituto documentado | Ver 3.2 |

**MA-1 y MA-2 son los bloqueantes duros de §5/FASE 1.** Si ninguna fuente los
satisface, se escala y **no se construye encima** (punto A4).

> **Por qué MA-1 no es negociable:** el PIB del Q1 se publica ~3 veces con valores
> distintos a lo largo de meses. Un backtest que use la cifra final para una fecha
> anterior a esa revisión está leyendo el futuro. La spec lo llama *"look-ahead
> disfrazado"* — es el más difícil de detectar porque **no rompe nada**: simplemente
> produce resultados mejores de lo que la realidad permitía.

### 3.2 Sustitución por proxy — condiciones

`vix`, `usd_index`, `yield_curve_2s10s` y `high_yield_oas` suelen requerir datos de
índices o renta fija. Si la fuente elegida no los cubre, un proxy vía ETF es
**aceptable sólo si**:

1. queda registrado en un ADR con el error de tracking asumido,
2. el proxy se usa de forma consistente en histórico y en vivo (nunca el índice real
   para el histórico y el proxy para lo nuevo — eso introduce un salto artificial),
3. la variable se marca como `proxied: true` en el snapshot macro, de modo que la
   degradación sea **visible en la salida**, no silenciosa.

---

## 4. CATEGORÍA: CONSENSO / EXPECTATIVAS

La spec (§2) la declara *"campo de primera clase"*. La auditoría la encontró
**totalmente ausente** (V-7). Es la categoría **más difícil de obtener** y la que más
probablemente obligue a recortar alcance.

| ID | Requisito | Criticidad |
|---|---|---|
| **EX-1** | `consensus_value` previo al release | 🔴 sin esto no hay sorpresa |
| **EX-2** | 🔴 **`consensus_available_at`** — cuándo se publicó **el consenso** | 🔴 LEY 6 |
| **EX-3** | `consensus_source` | 🟠 auditabilidad |
| **EX-4** | **Consenso histórico** (el vigente *entonces*, no el reconstruido hoy) | 🔴 LEY 1 |
| **EX-5** | Dispersión de estimaciones (desv. típica) | ⭕ habilita `surprise_zscore` |

### 4.1 Dos subcategorías con disponibilidad muy distinta

| Subcategoría | Ejemplo | Disponibilidad esperada |
|---|---|---|
| **Consenso de earnings** (EPS, ingresos) | EPS est. $2.10 vs real $2.40 | 🟢 relativamente común |
| **Consenso macro** (CPI, nóminas, Fed) | CPI est. 3.2% vs real 3.4% | 🔴 escaso y caro |

**EX-4 es el requisito que más proveedores incumplen en silencio:** muchos exponen el
consenso *actual*, y al consultar una fecha pasada devuelven el consenso **tal como se
ve hoy**. Es look-ahead puro y **no es detectable leyendo la documentación** — sólo se
descubre comparando la misma consulta histórica en dos momentos distintos, o
verificando que el consenso venga acompañado de su propio timestamp de publicación.

### 4.2 Degradación aceptable

Si el consenso macro resulta inviable, la degradación **debe ser explícita**:

- eventos **sin** `expectations` se marcan `surprise_available: false`;
- **no** se comparan contra eventos que sí la tienen (§2: el signo de sorpresa es
  filtro duro — un evento sin sorpresa no tiene signo que filtrar);
- la alerta declara que el análisis carece de la dimensión de sorpresa.

**Prohibido:** imputar, estimar o inferir un consenso ausente. Un consenso inventado
es peor que ninguno, porque se propaga al matching como si fuera un hecho.

---

## 5. MATRIZ DE CRITERIOS DE EVALUACIÓN (para A2)

Cada candidato se puntúa contra esto, con **evidencia de llamadas reales** en
`/fixtures`. Documentación del proveedor **no** cuenta como evidencia.

| # | Criterio | Peso | Método de verificación |
|---|---|---|---|
| 1 | `available_at` / `release_timestamp` con hora + TZ | 🔴 **BLOQUEANTE** | Inspeccionar la respuesta cruda. ¿Hora o sólo fecha? |
| 2 | Historial de revisiones (macro) | 🔴 **BLOQUEANTE** | Consultar una serie con revisión conocida (p. ej. PIB) y ver si devuelve las versiones |
| 3 | Consenso histórico *as-of* (EX-4) | 🔴 | Consultar un consenso de fecha pasada; verificar que trae su propio timestamp |
| 4 | Profundidad histórica real | 🔴 | Pedir la fecha más antigua disponible y comprobarla |
| 5 | Consulta por rango de fechas (OP-1/OP-2) | 🔴 | Ejecutar una consulta de ventana pasada |
| 6 | Cobertura de campos vs §1–4 | 🟠 | Diff campo a campo contra este documento |
| 7 | Rate limit vs carga diaria + recuperación | 🟠 | Leer límites; estimar volumen |
| 8 | Licencia de **almacenamiento** (NR-4) | 🟠 | Leer T&C |
| 9 | Costo a volumen diario sostenido | 🟠 | |
| 10 | Estabilidad / determinismo (OP-5) | 🟡 | Repetir una consulta idéntica |

---

## 6. CRITERIOS DE ESCALAMIENTO (punto A4)

Se **detiene la construcción** y se escala al usuario si, tras evaluar los candidatos:

| Condición | Consecuencia |
|---|---|
| Ninguna fuente de noticias da `published_at` con **hora** (OP-6) | 🔴 LEY 1 incumplible para eventos intradía → escalar |
| Ninguna fuente macro da **historial de revisiones** (MA-1) | 🔴 **Bloqueante explícito de la spec** → escalar |
| Ninguna fuente macro da `release_timestamp` (MA-2) | 🔴 LEY 2 incumplible → escalar |
| Ninguna fuente de noticias ofrece **archivo histórico** (§1.2) | 🟠 El sistema no puede arrancar en frío → escalar con opciones |
| Consenso macro inviable (EX-1/EX-4) | 🟠 Degradar §4.2 de forma explícita y documentada, **no** escalar |

> Conforme a la Regla 3 de la spec: *"Si un requisito de datos no se puede satisfacer,
> ESCALA — no improvises un workaround. Un workaround silencioso en la capa de datos
> invalida todo el sistema aguas arriba."*

---

## 7. RESUMEN: BLOQUEANTES

| ID | Requisito | Categoría |
|---|---|---|
| **OP-6** | `available_at` con precisión intradía, del proveedor — nunca del job | Noticias, Macro |
| **MA-1** | Historial de revisiones macro (initial + revisiones) | Macro |
| **MA-2** | `release_timestamp` por publicación macro | Macro |
| **EX-4** | Consenso histórico *as-of*, no reconstruido | Consenso |
| **PR-4** | Precios sin ajuste retroactivo, o splits reconstruibles | Precios |
| **§1.2** | Archivo histórico de noticias (arranque en frío) | Noticias |

**Siguiente:** A2 — evaluación con llamadas reales contra la matriz §5.
