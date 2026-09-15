/**
 * Lógica de cartera — pura y testeable, sin acceso a datos.
 *
 * El sistema NO está atado a un conjunto fijo de símbolos: cualquiera puede
 * añadirse, seguirse sin poseerlo, o cerrarse. Lo único que no se puede es
 * borrar historial.
 */

export type AssetType = 'stock' | 'etf' | 'fund' | 'crypto' | 'forex' | 'commodity' | 'other';
export type PositionSource = 'manual' | 'recommendation' | 'import' | 'correction';

export interface Position {
  symbol: string;
  quantity: number;
}

export interface SymbolInfo {
  symbol: string;
  displayName?: string | null;
  /** Identificador SEC. null es legítimo: los ETF no presentan filings. */
  cik?: string | null;
  assetType: AssetType;
  isTracked: boolean;
}

export class InvalidSymbolError extends Error {
  constructor(raw: string, reason: string) {
    super(`Símbolo inválido «${raw}»: ${reason}`);
    this.name = 'InvalidSymbolError';
  }
}

export class InvalidQuantityError extends Error {
  constructor(q: unknown) {
    super(
      `Cantidad inválida: ${q}. Debe ser un número finito ≥ 0. ` +
      `Para cerrar una posición se registra 0, nunca se borra la fila.`
    );
    this.name = 'InvalidQuantityError';
  }
}

/** Normaliza a mayúsculas y valida la forma. Acepta clases como BRK.B o BRK-B. */
export function normalizeSymbol(raw: string): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) throw new InvalidSymbolError(raw, 'está vacío');
  if (s.length > 12) throw new InvalidSymbolError(raw, 'demasiado largo');
  if (!/^[A-Z0-9][A-Z0-9.\-/]*$/.test(s)) {
    throw new InvalidSymbolError(raw, 'contiene caracteres no admitidos');
  }
  return s;
}

export function validateQuantity(q: unknown): number {
  const n = typeof q === 'string' ? Number(q) : q;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new InvalidQuantityError(q);
  }
  return n;
}

/**
 * CIK de la SEC con el relleno a 10 dígitos que exigen las rutas de EDGAR.
 * El valor se almacena sin relleno (320193) y se formatea al construir la URL
 * (CIK0000320193), porque el relleno es un detalle del transporte.
 */
export function padCik(cik: string): string {
  if (!/^[0-9]{1,10}$/.test(cik)) throw new Error(`CIK inválido: ${cik}`);
  return cik.padStart(10, '0');
}

export interface PricedPosition {
  symbol: string;
  quantity: number;
  /** null cuando no hay precio disponible en T. */
  price: number | null;
}

export interface WeightedPosition extends PricedPosition {
  marketValue: number | null;
  /** null cuando falta el precio: no se puede calcular, y no se finge. */
  weightPct: number | null;
}

export interface PortfolioWeights {
  positions: WeightedPosition[];
  totalValue: number;
  /** Símbolos sin precio en T. */
  missingPrices: string[];
  /**
   * Fracción del valor que SÍ pudo valorarse. Si es < 1, los pesos están
   * calculados sobre una cartera incompleta y no deben leerse como exactos.
   */
  pricedCoverage: number;
}

/**
 * Pesos de la cartera.
 *
 * Los símbolos sin precio NO se omiten en silencio: aparecen con `weightPct`
 * a null y se listan en `missingPrices`. Omitirlos redistribuiría su peso
 * entre los demás, inflando las posiciones valoradas y produciendo una
 * cartera que suma 100% pero no es la real — el tipo de error que no falla
 * pero corrompe todo lo que venga después.
 */
export function computeWeights(positions: readonly PricedPosition[]): PortfolioWeights {
  const missingPrices: string[] = [];
  let totalValue = 0;

  for (const p of positions) {
    if (p.price === null || !Number.isFinite(p.price)) missingPrices.push(p.symbol);
    else totalValue += p.quantity * p.price;
  }

  const weighted: WeightedPosition[] = positions.map(p => {
    const mv = p.price === null || !Number.isFinite(p.price) ? null : p.quantity * p.price;
    return {
      ...p,
      marketValue: mv,
      weightPct: mv === null || totalValue === 0 ? null : mv / totalValue,
    };
  });

  weighted.sort((a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1));

  const n = positions.length;
  return {
    positions: weighted,
    totalValue,
    missingPrices,
    pricedCoverage: n === 0 ? 1 : (n - missingPrices.length) / n,
  };
}

export interface PositionChange {
  symbol: string;
  before: number | null;
  after: number;
  kind: 'opened' | 'increased' | 'reduced' | 'closed' | 'unchanged';
}

/** Compara dos estados de la cartera. Base de la auditoría de recomendaciones. */
export function diffPortfolio(
  before: readonly Position[],
  after: readonly Position[]
): PositionChange[] {
  const b = new Map(before.map(p => [p.symbol, p.quantity]));
  const a = new Map(after.map(p => [p.symbol, p.quantity]));
  const changes: PositionChange[] = [];

  for (const [symbol, qAfter] of a) {
    const qBefore = b.get(symbol) ?? null;
    changes.push({ symbol, before: qBefore, after: qAfter, kind: classify(qBefore, qAfter) });
  }
  // Los símbolos ausentes en `after` se cerraron.
  for (const [symbol, qBefore] of b) {
    if (!a.has(symbol)) {
      changes.push({ symbol, before: qBefore, after: 0, kind: qBefore > 0 ? 'closed' : 'unchanged' });
    }
  }

  return changes.sort((x, y) => x.symbol.localeCompare(y.symbol));
}

function classify(before: number | null, after: number): PositionChange['kind'] {
  if (before === null || before === 0) return after > 0 ? 'opened' : 'unchanged';
  if (after === 0) return 'closed';
  if (after > before) return 'increased';
  if (after < before) return 'reduced';
  return 'unchanged';
}

/**
 * Qué capas de análisis puede alimentar un símbolo.
 *
 * Un ETF sin CIK no es un fallo: simplemente no tiene filings. El pipeline
 * debe degradar con elegancia en vez de romperse o, peor, tratar la ausencia
 * como "sin eventos".
 */
export function analysisCapabilities(info: SymbolInfo): {
  secFilings: boolean; prices: boolean; generalNews: boolean; macroRegime: boolean;
  degraded: string[];
} {
  const secFilings = Boolean(info.cik);
  const degraded: string[] = [];
  if (!secFilings) {
    degraded.push(
      `${info.symbol}: sin CIK (${info.assetType}), no hay eventos corporativos vía SEC; ` +
      `el análisis se apoya en precios, macro y noticias generales`
    );
  }
  return { secFilings, prices: true, generalNews: true, macroRegime: true, degraded };
}
