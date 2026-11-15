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

export function tasksFor(rest: SupabaseRest): readonly ClaudeTask<unknown, unknown>[] {
  return [
    descriptionMatch, // #66 casamento de descrição do item sem cadastro
    probableOrderTask(rest), // #65 ordem provável da nota sem ordem (E5)
    invoiceAuditTask({ audits: new SupabaseInvoiceAudits(rest), reads: new SupabaseAuditReads(rest) }), // #230 auditor de notas
  ] as readonly ClaudeTask<unknown, unknown>[];
}
