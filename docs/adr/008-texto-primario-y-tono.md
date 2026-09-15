# ADR 008 — Texto primario de filings y tono cuantificado

**Estado:** ACEPTADO
**Fecha:** 2026-09-15
**Evidencia:** `fixtures/sec-edgar/8k_ex991_earnings_text.json`, `fixtures/gdelt/gkg_sample.json`
**Cierra:** la última limitación de la capa 1

## Contexto

Con los ADR 006 y 007 la capa de datos quedaba funcional, pero con una carencia
que había que declarar antes de construir encima: **sólo se disponía de
titulares**.

- GDELT (`artlist`) devuelve `url`, `title`, `seendate`, `domain`, `language`,
  `sourcecountry` — **sin cuerpo y sin tono por artículo**.
- SEC EDGAR vía `data.sec.gov` devuelve metadatos y el código del evento, pero
  **los documentos viven en `www.sec.gov`**, que estaba bloqueado.

Analizar sentimiento sobre titulares alcanza para *"Warsh sustituye a Powell"*.
No alcanza para extraer que una cifra salió por encima o por debajo de lo
esperado — es decir, no alcanza para la sorpresa, que la spec §2 llama "la pieza
que faltaba".

Ambos hosts se añadieron a la allowlist y se evaluaron con llamadas reales.

## Decisión

1. **`www.sec.gov`** como fuente del **texto primario** de los filings.
2. **`data.gdeltproject.org` (GKG)** como fuente de **tono cuantificado** y temas
   por artículo.

## Justificación — el hallazgo que lo decide

Se descargó el Exhibit 99.1 del 8-K de resultados de Apple (accession
`0000320193-26-000018`, `items=2.02,9.01`, aceptado `2026-07-30T20:30:28Z`):
173.484 bytes de HTML, 10.456 caracteres de texto. Dice:

> *"The Company posted quarterly revenue of **$109.4 billion**, up 16 percent year
> over year… Diluted earnings per share was **$2.02**, up 29 percent year over
> year, and included a **favorable impact of $0.11 from tariff refunds**."*

### Validación cruzada entre fuentes independientes

El fixture de Twelve Data (ADR 002) registraba para esa misma fecha:

```
2026-07-30;After Hours;eps_estimate=1.89;eps_actual=2.02;difference=0.13;surprise_prc=6.88
```

**El EPS del documento oficial (2.02) coincide exactamente con el de Twelve
Data.** Dos fuentes independientes confirman el mismo hecho: una comercial, otra
la declaración de la propia empresa ante el regulador. Esto eleva la confianza en
Twelve Data de "plausible" a "verificado contra fuente primaria".

### El matiz que ninguna cifra sola revela

El texto añade algo que el `eps_actual` no puede contener:

| Lectura | EPS | vs consenso 1.89 |
|---|---|---|
| Titular | 2.02 | **+6.88%** — beat holgado |
| Descontando los $0.11 de reembolsos arancelarios | 1.91 | **+1.1%** — apenas en línea |

**La calidad del resultado cambia por completo.** Un analista humano lo ve en la
primera lectura; un sistema que sólo consume el número no puede verlo nunca.

Este es el argumento decisivo para ingerir el texto primario: no mejora la
precisión de un dato que ya teníamos — **aporta una dimensión que no existía**.
Un beat impulsado por un extraordinario no es comparable con uno operativo, y sin
el texto ambos entrarían al matching como el mismo evento.

### GDELT GKG — tono por artículo

Un archivo de ventana de 15 minutos (`20260915180000.gkg.csv`): **1.607
registros, 27 columnas**. La columna `V2Tone`:

```
5.92255, 6.83371, 0.91116, 7.74487, 20.72892, 1.13895, 393
```

Campos: `Tone`, `PositiveScore`, `NegativeScore`, `Polarity`,
`ActivityRefDensity`, `SelfGroupRefDensity`, `WordCount`.

Aporta sobre `artlist`:

| Campo | Utilidad |
|---|---|
| `Tone` | Sentimiento cuantificado, sin depender de analizar el titular |
| `PositiveScore`/`NegativeScore` | Separados: un texto puede ser intenso en ambos |
| `WordCount` | Permite descartar piezas demasiado breves para ser informativas |
| `V2Themes` | Taxonomía de temas propia de GDELT |

Se actualiza cada 15 minutos, coherente con la cadencia diaria (ADR 004).

## Requisitos operativos

1. **El índice de un filing va en `https://www.sec.gov/Archives/edgar/data/{CIK}/{accession sin guiones}/index.json`.** El formato con el accession repetido
   y sufijo `-index.json` devuelve 404, y `data.sec.gov/Archives/` no sirve
   documentos.
2. **`lastupdate.txt` de GDELT devuelve URLs con esquema `http://`, que el proxy
   rechaza.** Hay que reescribirlas a `https://` antes de descargar.
3. Cabecera `User-Agent` identificando al solicitante, también en `www.sec.gov`.
4. Volumen del GKG: ~6,8 MB comprimidos por ventana de 15 min. Ingerir **todo**
   el flujo es inviable; hay que filtrar por temas o dominios antes de persistir.

## Gaps aceptados

| Gap | Consecuencia |
|---|---|
| El texto del filing llega en HTML y hay que extraerlo | Requiere limpieza; la extracción no debe destruir `$`, `%` ni cifras (NR-3, el error del código auditado) |
| `Tone` de GDELT es un valor calculado por un tercero | Se almacena como campo del proveedor, no como sentimiento propio del sistema; su calidad entra en la validación como todo lo demás |
| El GKG cubre la ventana reciente | El archivo histórico profundo requiere descargar muchas ventanas; se evaluará al dimensionar el backfill |

## Consecuencia

**La capa 1 queda completa.** El sistema puede ingerir el hecho oficial con su
texto íntegro y su hora exacta, más la cobertura periodística con tono
cuantificado. Ya no hay ninguna limitación de datos que impida FASE 2.
