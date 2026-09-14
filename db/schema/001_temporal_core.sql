-- ============================================================================
-- 001_temporal_core.sql — Cimientos temporales
--
-- Sustituye por completo al schema auditado en AUDIT.md, que usaba sintaxis
-- MySQL de índices y nunca llegó a ejecutarse contra PostgreSQL.
--
-- PRINCIPIO RECTOR: las leyes se imponen en la BASE DE DATOS, no sólo en el
-- código. Una ley que depende de que el programador recuerde cumplirla ya
-- está rota. Aquí, violarla hace fallar el INSERT.
--
--   LEY 1  filtrado temporal      → available_at NOT NULL en todo dato
--   LEY 2  inicial vs revisado    → macro append-only, revisiones = filas nuevas
--   LEY 3  frecuencia ≠ prob.     → CHECK impide calibrated_probability sin validar
--   LEY 4  pesos = hipótesis      → weights_version NOT NULL en cada match
--   LEY 6  el reloj               → tripleta obligatoria, sin excepción
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS market;
SET search_path TO market, public;

-- ---------------------------------------------------------------------------
-- DOMINIOS
-- ---------------------------------------------------------------------------

-- LEY 6: un timestamp sin zona horaria es ambiguo, y la ambigüedad en la capa
-- temporal es indistinguible de un bug de look-ahead. timestamptz siempre.
CREATE DOMAIN clock_time AS timestamptz;

CREATE TYPE source_tier AS ENUM ('tier1', 'tier2', 'tier3', 'tier4');

CREATE TYPE event_type AS ENUM (
  'CENTRAL_BANK', 'ECONOMIC_DATA', 'EARNINGS',
  'GEOPOLITICAL', 'CORPORATE', 'OTHER'
);

CREATE TYPE verification_level AS ENUM (
  'official',      -- al menos una fuente Tier 1
  'corroborated',  -- ≥2 Tier 2 independientes
  'single_source',
  'unverified'
);

CREATE TYPE macro_release_type AS ENUM ('initial', 'revision');

-- Exactamente las 3 clases de la spec §4. Ni más ni menos: el Brier multiclase
-- exige clases mutuamente excluyentes y exhaustivas. El código auditado emitía
-- cinco ('volatile', 'consolidation'...), lo que lo hacía incalculable.
CREATE TYPE scenario_class AS ENUM ('bearish', 'neutral', 'bullish');

CREATE TYPE calibration_status AS ENUM (
  'uncalibrated', 'preliminary', 'well_calibrated'
);

CREATE TYPE horizon AS ENUM ('1d', '7d', '30d');

-- ---------------------------------------------------------------------------
-- GUARDIÁN DE APPEND-ONLY (LEY 2)
--
-- "Las revisiones se guardan como filas nuevas, nunca sobrescribiendo."
-- Se impone con un trigger: ningún UPDATE o DELETE puede tocar estas tablas,
-- ni por error de un programador ni por una migración descuidada.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'LEY 2: % es append-only. Intento de % rechazado. '
    'Las correcciones se registran como filas nuevas, nunca sobrescribiendo.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- ---------------------------------------------------------------------------
-- FUENTES Y TIERS  (spec §3 — jerarquía de fuentes)
-- ---------------------------------------------------------------------------

CREATE TABLE sources (
  id            bigserial PRIMARY KEY,
  domain        text        NOT NULL UNIQUE,
  display_name  text        NOT NULL,
  tier          source_tier NOT NULL,
  -- Distingue al originador del redistribuidor: cinco despachos del mismo
  -- cable no son cinco confirmaciones (spec §3).
  is_syndicator boolean     NOT NULL DEFAULT false,
  notes         text,
  created_at    clock_time  NOT NULL DEFAULT now()
);

COMMENT ON COLUMN sources.tier IS
  'Afecta a la VERIFICACIÓN, nunca al sentimiento (spec §3).';

-- ---------------------------------------------------------------------------
-- NOTICIAS CRUDAS  (capa 1)
-- ---------------------------------------------------------------------------

CREATE TABLE raw_news (
  id             bigserial  PRIMARY KEY,
  source_id      bigint     NOT NULL REFERENCES sources(id),

  -- LEY 6 — la tripleta. NOT NULL sin excepción: sin reloj, el dato no entra.
  event_time     clock_time NOT NULL,
  available_at   clock_time NOT NULL,
  ingested_at    clock_time NOT NULL DEFAULT now(),

  title          text       NOT NULL,
  body           text,
  url            text       NOT NULL,
  language       text       NOT NULL,

  -- Trazabilidad de procedencia: qué proveedor y qué llamada trajo esto.
  provider       text       NOT NULL,
  provider_id    text,
  raw_payload    jsonb      NOT NULL,

  content_hash   text       NOT NULL,

  CONSTRAINT raw_news_url_provider_uq UNIQUE (provider, url),

  -- Una noticia no puede estar disponible antes de que ocurra el hecho.
  CONSTRAINT ley6_available_after_event
    CHECK (available_at >= event_time),

  -- No se puede haber ingerido algo antes de que fuera público. Detecta
  -- relojes mal configurados y timestamps fabricados.
  CONSTRAINT ley6_ingested_after_available
    CHECK (ingested_at >= available_at)
);

COMMENT ON COLUMN raw_news.available_at IS
  'OP-6: DEBE venir del proveedor con precisión intradía. NUNCA derivarse de '
  'la hora del job de ingesta: con barrido diario, eso colapsaría todas las '
  'noticias de la jornada al mismo instante y destruiría su orden real.';

CREATE INDEX raw_news_available_at_idx ON raw_news (available_at DESC);
CREATE INDEX raw_news_content_hash_idx ON raw_news (content_hash);
CREATE INDEX raw_news_event_time_idx   ON raw_news (event_time DESC);

-- ---------------------------------------------------------------------------
-- EVENTOS  (capa 2-3 — N noticias → 1 evento)
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id              bigserial  PRIMARY KEY,

  -- LEY 6
  event_time      clock_time NOT NULL,
  -- available_at del evento = la MÁS TEMPRANA de sus noticias. Es el instante
  -- en que el hecho pudo conocerse por primera vez.
  available_at    clock_time NOT NULL,
  ingested_at     clock_time NOT NULL DEFAULT now(),

  event_type      event_type NOT NULL,
  title           text       NOT NULL,
  description     text,

  sentiment       double precision,
  magnitude       integer,
  affected_assets text[]     NOT NULL DEFAULT '{}',

  -- Verificación derivada de los tiers de sus fuentes
  has_tier1               boolean NOT NULL DEFAULT false,
  independent_tier2_count integer NOT NULL DEFAULT 0,
  verification            verification_level NOT NULL DEFAULT 'unverified',

  -- Marca explícita: un evento sin sorpresa NO es comparable con uno que sí
  -- la tiene (spec §2 — el signo de sorpresa es filtro duro).
  surprise_available boolean NOT NULL DEFAULT false,

  dedup_key       text       NOT NULL,

  CONSTRAINT events_sentiment_range CHECK (sentiment IS NULL OR sentiment BETWEEN -1 AND 1),
  CONSTRAINT events_magnitude_range CHECK (magnitude IS NULL OR magnitude BETWEEN 1 AND 10),
  CONSTRAINT ley6_available_after_event CHECK (available_at >= event_time),
  CONSTRAINT events_tier2_nonneg CHECK (independent_tier2_count >= 0)
);

CREATE INDEX events_available_at_idx ON events (available_at DESC);
CREATE INDEX events_type_idx         ON events (event_type);
CREATE UNIQUE INDEX events_dedup_key_uq ON events (dedup_key);

-- Relación evento ↔ noticias que lo sustentan. Conservar la multiplicidad es
-- lo que permite medir corroboración: un proveedor que "limpia duplicados"
-- destruiría esta señal.
CREATE TABLE event_sources (
  event_id    bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  raw_news_id bigint NOT NULL REFERENCES raw_news(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, raw_news_id)
);

-- ---------------------------------------------------------------------------
-- EXPECTATIVAS Y SORPRESA  (spec §2 — "la pieza que faltaba")
-- ---------------------------------------------------------------------------

CREATE TABLE event_expectations (
  id                     bigserial  PRIMARY KEY,
  event_id               bigint     NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,

  metric_name            text             NOT NULL,
  consensus_value        double precision NOT NULL,
  consensus_source       text,
  -- LEY 6 aplicada al consenso (EX-2). NULL permitido y explícito: el
  -- proveedor de earnings no lo entrega. Nunca se imputa — un consenso
  -- inventado se propaga al matching como si fuera un hecho.
  consensus_available_at clock_time,

  actual_value           double precision NOT NULL,
  actual_available_at    clock_time       NOT NULL,

  surprise_absolute      double precision NOT NULL,
  surprise_percent       double precision,
  -- Requiere dispersión de estimaciones (EX-5), no disponible hoy.
  -- Queda NULL antes que aproximado.
  surprise_zscore        double precision,

  ingested_at            clock_time NOT NULL DEFAULT now()
);

COMMENT ON TABLE event_expectations IS
  'El mercado no reacciona al dato sino a su diferencia con lo esperado. '
  'Dos eventos del mismo tipo con signos de sorpresa opuestos NO son '
  'comparables, aunque el resto del vector coincida (spec §2).';

CREATE INDEX event_expectations_sign_idx
  ON event_expectations (sign(surprise_absolute));

-- ---------------------------------------------------------------------------
-- MACRO BITEMPORAL  (LEY 2)
-- ---------------------------------------------------------------------------

CREATE TABLE macro_observations (
  id                bigserial  PRIMARY KEY,

  metric            text       NOT NULL,
  -- El periodo AL QUE se refiere el dato (p. ej. el Q1 que mide este PIB),
  -- distinto de cuándo se publicó. Esa distinción es el núcleo de LEY 2.
  reference_period  date       NOT NULL,

  value             double precision NOT NULL,
  release_type      macro_release_type NOT NULL,
  revision_number   integer    NOT NULL,

  -- LEY 6
  event_time        clock_time NOT NULL,
  available_at      clock_time NOT NULL,
  ingested_at       clock_time NOT NULL DEFAULT now(),

  source            text       NOT NULL,
  -- Si la variable se obtuvo por proxy (p. ej. VIX vía ETF), la degradación
  -- debe ser VISIBLE en la salida, nunca silenciosa.
  is_proxied        boolean    NOT NULL DEFAULT false,
  proxy_note        text,

  CONSTRAINT macro_revision_nonneg CHECK (revision_number >= 0),
  CONSTRAINT macro_initial_is_zero
    CHECK ((release_type = 'initial') = (revision_number = 0)),
  CONSTRAINT ley6_available_after_event CHECK (available_at >= event_time),
  CONSTRAINT macro_proxy_documented
    CHECK (NOT is_proxied OR proxy_note IS NOT NULL),

  -- Cada revisión es una fila distinta. Nunca un UPDATE.
  CONSTRAINT macro_unique_release
    UNIQUE (metric, reference_period, revision_number)
);

COMMENT ON TABLE macro_observations IS
  'Append-only. El PIB de un trimestre se publica varias veces con valores '
  'distintos; usar la cifra final en un backtest de fecha anterior es '
  'look-ahead disfrazado — el más peligroso, porque no rompe nada: sólo '
  'produce resultados mejores de lo que la realidad permitía.';

CREATE TRIGGER macro_observations_append_only
  BEFORE UPDATE OR DELETE ON macro_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE INDEX macro_asof_idx ON macro_observations (metric, available_at DESC);

-- Vista as-of: el valor VIGENTE en T es el último release con
-- available_at <= T. No el más reciente de hoy.
CREATE OR REPLACE FUNCTION macro_as_of(p_metric text, p_t clock_time)
RETURNS TABLE (
  metric text, reference_period date, value double precision,
  release_type macro_release_type, revision_number integer,
  available_at clock_time, is_proxied boolean
)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (m.reference_period)
         m.metric, m.reference_period, m.value,
         m.release_type, m.revision_number, m.available_at, m.is_proxied
  FROM macro_observations m
  WHERE m.metric = p_metric
    AND m.available_at <= p_t          -- LEY 1
  ORDER BY m.reference_period DESC, m.available_at DESC;
$$;

-- ---------------------------------------------------------------------------
-- SNAPSHOT DE RÉGIMEN  (capa 4)
-- ---------------------------------------------------------------------------

CREATE TABLE macro_snapshots (
  id            bigserial  PRIMARY KEY,
  -- El instante respecto al cual se resolvió el régimen.
  as_of         clock_time NOT NULL,
  ingested_at   clock_time NOT NULL DEFAULT now(),
  -- {metric: {value, available_at, revision_number, is_proxied}}
  regime        jsonb      NOT NULL,
  -- Cuántas de las 11 variables se pudieron resolver. La cobertura parcial
  -- debe ser visible: un régimen con 3 de 11 variables no es un régimen.
  coverage_count integer   NOT NULL,
  coverage_total integer   NOT NULL,

  CONSTRAINT snapshot_coverage_sane
    CHECK (coverage_count >= 0 AND coverage_count <= coverage_total)
);

CREATE INDEX macro_snapshots_asof_idx ON macro_snapshots (as_of DESC);

ALTER TABLE events
  ADD COLUMN macro_snapshot_id bigint REFERENCES macro_snapshots(id);

-- ---------------------------------------------------------------------------
-- PRECIOS  (capa 9 — medición de la reacción real)
-- ---------------------------------------------------------------------------

CREATE TABLE market_prices (
  id           bigserial  PRIMARY KEY,
  symbol       text       NOT NULL,
  session_date date       NOT NULL,

  open         numeric(18,6),
  high         numeric(18,6),
  low          numeric(18,6),
  close        numeric(18,6) NOT NULL,
  volume       bigint,

  -- LEY 1: un cierre no está disponible hasta que la sesión cierra. Sin este
  -- campo, un backtest podría usar el cierre del mismo día del evento.
  available_at clock_time NOT NULL,
  ingested_at  clock_time NOT NULL DEFAULT now(),

  -- PR-4: se almacena la serie CRUDA. Los precios ajustados se reescriben
  -- hacia atrás en cada split, de modo que un backtest de 2021 vería precios
  -- que nadie pudo observar en 2021. El ajuste se reconstruye con
  -- corporate_actions, aplicando sólo las acciones con available_at <= T.
  is_adjusted  boolean    NOT NULL DEFAULT false,

  CONSTRAINT market_prices_uq UNIQUE (symbol, session_date),
  CONSTRAINT market_prices_raw_only
    CHECK (NOT is_adjusted)
);

CREATE INDEX market_prices_symbol_date_idx
  ON market_prices (symbol, session_date DESC);

CREATE TABLE corporate_actions (
  id            bigserial  PRIMARY KEY,
  symbol        text       NOT NULL,
  action_type   text       NOT NULL,   -- 'split' | 'dividend'
  ex_date       date       NOT NULL,
  ratio         numeric(18,8),
  amount        numeric(18,6),
  available_at  clock_time NOT NULL,
  ingested_at   clock_time NOT NULL DEFAULT now(),
  CONSTRAINT corporate_actions_uq UNIQUE (symbol, action_type, ex_date)
);

-- ---------------------------------------------------------------------------
-- ARCHIVO DE CONSENSO  (ADR 004)
--
-- El proveedor sólo expone una ventana rodante de 90 días. Capturando a
-- diario construimos nuestro propio archivo as-of, fechado por observación
-- directa. Un día no capturado es un agujero PERMANENTE: el consenso de ayer
-- no se puede volver a observar.
-- ---------------------------------------------------------------------------

CREATE TABLE consensus_snapshots (
  id              bigserial  PRIMARY KEY,
  symbol          text       NOT NULL,
  metric_name     text       NOT NULL,
  period_label    text       NOT NULL,
  period_end      date,

  estimate        double precision NOT NULL,
  -- El instante de captura ES el available_at, y es real: lo observamos.
  available_at    clock_time NOT NULL,
  ingested_at     clock_time NOT NULL DEFAULT now(),
  provider        text       NOT NULL,

  CONSTRAINT consensus_snapshot_uq
    UNIQUE (symbol, metric_name, period_label, available_at)
);

CREATE TRIGGER consensus_snapshots_append_only
  BEFORE UPDATE OR DELETE ON consensus_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE INDEX consensus_asof_idx
  ON consensus_snapshots (symbol, metric_name, available_at DESC);

-- ---------------------------------------------------------------------------
-- AUDITORÍA DE INGESTA  (ADR 004 — los huecos deben ser visibles)
-- ---------------------------------------------------------------------------

CREATE TABLE ingestion_runs (
  id            bigserial  PRIMARY KEY,
  job_name      text       NOT NULL,
  window_start  clock_time NOT NULL,
  window_end    clock_time NOT NULL,
  started_at    clock_time NOT NULL DEFAULT now(),
  finished_at   clock_time,
  status        text       NOT NULL DEFAULT 'running',
  rows_ingested integer    NOT NULL DEFAULT 0,
  error_message text,

  CONSTRAINT ingestion_window_sane CHECK (window_end > window_start),
  CONSTRAINT ingestion_status_valid
    CHECK (status IN ('running', 'ok', 'failed', 'partial'))
);

COMMENT ON TABLE ingestion_runs IS
  'Un hueco se REGISTRA y queda visible; jamás se rellena por interpolación.';

CREATE INDEX ingestion_runs_job_window_idx
  ON ingestion_runs (job_name, window_start DESC);

-- ---------------------------------------------------------------------------
-- MATCHING  (capa 5 — LEY 4)
-- ---------------------------------------------------------------------------

CREATE TABLE similarity_matches (
  id                  bigserial PRIMARY KEY,
  query_event_id      bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  historical_event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  score               double precision NOT NULL,
  -- Los 7 componentes del contrato SimilarityMatch. El código auditado tenía
  -- 5, y uno de ellos era solapamiento de keywords: comparar eventos por
  -- palabras compartidas es comparar por estilo del periodista.
  c_event_type        double precision NOT NULL,
  c_surprise_alignment double precision NOT NULL,
  c_sentiment         double precision NOT NULL,
  c_magnitude         double precision NOT NULL,
  c_asset_overlap     double precision NOT NULL,
  c_macro_distance    double precision NOT NULL,
  c_volatility_regime double precision NOT NULL,

  -- LEY 4: sin saber QUÉ configuración produjo un score, la recalibración de
  -- FASE 3 es irreproducible.
  weights_version     text   NOT NULL,
  -- El instante respecto al cual se resolvió el match. Permite auditar
  -- después que no se usó nada posterior a T.
  computed_as_of      clock_time NOT NULL,
  ingested_at         clock_time NOT NULL DEFAULT now(),

  CONSTRAINT similarity_score_range CHECK (score BETWEEN 0 AND 1),
  CONSTRAINT similarity_no_self CHECK (query_event_id <> historical_event_id),
  CONSTRAINT similarity_uq UNIQUE (query_event_id, historical_event_id, weights_version)
);

CREATE INDEX similarity_query_idx ON similarity_matches (query_event_id, score DESC);

-- ---------------------------------------------------------------------------
-- ESCENARIOS  (capa 6 — LEY 3)
-- ---------------------------------------------------------------------------

CREATE TABLE scenario_projections (
  id                     bigserial PRIMARY KEY,
  event_id               bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  scenario               scenario_class NOT NULL,
  horizon                horizon NOT NULL,

  -- LEY 3 — OBSERVACIÓN: conteo puro, siempre disponible.
  historical_frequency   double precision NOT NULL,
  historical_sample_size integer NOT NULL,

  -- LEY 3 — AFIRMACIÓN DE MODELO: sólo tras validación out-of-sample.
  calibrated_probability double precision,
  calibration_status     calibration_status NOT NULL DEFAULT 'uncalibrated',

  -- Distribución y colas (spec §5/FASE 2)
  ret_mean               double precision,
  ret_stdev              double precision,
  ret_p20                double precision,
  ret_p10                double precision,
  ret_p05                double precision,
  ret_worst_observed     double precision,

  weights_version        text   NOT NULL,
  computed_as_of         clock_time NOT NULL,
  ingested_at            clock_time NOT NULL DEFAULT now(),

  CONSTRAINT scenario_freq_range CHECK (historical_frequency BETWEEN 0 AND 1),
  CONSTRAINT scenario_sample_nonneg CHECK (historical_sample_size >= 0),
  CONSTRAINT scenario_uq UNIQUE (event_id, scenario, horizon, weights_version),

  -- LEY 3 IMPUESTA POR LA BASE DE DATOS.
  -- Es imposible guardar una "probabilidad calibrada" mientras el estado sea
  -- 'uncalibrated'. El código auditado persistía constantes inventadas (0.5,
  -- 0.3 ajustadas ±0.2) en una columna llamada `probability`, donde eran
  -- indistinguibles de una probabilidad real. Aquí ese INSERT falla.
  CONSTRAINT ley3_no_calibrated_without_validation
    CHECK (calibrated_probability IS NULL OR calibration_status <> 'uncalibrated'),
  CONSTRAINT ley3_calibrated_range
    CHECK (calibrated_probability IS NULL OR calibrated_probability BETWEEN 0 AND 1)
);

CREATE INDEX scenario_event_idx ON scenario_projections (event_id, horizon);

-- ---------------------------------------------------------------------------
-- RESULTADOS OBSERVADOS  (capa 9 — el aprendizaje)
--
-- Inexistente en el código auditado: había una tabla learning_feedback que
-- ningún módulo escribía ni leía. Sin esta capa el sistema no aprende nada.
-- ---------------------------------------------------------------------------

CREATE TABLE observed_outcomes (
  id                bigserial PRIMARY KEY,
  event_id          bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  symbol            text   NOT NULL,
  horizon           horizon NOT NULL,

  baseline_close    numeric(18,6) NOT NULL,
  outcome_close     numeric(18,6) NOT NULL,
  realized_return   double precision NOT NULL,

  -- σ del régimen, calculada CON DATOS PREVIOS A T (spec §4).
  regime_sigma      double precision NOT NULL,
  observed_scenario scenario_class NOT NULL,

  measured_at       clock_time NOT NULL,
  ingested_at       clock_time NOT NULL DEFAULT now(),

  CONSTRAINT observed_sigma_positive CHECK (regime_sigma > 0),
  CONSTRAINT observed_uq UNIQUE (event_id, symbol, horizon)
);

CREATE TRIGGER observed_outcomes_append_only
  BEFORE UPDATE OR DELETE ON observed_outcomes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON COLUMN observed_outcomes.observed_scenario IS
  'Clasificado por la definición FIJA de spec §4: bearish < -0.5σ, '
  'neutral dentro de ±0.5σ, bullish > +0.5σ. No ajustable post-hoc.';

COMMIT;
