/**
 * Deduplicación: N noticias → 1 evento (capa 2).
 *
 * AGNÓSTICO POR DISEÑO. Este módulo no conoce ningún símbolo, emisor ni
 * sector. Agrupa por entidad + tipo + proximidad temporal + similitud de
 * texto, donde «entidad» es una cadena opaca que el llamante decide (un CIK,
 * un ticker, un identificador de mercado). Añadir, quitar o cambiar símbolos
 * no toca este código.
 *
 * Todos los umbrales entran por parámetro, ninguno está incrustado en la
 * lógica (LEY 4).
 *
 * POR QUÉ IMPORTA: sin esta capa, una misma publicación de resultados contada
 * en dos documentos entra como dos eventos. El matching histórico contaría
 * doble, inflando el número de comparables — que es justo la cifra de la que
 * depende toda la evidencia estadística del sistema.
 */

export type SourceTier = 'tier1' | 'tier2' | 'tier3' | 'tier4';
export type VerificationLevel = 'official' | 'corroborated' | 'single_source' | 'unverified';

export interface DedupCandidate {
  id: string;
  /**
   * Identificador opaco de la entidad afectada. El llamante decide qué es:
   * un CIK, un ticker, lo que sea. null para noticias sin entidad concreta
   * (macro, geopolítica), que se agrupan sólo por texto y tiempo.
   */
  entityKey: string | null;
  eventType: string;
  title: string;
  eventTime: Date;
  availableAt: Date;
  sourceTier: SourceTier;
  sourceDomain: string;
  /** Periodo reportado, si la fuente lo declara. Refuerza la agrupación. */
  reportPeriod?: string | null;
}

export interface DedupConfig {
  /** Ventana máxima entre dos piezas del mismo evento. */
  windowMinutes: number;
  /**
   * Ventana estrecha: dentro de ella basta con compartir entidad y tipo,
   * sin exigir parecido de texto ni mismo periodo declarado.
   *
   * Existe por un caso real. Una publicación de resultados llega en dos
   * documentos: el comunicado y el informe trimestral. Sus títulos no se
   * parecen, y sus periodos declarados son DISTINTOS —uno fecha la
   * publicación, el otro el trimestre que cubre—, así que ninguna de las
   * otras dos reglas los une.
   *
   * El razonamiento: que una misma entidad tenga dos hechos DISTINTOS del
   * mismo tipo tan seguidos es implausible; es mucho más probable que sean
   * dos documentos del mismo hecho.
   */
  tightWindowMinutes: number;

  /**
   * Ventana estrecha POR TIPO DE EVENTO, cuando el tipo lo justifica.
   *
   * Medido sobre filings reales de tres emisores, el hueco entre el
   * comunicado de resultados y el informe trimestral fue de 15 minutos, 3
   * horas y 13,5 horas respectivamente. Cada empresa tiene su costumbre, así
   * que una ventana única o deja casos fuera o es absurdamente laxa para
   * todo lo demás.
   *
   * Los resultados se publican por entregas a lo largo de horas o días; un
   * cambio de directivo, no. De ahí que la ventana dependa del tipo.
   *
   * Sigue siendo agnóstico al emisor: es el TIPO de hecho lo que manda, no
   * quién lo publica.
   */
  tightWindowByType?: Record<string, number>;
  /** Similitud de título para considerar dos textos el mismo contenido. */
  titleSimilarityThreshold: number;
  /** Similitud por encima de la cual dos fuentes distintas son el mismo cable. */
  syndicationThreshold: number;
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  windowMinutes: 120,
  tightWindowMinutes: 60,
  tightWindowByType: {
    // 4 días: cubre con margen los tres patrones medidos (15 min, 3 h, 13,5 h)
    // sin llegar a rozar el trimestre siguiente, que está a ~3 meses.
    EARNINGS: 4 * 24 * 60,
  },
  titleSimilarityThreshold: 0.5,
  syndicationThreshold: 0.85,
};

/**
 * Tokens normalizados de un título.
 *
 * Se conservan cifras y símbolos monetarios: son señal, no ruido. El código
 * auditado los borraba y con ellos la información numérica que la sorpresa
 * necesita (AUDIT.md V-7).
 */
export function tokenize(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}$%.\s-]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
  );
}

/** Jaccard sobre tokens. 1 = idénticos, 0 = sin nada en común. */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokenize(a), tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export interface Cluster {
  members: DedupCandidate[];
  /** La pieza que representa al evento: la más temprana y de mejor tier. */
  representative: DedupCandidate;
  /**
   * El instante en que el hecho pudo conocerse POR PRIMERA VEZ. Es el mínimo
   * de sus miembros, no el del representante: si un cable de Tier 3 salió
   * antes que el comunicado oficial, el hecho ya era público entonces.
   */
  earliestAvailableAt: Date;
  entityKey: string | null;
  eventType: string;
}

const MINUTE = 60_000;

/**
 * Agrupa candidatos en eventos.
 *
 * Dos piezas pertenecen al mismo evento si comparten entidad y tipo, caen
 * dentro de la ventana temporal, y o bien declaran el mismo periodo
 * reportado, o bien sus títulos se parecen lo bastante.
 *
 * La regla del periodo es lo que permite fusionar un 8-K de resultados con
 * el 10-Q del mismo trimestre: sus títulos no se parecen, pero describen el
 * mismo hecho.
 */
export function clusterCandidates(
  candidates: readonly DedupCandidate[],
  config: DedupConfig = DEFAULT_DEDUP_CONFIG
): Cluster[] {
  const sorted = [...candidates].sort(
    (a, b) => a.availableAt.getTime() - b.availableAt.getTime()
  );

  const clusters: Cluster[] = [];

  for (const cand of sorted) {
    const target = clusters.find(c => belongsTo(cand, c, config));
    if (target) {
      target.members.push(cand);
      if (cand.availableAt < target.earliestAvailableAt) {
        target.earliestAvailableAt = cand.availableAt;
      }
      target.representative = pickRepresentative(target.members);
    } else {
      clusters.push({
        members: [cand],
        representative: cand,
        earliestAvailableAt: cand.availableAt,
        entityKey: cand.entityKey,
        eventType: cand.eventType,
      });
    }
  }

  return clusters;
}

function belongsTo(cand: DedupCandidate, cluster: Cluster, cfg: DedupConfig): boolean {
  if (cand.entityKey !== cluster.entityKey) return false;
  if (cand.eventType !== cluster.eventType) return false;

  const tight = cfg.tightWindowByType?.[cand.eventType] ?? cfg.tightWindowMinutes;
  // La ventana amplia nunca puede ser menor que la estrecha del tipo.
  const wide = Math.max(cfg.windowMinutes, tight);

  return cluster.members.some(m => {
    const gap = Math.abs(cand.availableAt.getTime() - m.availableAt.getTime());
    if (gap > wide * MINUTE) return false;

    // Ventana estrecha: entidad y tipo bastan. Dos hechos distintos del mismo
    // tipo, de la misma entidad, tan seguidos, es implausible.
    if (gap <= tight * MINUTE) return true;

    // Mismo periodo declarado: es el mismo hecho aunque el texto difiera.
    if (cand.reportPeriod && m.reportPeriod && cand.reportPeriod === m.reportPeriod) {
      return true;
    }
    return titleSimilarity(cand.title, m.title) >= cfg.titleSimilarityThreshold;
  });
}

const TIER_RANK: Record<SourceTier, number> = { tier1: 0, tier2: 1, tier3: 2, tier4: 3 };

/** Mejor tier primero; a igual tier, el más temprano. */
function pickRepresentative(members: readonly DedupCandidate[]): DedupCandidate {
  return [...members].sort((a, b) =>
    TIER_RANK[a.sourceTier] - TIER_RANK[b.sourceTier] ||
    a.availableAt.getTime() - b.availableAt.getTime()
  )[0];
}

export interface VerificationResult {
  hasTier1: boolean;
  /** Fuentes Tier 2 que NO son redistribuciones del mismo texto. */
  independentTier2Count: number;
  level: VerificationLevel;
  /** Miembros descartados por ser el mismo cable, con su original. */
  syndicatedGroups: { original: string; duplicates: string[] }[];
}

/**
 * Verificación de un evento.
 *
 * La spec es explícita: «Cinco artículos Tier 3 del mismo cable no son cinco
 * confirmaciones». Aquí se detecta la sindicación comparando títulos: dos
 * piezas de dominios distintos con texto casi idéntico son la misma nota
 * redistribuida, y cuentan como una.
 *
 * Sin esto, la verificación se infla sola: basta con que un teletipo lo
 * republiquen veinte medios para que un rumor parezca confirmado.
 */
export function assessVerification(
  cluster: Cluster,
  cfg: DedupConfig = DEFAULT_DEDUP_CONFIG
): VerificationResult {
  const hasTier1 = cluster.members.some(m => m.sourceTier === 'tier1');

  const tier2 = cluster.members.filter(m => m.sourceTier === 'tier2');
  const originals: DedupCandidate[] = [];
  const syndicatedGroups: VerificationResult['syndicatedGroups'] = [];

  for (const m of tier2) {
    const dup = originals.find(o =>
      o.sourceDomain !== m.sourceDomain &&
      titleSimilarity(o.title, m.title) >= cfg.syndicationThreshold
    );
    if (dup) {
      const g = syndicatedGroups.find(x => x.original === dup.id);
      if (g) g.duplicates.push(m.id);
      else syndicatedGroups.push({ original: dup.id, duplicates: [m.id] });
    } else {
      originals.push(m);
    }
  }

  // Dominios distintos entre los originales: ésa es la confirmación real.
  const independentTier2Count = new Set(originals.map(o => o.sourceDomain)).size;

  let level: VerificationLevel;
  if (hasTier1) level = 'official';
  else if (independentTier2Count >= 2) level = 'corroborated';
  else if (cluster.members.length >= 1) level = 'single_source';
  else level = 'unverified';

  return { hasTier1, independentTier2Count, level, syndicatedGroups };
}

export interface DedupSummary {
  inputCount: number;
  eventCount: number;
  /** Cuántas piezas se fusionaron. Es el ruido que se habría contado doble. */
  mergedCount: number;
  largestCluster: number;
}

export function summarizeDedup(clusters: readonly Cluster[]): DedupSummary {
  const inputCount = clusters.reduce((n, c) => n + c.members.length, 0);
  return {
    inputCount,
    eventCount: clusters.length,
    mergedCount: inputCount - clusters.length,
    largestCluster: clusters.reduce((m, c) => Math.max(m, c.members.length), 0),
  };
}
