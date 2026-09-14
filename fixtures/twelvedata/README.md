# Fixtures — evidencia de llamadas reales

Respuestas crudas capturadas el **2026-09-14** vía el conector MCP de Twelve Data.
Son la evidencia que respalda `docs/PROVIDER_EVALUATION.md` (FASE 1 / A2).

La spec exige evaluar "con llamadas reales, no con documentación". Estos archivos
son esas llamadas. No editar: si un proveedor cambia su contrato, se añade una
captura nueva fechada, nunca se reescribe la anterior.

| Archivo | Llamada | Criterio que verifica |
|---|---|---|
| `news_latest.json`       | `get_company_news(AAPL, outputsize=3)` | OP-6 (hora), tier, relevancia |
| `news_range_empty.json`  | `get_company_news(AAPL, 2026-03-01 → 2026-03-08)` | OP-1/OP-2, densidad de archivo |
| `earliest_timestamp.csv` | `get_earliest_timestamp(AAPL, 1day)` | PR-2 (profundidad) |
| `earnings.csv`           | `get_earnings(AAPL, outputsize=6)` | EX-1 (sorpresa) |
| `eps_trend.json`         | `get_analyst_data(AAPL, eps_trend)` | EX-4 (consenso as-of) |
| `time_series_range.csv`  | `get_time_series(AAPL, 2026-01-28 → 2026-02-03)` | OP-1, PR-1, PR-3 |
