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
    invoiceAuditTask({ audits: new SupabaseInvoiceAudits(rest), reads: new SupabaseAuditReads(rest) }), // #230 auditor de notas (maxPerRun 1); por último: é a mais cara, com tool use
  ] as readonly ClaudeTask<unknown, unknown>[];
}
