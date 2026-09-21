# InvestingApp — instrucciones del proyecto

Sistema de apoyo a decisiones de inversión basado en evidencia histórica.
**No es un predictor de mercado.** Analiza noticias y eventos reales, mide cómo
reaccionaron los mercados a eventos parecidos en el pasado, y avisa. La
diferencia no es de matiz: un predictor afirma lo que va a pasar, y esto
describe lo que pasó antes en circunstancias comparables, con su incertidumbre
a la vista.

Todo el desarrollo va en el repositorio `InvestingApp`, rama
`claude/market-news-alerts-analyzer-d09nq4`.

---

## 1. Escribir el mínimo necesario

Antes de escribir código, bajar la escalera y parar en el primer peldaño que
resuelva el problema:

1. **¿Hace falta que exista?** Lo que no se escribe no se mantiene ni falla.
2. **¿Ya está en el repositorio?** Buscar antes de crear.
3. **¿Lo hace la librería estándar?** `node:test`, `URL`, `Intl`, `Date`.
4. **¿Hay una función nativa de la plataforma?** SQL antes que TypeScript
   cuando el dato vive en la base; `<input type="date">` antes que un
   calendario a mano.
5. **¿Lo hace una dependencia ya instalada?** Este proyecto tiene `pg` y poco
   más, y así debería seguir.
6. **¿Cabe en una línea?**
7. **Sólo entonces: lo mínimo que funcione.**

Corolario: no añadir dependencias sin una razón escrita. El proyecto corre con
`node --experimental-strip-types`, sin paso de compilación, y eso es una
ventaja que se pierde en cuanto se mete un bundler.

## 2. La excepción, que aquí manda

La escalera recorta **funcionalidad especulativa**. No recorta lo que hace que
los datos signifiquen algo. En este proyecto **no son código de más**:

- **La trazabilidad temporal.** `event_time`, `available_at`, `ingested_at`,
  los `CHECK` y los triggers `append_only`. Sin ellos el sistema seguiría
  funcionando y mentiría.
- **Negarse a concluir de más.** Devolver «no se puede saber» en vez de un
  número plausible. Una posición sin precio no aporta peso a la cartera; un
  ticker ambiguo no se resuelve al azar; una línea que no se entiende se
  informa en vez de saltarse.
- **La validación de entrada y la procedencia del dato.** De dónde salió y
  cuándo, siempre.
- **El comentario que explica POR QUÉ.** No el que repite lo que hace el
  código.

Dos fallos reales de este repositorio, los dos invisibles para «funciona»:

- El precio se fechaba con `timestamp` (la vela, 13:30Z) en vez de
  `last_quote_at` (el cruce, 18:07Z). Casi cinco horas de adelanto escritas en
  `available_at`, y el precio congelado en el primer refresco del día por
  colisión de clave única.
- El tabulador se trataba como separador de entradas, así que `MU<tab>0.3`
  daba un ticker `MU` sin cantidad y otro ticker llamado `0.3`.

Ninguno de los dos impedía que el programa corriera. Los dos falseaban la
cartera en silencio. **Ése es el fallo que este proyecto existe para no
cometer**, y el código que lo evita nunca sobra.

## 3. Las 6 leyes

1. **Sin look-ahead.** Todo dato usado en un instante `T` cumple
   `available_at <= T`. Sin excepciones ni ramas especiales.
2. **Dato inicial ≠ dato revisado.** El macro es bitemporal y append-only
   (ALFRED: `realtime_start` / `realtime_end`). Lo que se publicó entonces no
   es lo que dice hoy la serie corregida.
3. **`historical_frequency` ≠ `calibrated_probability`.** Una frecuencia
   observada no es una probabilidad hasta que se calibra y se valida. En el
   esquema: `ley3_no_calibrated_without_validation`.
4. **Los pesos de similitud son hipótesis.** Van en configuración, con su
   `validation_status`. Nunca incrustados en el código como si fueran hechos.
5. **La confianza no es un número.** Son cuatro dimensiones separadas. Un
   agregado las promedia y esconde cuál falla.
6. **Todo registro lleva sus tres tiempos:** `event_time`, `available_at`,
   `ingested_at`. `available_at` viene del proveedor, nunca de la hora a la
   que corrió el trabajo.

## 4. Antes de dar algo por bueno

- **Probar con tickers reales.** Los mocks los escribe uno mismo y no
  contradicen a nadie: los dos fallos de arriba salieron al mirar datos
  reales, no al pasar pruebas. Un mock vale cuando copia una respuesta real.
- **Decir qué NO se ha verificado.** `api.twelvedata.com` está bloqueado desde
  el entorno de desarrollo remoto; el cliente HTTP está probado contra
  respuestas capturadas, no ejecutándolo. Eso se dice, no se omite.
- **Nada alrededor de seis tickers concretos.** La cartera es editable y el
  sistema tiene que funcionar con cualquier símbolo, en cualquier momento.
- **`npm test` en verde** antes de cada commit.

## 5. Fuera de alcance hasta que se valide

Optimización de cartera, tamaño de posición, ratios de cobertura y cualquier
puntuación agregada de recomendación. Construirlas antes de tener validada la
capa de abajo sería poner un número encima de otro sin saber si el de abajo
vale.

## 6. Mapa rápido

| Dónde | Qué |
|---|---|
| `db/schema/` | Las leyes, en `CHECK` y triggers, no sólo en el código |
| `src/data/asOf.ts` | La LEY 1 aplicada a cada consulta |
| `src/ingest/` | Precios, símbolos, filings SEC, macro, planificador diario |
| `src/portfolio/` | Posiciones, pesos, lectura de carteras pegadas |
| `src/scoring/` | Escenarios (±0.5σ) y Brier multiclase (base 2/3) |
| `docs/adr/` | Las decisiones tomadas y por qué. Leer antes de rehacerlas |
| `docs/AUDIT.md` | Qué falló en el intento anterior |
| `scripts/dev-server.ts` + `probar.html` | Interfaz de pruebas, sólo localhost |

Idioma: comentarios, mensajes de error y documentación **en castellano**.
