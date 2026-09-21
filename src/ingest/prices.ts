/**
 * Precios en vivo (ADR 001 / 003_quotes.sql).
 *
 * Un quote es un precio intradía: sirve para valorar la cartera AHORA, y no
 * para calcular sigma ni medir reacciones a horizonte — eso exige cierres de
 * sesión, que viven en otra tabla. La distinción está en el esquema y no debe
 * difuminarse aquí.
 */

const BASE = 'https://api.twelvedata.com';

/**
 * De dónde salió `quotedAt`. No es metadato decorativo: sólo los dos primeros
 * valores son instantes del proveedor y por tanto válidos como `available_at`
 * (OP-6). `request_time` es nuestro reloj y no puede escribirse en la tabla.
 */
export type QuotedAtSource = 'last_quote_at' | 'timestamp' | 'request_time';

export interface Quote {
  symbol: string;
  price: number;
  /** Instante del precio SEGÚN EL PROVEEDOR, no la hora de nuestra petición. */
  quotedAt: Date;
  quotedAtSource: QuotedAtSource;
  isMarketOpen: boolean;
  /** Cierre de la sesión anterior: ése sí es un hecho consumado. */
  previousClose: number | null;
  name: string | null;
  /** Quién dio el dato. Va a la tabla: un precio sin procedencia no es un dato. */
  provider: string;
  /** Mercado donde cotiza, cuando el proveedor lo dice. */
  exchange: string | null;
  currency: string | null;
}

export const PROVIDER = 'twelvedata';

/** Cierto sólo si el instante lo puso el proveedor, no nosotros. */
export function hasProviderInstant(q: Quote): boolean {
  return q.quotedAtSource !== 'request_time';
}

export class QuoteUnavailableError extends Error {
  readonly symbol: string;
  constructor(symbol: string, reason: string) {
    super(`Sin precio para ${symbol}: ${reason}`);
    this.name = 'QuoteUnavailableError';
    this.symbol = symbol;
  }
}

/**
 * El proveedor ha dicho «ahora no», no «no existe».
 *
 * Es una clase aparte porque exige la reacción CONTRARIA a los demás fallos:
 * ante un ticker desconocido, reintentar es perder tiempo; ante un límite por
 * minuto, reintentar es lo único que funciona. Confundirlos hacía que una
 * cartera de 9 símbolos en el plan gratuito (8 créditos/minuto) perdiera
 * siempre el noveno y lo mostrara como si no tuviera precio.
 */
export class RateLimitError extends QuoteUnavailableError {
  readonly retryAfterMs: number | null;
  constructor(symbol: string, retryAfterMs: number | null) {
    super(symbol, 'el plan permite un número limitado de llamadas por minuto');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Traduce el mensaje del proveedor a algo accionable.
 *
 * Ante un ticker que no reconoce responde «**symbol** or **figi** parameter is
 * missing or invalid» — comprobado con ZZQQXX el 2026-09-21. Tal cual, parece
 * un fallo nuestro al construir la petición, y no lo es. El texto original se
 * conserva detrás para no perder información al diagnosticar.
 */
function explainProviderError(message: string): string {
  const m = message.trim();
  if (/symbol.*(missing or invalid|not found)/i.test(m)) {
    return `el proveedor no reconoce este ticker. Comprueba que esté bien ` +
           `escrito y que cotice en un mercado cubierto por tu plan (${m})`;
  }
  if (/limit|credits|quota/i.test(m)) {
    return `se agotó el límite de llamadas del plan; el precio existe pero ` +
           `hoy no se puede pedir (${m})`;
  }
  return m || 'error del proveedor';
}

/** `Retry-After` en milisegundos, cuando el proveedor se molesta en decirlo. */
function retryAfterMs(res: { headers?: { get(name: string): string | null } }): number | null {
  const v = res.headers?.get('retry-after');
  if (!v) return null;
  const segundos = Number(v);
  return Number.isFinite(segundos) && segundos >= 0 ? segundos * 1000 : null;
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

  // 429 llega como código HTTP de verdad (visto con una cartera de 9 símbolos
  // en el plan gratuito). Se distingue del resto para que quien llame pueda
  // esperar y repetir en vez de dar el precio por perdido.
  if (res.status === 429) {
    throw new RateLimitError(symbol, retryAfterMs(res));
  }
  if (!res.ok) throw new QuoteUnavailableError(symbol, `HTTP ${res.status}`);

  const data = await res.json() as Record<string, unknown>;

  // El proveedor devuelve 200 con un cuerpo de error: un símbolo desconocido o
  // el límite de llamadas agotado no llegan como código HTTP.
  if (data.status === 'error' || data.code) {
    const mensaje = String(data.message ?? '');
    // El mismo límite también aparece dentro de una respuesta 200.
    if (Number(data.code) === 429 || /run out of API credits|per minute/i.test(mensaje)) {
      throw new RateLimitError(symbol, null);
    }
    throw new QuoteUnavailableError(symbol, explainProviderError(mensaje));
  }

  const price = num(data.close);
  if (price === null || price <= 0) {
    throw new QuoteUnavailableError(symbol, 'el proveedor no devolvió un precio válido');
  }

  // `last_quote_at` ANTES que `timestamp`. Verificado contra la API real el
  // 2026-09-17: con el mercado abierto los dos campos vienen y NO son lo mismo.
  //
  //   QQQM  timestamp 13:30:00Z   last_quote_at 18:06:00Z
  //   SOXL  timestamp 13:30:00Z   last_quote_at 18:07:00Z
  //   LLY   timestamp 13:30:00Z   last_quote_at 18:07:00Z
  //
  // `timestamp` es el instante de la VELA (la apertura de la sesión: idéntico
  // para los tres); `last_quote_at` es el instante del cruce. Usar `timestamp`
  // fechaba un precio de las 18:07 como si existiera a las 13:30 — casi cinco
  // horas de adelanto, que es exactamente lo que prohíbe la LEY 1 al escribirse
  // en `available_at`. Y como quote_uq es (symbol, quoted_at, provider), todas
  // las actualizaciones del día colisionaban en la misma clave: el precio se
  // congelaba en la primera y el ON CONFLICT DO NOTHING lo ocultaba.
  const ts = num(data.last_quote_at) ?? num(data.timestamp);
  const source: QuotedAtSource =
    num(data.last_quote_at) !== null ? 'last_quote_at'
    : ts !== null ? 'timestamp'
    : 'request_time';
  const quotedAt = ts !== null ? new Date(ts * 1000) : new Date();

  return {
    symbol: String(data.symbol ?? symbol).toUpperCase(),
    price,
    quotedAt,
    quotedAtSource: source,
    isMarketOpen: data.is_market_open === true || data.is_market_open === 'true',
    previousClose: num(data.previous_close),
    name: typeof data.name === 'string' ? data.name : null,
    provider: PROVIDER,
    exchange: typeof data.exchange === 'string' ? data.exchange : null,
    currency: typeof data.currency === 'string' ? data.currency : null,
  };
}

export interface QuoteResult {
  symbol: string;
  quote?: Quote;
  error?: string;
}

export interface FetchQuotesOptions {
  fetchImpl?: typeof fetch;
  /** Pausa entre llamadas mientras el proveedor no proteste. */
  delayMs?: number;
  /** Pausa entre llamadas DESPUÉS de haber chocado con el límite. */
  slowDelayMs?: number;
  /** Cuánto esperar antes de repetir un símbolo que dio 429. */
  cooldownMs?: number;
  /** Cuántas veces repetir un símbolo frenado. 0 lo desactiva. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Precios de varios símbolos.
 *
 * Secuencial a propósito: el plan gratuito limita las llamadas por minuto y
 * una ráfaga en paralelo lo agota y devuelve errores para todos. Un fallo
 * individual no aborta el resto — cada símbolo lleva su resultado.
 *
 * El ritmo se adapta en vez de fijarse de antemano. Empieza rápido, porque una
 * cartera pequeña cabe de sobra en el límite y no tiene por qué tardar; y sólo
 * si el proveedor frena se espacia y se repite el símbolo frenado. Fijar de
 * entrada la pausa lenta castigaría a todas las carteras por lo que sólo le
 * pasa a las grandes, y no espaciar nunca perdía un precio que sí existe:
 * con 9 símbolos y 8 créditos por minuto, el noveno se mostraba «sin precio».
 */
export async function fetchQuotes(
  symbols: readonly string[],
  apiKey: string,
  opts: FetchQuotesOptions = {}
): Promise<QuoteResult[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const rapido = opts.delayMs ?? 250;
  const lento = opts.slowDelayMs ?? 8_000;
  const cooldown = opts.cooldownMs ?? 15_000;
  const maxRetries = opts.maxRetries ?? 2;

  const out: QuoteResult[] = [];
  let frenado = false;

  for (let i = 0; i < symbols.length; i++) {
    if (i > 0) {
      const pausa = frenado ? lento : rapido;
      if (pausa > 0) await sleep(pausa);
    }

    const symbol = symbols[i];
    let intento = 0;
    for (;;) {
      try {
        out.push({ symbol, quote: await fetchQuote(symbol, apiKey, opts.fetchImpl) });
        break;
      } catch (e) {
        if (e instanceof RateLimitError && intento < maxRetries) {
          // A partir de aquí el resto de la cartera va despacio: si ya se ha
          // agotado el cupo, seguir al ritmo rápido sólo produce más rebotes.
          frenado = true;
          intento++;
          await sleep(e.retryAfterMs ?? cooldown);
          continue;
        }
        out.push({ symbol, error: (e as Error).message });
        break;
      }
    }
  }
  return out;
}
