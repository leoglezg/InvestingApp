#!/usr/bin/env node
/**
 * Validación de la deduplicación contra DATOS REALES.
 *
 *   npm run verify:real -- AAPL MU NVDA
 *   npm run verify:real -- TSLA JPM XOM        (cualquier ticker sirve)
 *
 * Los tests unitarios usan entidades inventadas a propósito: comprueban que
 * el algoritmo es agnóstico. Esto comprueba otra cosa distinta y también
 * necesaria — que se comporta bien con lo que las fuentes devuelven de
 * verdad, que nunca es tan limpio como un caso sintético.
 *
 * De hecho fue este script el que reveló que la regla del periodo declarado
 * no bastaba: un comunicado de resultados y su informe trimestral traen
 * periodos DISTINTOS, porque uno fecha la publicación y el otro el trimestre
 * cubierto.
 *
 * No toca la base de datos: sólo lee de las fuentes y reporta.
 */

import { loadSecTickers, resolveSymbol } from '../src/data/secTickers.ts';
import { fetchSecFilings, type SecFiling } from '../src/ingest/sources.ts';
import {
  clusterCandidates, assessVerification, summarizeDedup,
  DEFAULT_DEDUP_CONFIG, type DedupCandidate,
} from '../src/dedup/cluster.ts';

const UA = process.env.SEC_USER_AGENT ?? '';
const symbols = process.argv.slice(2).map(s => s.toUpperCase());
const daysBack = Number(process.env.DAYS_BACK ?? 180);

if (symbols.length === 0) {
  console.error('Uso: npm run verify:real -- <SÍMBOLO> [SÍMBOLO...]');
  process.exit(1);
}

/** Traduce los códigos `items` de un 8-K al tipo de evento de la spec. */
function classify(f: SecFiling): string {
  const items = f.items ?? '';
  if (items.includes('2.02') || f.form.startsWith('10-Q') || f.form.startsWith('10-K')) {
    return 'EARNINGS';
  }
  if (/1\.01|5\.02|5\.07|2\.03|2\.05|8\.01/.test(items)) return 'CORPORATE';
  return 'OTHER';
}

const catalog = await loadSecTickers({ userAgent: UA });
const since = new Date(Date.now() - daysBack * 24 * 3600 * 1000);

console.log(`\n  VALIDACIÓN CON DATOS REALES — últimos ${daysBack} días\n`);

let totalIn = 0, totalOut = 0;

for (const symbol of symbols) {
  const resolved = resolveSymbol(symbol, catalog);

  if (!resolved.cik) {
    // No es un fallo: los ETF no presentan filings propios.
    console.log(`  ${symbol.padEnd(6)} sin CIK — no es emisor (${resolved.isNonFiler ? 'ETF o fondo' : '?'}); se omite la capa SEC\n`);
    continue;
  }

  let filings: SecFiling[];
  try {
    filings = await fetchSecFilings(resolved.cik, since, { secUserAgent: UA, fredApiKey: '' });
  } catch (e) {
    console.log(`  ${symbol.padEnd(6)} ERROR: ${(e as Error).message}\n`);
    continue;
  }

  const candidates: DedupCandidate[] = filings.map(f => ({
    id: f.accessionNumber,
    entityKey: resolved.cik,
    eventType: classify(f),
    title: `${f.form} ${f.items || ''}`.trim(),
    eventTime: new Date(f.reportDate || f.filingDate),
    availableAt: new Date(f.acceptanceDateTime),
    sourceTier: 'tier1',
    sourceDomain: 'sec.gov',
    reportPeriod: f.reportDate,
  }));

  const clusters = clusterCandidates(candidates, DEFAULT_DEDUP_CONFIG);
  const s = summarizeDedup(clusters);
  totalIn += s.inputCount; totalOut += s.eventCount;

  const nombre = (resolved.displayName ?? '').slice(0, 28);
  console.log(`  ${symbol.padEnd(6)} ${nombre.padEnd(30)} CIK ${resolved.cik}`);
  console.log(`         ${s.inputCount} documentos → ${s.eventCount} eventos  (${s.mergedCount} fusionados)`);

  for (const c of clusters.filter(x => x.members.length > 1)) {
    const v = assessVerification(c);
    const docs = c.members
      .map(m => m.title)
      .join(' + ');
    const t = c.earliestAvailableAt.toISOString().slice(0, 16).replace('T', ' ');
    console.log(`         ⤷ FUSIÓN  ${t}  ${c.eventType.padEnd(9)} ${docs}  [${v.level}]`);
  }
  console.log('');
}

console.log(`  TOTAL: ${totalIn} documentos → ${totalOut} eventos` +
  (totalIn ? `  (${(100 * (totalIn - totalOut) / totalIn).toFixed(0)}% fusionado)` : ''));
console.log('');
