-- ============================================================================
-- 002_portfolio.sql — Cartera y universo de símbolos
--
-- DECISIÓN DE DISEÑO CENTRAL: la cartera es BITEMPORAL, igual que el macro.
--
-- Una tabla de posiciones que se actualiza con UPDATE respondería "¿qué tiene
-- el usuario?" pero sería incapaz de responder "¿qué tenía el 3 de marzo?".
-- Y esa es justo la pregunta que hay que hacer para medir si una recomendación
-- pasada fue acertada: el impacto de un evento depende de la cartera que había
-- ENTONCES, no de la de hoy.
--
-- Sin esto, la capa 7 (impacto en cartera) sería imposible de validar, porque
-- cada cambio de posición borraría la evidencia contra la que comparar. Es la
-- LEY 1 aplicada a los datos del propio usuario.
-- ============================================================================

BEGIN;

SET search_path TO market, public;

-- ---------------------------------------------------------------------------
-- UNIVERSO DE SÍMBOLOS
--
-- Separado de las posiciones a propósito: el usuario quiere analizar símbolos
-- que NO posee todavía (candidatos de compra). Seguir ≠ tener.
-- ---------------------------------------------------------------------------

CREATE TYPE asset_type AS ENUM ('stock', 'etf', 'fund', 'crypto', 'forex', 'commodity', 'other');

CREATE TABLE symbols (
  symbol        text PRIMARY KEY,
  display_name  text,

  -- Identificador del emisor ante la SEC. NULL es legítimo y frecuente:
  -- los ETF no presentan 8-K. Un símbolo sin CIK no es un error, sólo
  -- significa que su análisis no puede apoyarse en filings.
  cik           text,
  asset_type    asset_type NOT NULL DEFAULT 'stock',

  -- Si el sistema debe ingerir datos para este símbolo. Se desactiva en vez
  -- de borrar, para no perder el histórico ya recogido.
  is_tracked    boolean NOT NULL DEFAULT true,

  added_at      clock_time NOT NULL DEFAULT now(),
  notes         text,

  CONSTRAINT symbols_upper CHECK (symbol = upper(symbol)),
  CONSTRAINT symbols_cik_digits CHECK (cik IS NULL OR cik ~ '^[0-9]{1,10}$')
);

COMMENT ON COLUMN symbols.cik IS
  'NULL para ETF y otros instrumentos sin filings propios. El pipeline debe '
  'degradar con elegancia: sin CIK no hay capa SEC, pero sí precios, macro y '
  'noticias generales.';

CREATE INDEX symbols_tracked_idx ON symbols (is_tracked) WHERE is_tracked;
CREATE INDEX symbols_cik_idx ON symbols (cik) WHERE cik IS NOT NULL;

-- ---------------------------------------------------------------------------
-- POSICIONES — append-only
--
-- Cada cambio es una FILA NUEVA. Nunca se actualiza ni se borra.
-- Vender del todo se registra como quantity = 0, no como DELETE: la posición
-- cerrada es parte del historial y se necesita para evaluar la decisión.
-- ---------------------------------------------------------------------------

CREATE TABLE portfolio_positions (
  id             bigserial PRIMARY KEY,
  symbol         text NOT NULL REFERENCES symbols(symbol),

  quantity       numeric(20, 8) NOT NULL,

  -- Desde cuándo esta posición es la vigente. Es el equivalente de
  -- available_at para los datos del usuario.
  effective_from clock_time NOT NULL,
  -- Cuándo lo registramos. Distinto de effective_from: si el usuario apunta
  -- el lunes una compra hecha el viernes, effective_from es el viernes y
  -- recorded_at el lunes. Sin esa distinción no se puede saber si el sistema
  -- conocía la posición cuando emitió una recomendación.
  recorded_at    clock_time NOT NULL DEFAULT now(),

  -- De dónde salió el cambio: registro manual, o seguimiento de una
  -- recomendación del propio sistema (lo que permite medir si seguirlas
  -- mejoró o empeoró el resultado).
  source         text NOT NULL DEFAULT 'manual',
  note           text,

  CONSTRAINT position_quantity_nonneg CHECK (quantity >= 0),
  CONSTRAINT position_source_valid
    CHECK (source IN ('manual', 'recommendation', 'import', 'correction')),
  CONSTRAINT position_recorded_after_effective
    CHECK (recorded_at >= effective_from),
  -- Una sola posición vigente por símbolo e instante.
  CONSTRAINT position_unique_moment UNIQUE (symbol, effective_from)
);

CREATE TRIGGER portfolio_positions_append_only
  BEFORE UPDATE OR DELETE ON portfolio_positions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE portfolio_positions IS
  'Append-only. Vender del todo es quantity = 0, nunca un DELETE: la posición '
  'cerrada forma parte del historial contra el que se evalúan las decisiones.';

CREATE INDEX positions_symbol_time_idx
  ON portfolio_positions (symbol, effective_from DESC);

-- ---------------------------------------------------------------------------
-- CARTERA VIGENTE EN T  (LEY 1)
--
-- La posición vigente en T es la última con effective_from <= T.
-- Las de cantidad 0 se excluyen del resultado, pero permanecen en la tabla.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION portfolio_as_of(p_t clock_time)
RETURNS TABLE (
  symbol text, quantity numeric, effective_from clock_time,
  asset_type asset_type, cik text, display_name text
)
LANGUAGE sql STABLE AS $$
  SELECT p.symbol, p.quantity, p.effective_from, s.asset_type, s.cik, s.display_name
  FROM (
    SELECT DISTINCT ON (pp.symbol) pp.symbol, pp.quantity, pp.effective_from
    FROM portfolio_positions pp
    WHERE pp.effective_from <= p_t          -- LEY 1
    ORDER BY pp.symbol, pp.effective_from DESC
  ) p
  JOIN symbols s ON s.symbol = p.symbol
  WHERE p.quantity > 0
  ORDER BY p.symbol;
$$;

COMMENT ON FUNCTION portfolio_as_of IS
  'La cartera tal como era en T. Necesaria para evaluar una recomendación '
  'pasada contra las posiciones que existían entonces, no contra las de hoy.';

-- Pesos de la cartera en T, para la capa 7 (impacto agregado).
-- Requiere precios; devuelve NULL en weight_pct cuando falta el precio en T,
-- en lugar de omitir la fila: una cobertura de precios incompleta debe verse.
CREATE OR REPLACE FUNCTION portfolio_weights_as_of(p_t clock_time)
RETURNS TABLE (
  symbol text, quantity numeric, close_price numeric,
  market_value numeric, weight_pct double precision, price_date date
)
LANGUAGE sql STABLE AS $$
  WITH pos AS (
    SELECT * FROM portfolio_as_of(p_t)
  ),
  priced AS (
    SELECT p.symbol, p.quantity, mp.close, mp.session_date,
           (p.quantity * mp.close) AS mv
    FROM pos p
    LEFT JOIN LATERAL (
      SELECT m.close, m.session_date
      FROM market_prices m
      WHERE m.symbol = p.symbol
        AND m.available_at <= p_t          -- LEY 1
      ORDER BY m.session_date DESC
      LIMIT 1
    ) mp ON true
  ),
  total AS (SELECT NULLIF(SUM(mv), 0) AS t FROM priced)
  SELECT pr.symbol, pr.quantity, pr.close, pr.mv,
         (pr.mv / (SELECT t FROM total))::double precision,
         pr.session_date
  FROM priced pr
  ORDER BY pr.mv DESC NULLS LAST;
$$;

COMMIT;
