# Fixtures — GDELT

Prueba de paciencia ejecutada el **2026-09-15** contra `api.gdeltproject.org`.

## Resultado

```
GDELT-historico: intento 1 → HTTP 429
GDELT-historico: OK en intento 2 (tras ~15s)
   articulos en ventana historica: 5
   CAMPOS: ["url","url_mobile","title","seendate","socialimage","domain","language","sourcecountry"]
   20260303T183000Z | newsweek.com      | English | Federal Reserve Hit With Issues With Transac
   20260305T091500Z | finance.yahoo.com | English | Kraken Gains Fed Access : Could Ripple Follo
   20260304T203000Z | livemint.com      | English | Kevin Warsh to replace Jerome Powell as Fede
   20260304T203000Z | livemint.com      | English | Trump nominates Kevin Warsh as Federal Reser
```

Consulta: `query="federal reserve" sourcelang:english`,
ventana `20260302000000` → `20260307000000` (histórica, 6 meses atrás).

## Contraste: Yahoo en la misma prueba

```
Yahoo-noticias: intento 1..6 → HTTP 429
Yahoo-noticias: AGOTADO tras 6 intentos
```

Backoff de 0 → 15 → 30 → 45 → 60 → 90 s (240 s acumulados). Yahoo nunca
respondió; GDELT sí al segundo intento. La diferencia es cualitativa, no de
grado: GDELT limita por cuota compartida, Yahoo bloquea la IP de datacenter.

## Advertencia sobre `seendate`

Los valores llegan redondeados a 15 minutos (`183000Z`, `091500Z`, `203000Z`).
Es **cuándo GDELT vio el artículo**, no cuándo se publicó: es un proxy de
`available_at` ligeramente posterior al real. Suficiente para horizontes de
1d/7d/30d, insuficiente para análisis intradía fino. Debe almacenarse marcado
como proxy, nunca como instante de publicación.
