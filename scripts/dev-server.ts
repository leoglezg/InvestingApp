#!/usr/bin/env node
/**
 * Servidor de PRUEBAS. No es la interfaz definitiva.
 *
 *   npm run dev
 *   → http://localhost:3000
 *
 * Existe para una cosa: comprobar a mano que las piezas construidas hasta
 * ahora funcionan de verdad contra la base y las fuentes. Deliberadamente sin
 * framework, sin build y en un único archivo, para que se lea de un vistazo y
 * se tire cuando llegue la UI real.
 *
 * Escucha SOLO en localhost: expone la cartera y permite modificarla, así que
 * no debe quedar accesible desde fuera de la máquina.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import { computeWeights } from '../src/portfolio/positions.ts';
import { normalizeSymbol, validateQuantity } from '../src/portfolio/positions.ts';
import { loadSecTickers, resolveSymbol, describeResolution } from '../src/data/secTickers.ts';
import { fetchSecFilings, EVENT_FORMS, type SecFiling } from '../src/ingest/sources.ts';
import { clusterCandidates, summarizeDedup, type DedupCandidate } from '../src/dedup/cluster.ts';
import { planDailyIngest } from '../src/ingest/planner.ts';

const PORT = Number(process.env.PORT ?? 3000);
const DB = process.env.DATABASE_URL;
const UA = process.env.SEC_USER_AGENT ?? '';

const pool = DB ? new pg.Pool({ connectionString: DB, max: 4 }) : null;

// ---------------------------------------------------------------------------

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) throw new Error('DATABASE_URL no está configurada (revisa tu .env)');
  const c = await pool.connect();
  try {
    await c.query('SET search_path TO market, public');
    return (await c.query(sql, params)).rows as T[];
  } finally {
    c.release();
  }
}

function classify(f: SecFiling): string {
  const items = f.items ?? '';
  if (items.includes('2.02') || f.form.startsWith('10-Q') || f.form.startsWith('10-K')) return 'EARNINGS';
  if (/1\.01|5\.02|5\.07|2\.03|2\.05|8\.01/.test(items)) return 'CORPORATE';
  return 'OTHER';
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // Un cuerpo enorme no debe agotar la memoria del proceso.
    if (size > 64 * 1024) throw new Error('Cuerpo de la petición demasiado grande');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('El cuerpo no es JSON válido');
  }
}

// --- rutas -----------------------------------------------------------------

const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {

  'GET /api/health': async () => {
    const out: Record<string, unknown> = {
      db: 'sin configurar', secUserAgent: UA ? 'configurado' : 'FALTA',
      fredApiKey: process.env.FRED_API_KEY ? 'configurada' : 'FALTA',
    };
    if (pool) {
      try {
        const r = await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'market'`
        );
        out.db = `conectada (${r[0].n} tablas)`;
      } catch (e) {
        out.db = `ERROR: ${(e as Error).message}`;
      }
    }
    return out;
  },

  'GET /api/portfolio': async () => {
    const rows = await q<Record<string, string | null>>('SELECT * FROM portfolio_weights_as_of(now())');
    const w = computeWeights(rows.map(r => ({
      symbol: String(r.symbol),
      quantity: Number(r.quantity),
      price: r.close_price == null ? null : Number(r.close_price),
    })));
    const meta = new Map(rows.map(r => [String(r.symbol), { kind: r.price_kind, at: r.price_at }]));
    return {
      positions: w.positions.map(p => ({ ...p, ...meta.get(p.symbol) })),
      totalValue: w.totalValue,
      missingPrices: w.missingPrices,
      pricedCoverage: w.pricedCoverage,
    };
  },

  'GET /api/symbols': async () =>
    q(`SELECT symbol, display_name, cik, asset_type, is_tracked FROM symbols ORDER BY symbol`),

  'GET /api/events': async (_req, url) => {
    const symbol = url.searchParams.get('symbol');
    return q(
      `SELECT e.id, e.event_type, e.title, e.available_at, e.verification,
              e.affected_assets
         FROM events e
        WHERE ($1::text IS NULL OR $1 = ANY(e.affected_assets))
        ORDER BY e.available_at DESC LIMIT 50`,
      [symbol]
    );
  },

  'GET /api/plan': async () => {
    const rows = await q<Record<string, unknown>>(
      `SELECT symbol, cik, asset_type, is_tracked FROM symbols`
    );
    const plan = planDailyIngest(
      rows.map(r => ({
        symbol: String(r.symbol),
        cik: (r.cik as string | null) ?? null,
        assetType: r.asset_type as never,
        isTracked: Boolean(r.is_tracked),
      })),
      {
        now: new Date(), includeQuotes: true,
        macroMetrics: ['GDPC1', 'CPIAUCSL', 'UNRATE', 'DFF'],
        newsQueries: ['federal reserve', 'inflation'],
      }
    );
    const byKind: Record<string, number> = {};
    for (const t of plan.tasks) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
    return { trackedSymbols: plan.trackedSymbols, byKind, total: plan.tasks.length, skippedSec: plan.skippedSec };
  },

  /** Deduplicación contra datos reales. No toca la base. */
  'GET /api/verify': async (_req, url) => {
    const raw = (url.searchParams.get('symbols') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (raw.length === 0) throw new Error('Indica al menos un símbolo');
    if (raw.length > 12) throw new Error('Máximo 12 símbolos por consulta');

    const symbols = raw.map(normalizeSymbol);
    const catalog = await loadSecTickers({ userAgent: UA });
    const since = new Date(Date.now() - 180 * 24 * 3600 * 1000);

    const results = [];
    for (const symbol of symbols) {
      const r = resolveSymbol(symbol, catalog);
      if (!r.cik) {
        results.push({ symbol, status: 'no_cik', message: describeResolution(r).message });
        continue;
      }
      try {
        const filings = await fetchSecFilings(r.cik, since, { secUserAgent: UA, fredApiKey: '' });
        const candidates: DedupCandidate[] = filings.map(f => ({
          id: f.accessionNumber, entityKey: r.cik, eventType: classify(f),
          title: `${f.form} ${f.items || ''}`.trim(),
          eventTime: new Date(f.reportDate || f.filingDate),
          availableAt: new Date(f.acceptanceDateTime),
          sourceTier: 'tier1', sourceDomain: 'sec.gov', reportPeriod: f.reportDate,
        }));
        const clusters = clusterCandidates(candidates);
        const s = summarizeDedup(clusters);
        results.push({
          symbol, status: filings.length === 0 ? 'no_event_forms' : 'ok',
          name: r.displayName, cik: r.cik, ...s,
          eventForms: EVENT_FORMS,
          merges: clusters.filter(c => c.members.length > 1).map(c => ({
            at: c.earliestAvailableAt, type: c.eventType,
            docs: c.members.map(m => m.title),
          })),
        });
      } catch (e) {
        results.push({ symbol, status: 'error', message: (e as Error).message });
      }
    }
    return { results };
  },

  'POST /api/position': async (req) => {
    const body = await readBody(req);
    const symbol = normalizeSymbol(String(body.symbol ?? ''));
    const quantity = validateQuantity(body.quantity);

    const exists = await q('SELECT symbol FROM symbols WHERE symbol = $1', [symbol]);
    if (exists.length === 0) {
      const catalog = await loadSecTickers({ userAgent: UA });
      const r = resolveSymbol(symbol, catalog);
      await q(
        `INSERT INTO symbols (symbol, display_name, cik, asset_type) VALUES ($1,$2,$3,$4)`,
        [symbol, r.displayName, r.cik, r.notInSecRegistry ? 'other' : 'stock']
      );
    }

    await q(
      `INSERT INTO portfolio_positions (symbol, quantity, effective_from, source, note)
       VALUES ($1, $2, now(), 'manual', $3)`,
      [symbol, quantity, body.note ?? null]
    );
    return { ok: true, symbol, quantity };
  },
};

// ---------------------------------------------------------------------------

const PAGE = /* html */ `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>InvestingApp — pruebas</title>
<style>
 :root{--bg:#fbfbfa;--fg:#1a1a18;--mut:#6b6b66;--line:#e4e4e0;--acc:#2f5d50;--warn:#8a5a2b}
 @media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#eceae4;--mut:#9a9a93;--line:#2e2e2b;--acc:#7fb3a1;--warn:#d6a35c}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;padding:24px 16px}
 main{max-width:920px;margin:0 auto}
 h1{font-size:19px;margin:0 0 2px} .sub{color:var(--mut);margin:0 0 22px;font-size:13px}
 section{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:14px;background:color-mix(in srgb,var(--bg) 92%,var(--fg) 8%)}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 10px;font-weight:600}
 table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
 th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);padding:5px 8px 5px 0;font-weight:600}
 td{padding:5px 8px 5px 0;border-top:1px solid var(--line)}
 .r{text-align:right} .mut{color:var(--mut)} .warn{color:var(--warn)}
 button{background:var(--acc);color:var(--bg);border:0;border-radius:6px;padding:7px 13px;font:inherit;font-weight:500;cursor:pointer}
 button:hover{opacity:.9}
 input{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;font:inherit}
 .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
 pre{background:color-mix(in srgb,var(--bg) 80%,var(--fg) 20%);padding:10px;border-radius:6px;overflow:auto;font-size:12px;margin:8px 0 0}
 .tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid var(--line);color:var(--mut)}
</style></head><body><main>
<h1>InvestingApp</h1>
<p class="sub">Interfaz de pruebas. No es la definitiva: sirve para comprobar que las piezas funcionan.</p>

<section><h2>Estado</h2><div id="health" class="mut">cargando…</div></section>

<section><h2>Cartera</h2><div id="pf" class="mut">cargando…</div></section>

<section><h2>Modificar posición</h2>
 <div class="row">
  <input id="sym" placeholder="SÍMBOLO" size="9" autocapitalize="characters">
  <input id="qty" placeholder="cantidad" size="9" inputmode="decimal">
  <button onclick="setPos()">Guardar</button>
  <span class="mut">0 cierra la posición · el historial se conserva</span>
 </div>
 <div id="setres"></div></section>

<section><h2>Plan de ingesta</h2>
 <p class="mut" style="margin:0 0 8px">Se construye desde los símbolos registrados, no de una lista fija.</p>
 <div id="plan" class="mut">cargando…</div></section>

<section><h2>Verificar deduplicación con datos reales</h2>
 <div class="row">
  <input id="vs" placeholder="AAPL,MU,SPY" size="30">
  <button onclick="verify()">Consultar SEC</button>
 </div>
 <div id="vres"></div></section>

<section><h2>Eventos detectados</h2><div id="ev" class="mut">cargando…</div></section>
</main>
<script>
const $=i=>document.getElementById(i);
const n=(v,d=2)=>v==null?'—':Number(v).toLocaleString('es',{maximumFractionDigits:d});
async function api(p,o){const r=await fetch(p,o);const j=await r.json();if(!r.ok)throw new Error(j.error||'error');return j}

async function health(){try{const h=await api('/api/health');
 $('health').innerHTML=Object.entries(h).map(([k,v])=>
  \`<div><span class="mut">\${k}:</span> <span class="\${String(v).includes('ERROR')||String(v)==='FALTA'?'warn':''}">\${v}</span></div>\`).join('')}
 catch(e){$('health').innerHTML='<span class="warn">'+e.message+'</span>'}}

async function portfolio(){try{const d=await api('/api/portfolio');
 if(!d.positions.length){$('pf').textContent='Sin posiciones.';return}
 let h='<table><tr><th>Símbolo</th><th class="r">Cantidad</th><th class="r">Precio</th><th class="r">Valor</th><th class="r">Peso</th><th>Origen</th></tr>';
 for(const p of d.positions) h+=\`<tr><td><b>\${p.symbol}</b></td><td class="r">\${n(p.quantity,8)}</td>
  <td class="r">\${n(p.price)}</td><td class="r">\${n(p.marketValue)}</td>
  <td class="r">\${p.weightPct==null?'<span class="warn">—</span>':n(p.weightPct*100,1)+'%'}</td>
  <td class="mut">\${p.kind==='quote'?'en vivo':p.kind==='close'?'cierre':''}</td></tr>\`;
 h+='</table><p class="mut" style="margin:8px 0 0">Total: '+n(d.totalValue)+'</p>';
 if(d.missingPrices.length) h+='<p class="warn" style="margin:4px 0 0">Sin precio: '+d.missingPrices.join(', ')+
  ' — los pesos cubren el '+n(d.pricedCoverage*100,0)+'% de las posiciones.</p>';
 $('pf').innerHTML=h}catch(e){$('pf').innerHTML='<span class="warn">'+e.message+'</span>'}}

async function plan(){try{const p=await api('/api/plan');
 let h='<div class="row" style="gap:14px">'+Object.entries(p.byKind).map(([k,v])=>
  \`<span><b>\${v}</b> <span class="mut">\${k}</span></span>\`).join('')+'</div>';
 h+='<p class="mut" style="margin:8px 0 0">'+p.total+' tareas sobre '+p.trackedSymbols.length+' símbolos: '+p.trackedSymbols.join(', ')+'</p>';
 if(p.skippedSec.length) h+='<p class="mut" style="margin:4px 0 0">Sin capa SEC: '+
  p.skippedSec.map(s=>s.symbol).join(', ')+'</p>';
 $('plan').innerHTML=h}catch(e){$('plan').innerHTML='<span class="warn">'+e.message+'</span>'}}

async function events(){try{const e=await api('/api/events');
 if(!e.length){$('ev').textContent='Sin eventos todavía.';return}
 let h='<table><tr><th>Público desde</th><th>Tipo</th><th>Activos</th><th>Verificación</th><th>Título</th></tr>';
 for(const x of e) h+=\`<tr><td class="mut">\${new Date(x.available_at).toISOString().slice(0,16).replace('T',' ')}</td>
  <td><span class="tag">\${x.event_type}</span></td><td>\${(x.affected_assets||[]).join(', ')}</td>
  <td class="mut">\${x.verification}</td><td>\${x.title}</td></tr>\`;
 $('ev').innerHTML=h+'</table>'}catch(e){$('ev').innerHTML='<span class="warn">'+e.message+'</span>'}}

async function setPos(){const s=$('sym').value.trim(),q=$('qty').value.trim();
 if(!s||q===''){$('setres').innerHTML='<p class="warn">Indica símbolo y cantidad.</p>';return}
 try{const r=await api('/api/position',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({symbol:s,quantity:q})});
  $('setres').innerHTML='<p style="margin:8px 0 0">Guardado: <b>'+r.symbol+'</b> = '+n(r.quantity,8)+'</p>';
  $('sym').value='';$('qty').value='';portfolio();plan()}
 catch(e){$('setres').innerHTML='<p class="warn" style="margin:8px 0 0">'+e.message+'</p>'}}

async function verify(){const s=$('vs').value.trim();if(!s)return;
 $('vres').innerHTML='<p class="mut" style="margin:8px 0 0">consultando la SEC…</p>';
 try{const d=await api('/api/verify?symbols='+encodeURIComponent(s));
  let h='<table style="margin-top:8px"><tr><th>Símbolo</th><th>Resultado</th></tr>';
  for(const r of d.results){
   let c;
   if(r.status==='ok') c=\`<b>\${r.inputCount}</b> documentos → <b>\${r.eventCount}</b> eventos (\${r.mergedCount} fusionados)\`
    +r.merges.map(m=>\`<div class="mut">⤷ \${new Date(m.at).toISOString().slice(0,16).replace('T',' ')} \${m.type}: \${m.docs.join(' + ')}</div>\`).join('');
   else if(r.status==='no_event_forms') c='<span class="mut">registrado ante la SEC, pero no publica formularios de evento</span>';
   else if(r.status==='no_cik') c='<span class="mut">'+r.message+'</span>';
   else c='<span class="warn">'+r.message+'</span>';
   h+=\`<tr><td><b>\${r.symbol}</b><div class="mut" style="font-size:12px">\${r.name||''}</div></td><td>\${c}</td></tr>\`}
  $('vres').innerHTML=h+'</table>'}
 catch(e){$('vres').innerHTML='<p class="warn" style="margin:8px 0 0">'+e.message+'</p>'}}

health();portfolio();plan();events();
</script></body></html>`;

// ---------------------------------------------------------------------------

/**
 * Orígenes admitidos para peticiones desde el navegador.
 *
 * Se permite «null», que es el Origin de un archivo abierto con file://, para
 * que el HTML suelto funcione con doble clic. Y localhost, para la página que
 * sirve este mismo proceso.
 *
 * NO se usa un comodín: este servidor lee y modifica la cartera, y con CORS
 * abierto cualquier web que el usuario visitara podría pedirle datos o
 * cambiar posiciones a su espalda.
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  const permitido =
    origin === undefined ||
    origin === 'null' ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

  if (!permitido) return {};
  return {
    'access-control-allow-origin': origin ?? 'null',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'origin',
  };
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  const cors = corsHeaders(req.headers.origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (key === 'GET /') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  const handler = routes[key];
  if (!handler) {
    res.writeHead(404, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Ruta no encontrada: ${key}` }));
    return;
  }

  try {
    const data = await handler(req, url);
    res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  } catch (e) {
    // El mensaje llega al navegador: útil para depurar, y no expone secretos
    // porque los errores de esta capa hablan de símbolos y validaciones.
    res.writeHead(400, { ...cors, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

/**
 * Diagnóstico de por qué faltan variables cuando el .env sí existe.
 *
 * Dos causas reales, ambas difíciles de ver a simple vista:
 *
 *  - El archivo empieza por una marca de orden de bytes (BOM). PowerShell la
 *    añade con `Out-File -Encoding utf8`, es invisible al abrirlo, y hace que
 *    Node lea la PRIMERA clave como «﻿CLAVE»: esa variable se pierde y
 *    las demás cargan bien, que es justo lo que despista.
 *  - El archivo no se está cargando en absoluto (falta --env-file).
 */
function diagnosticarEnv(): string[] {
  const avisos: string[] = [];
  let contenido: Buffer;
  try {
    contenido = readFileSync('.env');
  } catch {
    avisos.push('No se encontró .env en esta carpeta. Créalo junto a package.json.');
    return avisos;
  }

  if (contenido[0] === 0xef && contenido[1] === 0xbb && contenido[2] === 0xbf) {
    avisos.push(
      'El .env empieza por una marca invisible (BOM) que Node no admite: la ' +
      'PRIMERA línea del archivo se pierde. Para quitarla:'
    );
    avisos.push('    $c = Get-Content .env');
    avisos.push('    [System.IO.File]::WriteAllLines("$PWD\\.env", $c)');
    return avisos;
  }

  const claves = contenido.toString('utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=')[0]);
  if (claves.length > 0) {
    avisos.push(
      `El .env tiene ${claves.length} variable(s) (${claves.join(', ')}) pero no ` +
      'llegaron al proceso. Arranca con "npm run dev", que las carga.'
    );
  }
  return avisos;
}

// Sólo localhost: la interfaz permite modificar la cartera.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  InvestingApp — interfaz de pruebas`);
  console.log(`  http://localhost:${PORT}\n`);

  const faltan: string[] = [];
  if (!DB) faltan.push('DATABASE_URL');
  if (!UA) faltan.push('SEC_USER_AGENT');

  if (faltan.length) {
    console.log(`  ⚠ Falta(n): ${faltan.join(', ')}`);
    for (const a of diagnosticarEnv()) console.log(`    ${a}`);
  } else {
    console.log('  ✓ Credenciales cargadas.');
  }
  console.log('');
});
