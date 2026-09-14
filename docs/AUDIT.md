# AUDIT.md — FASE 0

**Fecha:** 2026-09-14
**Auditor:** Claude Code
**Spec de referencia:** PROMPT MAESTRO v3.0
**Código auditado:** `leoglezg/Prueba-Claude` @ `5927649` ("Add implementation phases and roadmap")
**Repo destino del trabajo:** `leoglezg/InvestingApp` @ `claude/market-news-alerts-analyzer-d09nq4`

---

## 0. RESUMEN EJECUTIVO

Se auditaron 2,758 líneas (1,487 de código fuente, 1,271 de documentación) repartidas en 19 archivos.

**Conclusión de primer orden, antes de cualquier análisis metodológico:**

> **El sistema nunca ha ejecutado.** No es un sistema en producción con deuda técnica: es un esqueleto que contiene **cinco defectos fatales de carga/ejecución** que impiden que el proceso arranque o que el esquema se cree. Ninguna de las métricas que produce ha existido jamás como número real.

Esto cambia la naturaleza del refactor. No hay que preservar comportamiento en producción, porque no hay producción. **La buena noticia:** no hay datos contaminados que migrar ni usuarios que dependan de salidas erróneas.

**Conclusión de segundo orden:** el código viola **las 6 leyes inviolables, sin excepción**, y omite por completo la Sección 2 (sorpresa vs expectativa), que la spec define como "la pieza que faltaba". Las capas 9, 10 y 11 (observación, validación, recalibración) —es decir, **todo el aprendizaje**— no existen.

**Veredicto agregado:** de 14 módulos, **2 CUMPLEN parcialmente, 6 REFACTOR, 4 REEMPLAZAR, 2 ELIMINAR**. Ninguno cumple íntegramente.

---

## 1. INVENTARIO: CÓDIGO EXISTENTE → CAPAS DE LA SPEC (§3)

| # | Capa de la spec | Módulo(s) existente(s) | Estado |
|---|---|---|---|
| 1 | INGESTA | *ninguno* | ❌ **AUSENTE** — no hay cliente de ningún proveedor. `server.js` recibe noticias por `POST` manual. Las API keys están configuradas pero nunca se usan. |
| 2 | DEDUPLICACIÓN | `newsProcessor.isDuplicate()` | ⚠️ **ROTA** — dedup por hash exacto de `título+fuente+fecha`. No agrupa N noticias → 1 evento. Además el SQL falla siempre (§3.C). |
| 3 | ANÁLISIS DE EVENTO | `eventAnalyzer.js`, `newsProcessor.classifyEventType()` | ⚠️ **PARCIAL** — hay tipo, sentimiento, magnitud, activos. **Falta SORPRESA por completo.** |
| 4 | SNAPSHOT MACRO | *ninguno* | ❌ **AUSENTE** — cero tablas, cero código. Las 11 variables de régimen no existen. |
| 5 | MATCHING HISTÓRICO | `patternAnalyzer.js` | ⚠️ **PARCIAL E INVÁLIDO** — similitud con pesos hardcodeados, sin distancia macro, sin sorpresa, sin filtro temporal. |
| 6 | ESCENARIOS | `scenarioEngine.js` | ❌ **INVÁLIDO** — produce "probabilidades" inventadas, no frecuencias observadas. Sin distribución ni percentiles. |
| 7 | IMPACTO PORTAFOLIO | `user_portfolio` (tabla, sin código) | ❌ **AUSENTE** — la tabla existe; ningún módulo la lee. |
| 8 | ALERTA | `alertEngine.js` | ⚠️ **TRANSPORTE OK / CONTENIDO INVÁLIDO** — Telegram y email funcionan conceptualmente; el contenido viola LEY 5. |
| 9 | OBSERVACIÓN (T+1/7/30) | `learning_feedback` (tabla huérfana) | ❌ **AUSENTE** — tabla declarada, **cero código la escribe o lee**. |
| 10 | VALIDACIÓN (Brier) | *ninguno* | ❌ **AUSENTE** — cero Brier, cero calibración, cero accuracy direccional. |
| 11 | RECALIBRACIÓN | *ninguno* | ❌ **AUSENTE** — `ml:train` apunta a `src/ml/train.js`, archivo **que no existe**. |

**Cobertura real de la arquitectura: 3 de 11 capas implementadas parcialmente. 0 de 11 completas.**

El objetivo declarado por el usuario —*"aprender con el tiempo a tomar cada vez mejores decisiones"*— corresponde a las capas 9–11. **Ninguna existe.** El sistema no aprende nada; el nombre `learning_feedback` es aspiracional.

---

## 2. VEREDICTO POR MÓDULO

| Módulo | LOC | Veredicto | Justificación |
|---|---|---|---|
| `src/database/connection.js` | 40 | **REFACTOR** | El pool `pg` está correctamente configurado (límites, timeouts, handler de error). Pero exporta `query()` cruda, que es **el vector exacto por el que se viola LEY 1**: 6 módulos la llaman sin filtro temporal. Debe dejar de exportarse y quedar encapsulada tras `asOf(T)`. |
| `src/database/schema.sql` | 134 | **REEMPLAZAR** | Sintaxis inválida en PostgreSQL (§3.C-1) → nunca se ejecutó. Faltan las 3 columnas de reloj en todas las tablas, la tabla macro bitemporal, los tiers de fuente y la sorpresa. Reescritura total. |
| `src/config/index.js` | 54 | **REFACTOR** | Estructura sana (dotenv + objeto tipado). Dos problemas: (a) preselecciona NewsAPI/AlphaVantage/Finnhub sin FASE 1; (b) `similarityThreshold: 0.75` y `minHistoricalEvents: 10` son parámetros de negocio que deben vivir en `/config` versionado con `validation_status`, no en env vars sueltas. |
| `src/backend/services/newsProcessor.js` | 122 | **REFACTOR** | `cleanText()` y `classifyEventType()` son reutilizables. Pero: dedup SQL rota, dedup es noticia↔noticia (no noticia→evento), `cleanText` destruye `$`, `%` y `€` —**datos numéricos que la sorpresa necesita**—, y `originalPublishedAt` se captura pero nunca se persiste en columna. |
| `src/ml/analyzers/eventAnalyzer.js` | 120 | **REFACTOR** | El análisis de sentimiento vía `natural`/AFINN es una base defendible. Pero `eventMagnitudes` son 10 rangos hardcodeados sin justificación empírica, `extractAffectedAssets` usa una lista blanca de 11 símbolos, y **no hay sorpresa**. |
| `src/ml/patterns/patternAnalyzer.js` | 165 | **REEMPLAZAR** | Núcleo metodológicamente inválido: pesos hardcodeados (LEY 4), sin `macro_distance`, sin `surprise_alignment`, sin `weights_version`, y sobre todo **sin filtro `available_at <= T`** — hace match contra eventos futuros respecto a T (LEY 1). Más un `require()` fatal en ESM. |
| `src/ml/scenarios/scenarioEngine.js` | 148 | **REEMPLAZAR** | Viola LEY 3 en su núcleo conceptual: emite `probability` como constante literal ajustada heurísticamente. No hay frecuencia histórica, ni tamaño de muestra, ni distribución, ni percentiles p20/p10/p05. Los 5 tipos de escenario contradicen la definición de 3 clases de §4. |
| `src/backend/services/recommendationEngine.js` | 147 | **ELIMINAR** | **Explícitamente fuera de alcance** (spec §5 "FUERA DE ALCANCE"): emite `buy/sell/hold/reduce/increase` con `confidence` y `risk_level` sobre escenarios no validados. La spec: *"optimizar alrededor de señales aún no validadas amplifica el error en vez de reducirlo"*. |
| `src/backend/services/alertEngine.js` | 185 | **REFACTOR** | La capa de transporte (Telegram + nodemailer) se conserva. El contenido se reescribe: hoy emite `Confidence: 87%` sobre una métrica inventada y presenta recomendaciones prohibidas. Además inyecta HTML sin escapar (riesgo XSS en el cliente de correo). |
| `src/backend/server.js` | 156 | **REFACTOR** | Los 6 imports están rotos (§3.C-2) → no arranca. La orquestación también es incorrecta: llama a `recommendationEngine` (fuera de alcance) y `confidence: 0.8` está hardcodeado en L54. El andamiaje Express (helmet, cors, pino) se conserva. |
| `src/frontend/App.jsx` | 118 | **REFACTOR (diferido)** | Andamiaje de routing/estado aprovechable. Se difiere hasta que el backend emita el contrato correcto. |
| `src/frontend/pages/Dashboard.jsx` | 115 | **REFACTOR (diferido)** | Muestra `Confidence: {rec.confidence*100}%` (L102) — la métrica que viola LEY 5. `avg_sentiment*100` (L30) presenta un sentimiento [-1,1] como si fuera porcentaje. |
| `src/frontend/pages/Recommendations.jsx` | 97 | **ELIMINAR** | Es la UI de la capa fuera de alcance. Renderiza una **barra de progreso de "Confidence"** (L53-59) — la materialización visual exacta del antipatrón nº1. |
| `src/frontend/pages/EventsList.jsx` | 45 | **REFACTOR (diferido)** | El más sano del frontend. Solo debe cambiar la columna `Confidence` y añadir `available_at`. |

---

## 3. VIOLACIONES, ORDENADAS POR GRAVEDAD

### BLOQUEANTES DE INTEGRIDAD METODOLÓGICA

#### V-1 · LEY 1 (NO LOOK-AHEAD) — violación total 🔴

No existe `asOf(T)`. No existe `assertNoLookAhead()`. No existe `LookAheadViolationError`. Cero tests.

`connection.js` exporta `query()` cruda y **los 6 módulos la invocan directamente**. La consulta central de matching (`patternAnalyzer.js:14-27`) es:

```sql
SELECT * FROM historical_patterns
WHERE event_type = $1 AND ABS(sentiment_score - $2) < 0.3
  AND magnitude BETWEEN $3 AND $4
ORDER BY occurrences DESC, updated_at DESC
```

**No hay una sola cláusula temporal.** Al analizar un evento de 2023, este query devuelve patrones de 2025. Peor: `ORDER BY occurrences DESC` ordena por un contador que se **incrementa con eventos futuros** (`updatePattern`, L111-124). El ranking de similitud está contaminado por información posterior a T por construcción.

**Agravante:** `historical_patterns` no tiene *ninguna* columna de fecha del evento original — solo `created_at`/`updated_at` de la fila. Aunque quisiéramos filtrar por T, **el dato necesario no está almacenado**. No es un bug de query: es un defecto de modelo de datos.

#### V-2 · LEY 6 (RELOJ) — violación total 🔴

Ninguna de las 8 tablas tiene la tripleta obligatoria `event_time` / `available_at` / `ingested_at`.

| Tabla | Tiene | Falta |
|---|---|---|
| `events` | `created_at` (≈`ingested_at`), `processed_at` | `event_time`, **`available_at`** |
| `market_data` | `date` | `available_at`, `ingested_at` |
| `historical_patterns` | `created_at`, `updated_at` | las 3 |
| `scenarios`, `recommendations`, `alerts`, `learning_feedback` | `created_at` | las 3 |

`newsProcessor.js:16` sí captura `originalPublishedAt: rawNews.publishedAt` — el candidato natural a `available_at` — pero `saveProcessedNews` (L101) **nunca lo escribe en una columna**: queda enterrado en el blob `raw_data` JSONB, no indexable y no consultable de forma fiable.

V-1 y V-2 son un solo defecto: **sin V-2 resuelto, V-1 es irreparable.** Este es el bloqueante raíz de todo el sistema.

#### V-3 · LEY 2 (INICIAL vs REVISADO) — violación total 🔴

No existe tabla de datos macro. No existe `release_type`, `revision_number`, `initial_release_value`. Las 11 variables de régimen (`fed_funds_rate`, `inflation_yoy`, `yield_curve_2s10s`, `vix`, `high_yield_oas`…) **no aparecen en ninguna parte del código ni del esquema.**

Agravante estructural en `market_data`: `UNIQUE(symbol, date)` (L36) **fuerza sobrescritura** e impide por diseño el almacenamiento append-only que la ley exige.

#### V-4 · LEY 3 (FRECUENCIA ≠ PROBABILIDAD) — violación agravada 🔴

La spec prohíbe llamar "probabilidad" a una frecuencia histórica. **El código hace algo peor: llama "probabilidad" a una constante inventada.**

`scenarioEngine.createBaseScenarios()` (L28-82) asigna literales:

```js
scenarios.push({ type: 'bullish', probability: 0.5,  ... });   // L33
scenarios.push({ type: 'consolidation', probability: 0.3, ... }); // L41
scenarios.push({ type: 'bearish', probability: 0.5,  ... });   // L49
scenarios.push({ type: 'volatile', probability: 0.35, ... });  // L57
scenarios.push({ type: 'stable', probability: 0.6,  ... });    // L64
```

Luego se ajustan por heurística (L108-112):

```js
if (Math.sign(avgReturn) === Math.sign(scenario.expected_return)) {
  scenario.probability = Math.min(0.9, scenario.probability + 0.2);
} else {
  scenario.probability = Math.max(0.1, scenario.probability - 0.15);
}
```

Y se persisten en una columna llamada `probability FLOAT CHECK (probability >= 0 AND probability <= 1)` (`schema.sql:66`), donde son indistinguibles de una probabilidad real.

**Estos números no provienen de ningún dato.** El `0.2` y el `-0.15` no tienen origen empírico ni derivación. No existe `historical_frequency` ni `historical_sample_size` en todo el repositorio. El usuario recibiría por Telegram "Bullish: 70%" sin que ese 70% tenga relación alguna con lo que ocurrió históricamente.

**Además,** las probabilidades no suman 1 (0.5 + 0.3 = 0.8; 0.6 + 0.4 = 1.0; 0.5 + 0.35 = 0.85), lo que las descalifica incluso como distribución. Y los 5 tipos (`bullish/bearish/consolidation/volatile/stable`) contradicen las 3 clases mutuamente excluyentes de §4, haciendo el Brier multiclase **imposible de calcular** sobre esta salida.

#### V-5 · LEY 5 (CONFIANZA NO ES UN NÚMERO) — violación literal 🔴

`recommendationEngine.calculateConfidence()` (L70-76) es el antipatrón nº1 de la tabla §7, textualmente:

```js
calculateConfidence(scenario, event) {
  const scenarioConfidence = scenario.confidence / 10;   // heurística de tamaño de muestra
  const eventConfidence = event.confidence || 0.5;       // |score AFINN| / 5
  const probabilityFactor = Math.max(0.3, scenario.probability);  // constante inventada (V-4)
  return Math.min(1, (scenarioConfidence*0.4 + eventConfidence*0.3 + probabilityFactor*0.3));
}
```

Promedia ponderadamente **tres métricas de naturaleza incompatible** — una proxy de tamaño muestral, una intensidad léxica y una constante arbitraria — y emite un escalar 0–1 que se muestra al usuario como `Confidence: 87%` en Telegram (`alertEngine.js:55`), en el Dashboard (L102) y como **barra de progreso** en `Recommendations.jsx` (L53-59).

Segunda instancia, `patternAnalyzer`/`scenarioEngine.calculateProbabilityAdjustment()` (L143-145):

```js
return (historicalAccuracy * 0.6) + (patternSimilarity * 0.4);
```

Mezcla una métrica de acierto con una de distancia vectorial. *(Nota: esta función está **muerta** — nadie la llama.)*

No existe `AnalysisQualityReport` ni separación en las 4 dimensiones que exige la ley.

#### V-6 · LEY 4 (PESOS = HIPÓTESIS) — violación 🟠

`patternAnalyzer.calculateSimilarity()` (L60-80) hardcodea los 5 pesos en la lógica:

```js
if (sig1.event_type === sig2.event_type) score += 0.3;              // 0.30
score += (1 - Math.abs(Δsentiment)) * 0.2;                          // 0.20
score += (1 - Math.abs(Δmagnitude)/10) * 0.2;                       // 0.20
score += assetScore * 0.15;                                          // 0.15
score += keywordScore * 0.15;                                        // 0.15
```

No existe `config/similarity.weights.json`. No existe `validation_status`. No existe `weights_version` en `SimilarityMatch` — **es imposible saber qué configuración produjo un score histórico**, lo que hace la recalibración de FASE 3 irreproducible.

El umbral `0.75` sí está en env var (`config/index.js:49`), pero sin `validation_status` ni `last_validated_at`, y se aplica como umbral fijo, no adaptativo (0.60/0.70/0.75 según N).

**Defecto de diseño adicional:** el vector de similitud carece de 3 de los 7 componentes que exige el contrato `SimilarityMatch`: `surprise_alignment`, `macro_distance` y `volatility_regime`. En su lugar usa **solapamiento de keywords (15%)** — una heurística léxica sin fundamento económico. Comparar eventos por palabras compartidas equivale a comparar por estilo de redacción del periodista.

#### V-7 · §2 SORPRESA vs EXPECTATIVA — ausencia total 🔴

La spec la define como *"la pieza que faltaba"* y *"un campo de primera clase del evento, no un extra"*.

**No existe ni el concepto.** Cero `consensus_value`, cero `surprise_absolute`, cero `EventExpectations`. Ninguna tabla, ningún campo, ninguna función.

Consecuencia directa: el sistema no puede distinguir *"CPI 3.4% vs consenso 3.2%"* (sorpresa +0.2pp, reacción negativa) de *"CPI 3.4% vs consenso 3.6%"* (sorpresa −0.2pp, reacción positiva). Son el **mismo evento** para este código, y su regla de matching los declararía similares — precisamente el caso que §2 prohíbe como "matching sin sentido económico".

**Agravante oculto:** `newsProcessor.cleanText()` (L26-30) aplica `.replace(/[^\w\s\-.,!?]/g, '')`, que **destruye `$`, `%`, `€`, `£`** del texto. El pipeline actual borra activamente los símbolos donde vive la información numérica que la sorpresa necesita.

#### V-8 · JERARQUÍA DE FUENTES (TIERS) — ausencia total 🟠

`events.source` es un `VARCHAR(50)` plano. No existe `SourceTier`, ni `sources_by_tier`, ni `verification_level`, ni `has_tier1`.

La dedup por hash exacto (`título+fuente+fecha`) **no agrupa**: 5 despachos del mismo cable de Reuters con titulares ligeramente distintos generan **5 eventos independientes**, cada uno disparando su propia alerta. Es exactamente el antipatrón *"contar 5 artículos del mismo cable como 5 confirmaciones"*, materializado como 5 notificaciones de Telegram.

#### V-9 · ALCANCE — se construyó lo prohibido 🟠

`recommendationEngine.js` (147 LOC) + `Recommendations.jsx` (97 LOC) = **244 líneas dedicadas a la capa que §5 declara FUERA DE ALCANCE.** Emite `buy`/`sell`/`reduce` con `risk_level` calculado sobre escenarios cuya "probabilidad" es inventada (V-4) y cuya "confianza" es un promedio inválido (V-5).

Es la violación con **mayor potencial de daño real al usuario**: es lo único que llega a su teléfono.

#### V-10 · FASE 1 SALTADA 🟡

`config/index.js:20-33` preselecciona NewsAPI, Alpha Vantage y Finnhub. No existe `/docs/DATA_REQUIREMENTS.md` ni `/docs/PROVIDER_EVALUATION.md` ni ADRs. Ninguna evaluación de `available_at` ni de historial de revisiones — los dos requisitos que la spec marca como **bloqueantes duros**.

*(Nota de honestidad: en esta misma sesión conectamos Neon y Twelve Data por conveniencia, incurriendo en el mismo antipatrón. Ambos quedan degradados a **candidatos**, no a decisión. Ver §6.)*

---

### C. DEFECTOS FATALES DE EJECUCIÓN

Estos no son de metodología: impiden que el código corra. Son la evidencia de que **nunca se ejecutó**.

| # | Archivo | Defecto | Efecto |
|---|---|---|---|
| **C-1** | `schema.sql` (L18-20, 37, 57-58, 73, 89-91, 103-104, 117, 128) | `INDEX ... ON ...` **dentro** de `CREATE TABLE` es sintaxis MySQL. PostgreSQL no la admite. | 🔴 **El esquema entero falla.** Ninguna tabla se creó jamás. |
| **C-2** | `server.js` (L6-11) | Importa `{ newsProcessor }`, `{ eventAnalyzer }`, `{ patternAnalyzer }`, `{ scenarioEngine }`, `{ recommendationEngine }`, `{ alertEngine }` como *named exports*. Los módulos solo exportan la **clase** y un **default**. | 🔴 `SyntaxError: The requested module does not provide an export named...` → **el servidor no arranca.** Los 6 imports están rotos. |
| **C-3** | `newsProcessor.js` (L40) | `raw_data->>"hash"` — en PostgreSQL las comillas dobles son **identificadores**, no literales. Debe ser `'hash'`. | 🟠 El query lanza error → el `catch` (L44) devuelve `false` → **toda noticia se considera nueva. La deduplicación nunca funciona.** |
| **C-4** | `patternAnalyzer.js` (L161) | `require('crypto')` en módulo ESM (`"type": "module"`). | 🟠 `ReferenceError: require is not defined` al guardar cualquier patrón nuevo. *(Irónicamente `newsProcessor.js:2` sí lo hace bien con `import crypto`.)* |
| **C-5** | `package.json` (L11-13) | `db:migrate` → `src/database/migrate.js`, `worker` → `src/backend/workers/newsWorker.js`, `ml:train` → `src/ml/train.js`. | 🟠 **Los 3 archivos no existen.** No hay migraciones, ni worker de ingesta, ni entrenamiento. |

**Defectos menores adicionales:**
- `server.js:97-102` — al filtrar por `asset`, hace `params.unshift(asset)` dejando `[asset, limit]` contra placeholders `$1=asset, $2=limit`. Funciona por accidente, pero la construcción es frágil y `limit` entra como string sin validar.
- `alertEngine.js:122-170` — interpola `content.summary`, `content.source` y `content.url` en HTML **sin escapar** → XSS almacenado vía titular de noticia.
- `schema.sql:132` duplica un índice ya declarado inline.
- `eventAnalyzer.js:29` — `confidence = |score|/5` etiqueta intensidad léxica como "confianza", contribuyendo a V-5.

---

## 4. MÉTRICAS ENGAÑOSAS — CATÁLOGO

| Métrica | Dónde se muestra | Qué aparenta | Qué es realmente |
|---|---|---|---|
| `confidence` (recomendación) | Telegram, Dashboard L102, barra de progreso `Recommendations.jsx` L53-59 | Probabilidad de acierto | Promedio de 3 métricas incompatibles, una de ellas inventada (V-5) |
| `probability` (escenario) | `scenarios.probability`, API `/api/analyze-event` | Probabilidad del escenario | Literal hardcodeado ±0.2 heurístico. Sin origen empírico. No suma 1 (V-4) |
| `confidence` (escenario, 1–10) | `scenarios.confidence` | Calidad de la evidencia | `min(10, 6 + ceil(n/2))` — función del **conteo** de patrones, ignora dispersión, calidad y régimen |
| `confidence` (evento, 0–1) | `events.confidence`, EventsList L31 | Fiabilidad del análisis | `|AFINN score| / 5` — intensidad léxica. Un titular con muchas palabras cargadas parece "más fiable" |
| `expected_return` | Telegram, Dashboard L103 | Retorno esperado | `2 + (sentiment × 5)` — **fórmula lineal inventada**. Un sentimiento 0.8 "predice" +6.0% sin ningún dato detrás |
| `avg_sentiment` | Dashboard L30 como `%` | Porcentaje | Media de un score en [-1,1] renderizada como porcentaje. Un −0.3 se muestra como "−30%" |
| `risk_level` | Telegram, Recommendations L71 | Nivel de riesgo | `volatility×2 + magnitude/10×0.5` con cortes en 0.7/0.55/0.35/0.15 — 6 constantes mágicas sin derivación |
| `occurrences` | Orden del matching | Frecuencia histórica | Contador incrementado por eventos **futuros** respecto a T (V-1) |

**Constantes mágicas en lógica de negocio — inventario:** `0.3`/`0.2`/`0.2`/`0.15`/`0.15` (pesos de similitud), `0.5`/`0.3`/`0.35`/`0.6`/`0.4` (probabilidades base), `0.2`/`0.15` (ajustes), `0.6`/`0.4` (adjustment muerto), `0.4`/`0.3`/`0.3` (confianza), `0.7`/`0.55`/`0.35`/`0.15` (riesgo), `0.3`/`2` (umbrales SQL de matching), `6`/`2` (confianza por muestra), `5`/`2`/`2` (magnitud), `0.5` (corte de sentimiento), `/5` (normalización AFINN), `0.8` (confidence en `server.js:54`), `20 × {min,max}` (rangos de magnitud). **≈40 constantes**, ninguna en `/config`, ninguna auditable.

---

## 5. PLAN DE REFACTOR INCREMENTAL

**Principio rector:** el orden lo dicta la spec, no la conveniencia. **FASE 1 va antes que cualquier línea de pipeline.** Construir sobre un proveedor sin `available_at` verificado produciría un sistema imposible de backtestear — exactamente el bloqueante que §5/FASE 1 marca como motivo de escalamiento.

**Corolario:** los defectos C-1..C-5 **no se arreglan**. Pertenecen a módulos marcados REEMPLAZAR o a un esquema que se reescribe entero. Arreglarlos sería trabajo desechable.

### Bloque A — FASE 1: Viabilidad de datos *(sin código de producto)*

| Commit | Entregable | DoD |
|---|---|---|
| A1 | `docs/DATA_REQUIREMENTS.md` | Requisitos por categoría (noticias/precios/macro/consenso). Campos obligatorios, profundidad histórica, **semántica exacta de timestamps**, historial de revisiones, rate limits, licencia, costo. **Escrito antes de mirar ningún proveedor.** |
| A2 | `fixtures/` + `docs/PROVIDER_EVALUATION.md` | Matriz candidato × requisito con **respuestas reales guardadas**, no documentación. Mínimo 2–3 candidatos por categoría. Incluye Twelve Data y Neon como candidatos, sin trato preferente. |
| A3 | `docs/adr/001..004` | Un ADR por categoría con decisión, alternativas descartadas y **gaps aceptados escritos explícitamente**. |
| **A4** | **PUNTO DE ESCALAMIENTO** | Si ninguna fuente macro expone `available_at` real o historial de revisiones → **se detiene y se escala.** No se construye encima. |

### Bloque B — FASE 2: Cimientos temporales *(el núcleo de todo)*

| Commit | Entregable | DoD |
|---|---|---|
| B1 | `schema/001_temporal_core.sql` | Esquema nuevo, sintaxis PostgreSQL válida. Tripleta de reloj obligatoria (`NOT NULL`) en toda tabla. Macro bitemporal append-only con `release_type`/`revision_number`. Tiers de fuente. Tabla de expectativas/consenso. |
| B2 | `src/data/asOf.ts` + tests | **Único punto de acceso a datos.** `assertNoLookAhead()`, `LookAheadViolationError`. Test obligatorio: leer dato con `available_at > T` **lanza excepción**, no devuelve null. |
| B3 | `src/data/repository.ts` | `query()` cruda deja de exportarse. Todo acceso pasa por `asOf(T)`. Test de arquitectura que falla si algún módulo importa `pg` directamente. |
| B4 | `config/similarity.weights.json` | Pesos fuera del código, con `validation_status: 'hypothesis'`, `last_validated_at: null`, `version`. Toda salida marcada **NO VALIDADA** mientras el status sea `hypothesis`. |

### Bloque C — FASE 2: Pipeline núcleo

| Commit | Entregable |
|---|---|
| C1 | Ingesta + clasificación por tier. `available_at` persistido en columna, nunca en JSONB. |
| C2 | Dedup **noticia → evento** (clustering), no hash exacto. Verificación por tier independiente. |
| C3 | Análisis de evento **con sorpresa como campo de primera clase** (V-7). `cleanText` deja de destruir `$`/`%`/`€`. |
| C4 | Snapshot macro en T con valores initial-release (LEY 2). |
| C5 | Matching: 7 componentes completos, pesos desde config, `weights_version` persistido, **filtro duro de signo de sorpresa**. |
| C6 | Escenarios: `historical_frequency` + `historical_sample_size` + distribución + p20/p10/p05 + `worst_observed`. **Sin `calibrated_probability`** (LEY 3). 3 clases, no 5. |
| C7 | Impacto en portafolio: agregación por pesos actuales + cola. **Sin optimización.** |
| C8 | Alerta con `AnalysisQualityReport` de 4 dimensiones separadas (LEY 5). Sin escalar agregado. HTML escapado. |
| C9 | **Borrado** de `recommendationEngine.js` y `Recommendations.jsx` (V-9). |

**DoD Bloque C:** un evento real recorre las 8 capas end-to-end · tests de look-ahead en verde (incluido el que debe lanzar) · ninguna salida contiene `calibrated_probability` · cero constantes de negocio fuera de `/config`.

### Bloque D — FASE 3: Validación y aprendizaje

| Commit | Entregable |
|---|---|
| D1 | Observación real en T+1d/7d/30d (capa 9 — hoy inexistente). |
| D2 | Clasificación del escenario **observado** con σ del régimen calculada **con datos previos a T**. |
| D3 | Brier multiclase + baseline uniforme (0.667) + n + IC. Curva de calibración por bins de 10pp. |
| D4 | Desglose por tipo de evento **y por régimen macro**. |
| D5 | Backtesting time-aware con split **out-of-sample** (periodo A → periodo B posterior; nunca aleatorio). |
| D6 | Recalibración **solo si mejora out-of-sample**. `validation_status` actualizado con evidencia. |
| D7 | **Solo si la calibración es buena:** habilitar `calibrated_probability`. |

---

## 6. CONFLICTOS CON LA SPEC — REPORTADOS, NO RESUELTOS

Conforme a §9 (*"Si algo de esta spec entra en conflicto con lo que ya existe, repórtalo antes de resolverlo por tu cuenta"*):

### CONF-1 · El código vivía en otro repositorio
La spec asume una implementación previa auditable. Estaba en `Prueba-Claude`, no en `InvestingApp` (que está vacío, sin un solo commit). **Resuelto:** auditado en modo lectura; todo el trabajo se deposita en `InvestingApp` por instrucción explícita del usuario.

### CONF-2 · "No reconstruyas lo que ya cumple la spec" — no aplica
La Regla 1 asume que parte del código cumple. **Ningún módulo cumple íntegramente**, y el sistema nunca ejecutó (§3.C). El refactor incremental de la Regla 1 sigue siendo el método correcto, pero se aplica sobre un esqueleto no funcional, no sobre un sistema vivo. **Decisión propuesta, requiere confirmación:** reescritura guiada por la spec, conservando lo listado como REFACTOR (pool `pg`, andamiaje Express, sentimiento AFINN, transporte de alertas, `classifyEventType`).

### CONF-3 · Twelve Data no cubre el régimen macro
Verificado contra la ficha técnica del proveedor, que declara **fuera de alcance: índices, bonos/renta fija y opciones**.

| Variable de régimen (§3) | ¿Twelve Data? |
|---|---|
| `fed_funds_rate`, `inflation_yoy`, `unemployment`, `gdp_growth` | ❌ fuera de dominio |
| `yield_curve_2s10s`, `high_yield_oas` | ❌ renta fija — declarado fuera de alcance |
| `vix`, `usd_index` | ❌ índices — declarado fuera de alcance |
| `sp500_trend_20d` | ⚠️ solo vía proxy ETF (SPY) |
| `oil`, `gold` | ✅ |

**Cobertura: ~2.5 de 11 variables.** Se requiere una fuente macro adicional, a determinar en FASE 1 sin preselección (V-10). Twelve Data sigue siendo candidato fuerte para precios y para consenso de EPS (`get_analyst_data`, `get_earnings`); su capacidad de exponer `available_at` **está sin verificar** y es requisito bloqueante.

### CONF-4 · Escenarios: 5 tipos vs 3 clases
El código emite `bullish/bearish/consolidation/volatile/stable`; §4 define exactamente 3 clases mutuamente excluyentes y exhaustivas por umbral de ±0.5σ. **El Brier multiclase es incalculable sobre la taxonomía actual.** Se adopta la de §4 (queda resuelto vía REEMPLAZAR de `scenarioEngine`), pero se señala porque implica descartar la semántica de "volatile" — que no es direccional y por tanto no encaja en una partición por retorno.

---

## 7. ESTADO DE LA FASE 0

| Criterio DoD | Estado |
|---|---|
| `docs/AUDIT.md` con tabla módulo → veredicto → justificación | ✅ §2 |
| Lista priorizada de violaciones (bloqueantes primero) | ✅ §3 |
| Plan de refactor incremental, repo funcionando en cada commit | ✅ §5 |
| **Cero líneas de feature nueva** | ✅ **Cero. Solo este documento.** |

**Siguiente paso:** Bloque A1 — `docs/DATA_REQUIREMENTS.md`. Requiere confirmación del usuario sobre CONF-2.
