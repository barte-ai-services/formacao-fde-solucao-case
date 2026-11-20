// Registro das tarefas do Claude (#66, #171): uma linha por tarefa. O laço, a tabela e o Cron servem a todas.
// #38 O dossiê não entra aqui: é reativo, disparado pelo próprio tick quando a proposta nasce (dossier/event.ts),
// sem rodada agendada — uma tarefa deste laço, ao contrário, só roda relendo o que ficou pendente a cada rodada.
import type { SupabaseRest } from '../../connectors/supabase-rest.js';
import type { ClaudeTask } from '../task.js';
import { SupabaseAuditReads } from '../../connectors/audit-reads.js';
import { SupabaseInvoiceAudits } from '../../connectors/invoice-audit-store.js';
import { descriptionMatch } from './description-match.js';
import { invoiceAuditTask } from './invoice-audit.js';
import { probableOrderTask } from './probable-order.js';
import { supplierRequestDraftTask } from '../../supplier/draft-task.js';
import { supplierDeps } from '../../supplier/supabase-deps.js';
import { supplierReplyReadingTask } from '../../supplier/reply-task.js';
import { replyDeps } from '../../supplier/supabase-reply-deps.js';

/** #157: o casamento de descrição e a ordem provável têm 1 pedido por rodada cada (eram 5, o teto antigo da rodada): ficam 5 vezes mais lentos para caber nas subrequests; a conta está em api/src/claude/cron.ts. */
export const DESCRIPTION_MATCH_LIMIT = 1;
export const PROBABLE_ORDER_LIMIT = 1;

/** #157: a leitura tem um pedido por rodada; a conta das subrequests está em api/src/claude/cron.ts. */
export const SUPPLIER_REPLY_LIMIT = 1;

export function tasksFor(rest: SupabaseRest): readonly ClaudeTask<unknown, unknown>[] {
  // #157: estas tarefas nunca enviam: o envio da cobrança é só da rota, por uma pessoa; o `mailer` padrão aqui nem é chamado.
  // #157: a cobrança não é tarefa do Claude: a varredura do prazo a monta pela regra (api/src/cron/supplier-sweep.ts).
  // #157 A ordem é a da fome: com o Worker no plano gratuito (50 subrequests), passado o limite todo fetch lança e as últimas tarefas não rodam; a leitura da #157 vem antes da ordem provável para não ser a primeira a passar fome. O que sobra de fora é a lacuna da #155.
  const reply = replyDeps(rest);
  return [
    { ...descriptionMatch, limit: DESCRIPTION_MATCH_LIMIT }, // #157 casamento de descrição do item sem cadastro; #157 de 5 para 1 por rodada (mais lento, para caber nas subrequests)
    { ...supplierReplyReadingTask(reply), limit: SUPPLIER_REPLY_LIMIT }, // #157 leitura da resposta do fornecedor (#157); grava só a leitura e o status da mensagem
    { ...probableOrderTask(rest), limit: PROBABLE_ORDER_LIMIT }, // #157 ordem provável da nota sem ordem (E5); #157 de 5 para 1 por rodada (mais lento, para caber nas subrequests)
    supplierRequestDraftTask(supplierDeps(rest)), // #156 rascunho do pedido ao fornecedor (#156); não emite nem envia
    // #333 O auditor (#230) saiu deste laço: com ele a rodada media 58 subrequests, fora dos 50 do plano gratuito, e ele, o último, nunca rodava. Tem a lista e o cron próprios (auditTasksFor).
  ] as readonly ClaudeTask<unknown, unknown>[];
}

/**
 * #333 Notas auditadas por invocação do cron do auditor: 1. A conta de pior caso (tasks/invoice-audit.ts) é 4 fixas
 * (2 leituras do laço e 2 do reparo dos níveis) + 34 por nota (18 voltas, AUDIT_MAX_TURNS, + 12 leituras + 4) = 38 para 1 nota; 2 notas dariam 60,
 * que não cabe nos 50, e mudariam o teto `maxPerRun` da tarefa (#230), que os testes do auditor fixam e a #333 não toca (AC-6). Medido com a fila cheia: 8 (2 voltas) e 36 (as 18 voltas do teto e as 12 leituras). São 4 invocações por hora.
 */
export const AUDIT_NOTES_PER_RUN = 1;

/** #333 A lista do cron do auditor: só ele, com a própria invocação e, portanto, o próprio teto de 50 subrequests; a conta está em api/src/claude/cron.ts. */
export function auditTasksFor(rest: SupabaseRest): readonly ClaudeTask<unknown, unknown>[] {
  return [
    { ...invoiceAuditTask({ audits: new SupabaseInvoiceAudits(rest), reads: new SupabaseAuditReads(rest) }), limit: AUDIT_NOTES_PER_RUN }, // #230 auditor de notas (maxPerRun 1), o mais caro, com tool use
  ] as readonly ClaudeTask<unknown, unknown>[];
}
