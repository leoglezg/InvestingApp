/**
 * Resolución ticker → CIK contra el catálogo oficial de la SEC.
 *
 * Es lo que permite añadir cualquier símbolo sin tocar código. Un ticker que
 * no aparece NO es un error: los ETF no son emisores con filings propios, así
 * que se registran sin CIK y su análisis se apoya en las demás fuentes.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SecCompany {
  ticker: string;
  cik: string;
  title: string;
}

interface CacheFile {
  fetchedAt: string;
  companies: Record<string, SecCompany>;
}

/**
 * La SEC exige identificarse. Sin `User-Agent` responde 403 — no es opcional
 * ni cosmético.
 */
function headers(userAgent: string): HeadersInit {
  if (!userAgent?.trim()) {
    throw new Error(
      'SEC_USER_AGENT es obligatorio: la SEC exige identificar al solicitante ' +
      'y devuelve 403 sin esa cabecera. Formato: "Proyecto contacto@ejemplo.com".'
    );
  }
  return { 'User-Agent': userAgent, Accept: 'application/json' };
}

async function readCache(path: string): Promise<CacheFile | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    const age = Date.now() - new Date(parsed.fetchedAt).getTime();
    return age < CACHE_TTL_MS ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Catálogo completo, cacheado en disco 24 h.
 *
 * Son ~800 KB y >10.000 emisores. Descargarlo en cada consulta sería
 * maleducado con un servicio público y gratuito.
 */
export async function loadSecTickers(opts: {
  userAgent: string;
  cachePath?: string;
  force?: boolean;
}): Promise<Record<string, SecCompany>> {
  const cachePath = opts.cachePath ?? join(process.cwd(), '.cache', 'sec_company_tickers.json');

  if (!opts.force) {
    const cached = await readCache(cachePath);
    if (cached) return cached.companies;
  }

  const res = await fetch(SEC_TICKERS_URL, { headers: headers(opts.userAgent) });
  if (!res.ok) {
    throw new Error(`No se pudo descargar el catálogo de la SEC: HTTP ${res.status}`);
  }

  // El formato es {"0": {cik_str, ticker, title}, "1": {...}}: un objeto
  // indexado por posición, no un array.
  const raw = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;

  const companies: Record<string, SecCompany> = {};
  for (const entry of Object.values(raw)) {
    if (!entry?.ticker) continue;
    companies[entry.ticker.toUpperCase()] = {
      ticker: entry.ticker.toUpperCase(),
      cik: String(entry.cik_str),
      title: entry.title,
    };
  }

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), companies } satisfies CacheFile),
    'utf8'
  );

  return companies;
}

export interface ResolvedSymbol {
  symbol: string;
  cik: string | null;
  displayName: string | null;
  /**
   * true si no figura en el registro de emisores de la SEC.
   *
   * CUIDADO CON LA INTERPRETACIÓN: esto significa exactamente eso y nada más.
   * NO permite concluir que el símbolo sea un ETF, ni que exista siquiera.
   * Un ticker mal escrito produce el mismo resultado que un ETF legítimo.
   *
   * Para distinguirlos hace falta consultar un proveedor de mercado, que es
   * lo que hace `describeResolution` cuando se le da esa información.
   */
  notInSecRegistry: boolean;
}

export function resolveSymbol(
  symbol: string,
  catalog: Record<string, SecCompany>
): ResolvedSymbol {
  const s = symbol.toUpperCase();
  const hit = catalog[s];
  return hit
    ? { symbol: s, cik: hit.cik, displayName: hit.title, notInSecRegistry: false }
    : { symbol: s, cik: null, displayName: null, notInSecRegistry: true };
}

/** Qué se sabe del símbolo en el proveedor de mercado, si se consultó. */
export interface MarketLookup {
  exists: boolean;
  instrumentType?: string | null;
  instrumentName?: string | null;
}

export type ResolutionVerdict =
  | 'issuer'          // emisor con filings propios
  | 'non_filer'       // existe en mercado, pero no presenta filings (ETF, fondo)
  | 'unknown_symbol'  // no existe en ninguna parte: probablemente mal escrito
  | 'unverified';     // no está en la SEC y no se pudo comprobar en mercado

/**
 * Traduce la resolución a un veredicto que no afirme de más.
 *
 * Sin consultar el mercado, lo máximo honesto que puede decirse de un símbolo
 * ausente del registro de la SEC es «no lo sé»: podría ser un ETF o podría
 * ser una errata. Decir «es un ETF» sin comprobarlo convierte el error de
 * tecleo del usuario en una afirmación falsa del sistema.
 */
export function describeResolution(
  r: ResolvedSymbol,
  market?: MarketLookup
): { verdict: ResolutionVerdict; message: string } {
  if (!r.notInSecRegistry) {
    return { verdict: 'issuer', message: `emisor registrado (CIK ${r.cik})` };
  }

  if (!market) {
    return {
      verdict: 'unverified',
      message:
        'no figura en el registro de emisores de la SEC. Puede ser un ETF o ' +
        'fondo (que no presentan filings propios) o un símbolo mal escrito: ' +
        'sin consultar un proveedor de mercado no se puede distinguir',
    };
  }

  if (!market.exists) {
    return {
      verdict: 'unknown_symbol',
      message: 'no existe en el proveedor de mercado ni en el registro de la SEC: revisa el símbolo',
    };
  }

  const tipo = market.instrumentType ?? 'instrumento';
  const nombre = market.instrumentName ? ` — ${market.instrumentName}` : '';
  return {
    verdict: 'non_filer',
    message: `${tipo} sin filings propios${nombre}; el análisis se apoya en precios, macro y noticias`,
  };
}
