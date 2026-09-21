/**
 * Reconocimiento de tickers (Twelve Data /symbol_search).
 *
 * EL PROBLEMA QUE RESUELVE ESTE MÓDULO no es "encontrar el ticker": es que un
 * mismo ticker identifica cosas distintas en mercados distintos, y pedir el
 * precio sin decidir cuál se quiere devuelve un precio cualquiera de entre
 * ellos. Comprobado contra la API real el 2026-09-21:
 *
 *   SOXL  NYSE (ARCX, USD)  Direxion Daily Semiconductor Bull 3X Shares
 *   SOXL  LSE  (XLON, USD)  Leverage Shares 4x Long Semiconductors ETP
 *   SOXL  BMV  (XMEX, MXN)  Direxion ... cotizado en pesos
 *
 * El de Londres NO es el mismo producto (4x frente a 3x, emisor distinto), y
 * el de México es el mismo producto en otra moneda. Valorar la cartera con
 * cualquiera de los dos por accidente daría un número creíble y falso, que es
 * la peor clase de error: no se nota.
 *
 * De ahí la regla de abajo. Y de ahí que, cuando la regla no basta, este
 * módulo NO elija: devuelve los candidatos. Inventar un desempate sería
 * exactamente el antipatrón que el resto del sistema evita.
 */

import { PROVIDER } from './prices.ts';

const BASE = 'https://api.twelvedata.com';

export interface Listing {
  symbol: string;
  name: string;
  exchange: string;
  micCode: string;
  country: string;
  currency: string;
  instrumentType: string;
}

export class SymbolSearchError extends Error {
  constructor(query: string, reason: string) {
    super(`No se pudo buscar «${query}»: ${reason}`);
    this.name = 'SymbolSearchError';
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Busca un ticker o un nombre. Devuelve TODAS las cotizaciones encontradas,
 * sin filtrar: filtrar aquí escondería la ambigüedad en vez de resolverla.
 */
export async function searchSymbol(
  query: string,
  apiKey: string,
  fetchImpl?: typeof fetch
): Promise<Listing[]> {
  const term = query.trim();
  if (!term) throw new SymbolSearchError(query, 'la consulta está vacía');
  if (!apiKey) throw new SymbolSearchError(term, 'falta TWELVEDATA_API_KEY en el .env');

  const url = new URL(`${BASE}/symbol_search`);
  url.searchParams.set('symbol', term);
  url.searchParams.set('outputsize', '30');
  url.searchParams.set('apikey', apiKey);

  const res = await (fetchImpl ?? fetch)(url.toString());
  if (!res.ok) throw new SymbolSearchError(term, `HTTP ${res.status}`);

  const body = await res.json() as Record<string, unknown>;
  // Igual que /quote, el proveedor devuelve errores con código 200.
  if (body.status === 'error') {
    throw new SymbolSearchError(term, str(body.message) || 'error del proveedor');
  }

  const data = Array.isArray(body.data) ? body.data : [];
  return data.map((d): Listing => {
    const r = d as Record<string, unknown>;
    return {
      symbol: str(r.symbol).toUpperCase(),
      name: str(r.instrument_name),
      exchange: str(r.exchange),
      micCode: str(r.mic_code),
      country: str(r.country),
      currency: str(r.currency),
      instrumentType: str(r.instrument_type),
    };
  }).filter(l => l.symbol !== '');
}

export interface Resolution {
  query: string;
  /** La cotización elegida, o undefined si hubo que rendirse. */
  chosen?: Listing;
  /** Las que compitieron. Se conservan siempre, se haya elegido o no. */
  candidates: Listing[];
  /** Cierto cuando quedó más de una candidata indistinguible por la regla. */
  ambiguous: boolean;
  /** En castellano y para leer: por qué salió esto. */
  reason: string;
}

/**
 * IEX publica cotizaciones de valores cuyo mercado primario es NASDAQ o NYSE.
 * Como listado es real, pero no es la referencia del valor, así que se deja
 * para el final en vez de descartarlo.
 */
const VENUE_SECUNDARIO = new Set(['IEXG']);

/**
 * Elige una cotización entre las encontradas.
 *
 * La regla, en orden y sin excepciones:
 *   1. El símbolo tiene que coincidir exacto con lo buscado (una búsqueda por
 *      "LLY" no debe acabar en "LLETNC", un ETN sudafricano sobre Lilly).
 *   2. Se prefiere Estados Unidos: es el mercado primario de lo que cubre el
 *      proveedor y el que cuadra con los datos de la SEC que usa el resto del
 *      sistema. Sin esto, LLY podría resolverse a la BMV y valorarse en pesos.
 *   3. Dentro de EE.UU., se prefiere el mercado primario sobre IEX.
 *   4. Si queda exactamente una, ésa es. Si queda más de una, NO se elige.
 *
 * El punto 4 es deliberado. Ante dos productos distintos con el mismo ticker,
 * cualquier desempate automático sería una suposición disfrazada de dato.
 */
export function chooseListing(query: string, listings: readonly Listing[]): Resolution {
  const q = query.trim().toUpperCase();
  const base = { query: q, candidates: [...listings] };

  if (listings.length === 0) {
    return { ...base, ambiguous: false, reason: 'el proveedor no conoce este ticker' };
  }

  const exactas = listings.filter(l => l.symbol === q);
  if (exactas.length === 0) {
    return {
      ...base, ambiguous: false,
      reason: `ningún resultado coincide exactamente con «${q}»; ` +
              `lo más parecido es ${listings[0].symbol} (${listings[0].name})`,
    };
  }

  const eeuu = exactas.filter(l => l.country === 'United States');
  const pool = eeuu.length > 0 ? eeuu : exactas;

  const primarias = pool.filter(l => !VENUE_SECUNDARIO.has(l.micCode));
  const finalistas = primarias.length > 0 ? primarias : pool;

  if (finalistas.length === 1) {
    const l = finalistas[0];
    const via = eeuu.length > 0 && exactas.length > eeuu.length
      ? ` (se prefirió el listado de EE.UU. frente a ${exactas.length - eeuu.length} extranjero(s))`
      : '';
    return {
      ...base, chosen: l, ambiguous: false,
      reason: `${l.name} · ${l.exchange} · ${l.currency}${via}`,
    };
  }

  // Varias finalistas: si todas son el MISMO instrumento en el mismo mercado y
  // moneda, la diferencia es de venue y da igual cuál se tome. Si no, no.
  const mismaCosa = finalistas.every(
    l => l.name === finalistas[0].name && l.currency === finalistas[0].currency
  );
  if (mismaCosa) {
    return {
      ...base, chosen: finalistas[0], ambiguous: false,
      reason: `${finalistas[0].name} · ${finalistas[0].exchange} · ${finalistas[0].currency}`,
    };
  }

  return {
    ...base, ambiguous: true,
    reason: `«${q}» identifica ${finalistas.length} instrumentos distintos: ` +
            finalistas.map(l => `${l.name} (${l.exchange}, ${l.currency})`).join(' · ') +
            '. Indica el mercado para desempatar.',
  };
}

/** Reconoce un ticker de principio a fin: busca y decide. */
export async function resolveTicker(
  query: string,
  apiKey: string,
  fetchImpl?: typeof fetch
): Promise<Resolution> {
  return chooseListing(query, await searchSymbol(query, apiKey, fetchImpl));
}

export { PROVIDER };
