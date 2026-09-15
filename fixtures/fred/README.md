# Fixtures — FRED / ALFRED

Respuestas reales de `api.stlouisfed.org`, capturadas el **2026-09-15**.
Resuelven **MA-1** y **MA-2**, los dos bloqueantes más duros de la spec.

La API key va en `.env` (`FRED_API_KEY`) y **nunca** se commitea. Las URLs de
estos fixtures se guardan sin el parámetro `api_key`.

| Archivo | Llamada | Qué demuestra |
|---|---|---|
| `gdpc1_asof_2025-06-01.json` | `observations` con `realtime_start=realtime_end=2025-06-01` | **MA-2** — el valor vigente en una fecha pasada |
| `gdpc1_q1_2025_vintages.json` | `observations` con rango realtime 2025-04-01 → 2026-09-15 | **MA-1** — las 4 versiones del mismo trimestre |
| `gdpc1_vintagedates.json` | `vintagedates` | 16 fechas de revisión desde 2025-04-01 |

## El hallazgo

El PIB real del Q1-2025 (`GDPC1`, `date=2025-01-01`) tuvo **cuatro valores
distintos** según cuándo se consultara:

| Vigente desde | hasta | Valor |
|---|---|---|
| 2025-04-30 | 2025-05-28 | 23526.085 |
| 2025-05-29 | 2025-06-25 | 23528.047 |
| 2025-06-26 | 2025-09-24 | **23512.717** ← revisó a la baja |
| 2025-09-25 | (hoy) | 23548.21 |

Un backtest fechado en julio de 2025 que usara el valor de hoy (23548.21)
estaría usando información que no existía: entonces el dato vigente era
23512.717. La diferencia es de 35 puntos, y el camino intermedio fue en
dirección contraria.

Esto es el "look-ahead disfrazado" de la LEY 2, y es el más peligroso porque
no rompe nada: sólo produce resultados mejores de lo que la realidad permitía.
