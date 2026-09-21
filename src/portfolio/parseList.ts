/**
 * Lectura de una cartera pegada como texto.
 *
 * El objetivo es que se pueda pegar lo que uno tiene a mano —una exportación
 * del bróker, una nota, un mensaje— y no reescribirlo campo a campo. Por eso
 * admite separadores y adornos distintos.
 *
 * Lo que NO hace: adivinar. Una línea que no se entiende se devuelve como
 * línea no entendida, con su número y su texto, en vez de saltarse en
 * silencio. Saltarse una línea sería perder una posición sin avisar, y la
 * cartera resultante parecería completa.
 */

import { normalizeSymbol, validateQuantity } from './positions.ts';

export interface ParsedEntry {
  symbol: string;
  /** null cuando la línea trae sólo el ticker: es un ticker a seguir, sin posición. */
  quantity: number | null;
  line: number;
  raw: string;
}

export interface ParseFailure {
  line: number;
  raw: string;
  reason: string;
}

export interface ParseResult {
  entries: ParsedEntry[];
  failures: ParseFailure[];
  /** Tickers repetidos en la entrada, con la línea que finalmente vale. */
  duplicates: { symbol: string; lines: number[] }[];
}

/** Palabras que acompañan a la cantidad y no aportan nada. */
const RUIDO = /\b(shares?|acciones?|acc\.?|uds?\.?|unidades?|qty|cantidad|titulos?|títulos?)\b/gi;

/**
 * Convierte el trozo numérico en número.
 *
 * "7,42" es un decimal en castellano, pero la coma también separa entradas.
 * Se resuelve por la forma: una coma ENTRE DÍGITOS es decimal; una coma
 * seguida de otra cosa es separador y ya se ha partido antes de llegar aquí.
 * Los separadores de millar ("1.234" o "1,234") no se interpretan: en una
 * cartera de acciones fraccionadas son mucho menos probables que un decimal,
 * y adivinar mal cambiaría la posición por mil.
 */
function aNumero(t: string): number | null {
  const limpio = t.replace(/[$€£\s]/g, '');
  if (!/^[0-9]+([.,][0-9]+)?$/.test(limpio)) return null;
  const n = Number(limpio.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parte el texto en entradas.
 *
 * Los saltos de línea mandan. Dentro de una línea, la coma y el punto y coma
 * separan sólo si lo que sigue empieza por letra: así "LLY 0,88" sigue siendo
 * una entrada y "AAPL 2, KO 3" son dos.
 *
 * El tabulador NO separa entradas: en una tabla exportada es lo que hay entre
 * el ticker y la cantidad. Tratarlo como separador partía "MU<tab>0.3" en dos
 * y la cantidad se colaba como si fuera otro ticker.
 */
function trocear(texto: string): { raw: string; line: number }[] {
  const out: { raw: string; line: number }[] = [];
  texto.split(/\r?\n/).forEach((linea, i) => {
    const partes = linea.split(/[;,](?=\s*[A-Za-z$])/);
    for (const p of partes) {
      const raw = p.trim();
      if (raw) out.push({ raw, line: i + 1 });
    }
  });
  return out;
}

export function parsePortfolioText(texto: string): ParseResult {
  const entries: ParsedEntry[] = [];
  const failures: ParseFailure[] = [];
  const vistos = new Map<string, number[]>();

  for (const { raw, line } of trocear(texto)) {
    // Comentarios y cabeceras de una exportación.
    if (/^[#/]/.test(raw)) continue;

    const limpio = raw.replace(RUIDO, ' ').replace(/[:=]/g, ' ').trim();
    const campos = limpio.split(/\s+/).filter(Boolean);
    if (campos.length === 0) continue;

    // El ticker es el primer campo; el "$" de "$AAPL" es adorno.
    const crudo = campos[0].replace(/^\$/, '');

    // Un número suelto no es un ticker. normalizeSymbol acepta "0.3" —y hace
    // bien, hay mercados con tickers numéricos—, así que el filtro va aquí,
    // donde sabemos que estamos leyendo una lista de posiciones. Se informa
    // en vez de descartarlo: un número suelto suele ser una cantidad que se
    // quedó huérfana, y perderla en silencio falsearía la cartera.
    if (/^[0-9]+([.,][0-9]+)?$/.test(crudo)) {
      failures.push({ line, raw, reason: `«${raw}» es un número suelto, no un ticker` });
      continue;
    }

    let symbol: string;
    try {
      symbol = normalizeSymbol(crudo);
    } catch (e) {
      failures.push({ line, raw, reason: (e as Error).message });
      continue;
    }

    // Cabeceras de tabla: "Symbol Quantity" pasaría el filtro de ticker.
    if (/^(symbol|ticker|simbolo|símbolo|activo)$/i.test(crudo)) continue;

    let quantity: number | null = null;
    if (campos.length > 1) {
      // Se busca el primer campo que sea un número. Así "AAPL 2.24 USD" y
      // "AAPL  2.24" funcionan igual, y sobra lo que venga detrás.
      const n = campos.slice(1).map(aNumero).find(v => v !== null);
      if (n === undefined) {
        failures.push({
          line, raw,
          reason: `no se encontró una cantidad en «${raw}»`,
        });
        continue;
      }
      try {
        quantity = validateQuantity(n);
      } catch (e) {
        failures.push({ line, raw, reason: (e as Error).message });
        continue;
      }
    }

    vistos.set(symbol, [...(vistos.get(symbol) ?? []), line]);
    entries.push({ symbol, quantity, line, raw });
  }

  // Un ticker repetido no es un error: puede ser una lista corregida a mano.
  // Vale la última aparición, pero se informa de que hubo más de una para que
  // nadie descubra tarde que su primera línea no contaba.
  const duplicates: { symbol: string; lines: number[] }[] = [];
  const finales: ParsedEntry[] = [];
  for (const [symbol, lines] of vistos) {
    if (lines.length > 1) duplicates.push({ symbol, lines });
    const ultima = entries.filter(e => e.symbol === symbol).at(-1)!;
    finales.push(ultima);
  }

  return { entries: finales, failures, duplicates };
}
