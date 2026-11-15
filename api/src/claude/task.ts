/**
 * O contrato de uma tarefa do Claude no Worker (#66, #171). Cada tarefa vive num arquivo de
 * src/tasks/ e entra no registro de src/tasks/index.ts com uma linha. Outros planos (#65, #68)
 * acrescentam as suas sem mexer no laço (#66).
 */
import type { Ask, Converse } from './client.js';
import type { Db } from './db.js';

/** #66 Um pedido pendente: a chave estável da entrada e a entrada em si. */
export type PendingRequest<I> = { readonly key: string; readonly input: I };

/** #66 O que a leitura devolve: os pedidos e quantas linhas do banco foram descartadas por fora do formato. */
export type PendingResult<I> = { readonly requests: PendingRequest<I>[]; readonly dropped: number };

export type ClaudeTask<I, O> = {
  /** #66 Nome gravado em claude_suggestions.task; o Worker lê por ele. */
  readonly name: string;
  /** #66 O que falta sugerir, lido do banco e estreitado por guard. O laço tira o que já está ok. */
  pending(db: Db): Promise<PendingResult<I>>;
  /**
   * #230 Teto de pedidos desta tarefa por rodada, abaixo do teto do laço. Opcional: uma tarefa com tool use
   * gasta várias chamadas à Messages API e leituras do banco por pedido, e o plano gratuito tem 50 subrequests.
   */
  readonly maxPerRun?: number;
  /**
   * #66 Pergunta ao Claude e devolve a saída já validada, pronta para gravar.
   * #230 `converse` é o laço de tool use, só para a tarefa que oferece tools; sem ele, ela falha fechada.
   */
  run(input: I, ask: Ask, converse?: Converse): Promise<O>;
};
