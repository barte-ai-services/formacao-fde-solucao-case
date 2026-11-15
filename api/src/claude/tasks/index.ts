// Registro das tarefas do Claude (#66, #171): uma linha por tarefa. O laço, a tabela e o Cron servem a todas.
import type { SupabaseRest } from '../../connectors/supabase-rest.js';
import type { ClaudeTask } from '../task.js';
import { descriptionMatch } from './description-match.js';
import { probableOrderTask } from './probable-order.js';

export function tasksFor(rest: SupabaseRest): readonly ClaudeTask<unknown, unknown>[] {
  return [
    descriptionMatch, // #66 casamento de descrição do item sem cadastro
    probableOrderTask(rest), // #65 ordem provável da nota sem ordem (E5)
  ] as readonly ClaudeTask<unknown, unknown>[];
}
