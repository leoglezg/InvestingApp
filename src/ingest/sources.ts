/**
 * Clientes de las fuentes verificadas en FASE 1.
 *
 * Cada una tiene su trampa, documentada en los ADR y aprendida a base de
 * llamadas reales. Están recogidas aquí para no volver a tropezar:
 *
 *   SEC   — exige User-Agent identificando al solicitante, o 403.
 *   FRED  — su realtime period por defecto es HOY, así que el comportamiento
 *           por defecto de la API viola la LEY 2 y no da error al hacerlo.
 *   GDELT — 429 intermitente por cuota compartida; cede con espera creciente.
 */

const SEC_BASE = 'https://data.sec.gov';
const FRED_BASE = 'https://api.stlouisfed.org/fred';
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

export interface FetchDeps {
  secUserAgent: string;
  fredApiKey: string;
  fetchImpl?: typeof fetch;
}

async function getJson(url: string, headers: HeadersInit, f: typeof fetch): Promise<unknown> {
  const res = await f(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url).host}`);
  return res.json();
}

/** CIK con el relleno a 10 dígitos que exigen las rutas de EDGAR. */
export function cikPath(cik: string): string {
  return `CIK${cik.padStart(10, '0')}`;
}

export interface SecFiling {
  accessionNumber: string;
  form: string;
  filingDate: string;
  reportDate: string | null;
  /** Instante en que el regulador aceptó el documento: el mejor available_at. */
  acceptanceDateTime: string;
  /** Códigos de evento del 8-K (2.02 resultados, 5.02 dirección…). */
  items: string;
  primaryDocument: string;
}

/**
 * Formularios que describen un EVENTO de mercado.
 *
 * Sin filtrar, un emisor activo devuelve decenas de Form 4 (operaciones de
 * directivos) por cada 8-K. En una prueba real, NVDA dio 52 filings en 120
 * días y casi todos eran Form 4: ingerirlos como eventos ahogaría la señal
 * en ruido y, peor, inflaría artificialmente el recuento de comparables
 * históricos del matching.
 *
 * Las operaciones de insiders pueden ser señal por sí mismas, pero son otra
 * cosa y merecen su propio tratamiento, no colarse como eventos materiales.
 */
export const EVENT_FORMS = ['8-K', '10-Q', '10-K', '6-K', '20-F'] as const;

function isEventForm(form: string, allowed: readonly string[]): boolean {
  // Acepta enmiendas: "8-K/A" cuenta como 8-K.
  const base = form.split('/')[0].trim().toUpperCase();
  return allowed.includes(base);
}

/**
 * Filings de un emisor dentro de una ventana.
 *
 * El `acceptanceDateTime` es lo valioso: no es cuándo lo contó un medio, es
 * cuándo el hecho pasó a ser público.
 */
export async function fetchSecFilings(
  cik: string, since: Date, deps: FetchDeps,
  opts: { forms?: readonly string[] } = {}
): Promise<SecFiling[]> {
  const allowed = opts.forms ?? EVENT_FORMS;
  const f = deps.fetchImpl ?? fetch;
  const data = await getJson(
    `${SEC_BASE}/submissions/${cikPath(cik)}.json`,
    { 'User-Agent': deps.secUserAgent, Accept: 'application/json' },
    f
  ) as { filings?: { recent?: Record<string, unknown[]> } };

  const r = data.filings?.recent;
  if (!r?.accessionNumber) return [];

  const n = (r.accessionNumber as unknown[]).length;
  const out: SecFiling[] = [];
  const sinceMs = since.getTime();

  for (let i = 0; i < n; i++) {
    const accepted = String(r.acceptanceDateTime?.[i] ?? '');
    if (!accepted || new Date(accepted).getTime() < sinceMs) continue;

    const form = String(r.form?.[i] ?? '');
    if (!isEventForm(form, allowed)) continue;

    out.push({
      accessionNumber: String(r.accessionNumber[i]),
      form,
      filingDate: String(r.filingDate?.[i] ?? ''),
      reportDate: (r.reportDate?.[i] as string) || null,
      acceptanceDateTime: accepted,
      items: String(r.items?.[i] ?? ''),
      primaryDocument: String(r.primaryDocument?.[i] ?? ''),
    });
  }
  return out;
}

export interface MacroObservation {
  date: string;
  value: number;
  realtimeStart: string;
  realtimeEnd: string;
}

/**
 * Serie macro *vintage*: el valor tal como estaba publicado en `asOf`.
 *
 * `realtime_start` es OBLIGATORIO. Omitirlo devuelve la serie revisada de hoy
 * —look-ahead silencioso, LEY 2— y la API no avisa de nada. Por eso este
 * parámetro no tiene valor por defecto.
 */
export async function fetchMacroVintage(
  seriesId: string, asOf: Date, deps: FetchDeps,
  opts: { observationStart?: string } = {}
): Promise<MacroObservation[]> {
  const f = deps.fetchImpl ?? fetch;
  const rt = asOf.toISOString().slice(0, 10);

  const url = new URL(`${FRED_BASE}/series/observations`);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('realtime_start', rt);   // LEY 2
  url.searchParams.set('realtime_end', rt);
  url.searchParams.set('api_key', deps.fredApiKey);
  if (opts.observationStart) url.searchParams.set('observation_start', opts.observationStart);

  const data = await getJson(url.toString(), {}, f) as {
    observations?: { date: string; value: string; realtime_start: string; realtime_end: string }[];
  };

  return (data.observations ?? [])
    // FRED marca los ausentes con '.', no con null. Descartar en vez de
    // convertir a 0, que sería inventar un dato.
    .filter(o => o.value !== '.')
    .map(o => ({
      date: o.date,
      value: Number(o.value),
      realtimeStart: o.realtime_start,
      realtimeEnd: o.realtime_end,
    }));
}

/** Fechas en que una serie fue revisada. Base de la bitemporalidad. */
export async function fetchVintageDates(
  seriesId: string, since: string, deps: FetchDeps
): Promise<string[]> {
  const f = deps.fetchImpl ?? fetch;
  const url = new URL(`${FRED_BASE}/series/vintagedates`);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('realtime_start', since);
  url.searchParams.set('api_key', deps.fredApiKey);

  const data = await getJson(url.toString(), {}, f) as { vintage_dates?: string[] };
  return data.vintage_dates ?? [];
}

export interface NewsArticle {
  url: string;
  title: string;
  /**
   * Cuándo GDELT VIO el artículo, redondeado a 15 minutos. Es un proxy de
   * available_at ligeramente posterior al real: sirve para horizontes de
   * días, no para intradía fino. Nunca debe almacenarse como si fuera el
   * instante de publicación.
   */
  seenDate: string;
  domain: string;
  language: string;
  sourceCountry: string;
}

/**
 * Noticias de una ventana, con reintentos pacientes.
 *
 * GDELT limita por cuota compartida con la IP de salida, así que el 429 es
 * intermitente y cede esperando. Un job nocturno no tiene prisa: es preferible
 * tardar dos minutos a perder el día.
 */
export async function fetchNews(
  query: string, start: Date, end: Date,
  opts: { maxRecords?: number; tries?: number; sleep?: (ms: number) => Promise<void> } = {},
  fetchImpl?: typeof fetch
): Promise<NewsArticle[]> {
  const f = fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '');

  const url = new URL(GDELT_BASE);
  url.searchParams.set('query', query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', String(opts.maxRecords ?? 50));
  url.searchParams.set('startdatetime', stamp(start));
  url.searchParams.set('enddatetime', stamp(end));

  const waits = [0, 15_000, 25_000, 35_000, 50_000, 70_000];
  const tries = opts.tries ?? waits.length;

  for (let i = 0; i < tries; i++) {
    if (waits[i]) await sleep(waits[i]);
    const res = await f(url.toString());
    if (res.status === 429) continue;
    if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);

    const data = await res.json() as { articles?: Record<string, string>[] };
    return (data.articles ?? []).map(a => ({
      url: a.url, title: a.title, seenDate: a.seendate,
      domain: a.domain, language: a.language, sourceCountry: a.sourcecountry,
    }));
  }
  throw new Error(`GDELT: 429 persistente tras ${tries} intentos`);
}
