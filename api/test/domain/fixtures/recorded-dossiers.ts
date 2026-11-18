import type { Divergence } from '../../../src/domain/index.js';

// #313: os dois dossiês gravados em produção em 18/11 (notas 13793 e 13137): a saída do Claude como
// #313: foi gravada e o catálogo que o Worker mandou no prompt. A empresa é fictícia; nada além disto foi copiado.

// #313: o fato `nota.itens.quantidade` não estava no prompt gravado, que é anterior a ele. Foi acrescentado
// #313: com o valor que `buildFactCatalog` daria: 2 itens na nota 13793 e 3 na 13137.

export type RecordedFact = { readonly key: string; readonly label: string; readonly value: string };

export type RecordedDossier = {
  /** #313: o número da nota, como no fato `nota.numero`. */
  readonly number: string;
  readonly accessKey: string;
  /** #313: as chaves de acesso que as evidências das divergências apontam, como o Worker mandou. */
  readonly references: readonly string[];
  readonly facts: readonly RecordedFact[];
  readonly identifiers: readonly string[];
  readonly classifications: readonly Divergence['classification'][];
  /** #313: a saída crua do Claude, como foi gravada. */
  readonly output: {
    readonly summary: string;
    readonly supplier_history: string;
    readonly divergences: readonly { classification: string; what_diverges: string; evidence: string[] }[];
  };
};

export const RECORDED_13793: RecordedDossier = {
  "number": "13793",
  "accessKey": "35261113769729000182550010000137931847092345",
  "references": [
    "35261113769729000182550010000137731145340609",
    "35261113769729000182550010000137931847092345"
  ],
  "facts": [
    {
      "key": "nota.numero",
      "label": "Número da nota",
      "value": "13793"
    },
    {
      "key": "nota.serie",
      "label": "Série da nota",
      "value": "1"
    },
    {
      "key": "nota.total",
      "label": "Valor total da nota",
      "value": "R$ 16.283,52"
    },
    {
      "key": "nota.itens.quantidade",
      "label": "Quantidade de itens da nota",
      "value": "2"
    },
    {
      "key": "nota.item[F07-001].quantidade",
      "label": "Quantidade faturada de Pão de forma 500 g",
      "value": "1012 UN"
    },
    {
      "key": "nota.item[F07-001].preco_unitario",
      "label": "Preço unitário faturado de Pão de forma 500 g",
      "value": "R$ 9,49"
    },
    {
      "key": "nota.item[F07-001].total",
      "label": "Total faturado de Pão de forma 500 g",
      "value": "R$ 9.603,88"
    },
    {
      "key": "nota.item[F07-002].quantidade",
      "label": "Quantidade faturada de Bisnaguinha 300 g",
      "value": "836 UN"
    },
    {
      "key": "nota.item[F07-002].preco_unitario",
      "label": "Preço unitário faturado de Bisnaguinha 300 g",
      "value": "R$ 7,99"
    },
    {
      "key": "nota.item[F07-002].total",
      "label": "Total faturado de Bisnaguinha 300 g",
      "value": "R$ 6.679,64"
    },
    {
      "key": "ordem[OC-2026-42924].total",
      "label": "Valor total da ordem OC-2026-42924",
      "value": "R$ 16.283,52"
    },
    {
      "key": "ordem[OC-2026-42924].status",
      "label": "Situação da ordem OC-2026-42924",
      "value": "atendida"
    },
    {
      "key": "ordem[OC-2026-42924].item[F07-001].quantidade",
      "label": "Quantidade pedida de Pão de forma 500 g",
      "value": "1012 UN"
    },
    {
      "key": "ordem[OC-2026-42924].item[F07-001].preco_unitario",
      "label": "Preço unitário pedido de Pão de forma 500 g",
      "value": "R$ 9,49"
    },
    {
      "key": "ordem[OC-2026-42924].item[F07-001].saldo",
      "label": "Saldo da ordem para Pão de forma 500 g",
      "value": "0 UN"
    },
    {
      "key": "ordem[OC-2026-42924].item[F07-002].quantidade",
      "label": "Quantidade pedida de Bisnaguinha 300 g",
      "value": "836 UN"
    },
    {
      "key": "ordem[OC-2026-42924].item[F07-002].preco_unitario",
      "label": "Preço unitário pedido de Bisnaguinha 300 g",
      "value": "R$ 7,99"
    },
    {
      "key": "ordem[OC-2026-42924].item[F07-002].saldo",
      "label": "Saldo da ordem para Bisnaguinha 300 g",
      "value": "0 UN"
    },
    {
      "key": "cadastro.produto[SKU-1022].fator_caixa",
      "label": "Unidades por caixa de Pão de forma 500 g",
      "value": "4 UN por CX"
    },
    {
      "key": "cadastro.produto[SKU-1022].preco_referencia",
      "label": "Preço de referência por UN de Pão de forma 500 g",
      "value": "R$ 9,49"
    },
    {
      "key": "cadastro.produto[SKU-1023].fator_caixa",
      "label": "Unidades por caixa de Bisnaguinha 300 g",
      "value": "4 UN por CX"
    },
    {
      "key": "cadastro.produto[SKU-1023].preco_referencia",
      "label": "Preço de referência por UN de Bisnaguinha 300 g",
      "value": "R$ 7,99"
    },
    {
      "key": "cadastro.fornecedor.bloqueado",
      "label": "Fornecedor com pagamento bloqueado",
      "value": "não"
    },
    {
      "key": "recebimento[RC-9348].item[F07-001].quantidade",
      "label": "Quantidade contada de Pão de forma 500 g",
      "value": "1012 UN"
    },
    {
      "key": "recebimento[RC-9348].item[F07-002].quantidade",
      "label": "Quantidade contada de Bisnaguinha 300 g",
      "value": "836 UN"
    },
    {
      "key": "historico.notas_lancadas.quantidade",
      "label": "Notas do fornecedor já lançadas",
      "value": "3"
    },
    {
      "key": "historico.notas_lancadas.valor",
      "label": "Valor das notas do fornecedor já lançadas",
      "value": "R$ 24.164,64"
    },
    {
      "key": "historico.pagamentos.quantidade",
      "label": "Pagamentos ao fornecedor",
      "value": "0"
    },
    {
      "key": "historico.pagamentos.valor",
      "label": "Valor pago ao fornecedor",
      "value": "R$ 0,00"
    },
    {
      "key": "historico.notas_capturadas.quantidade",
      "label": "Outras notas do fornecedor capturadas",
      "value": "4"
    }
  ],
  "identifiers": [
    "35261113769729000182550010000137931847092345",
    "F07",
    "CD-02",
    "2026-11-09",
    "OC-2026-42924",
    "F07-001",
    "SKU-1022",
    "F07-002",
    "SKU-1023",
    "E6",
    "35261113769729000182550010000137731145340609",
    "2026-10-28",
    "13.769.729/0001-82",
    "RC-9348",
    "2026-11-02"
  ],
  "classifications": [
    "E6"
  ],
  "output": {
    "summary": "A nota {{nota.numero}} (série {{nota.serie}}) cobra o valor total de {{nota.total}} referente à ordem OC-2026-42924, que já está atendida ({{ordem[OC-2026-42924].status}}). A divergência classificada como E6 aponta que a mesma ordem e o mesmo valor já foram lançados em outro título, da nota 13773, que consta como paga. As quantidades faturadas, contadas e pedidas batem para os dois itens, e o saldo da ordem está zerado para ambos. O fornecedor não está bloqueado.",
    "divergences": [
      {
        "evidence": [
          "nota.total",
          "ordem[OC-2026-42924].total",
          "ordem[OC-2026-42924].status",
          "ordem[OC-2026-42924].item[F07-001].saldo",
          "ordem[OC-2026-42924].item[F07-002].saldo",
          "historico.pagamentos.quantidade",
          "historico.pagamentos.valor"
        ],
        "what_diverges": "A nota 13793 cobra a mesma ordem OC-2026-42924 e o mesmo valor total de um título já lançado (nota 13773), que consta como paga no contas a pagar. Os itens SKU-1022 e SKU-1023 aparecem na divergência.",
        "classification": "E6"
      }
    ],
    "supplier_history": "Fornecedor de código F07 (CNPJ 13.769.729/0001-82), com {{historico.notas_lancadas.quantidade}} notas já lançadas somando {{historico.notas_lancadas.valor}}. Há {{historico.pagamentos.quantidade}} pagamentos registrados, totalizando {{historico.pagamentos.valor}}. Constam ainda {{historico.notas_capturadas.quantidade}} outras notas capturadas. Cadastro sem bloqueio de pagamento ({{cadastro.fornecedor.bloqueado}})."
  }
};

export const RECORDED_13137: RecordedDossier = {
  "number": "13137",
  "accessKey": "35261147573594000106550010000131371591560338",
  "references": [
    "35261147573594000106550010000131371591560338",
    "35261147573594000106550010000131371591560338"
  ],
  "facts": [
    {
      "key": "nota.numero",
      "label": "Número da nota",
      "value": "13137"
    },
    {
      "key": "nota.serie",
      "label": "Série da nota",
      "value": "1"
    },
    {
      "key": "nota.total",
      "label": "Valor total da nota",
      "value": "R$ 118.719,60"
    },
    {
      "key": "nota.itens.quantidade",
      "label": "Quantidade de itens da nota",
      "value": "3"
    },
    {
      "key": "nota.item[F06-001].quantidade",
      "label": "Quantidade faturada de Pão de queijo congelado 1 kg",
      "value": "1524 UN"
    },
    {
      "key": "nota.item[F06-001].preco_unitario",
      "label": "Preço unitário faturado de Pão de queijo congelado 1 kg",
      "value": "R$ 24,90"
    },
    {
      "key": "nota.item[F06-001].total",
      "label": "Total faturado de Pão de queijo congelado 1 kg",
      "value": "R$ 37.947,60"
    },
    {
      "key": "nota.item[F06-002].quantidade",
      "label": "Quantidade faturada de Pizza congelada 460 g",
      "value": "1492 UN"
    },
    {
      "key": "nota.item[F06-002].preco_unitario",
      "label": "Preço unitário faturado de Pizza congelada 460 g",
      "value": "R$ 21,90"
    },
    {
      "key": "nota.item[F06-002].total",
      "label": "Total faturado de Pizza congelada 460 g",
      "value": "R$ 32.674,80"
    },
    {
      "key": "nota.item[F06-003].quantidade",
      "label": "Quantidade faturada de Sorvete 1,5 L",
      "value": "1788 UN"
    },
    {
      "key": "nota.item[F06-003].preco_unitario",
      "label": "Preço unitário faturado de Sorvete 1,5 L",
      "value": "R$ 26,90"
    },
    {
      "key": "nota.item[F06-003].total",
      "label": "Total faturado de Sorvete 1,5 L",
      "value": "R$ 48.097,20"
    },
    {
      "key": "ordem[OC-2026-42950].total",
      "label": "Valor total da ordem OC-2026-42950",
      "value": "R$ 118.719,60"
    },
    {
      "key": "ordem[OC-2026-42950].status",
      "label": "Situação da ordem OC-2026-42950",
      "value": "atendida"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-001].quantidade",
      "label": "Quantidade pedida de Pão de queijo congelado 1 kg",
      "value": "1524 UN"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-001].preco_unitario",
      "label": "Preço unitário pedido de Pão de queijo congelado 1 kg",
      "value": "R$ 24,90"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-001].saldo",
      "label": "Saldo da ordem para Pão de queijo congelado 1 kg",
      "value": "0 UN"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-002].quantidade",
      "label": "Quantidade pedida de Pizza congelada 460 g",
      "value": "1492 UN"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-002].preco_unitario",
      "label": "Preço unitário pedido de Pizza congelada 460 g",
      "value": "R$ 21,90"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-002].saldo",
      "label": "Saldo da ordem para Pizza congelada 460 g",
      "value": "0 UN"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-003].quantidade",
      "label": "Quantidade pedida de Sorvete 1,5 L",
      "value": "1788 UN"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-003].preco_unitario",
      "label": "Preço unitário pedido de Sorvete 1,5 L",
      "value": "R$ 26,90"
    },
    {
      "key": "ordem[OC-2026-42950].item[F06-003].saldo",
      "label": "Saldo da ordem para Sorvete 1,5 L",
      "value": "0 UN"
    },
    {
      "key": "cadastro.produto[SKU-1019].fator_caixa",
      "label": "Unidades por caixa de Pão de queijo congelado 1 kg",
      "value": "4 UN por CX"
    },
    {
      "key": "cadastro.produto[SKU-1019].preco_referencia",
      "label": "Preço de referência por UN de Pão de queijo congelado 1 kg",
      "value": "R$ 24,90"
    },
    {
      "key": "cadastro.produto[SKU-1020].fator_caixa",
      "label": "Unidades por caixa de Pizza congelada 460 g",
      "value": "4 UN por CX"
    },
    {
      "key": "cadastro.produto[SKU-1020].preco_referencia",
      "label": "Preço de referência por UN de Pizza congelada 460 g",
      "value": "R$ 21,90"
    },
    {
      "key": "cadastro.produto[SKU-1021].fator_caixa",
      "label": "Unidades por caixa de Sorvete 1,5 L",
      "value": "4 UN por CX"
    },
    {
      "key": "cadastro.produto[SKU-1021].preco_referencia",
      "label": "Preço de referência por UN de Sorvete 1,5 L",
      "value": "R$ 26,90"
    },
    {
      "key": "cadastro.fornecedor.bloqueado",
      "label": "Fornecedor com pagamento bloqueado",
      "value": "não"
    },
    {
      "key": "recebimento[RC-9350].item[F06-001].quantidade",
      "label": "Quantidade contada de Pão de queijo congelado 1 kg",
      "value": "1524 UN"
    },
    {
      "key": "recebimento[RC-9350].item[F06-002].quantidade",
      "label": "Quantidade contada de Pizza congelada 460 g",
      "value": "1492 UN"
    },
    {
      "key": "recebimento[RC-9350].item[F06-003].quantidade",
      "label": "Quantidade contada de Sorvete 1,5 L",
      "value": "1788 UN"
    },
    {
      "key": "historico.notas_lancadas.quantidade",
      "label": "Notas do fornecedor já lançadas",
      "value": "3"
    },
    {
      "key": "historico.notas_lancadas.valor",
      "label": "Valor das notas do fornecedor já lançadas",
      "value": "R$ 5.294,00"
    },
    {
      "key": "historico.pagamentos.quantidade",
      "label": "Pagamentos ao fornecedor",
      "value": "1"
    },
    {
      "key": "historico.pagamentos.valor",
      "label": "Valor pago ao fornecedor",
      "value": "R$ 1.836,00"
    },
    {
      "key": "historico.notas_capturadas.quantidade",
      "label": "Outras notas do fornecedor capturadas",
      "value": "7"
    }
  ],
  "identifiers": [
    "35261147573594000106550010000131371591560338",
    "F06",
    "CD-02",
    "2026-11-05",
    "OC-2026-42950",
    "F06-001",
    "SKU-1019",
    "F06-002",
    "SKU-1020",
    "F06-003",
    "SKU-1021",
    "E6",
    "2026-10-30",
    "47.573.594/0001-06",
    "RC-9350",
    "2026-11-06"
  ],
  "classifications": [
    "E6"
  ],
  "output": {
    "summary": "Proposta da nota {{nota.numero}} (série {{nota.serie}}), fornecedor CNPJ 47.573.594/0001-06, chave 35261147573594000106550010000131371591560338, valor total {{nota.total}}, vinculada à ordem OC-2026-42950 ({{ordem[OC-2026-42950].total}}, situação atendida). Os três itens da nota batem com a ordem em quantidade e preço unitário, e a contagem do recebimento RC-9350 confere com o faturado. A divergência registrada é de classificação E6: a mesma chave de acesso já tem título lançado no contas a pagar e a SEFAZ registra nova cobrança da mesma chave por reenvio pelo canal e-mail. A proposta não confirma valor em aberto para os itens: o saldo da ordem está zerado para os três SKUs.",
    "divergences": [
      {
        "evidence": [
          "nota.numero",
          "nota.total",
          "ordem[OC-2026-42950].total",
          "ordem[OC-2026-42950].status",
          "historico.notas_lancadas.quantidade",
          "historico.notas_lancadas.valor"
        ],
        "what_diverges": "A nota 13137 (chave de acesso 35261147573594000106550010000131371591560338) está sendo cobrada de novo, por reenvio pelo canal e-mail, enquanto já existe título lançado para a mesma chave, vinculado à ordem OC-2026-42950 no valor de {{ordem[OC-2026-42950].total}}, com situação lançada.",
        "classification": "E6"
      }
    ],
    "supplier_history": "Fornecedor CNPJ 47.573.594/0001-06, código F06, sem bloqueio de pagamento (cadastro.fornecedor.bloqueado: não). Já há {{historico.notas_lancadas.quantidade}} notas lançadas, somando {{historico.notas_lancadas.valor}}, e {{historico.pagamentos.quantidade}} pagamento no valor de {{historico.pagamentos.valor}}. Há ainda {{historico.notas_capturadas.quantidade}} outras notas capturadas do fornecedor."
  }
};
