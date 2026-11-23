// Tipos do gerador de notas da demonstração (#349).
import type { ApprovalLevel, Classification } from '../domain/index.js';
import type {
  KitNota,
  KitNotaItem,
  KitNotaLancada,
  KitNotaLancadaItem,
  KitOrdem,
  KitOrdemItem,
  KitPagamento,
  KitRecebimento,
  KitRecebimentoItem,
} from '../connectors/kit-rows.js';

export type DemoNotaRow = KitNota & { origin: 'demo' };

/** As linhas prontas para as tabelas kit_*, na ordem das chaves estrangeiras. */
export type DemoRows = {
  kit_ordens: KitOrdem[];
  kit_ordem_itens: KitOrdemItem[];
  kit_notas_lancadas: KitNotaLancada[];
  kit_nota_lancada_itens: KitNotaLancadaItem[];
  kit_notas: DemoNotaRow[];
  kit_nota_itens: KitNotaItem[];
  kit_recebimentos: KitRecebimento[];
  kit_recebimento_itens: KitRecebimentoItem[];
  kit_pagamentos: KitPagamento[];
};

/** O que o gerador espera da conferência: só em memória, nunca gravado. */
export type ExpectedClassification = { readonly classification: Classification; readonly level: ApprovalLevel };

export type DemoBatchInput = {
  /** A semente da rodada: a mesma semente, o mesmo instante e o mesmo início dão as mesmas linhas. */
  readonly seed: number;
  /** De 3 a 8 notas. */
  readonly count: number;
  readonly now: Date;
  /** O número de sequência da primeira nota do lote; cada nota gasta um (a seguinte começa em `nextSequenceStart`). */
  readonly sequenceStart: number;
  /** Chaves de acesso que já existem (as da base e as de rodadas anteriores): o gerador nunca as repete. */
  readonly takenKeys?: ReadonlySet<string>;
};

export type DemoBatch = {
  readonly rows: DemoRows;
  /** Chave de acesso da nota -> classificação e nível esperados. Nunca vai ao banco. */
  readonly expected: ReadonlyMap<string, ExpectedClassification>;
};
