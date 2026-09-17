/**
 * Precios en vivo (ADR 001 / 003_quotes.sql).
 *
 * Un quote es un precio intradía: sirve para valorar la cartera AHORA, y no
 * para calcular sigma ni medir reacciones a horizonte — eso exige cierres de
 * sesión, que viven en otra tabla. La distinción está en el esquema y no debe
 * difuminarse aquí.
 */

const BASE = 'https://api.twelvedata.com';

export interface Quote {
  symbol: string;
  price: number;
  /** Instante del precio SEGÚN EL PROVEEDOR, no la hora de nuestra petición. */
  quotedAt: Date;
  isMarketOpen: boolean;
  /** Cierre de la sesión anterior: ése sí es un hecho consumado. */
  previousClose: number | null;
  name: string | null;
}

export class QuoteUnavailableError extends Error {
  readonly symbol: string;
  constructor(symbol: string, reason: string) {
    super(`Sin precio para ${symbol}: ${reason}`);
    this.name = 'QuoteUnavailableError';
    this.symbol = symbol;
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Precio actual de un símbolo.
 *
 * Lanza en vez de devolver null cuando no hay precio: un precio ausente debe
 * quedar registrado como ausente, no confundirse con cero ni con un fallo
 * silencioso que luego aparece como peso inventado en la cartera.
 */
export async function fetchQuote(
  symbol: string,
  apiKey: string,
  fetchImpl?: typeof fetch
): Promise<Quote> {
  if (!apiKey) {
    throw new QuoteUnavailableError(symbol, 'falta TWELVEDATA_API_KEY en el .env');
  }

  const f = fetchImpl ?? fetch;
  const url = new URL(`${BASE}/quote`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', apiKey);

  const res = await f(url.toString());
  if (!res.ok) throw new QuoteUnavailableError(symbol, `HTTP ${res.status}`);

  const data = await res.json() as Record<string, unknown>;

  // El proveedor devuelve 200 con un cuerpo de error: un símbolo desconocido o
  // el límite de llamadas agotado no llegan como código HTTP.
  if (data.status === 'error' || data.code) {
    throw new QuoteUnavailableError(symbol, String(data.message ?? 'error del proveedor'));
  }

  const price = num(data.close);
  if (price === null || price <= 0) {
    throw new QuoteUnavailableError(symbol, 'el proveedor no devolvió un precio válido');
  }

  // `timestamp` viene en segundos. Si falta, se usa la hora actual y se anota
  // el matiz: es lo mejor disponible, pero no es el instante del proveedor.
  const ts = num(data.timestamp);
  const quotedAt = ts !== null ? new Date(ts * 1000) : new Date();

  return {
    symbol: String(data.symbol ?? symbol).toUpperCase(),
    price,
    quotedAt,
    isMarketOpen: data.is_market_open === true || data.is_market_open === 'true',
    previousClose: num(data.previous_close),
    name: typeof data.name === 'string' ? data.name : null,
  };
}

export interface QuoteResult {
  symbol: string;
  quote?: Quote;
  error?: string;
}

/**
 * Precios de varios símbolos.
 *
 * Secuencial a propósito: el plan gratuito del proveedor limita las llamadas
 * por minuto, y una ráfaga en paralelo lo agota y devuelve errores para todos.
 * Un fallo individual no aborta el resto — cada símbolo lleva su resultado.
 */
export async function fetchQuotes(
  symbols: readonly string[],
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<QuoteResult[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const delay = opts.delayMs ?? 250;
  const out: QuoteResult[] = [];

  for (let i = 0; i < symbols.length; i++) {
    if (i > 0 && delay > 0) await sleep(delay);
    try {
      out.push({ symbol: symbols[i], quote: await fetchQuote(symbols[i], apiKey, opts.fetchImpl) });
    } catch (e) {
      out.push({ symbol: symbols[i], error: (e as Error).message });
    }
  }
  return out;
}
