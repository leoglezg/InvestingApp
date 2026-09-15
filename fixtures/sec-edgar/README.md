# Fixtures — SEC EDGAR

Respuestas reales de `data.sec.gov`, capturadas el **2026-09-15**, tras el
desbloqueo de la política de red.

| Archivo | Llamada | Criterio que verifica |
|---|---|---|
| `submissions_AAPL_8K.json` | `GET /submissions/CIK0000320193.json` | OP-6 (timestamp), §1.2 (archivo histórico), taxonomía de eventos |

**Nota:** `data.sec.gov` exige cabecera `User-Agent` identificando al solicitante;
sin ella responde 403. Los hosts `www.sec.gov` y `efts.sec.gov` (búsqueda de texto
completo y feed global de filings) **no están** en la allowlist del entorno.
