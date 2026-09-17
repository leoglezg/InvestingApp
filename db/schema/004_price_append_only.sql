-- ============================================================================
-- 004_price_append_only.sql — Corrige una inconsistencia del guardián
--
-- `market_quotes` tenía trigger append-only y `market_prices` no, pese a que
-- ambas son observaciones de un hecho pasado. Se detectó al limpiar datos de
-- prueba: los quotes resistieron el borrado y los cierres no.
--
-- Un cierre de sesión es un hecho consumado. Si pudiera modificarse, la serie
-- con la que se calcula sigma y se miden las reacciones a T+1d/7d/30d dejaría
-- de ser reproducible: dos backtests de la misma fecha podrían dar resultados
-- distintos sin que nada lo indique.
--
-- Las correcciones se registran como filas nuevas con su propio available_at,
-- igual que las revisiones macro.
-- ============================================================================

BEGIN;

SET search_path TO market, public;

CREATE TRIGGER market_prices_append_only
  BEFORE UPDATE OR DELETE ON market_prices
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER corporate_actions_append_only
  BEFORE UPDATE OR DELETE ON corporate_actions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE market_prices IS
  'Append-only. Un cierre de sesión es un hecho consumado; poder reescribirlo '
  'haría irreproducible el cálculo de sigma y de las reacciones a horizonte.';

COMMIT;
