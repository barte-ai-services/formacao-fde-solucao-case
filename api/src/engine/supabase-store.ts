// #41 A loja do motor no Supabase: engine_settings e engine_decisions (migrações 20261116110000, 20261116120000 e
// #41 20261116130000).
import {
  isBoolean,
  isInteger,
  isNumber,
  isString,
  nullable,
  oneOf,
  optional,
  parseRows,
  shaped,
  type Guard,
  type Shape,
} from '../connectors/guards.js';
import { postgresErrorOf, SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import {
  DEFAULT_ANALYST_SETTINGS,
  type EngineDecision,
  type EngineMode,
  type EngineSettings,
  type StoredDecision,
} from './decision.js';
import {
  isClefFailure,
  type EngineReader,
  type EngineStore,
  type Evaluated,
  type ProposalOutcomeRow,
  type Retry,
} from './store.js';

type SettingsRow = {
  level: string;
  delegation_enabled: boolean;
  delegation_before_demo?: boolean | null;
  confidence_threshold: number | string;
  clef_timeout_ms: number;
};

/** #41 O PostgREST devolve `numeric` como número; aceita também o texto, por garantia. */
const isNumeric: Guard<number | string> = (v): v is number | string =>
  isNumber(v) || (isString(v) && v.trim() !== '' && Number.isFinite(Number(v)));

const isSettingsRow = shaped<SettingsRow>({
  level: isString,
  delegation_enabled: isBoolean,
  delegation_before_demo: optional(nullable(isBoolean)),
  confidence_threshold: isNumeric,
  clef_timeout_ms: isInteger,
} satisfies Shape<SettingsRow>);

type DecisionRow = {
  invoice_access_key: string;
  outcome: StoredDecision['outcome'];
  decided_by: StoredDecision['decidedBy'];
  confidence: number | string | null;
  model_version: string;
  mode: StoredDecision['mode'];
  role: StoredDecision['role'];
  reason: string;
  pending_reason: StoredDecision['pendingReason'];
  error: string | null;
  latency_ms: number | null;
  recommendation: 'approve' | 'refuse' | null;
  decided_at: string;
};

const DECISION_COLUMNS =
  'invoice_access_key,outcome,decided_by,confidence,model_version,mode,role,reason,pending_reason,error,latency_ms,recommendation,decided_at';

const isDecisionRow = shaped<DecisionRow>({
  invoice_access_key: isString,
  outcome: oneOf('approve', 'refuse', 'pending'),
  decided_by: oneOf('rule', 'clef', 'person'),
  confidence: nullable(isNumeric),
  model_version: isString,
  mode: oneOf('shadow', 'delegated'),
  role: oneOf('cascade', 'benchmark'),
  reason: isString,
  pending_reason: nullable(oneOf('below_confidence', 'outside_criteria', 'level_not_delegable', 'delegation_off', 'clef_failed')),
  error: nullable(isString),
  latency_ms: nullable(isInteger),
  // #42 A coluna da migração 20261117120000; a linha gravada antes dela (ou o fake sem ela) vale nula.
  recommendation: (v: unknown): v is DecisionRow['recommendation'] => v === undefined || v === null || v === 'approve' || v === 'refuse',
  decided_at: isString,
} satisfies Shape<DecisionRow>);

const decisionFromRow = (r: DecisionRow): StoredDecision => ({
  invoiceAccessKey: r.invoice_access_key,
  outcome: r.outcome,
  decidedBy: r.decided_by,
  confidence: r.confidence === null ? null : Number(r.confidence),
  modelVersion: r.model_version,
  mode: r.mode,
  role: r.role,
  reason: r.reason,
  pendingReason: r.pending_reason,
  error: r.error,
  latencyMs: r.latency_ms,
  recommendation: r.recommendation ?? null,
  decidedAt: r.decided_at,
});

type EvaluatedRow = {
  invoice_access_key: string;
  role: StoredDecision['role'];
  pending_reason: StoredDecision['pendingReason'];
  attempts: number;
  last_attempt_at: string;
};

const isEvaluatedRow = shaped<EvaluatedRow>({
  invoice_access_key: isString,
  role: oneOf('cascade', 'benchmark'),
  pending_reason: nullable(oneOf('below_confidence', 'outside_criteria', 'level_not_delegable', 'delegation_off', 'clef_failed')),
  attempts: isInteger,
  last_attempt_at: isString,
} satisfies Shape<EvaluatedRow>);

const isProposalOutcomeRow = shaped<{ invoice_access_key: string; classification: string; state: ProposalOutcomeRow['state'] }>({
  invoice_access_key: isString,
  classification: isString,
  state: oneOf('registrada', 'aguardando_aprovacao', 'aprovada', 'alterada'),
});

/** #41 Notas por leitura de propostas: a lista vai no filtro `in.(...)` da URL. */
const KEYS_PER_READ = 100;

/** #63 A chave de acesso tem 44 dígitos; validar aqui protege os filtros `in.(...)` montados com ela. */
const isAccessKey = (v: string): boolean => /^\d{44}$/.test(v);

export class SupabaseEngineStore implements EngineStore, EngineReader {
  /**
   * #356 AC-2 `clefTimeoutCapMs`: o teto do prazo do Clef que a rodada manual impõe (cron/manual-window.ts); o valor do banco só exige > 0 e,
   * subido, estouraria a janela do waitUntil. Sem teto (o Cron, a reconferência), vale o do banco.
   */
  constructor(
    private readonly rest: SupabaseRest,
    private readonly clefTimeoutCapMs?: number,
  ) {}

  private capped(settings: EngineSettings): EngineSettings {
    if (this.clefTimeoutCapMs === undefined) return settings;
    return { ...settings, clefTimeoutMs: Math.min(settings.clefTimeoutMs, this.clefTimeoutCapMs) };
  }

  async settings(level: string): Promise<EngineSettings> {
    return this.capped(await this.storedSettings(level));
  }

  private async storedSettings(level: string): Promise<EngineSettings> {
    const rows = parseRows(
      await this.rest.select('engine_settings', { filters: { level: `eq.${level}` } }),
      isSettingsRow,
      'engine_settings',
    );
    const [row] = rows;
    if (!row) return { ...DEFAULT_ANALYST_SETTINGS, level };
    return {
      level: row.level,
      delegationEnabled: row.delegation_enabled,
      delegationBeforeDemo: row.delegation_before_demo ?? null,
      confidenceThreshold: Number(row.confidence_threshold),
      clefTimeoutMs: row.clef_timeout_ms,
    };
  }

  async setDelegation(level: string, delegationEnabled: boolean, beforeDemo: boolean | null): Promise<void> {
    await this.rest.update(
      'engine_settings',
      { level: `eq.${level}` },
      { delegation_enabled: delegationEnabled, delegation_before_demo: beforeDemo, updated_at: new Date().toISOString() },
    );
  }

  /**
   * #41 Duas leituras: as notas com a decisão da cascata e as linhas da versão atual do Clef, separadas entre a
   * resposta (já medida) e a falha (`clef_failed`, com as tentativas e a hora da última, que a rodada usa para
   * tentar de novo a mais antiga e parar no teto).
   */
  async evaluated(mode: EngineMode, clefVersion: string, options: { readonly cascadeOnly?: boolean } = {}): Promise<Evaluated> {
    const read = async (filters: Record<string, string>) =>
      parseRows(
        await this.rest.select('engine_decisions', {
          select: 'invoice_access_key,role,pending_reason,attempts,last_attempt_at',
          filters: { mode: `eq.${mode}`, ...filters },
        }),
        isEvaluatedRow,
        'engine_decisions',
      );
    // #371 A rodada delegada só usa a cascata: uma leitura em vez de duas.
    const [cascadeRows, current] = await Promise.all([
      read({ role: 'eq.cascade' }),
      options.cascadeOnly ? Promise.resolve([]) : read({ model_version: `eq.${clefVersion}` }),
    ]);
    const failure = (r: EvaluatedRow) => isClefFailure({ pendingReason: r.pending_reason });
    return {
      cascade: new Set(cascadeRows.map((r) => r.invoice_access_key)),
      clef: new Set(current.filter((r) => !failure(r)).map((r) => r.invoice_access_key)),
      failed: new Map(
        current
          .filter(failure)
          .map((r) => [r.invoice_access_key, { role: r.role, attempts: r.attempts, lastAttemptAt: r.last_attempt_at }]),
      ),
    };
  }

  /**
   * #371 O lote da rodada delegada: uma leitura das propostas e uma gravação, com o id de cada decisão (nulo na que já existe ou que não tem proposta).
   * Se o lote bate na unicidade de uma cascata por proposta e modo (23505), nenhuma linha entrou: grava uma a uma, e a que perdeu a corrida fica nula.
   */
  async recordMany(decisions: readonly EngineDecision[]): Promise<(number | null)[]> {
    const rows = await this.rowsOf(decisions);
    if (rows.length === 0) return decisions.map(() => null);
    let inserted: unknown[];
    try {
      inserted = await this.rest.insert('engine_decisions', rows, { onConflict: 'proposal_id,model_version,mode', ignoreDuplicates: true });
    } catch (error) {
      if (postgresErrorOf(error)?.code !== '23505') throw error;
      const ids: (number | null)[] = [];
      for (const d of decisions) ids.push(await this.recordWithId(d));
      return ids;
    }
    const idByKey = new Map(
      parseRows(inserted, shaped<{ id: number; invoice_access_key: string }>({ id: isInteger, invoice_access_key: isString }), 'engine_decisions').map((r) => [r.invoice_access_key, r.id]),
    );
    return decisions.map((d) => idByKey.get(d.invoiceAccessKey) ?? null);
  }

  /**
   * #41 Liga cada decisão à proposta da nota (uma por nota) e grava, ignorando a que já existe na mesma
   * proposta, versão e modo. A unicidade de uma cascata por proposta e modo é garantida pela rodada, que só
   * grava a cascata da nota que ainda não tem; duas rodadas ao mesmo tempo gravam a mesma versão e caem na
   * primeira unicidade.
   */
  async record(decisions: readonly EngineDecision[]): Promise<number> {
    const rows = await this.rowsOf(decisions);
    const inserted = await this.rest.insert('engine_decisions', rows, {
      onConflict: 'proposal_id,model_version,mode',
      ignoreDuplicates: true,
    });
    return inserted.length;
  }

  /**
   * #42 A decisão do modo delegado, uma por vez, com o id que a aprovação do motor cita. A linha que já existe na
   * mesma proposta, versão e modo é ignorada (nulo); a cascata que já existe em outra versão bate na unicidade de
   * uma cascata por proposta e modo (23505), e também é nulo: a outra rodada gravou antes e é ela que decide.
   */
  async recordWithId(decision: EngineDecision): Promise<number | null> {
    const rows = await this.rowsOf([decision]);
    if (rows.length === 0) return null;
    let inserted: unknown[];
    try {
      inserted = await this.rest.insert('engine_decisions', rows, {
        onConflict: 'proposal_id,model_version,mode',
        ignoreDuplicates: true,
      });
    } catch (error) {
      if (postgresErrorOf(error)?.code === '23505') return null;
      throw error;
    }
    const [row] = parseRows(inserted, shaped<{ id: number }>({ id: isInteger }), 'engine_decisions');
    return row?.id ?? null;
  }

  /**
   * #41 Liga cada decisão à proposta da nota (uma por nota). A nota sem proposta fica de fora. A unicidade de uma
   * cascata por proposta e modo é garantida pela rodada, que só grava a cascata da nota que ainda não tem; duas
   * rodadas ao mesmo tempo gravam a mesma versão e caem na unicidade (proposta, versão, modo).
   */
  private async rowsOf(decisions: readonly EngineDecision[]): Promise<Record<string, unknown>[]> {
    if (decisions.length === 0) return [];
    const keys = [...new Set(decisions.map((d) => d.invoiceAccessKey))];
    if (!keys.every(isAccessKey)) {
      throw new SupabaseRestError('insert', 'engine_decisions', 0, 'chave de acesso fora do formato');
    }
    const proposals = parseRows(
      await this.rest.select('proposals', {
        select: 'id,invoice_access_key',
        filters: { invoice_access_key: `in.(${keys.map((k) => `"${k}"`).join(',')})` },
      }),
      shaped<{ id: number; invoice_access_key: string }>({ id: isInteger, invoice_access_key: isString }),
      'proposals',
    );
    const idByKey = new Map(proposals.map((p) => [p.invoice_access_key, p.id]));
    return decisions.flatMap((d) => {
      const proposalId = idByKey.get(d.invoiceAccessKey);
      if (proposalId === undefined) return [];
      return [
        {
          proposal_id: proposalId,
          invoice_access_key: d.invoiceAccessKey,
          outcome: d.outcome,
          decided_by: d.decidedBy,
          confidence: d.confidence,
          model_version: d.modelVersion,
          mode: d.mode,
          role: d.role,
          reason: d.reason,
          pending_reason: d.pendingReason,
          error: d.error,
          latency_ms: d.latencyMs,
          // #42 Só na pendência por confiança baixa; nas outras a restrição exige nula.
          recommendation: d.recommendation ?? null,
        },
      ];
    });
  }

  /**
   * #41 A resposta da nova tentativa do Clef: um PATCH por decisão, filtrado pela proposta, versão, modo, papel,
   * `pending_reason = clef_failed` e as tentativas lidas. O filtro garante que só a linha de falha é trocada (o
   * Postgres reconfere o WHERE depois do lock, então duas rodadas ao mesmo tempo nunca sobrescrevem uma resposta nem
   * contam a mesma tentativa duas vezes); as chaves da linha não mudam, e as duas unicidades seguem valendo.
   * `decided_at` passa a ser a hora da resposta.
   */
  async replaceFailed(retries: readonly Retry[]): Promise<number> {
    return this.patchFailed(retries, (d, now) => ({
      outcome: d.outcome,
      decided_by: d.decidedBy,
      confidence: d.confidence,
      reason: d.reason,
      pending_reason: d.pendingReason,
      error: d.error,
      latency_ms: d.latencyMs,
      decided_at: now,
    }));
  }

  /**
   * #41 A nova tentativa que falhou de novo: o mesmo filtro, e só a tentativa, a hora dela, o erro e a latência
   * mudam. `decided_at` fica o da primeira falha, então a proposta não muda de semana no relatório.
   */
  async noteFailedAttempt(retries: readonly Retry[]): Promise<number> {
    return this.patchFailed(retries, (d) => ({ error: d.error, latency_ms: d.latencyMs }));
  }

  private async patchFailed(
    retries: readonly Retry[],
    fields: (d: EngineDecision, now: string) => Record<string, unknown>,
  ): Promise<number> {
    let patched = 0;
    for (const { decision: d, attempts } of retries) {
      if (!isAccessKey(d.invoiceAccessKey)) {
        throw new SupabaseRestError('update', 'engine_decisions', 0, 'chave de acesso fora do formato');
      }
      const now = new Date().toISOString();
      const rows = await this.rest.update(
        'engine_decisions',
        {
          invoice_access_key: `eq.${d.invoiceAccessKey}`,
          model_version: `eq.${d.modelVersion}`,
          mode: `eq.${d.mode}`,
          role: `eq.${d.role}`,
          pending_reason: 'eq.clef_failed',
          attempts: `eq.${attempts}`,
        },
        { ...fields(d, now), attempts: attempts + 1, last_attempt_at: now },
      );
      patched += rows.length;
    }
    return patched;
  }

  /** #41 AC-4 As linhas do motor da nota no modo. A chave fora do formato não tem linha. */
  async forProposal(invoiceAccessKey: string, mode: EngineMode): Promise<StoredDecision[]> {
    if (!isAccessKey(invoiceAccessKey)) return [];
    const rows = await this.rest.select('engine_decisions', {
      select: DECISION_COLUMNS,
      filters: { invoice_access_key: `eq.${invoiceAccessKey}`, mode: `eq.${mode}` },
      order: 'decided_at',
    });
    return parseRows(rows, isDecisionRow, 'engine_decisions').map(decisionFromRow);
  }

  /**
   * #41 AC-5 As linhas do modo num período fechado, pelo índice (mode, decided_at). O limite de cima vai no `and`
   * do PostgREST, porque a coluna já tem o filtro de baixo; o instante vai entre aspas (tem `:` e `.`).
   */
  async between(mode: EngineMode, fromIso: string, toIso: string): Promise<StoredDecision[]> {
    const rows = await this.rest.select('engine_decisions', {
      select: DECISION_COLUMNS,
      filters: { mode: `eq.${mode}`, decided_at: `gte.${fromIso}`, and: `(decided_at.lt."${toIso}")` },
      order: 'decided_at',
    });
    return parseRows(rows, isDecisionRow, 'engine_decisions').map(decisionFromRow);
  }

  /**
   * #354 Os passos mais novos da cascata (regra ou Clef), nos dois modos, do mais novo ao mais velho; com `afterIso`,
   * só os decididos depois dele; `asc` os devolve do mais velho ao mais novo. A linha que a cascata deixou para a pessoa (`decided_by = person`) não entra: a
   * decisão da pessoa está em approvals.
   */
  async recentCascade(limit: number, afterIso?: string, direction: 'asc' | 'desc' = 'desc'): Promise<StoredDecision[]> {
    const rows = await this.rest.select('engine_decisions', {
      select: DECISION_COLUMNS,
      filters: { role: 'eq.cascade', decided_by: 'in.(rule,clef)', ...(afterIso !== undefined && { decided_at: `gt.${afterIso}` }) },
      order: `decided_at.${direction}`,
      limit,
    });
    return parseRows(rows, isDecisionRow, 'engine_decisions').map(decisionFromRow);
  }

  /** #41 AC-5 A classificação e o estado das propostas, em leituras de até 100 notas. */
  async proposals(invoiceAccessKeys: readonly string[]): Promise<ProposalOutcomeRow[]> {
    const keys = [...new Set(invoiceAccessKeys)].filter(isAccessKey);
    const out: ProposalOutcomeRow[] = [];
    for (let i = 0; i < keys.length; i += KEYS_PER_READ) {
      const chunk = keys.slice(i, i + KEYS_PER_READ);
      const rows = parseRows(
        await this.rest.select('proposals', {
          select: 'invoice_access_key,classification,state',
          filters: { invoice_access_key: `in.(${chunk.map((k) => `"${k}"`).join(',')})` },
        }),
        isProposalOutcomeRow,
        'proposals',
      );
      out.push(...rows.map((r) => ({ invoiceAccessKey: r.invoice_access_key, classification: r.classification, state: r.state })));
    }
    return out;
  }
}
