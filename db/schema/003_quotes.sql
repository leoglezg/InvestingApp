-- ============================================================================
-- 003_quotes.sql — Precios en vivo, sin romper la LEY 1
--
-- EL PROBLEMA:
-- Valorar la cartera "ahora" quiere el último precio, que con el mercado
-- abierto es intradía. Pero market_prices guarda CIERRES de sesión, y meter
-- ahí un precio intradía sería falsearlo: el cierre de hoy no existe todavía.
--
-- LA TENTACIÓN EQUIVOCADA sería relajar market_prices para admitir precios
-- "provisionales". Eso contaminaría la serie con la que se calcula sigma y
-- se miden las reacciones a T+1d/7d/30d, que es el corazón del análisis.
--
-- LA SOLUCIÓN: dos tablas con semánticas distintas y una vista que las une.
-- Cada punto de precio lleva su available_at real, y la regla es siempre la
-- misma: el precio vigente en T es el más reciente con available_at <= T.
-- Eso da el precio en vivo al preguntar por ahora, y el cierre correcto al
-- preguntar por una fecha pasada. Sin excepciones ni ramas especiales.
-- ============================================================================

BEGIN;

SET search_path TO market, public;

CREATE TABLE market_quotes (
  id             bigserial PRIMARY KEY,
  symbol         text NOT NULL,

  price          numeric(18,6) NOT NULL,
  -- Instante del quote SEGÚN EL PROVEEDOR, no la hora de nuestra petición.
  quoted_at      clock_time NOT NULL,
  available_at   clock_time NOT NULL,
  ingested_at    clock_time NOT NULL DEFAULT now(),

  -- Un precio con el mercado cerrado es el último cruce, no un precio vivo.
  -- La distinción importa al mostrarlo: "en vivo" frente a "último".
  is_market_open boolean NOT NULL,
  provider       text NOT NULL,

  CONSTRAINT quote_price_positive CHECK (price > 0),
  CONSTRAINT quote_uq UNIQUE (symbol, quoted_at, provider)
);

COMMENT ON TABLE market_quotes IS
  'Precios intradía para valorar la cartera en el momento. NO se usan para '
  'calcular sigma ni reacciones a horizonte: eso exige cierres de sesión.';

CREATE INDEX quotes_symbol_time_idx ON market_quotes (symbol, available_at DESC);

CREATE TRIGGER market_quotes_append_only
  BEFORE UPDATE OR DELETE ON market_quotes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- VISTA UNIFICADA
--
-- Cierres y quotes en un mismo eje temporal. `kind` conserva la procedencia,
-- para que quien consuma sepa si está mirando un cierre firme o un precio
-- en curso.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW price_points AS
  SELECT symbol, close AS price, available_at, 'close'::text AS kind,
         session_date::timestamptz AS reference_time
  FROM market_prices
  UNION ALL
  SELECT symbol, price, available_at, 'quote'::text AS kind,
         quoted_at AS reference_time
  FROM market_quotes;

COMMENT ON VIEW price_points IS
  'Regla única: el precio vigente en T es el más reciente con '
  'available_at <= T. Da el precio en vivo para ahora y el cierre correcto '
  'para una fecha pasada, sin ramas especiales.';

-- ---------------------------------------------------------------------------
-- PESOS DE LA CARTERA — ahora sobre price_points
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS portfolio_weights_as_of(timestamptz);

CREATE FUNCTION portfolio_weights_as_of(p_t clock_time)
RETURNS TABLE (
  symbol text, quantity numeric, close_price numeric, market_value numeric,
  weight_pct double precision, price_kind text, price_at clock_time
)
LANGUAGE sql STABLE AS $$
  WITH pos AS (SELECT * FROM portfolio_as_of(p_t)),
  priced AS (
    SELECT p.symbol, p.quantity, pp.price, pp.kind, pp.available_at,
           (p.quantity * pp.price) AS mv
    FROM pos p
    LEFT JOIN LATERAL (
      SELECT x.price, x.kind, x.available_at
      FROM price_points x
      WHERE x.symbol = p.symbol
        AND x.available_at <= p_t          -- LEY 1
      ORDER BY x.available_at DESC
      LIMIT 1
    ) pp ON true
  ),
  total AS (SELECT NULLIF(SUM(mv), 0) AS t FROM priced)
  SELECT pr.symbol, pr.quantity, pr.price, pr.mv,
         (pr.mv / (SELECT t FROM total))::double precision,
         pr.kind, pr.available_at
  FROM priced pr
  ORDER BY pr.mv DESC NULLS LAST;
$$;

COMMIT;
