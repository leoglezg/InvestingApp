# ADR 003 — Rechazo de Twelve Data como fuente de noticias

**Estado:** ACEPTADO (decisión negativa)
**Fecha:** 2026-09-14
**Evidencia:** `fixtures/twelvedata/news_latest.json`, `news_range_empty.json`

## Contexto

El usuario requiere que **las noticias se obtengan y busquen diariamente** para
alimentar todo el pipeline. La capa 1 (ingesta) es el origen de todo el producto.
Twelve Data ya estaba conectado y expone `get_company_news`, por lo que era el
candidato natural.

## Decisión

**Se RECHAZA Twelve Data como fuente de noticias.**

## Justificación

Se registra con detalle porque es una decisión negativa, y las decisiones negativas
mal documentadas se revierten por olvido.

### Lo que sí cumplía

`"datetime": "2026-05-28T13:45:00Z"` — timestamp con **hora y zona horaria**.
Satisface **OP-6**, el bloqueante nº1 de los requisitos. Fue lo que motivó una
evaluación seria en lugar de un descarte rápido.

### Las cuatro razones del rechazo

**1 · Densidad inservible.** Tres llamadas para AAPL —la empresa más cubierta del
mundo— devuelven como entrada más reciente una del **2026-05-28**. La fecha de
evaluación es 2026-09-14: **3½ meses sin una sola entrada.** Un sistema de alertas
diarias no tendría nada que procesar casi ningún día.

**2 · Archivo histórico vacío.** La ventana 2026-03-01 → 2026-03-08 devolvió
`"press_releases": []`. No es falta de profundidad: es falta de densidad.

**3 · No son noticias.** La clave de la respuesta es literalmente `press_releases`, y
el cuerpo lo confirma: *"FN Media Group Presents Oilprice.com Market Commentary"* es
publirreportaje pagado. En la jerarquía de la spec no alcanza siquiera Tier 4 — un
agregador al menos redistribuye periodismo.

> **Implicación que decide el asunto:** si el sistema tratara esto como señal de
> evento, **cualquiera que pague una nota de prensa podría disparar una alerta sobre
> el portafolio del usuario.** Eso es un vector de manipulación, no una fuente.

**4 · Relevancia nominal.** De 3 resultados para `AAPL`, **ninguno trata sobre
Apple**: dos son sobre REalloys (ALOY) y mencionan AAPL en una lista de *"companies
mentioned"*; el tercero es **un despacho en alemán sobre un viaje de Trump a Beijing**.
El filtro por símbolo parece coincidencia de texto, no atribución de entidad.
Alimentar el analizador de sentimiento con esto produciría un "sentimiento de Apple"
derivado de geopolítica en alemán.

## Por qué no se mitiga

No es un gap subsanable con configuración, filtrado o post-proceso: **la categoría del
dato es otra.** Es un feed de comunicados promocionales, no de noticias de mercado.
Ningún parámetro lo convierte en lo que el sistema necesita.

## Consecuencia

🔴 **La categoría de noticias queda sin resolver, y con ella el requisito diario del
usuario.** No hay capa 1. FASE 2 queda bloqueada en este punto —
ver `PROVIDER_EVALUATION.md` §5 (punto A4) y ADR 005.

## Nota

Este rechazo aplica **sólo a noticias**. Twelve Data sigue aceptado para precios
(ADR 001) y sorpresa de earnings (ADR 002).
