#!/usr/bin/env node
/**
 * CLI de cartera.
 *
 *   npm run portfolio -- list
 *   npm run portfolio -- set AAPL 3.5
 *   npm run portfolio -- set AAPL 3.5 --from 2026-09-10 --note "compra"
 *   npm run portfolio -- set AAPL 0                 (cerrar posición)
 *   npm run portfolio -- track NVDA                 (seguir sin poseer)
 *   npm run portfolio -- untrack XYZ
 *   npm run portfolio -- history AAPL
 *   npm run portfolio -- as-of 2026-06-01
 *
 * Los cambios son SIEMPRE altas, nunca modificaciones: la cartera es
 * append-only para poder reconstruir qué se tenía en cualquier fecha pasada.
 */

import pg from 'pg';
import { loadSecTickers, resolveSymbol, describeResolution } from '../src/data/secTickers.ts';
import {
  normalizeSymbol, validateQuantity, computeWeights, analysisCapabilities,
  type AssetType, type PositionSource,
} from '../src/portfolio/positions.ts';

const DB = process.env.DATABASE_URL;
const UA = process.env.SEC_USER_AGENT ?? '';

if (!DB) {
  console.error('Falta DATABASE_URL. Copia .env.example a .env y rellénala.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB });
await client.connect();
await client.query('SET search_path TO market, public');

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags.set(rest[i].slice(2), rest[++i] ?? '');
  else args.push(rest[i]);
}

const fmt = (n: unknown) => Number(n).toLocaleString('es', { maximumFractionDigits: 8 });

try {
  switch (cmd) {
    case 'list': await list(new Date()); break;
    case 'as-of': await list(parseDate(args[0], 'as-of requiere una fecha')); break;
    case 'set': await set(args[0], args[1]); break;
    case 'track': await track(args[0]); break;
    case 'untrack': await setTracked(args[0], false); break;
    case 'retrack': await setTracked(args[0], true); break;
    case 'history': await history(args[0]); break;
    default: usage();
  }
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await client.end();
}

function usage(): void {
  console.log(`
  Uso:
    list                       cartera actual
    as-of <YYYY-MM-DD>         cartera tal como era en esa fecha
    set <SÍMBOLO> <CANTIDAD>   fija la posición (0 = cerrar)
         [--from <fecha>]      desde cuándo aplica (por defecto, ahora)
         [--note "texto"]      anotación
         [--source manual|recommendation|import|correction]
    track <SÍMBOLO>            seguir sin poseer (candidato)
    untrack / retrack <SÍM>    activar o desactivar la ingesta
    history <SÍMBOLO>          historial completo de la posición
`);
}

function parseDate(raw: string | undefined, msg: string): Date {
  if (!raw) throw new Error(msg);
  const d = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${raw}`);
  return d;
}

async function list(at: Date): Promise<void> {
  const { rows } = await client.query(
    `SELECT * FROM portfolio_weights_as_of($1)`, [at]
  );
  if (rows.length === 0) {
    console.log('\n  Cartera vacía en esa fecha.\n');
    return;
  }

  const w = computeWeights(rows.map(r => ({
    symbol: r.symbol,
    quantity: Number(r.quantity),
    price: r.close_price === null ? null : Number(r.close_price),
  })));

  const meta = new Map(rows.map(r => [r.symbol, { kind: r.price_kind, at: r.price_at }]));

  console.log(`\n  Cartera al ${at.toISOString().slice(0, 16).replace('T', ' ')}\n`);
  console.log('  SÍMBOLO   CANTIDAD        PRECIO        VALOR     PESO   ORIGEN');
  console.log('  ' + '─'.repeat(68));
  for (const p of w.positions) {
    const price = p.price === null ? '       —' : fmt(p.price).padStart(8);
    const mv = p.marketValue === null ? '       —' : fmt(p.marketValue.toFixed(2)).padStart(8);
    const pct = p.weightPct === null ? '     —' : `${(p.weightPct * 100).toFixed(1)}%`.padStart(6);
    const m = meta.get(p.symbol);
    // Transparencia sobre la procedencia: un precio en vivo y un cierre de
    // hace tres días valen distinto, y el usuario debe poder distinguirlos.
    const origen = !m?.kind ? ''
      : m.kind === 'quote'
        ? `en vivo ${new Date(m.at).toISOString().slice(11, 16)}`
        : `cierre ${new Date(m.at).toISOString().slice(5, 10)}`;
    console.log(`  ${p.symbol.padEnd(9)} ${fmt(p.quantity).padStart(9)}  ${price}  ${mv}  ${pct}   ${origen}`);
  }

  if (w.missingPrices.length) {
    console.log(`\n  ⚠ Sin precio en esa fecha: ${w.missingPrices.join(', ')}`);
    console.log(`    Los pesos cubren el ${(w.pricedCoverage * 100).toFixed(0)}% de las posiciones,`);
    console.log('    así que no suman el total real de la cartera.');
  } else {
    console.log(`\n  Valor total: ${fmt(w.totalValue.toFixed(2))}`);
  }
  console.log('');
}

async function set(rawSymbol: string, rawQty: string): Promise<void> {
  if (!rawSymbol || rawQty === undefined) throw new Error('Uso: set <SÍMBOLO> <CANTIDAD>');
  const symbol = normalizeSymbol(rawSymbol);
  const quantity = validateQuantity(rawQty);
  const from = flags.has('from') ? parseDate(flags.get('from'), '') : new Date();
  const source = (flags.get('source') ?? 'manual') as PositionSource;

  await ensureSymbol(symbol);

  const prev = await client.query(
    `SELECT quantity FROM portfolio_positions WHERE symbol = $1
      AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`,
    [symbol, from]
  );
  const before = prev.rows[0] ? Number(prev.rows[0].quantity) : null;

  await client.query(
    `INSERT INTO portfolio_positions (symbol, quantity, effective_from, source, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [symbol, quantity, from, source, flags.get('note') ?? null]
  );

  const verb = before === null ? 'Abierta' : quantity === 0 ? 'Cerrada'
    : quantity > before ? 'Aumentada' : quantity < before ? 'Reducida' : 'Sin cambio en';
  const antes = before === null ? '' : ` (antes ${fmt(before)})`;
  console.log(`\n  ${verb} posición en ${symbol}: ${fmt(quantity)}${antes}\n`);
}

async function track(rawSymbol: string): Promise<void> {
  if (!rawSymbol) throw new Error('Uso: track <SÍMBOLO>');
  const symbol = normalizeSymbol(rawSymbol);
  await ensureSymbol(symbol);
  console.log(`\n  ${symbol} en seguimiento. Sin posición: se analiza como candidato.\n`);
}

/**
 * Registra el símbolo si no existe, resolviendo su CIK contra el catálogo de
 * la SEC. No estar en el catálogo es normal para ETF y fondos.
 */
async function ensureSymbol(symbol: string): Promise<void> {
  const existing = await client.query('SELECT symbol FROM symbols WHERE symbol = $1', [symbol]);
  if (existing.rowCount) return;

  let cik: string | null = null;
  let displayName: string | null = null;
  let assetType: AssetType = 'stock';

  try {
    const catalog = await loadSecTickers({ userAgent: UA });
    const r = resolveSymbol(symbol, catalog);
    cik = r.cik; displayName = r.displayName;
    if (r.notInSecRegistry) {
      // No se marca como 'etf': sin consultar un proveedor de mercado no se
      // puede saber si es un fondo legítimo o un símbolo mal escrito.
      assetType = 'other';
      const { message } = describeResolution(r);
      console.log(`\n  ${symbol}: ${message}.`);
      console.log('  Se registra sin CIK. Si esperabas una acción, revisa el símbolo.');
    }
  } catch (e) {
    console.log(`\n  ⚠ No se pudo consultar el catálogo de la SEC (${(e as Error).message}).`);
    console.log('    El símbolo se registra sin CIK; puede completarse más tarde.');
  }

  await client.query(
    `INSERT INTO symbols (symbol, display_name, cik, asset_type) VALUES ($1,$2,$3,$4)`,
    [symbol, displayName, cik, assetType]
  );

  const caps = analysisCapabilities({ symbol, cik, assetType, isTracked: true });
  for (const d of caps.degraded) console.log(`  ℹ ${d}`);
}

async function setTracked(rawSymbol: string, tracked: boolean): Promise<void> {
  if (!rawSymbol) throw new Error('Uso: untrack|retrack <SÍMBOLO>');
  const symbol = normalizeSymbol(rawSymbol);
  const r = await client.query(
    'UPDATE symbols SET is_tracked = $2 WHERE symbol = $1 RETURNING symbol', [symbol, tracked]
  );
  if (!r.rowCount) throw new Error(`${symbol} no está registrado.`);
  console.log(`\n  ${symbol}: ingesta ${tracked ? 'activada' : 'desactivada'}.`);
  console.log('  El histórico ya recogido se conserva.\n');
}

async function history(rawSymbol: string): Promise<void> {
  if (!rawSymbol) throw new Error('Uso: history <SÍMBOLO>');
  const symbol = normalizeSymbol(rawSymbol);
  const { rows } = await client.query(
    `SELECT quantity, effective_from, recorded_at, source, note
       FROM portfolio_positions WHERE symbol = $1 ORDER BY effective_from`,
    [symbol]
  );
  if (!rows.length) { console.log(`\n  Sin historial para ${symbol}.\n`); return; }

  console.log(`\n  Historial de ${symbol}\n`);
  console.log('  VIGENTE DESDE        CANTIDAD   ORIGEN          NOTA');
  console.log('  ' + '─'.repeat(62));
  for (const r of rows) {
    const d = new Date(r.effective_from).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  ${d}  ${fmt(r.quantity).padStart(9)}   ${String(r.source).padEnd(14)}  ${r.note ?? ''}`);
  }
  console.log('');
}
