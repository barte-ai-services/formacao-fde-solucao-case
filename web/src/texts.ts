/**
 * #126 AC-1: todo texto visível das rotas e das gavetas, num arquivo só, para revisão fácil.
 * O que depende de dado (contagem, nome, valor) é função; o resto é texto puro. Os rótulos de
 * nível, ação e exceção ficam em `approval/labels.ts` e `evidence/labels.ts`, que lêem daqui.
 */
import type { ApprovalLevel, DivergenceCode, DuplicateReason, EvidenceSource } from "./api/contract";

type ActionKind = "receber" | "receber_parcial" | "recusar";
type ReturnStatus = "pendente" | "emitida" | "cancelada";
type DuplicateTone = "negative" | "waiting" | "info";

export const texts = {
  /** Texto de toda tela: o "tentar de novo" do erro. */
  common: {
    retry: "Tentar de novo",
    errorDescription: "Tente de novo em um minuto. Se continuar, avise o suporte da Barte.",
    noteWord: (n: number) => (n === 1 ? "1 nota" : `${n} notas`),
  },

  /** #123 O estado vazio das telas: título, explicação e a ação para a fila. */
  emptyState: {
    action: "Ver a fila de aprovação",
    duplicadas: {
      title: "Nenhuma nota duplicada neste mês",
      description:
        "Quando uma nota cobrar uma compra já cobrada, ela aparece aqui ao lado da original, com o título bloqueado.",
    },
    valorBarrado: {
      title: "Nada evitado neste mês ainda",
      description: (baseline: string) =>
        `A perda mensal hoje é ${baseline}. O valor evitado aparece aqui assim que a primeira proposta for aprovada.`,
    },
    recebimento: {
      title: (noun: string) => `Nenhuma nota na ${noun} hoje`,
      description: (empty: string) => `${empty} Quando houver, cada caminhão aparece aqui com a ação a tomar.`,
    },
  },

  app: {
    loading: "Abrindo o contas a pagar…",
    error: "Não consegui abrir o contas a pagar agora",
  },

  notFound: {
    title: "Página não encontrada",
    body: "Este endereço não existe no contas a pagar.",
  },

  level: {
    regra: "Regra",
    analista: "Analista",
    coordenacao: "Coordenação",
    diretoria: "Diretoria",
    bloqueio: "Bloqueio",
  } satisfies Record<ApprovalLevel, string>,

  action: {
    receber: "Receber",
    receber_parcial: "Receber parcial",
    recusar: "Recusar",
  } satisfies Record<ActionKind, string>,

  /** O nome de cada exceção, como no wireframe aprovado (F3). */
  exception: {
    E1: "E1 · Falta física",
    E2: "E2 · Item trocado",
    E3: "E3 · Quantidade menor",
    E4: "E4 · Unidade de medida",
    E5: "E5 · Nota sem ordem",
    E6: "E6 · Duplicidade",
    E7: "E7 · Pago fora do fluxo",
    E8: "E8 · Item sem cadastro",
    NAO_CATALOGADA: "Não catalogada",
  } satisfies Record<DivergenceCode, string>,

  /** O sistema de onde vem cada evidência. */
  source: {
    sefaz: "Nota da SEFAZ",
    erp_compras: "ERP · ordem de compra",
    erp_contas_a_pagar: "ERP · contas a pagar",
    erp_cadastro: "ERP · cadastro",
    banco: "Banco",
    wms: "WMS · recebimento",
  } satisfies Record<EvidenceSource, string>,

  fila: {
    title: "Fila de aprovação",
    subtitle:
      "Notas que esperam a sua decisão, da mais urgente para a menos.",
    loading: "Carregando a fila…",
    error: "Não consegui ler a fila de aprovação agora",
    empty: "Nenhuma proposta espera a sua decisão.",
    statWaiting: { caption: "Aguardando aprovação", context: "propostas na fila" },
    statRisk: { caption: "Valor em risco na fila", context: "se pagas como vieram" },
    statBlocked: { caption: "Bloqueadas por duplicidade", context: "ninguém paga até resolver" },
    tableEmpty: "Nenhuma proposta na fila.",
    columns: {
      invoice: "Nota fiscal",
      classification: "Exceção",
      action: "Ação no recebimento",
      level: "Nível",
      risk: "Valor em risco",
      forwardedTo: "Encaminhada a",
    },
    match: "Confere",
    filterLabel: "Filtrar a fila",
    filterAll: "Todas",
    filterMine: "Minhas",
    needsLevel: (level: string) => `Precisa de ${level}`,
    noPermission: "Sem permissão para decidir",
    drawerTitle: (number: string | null) => (number ? `Proposta da NF ${number}` : "Proposta"),
    drawerError: "Não consegui ler esta proposta agora.",
    drawerLoading: "Carregando a proposta…",
  },

  listaDoDia: {
    title: "Lista do dia",
    subtitle: "Títulos conferidos que podem ser pagos hoje.",
    loading: "Carregando a lista do dia…",
    error: "Não consegui ler a lista do dia agora",
    empty: "Nenhum título para pagar hoje.",
    statTitles: { caption: "Títulos na lista", context: "liberados hoje" },
    statToPay: { caption: "A pagar", context: "soma dos títulos" },
    statByRule: { caption: "Liberados pela regra", context: "sem pessoa" },
    tableEmpty: "Nenhum título.",
    columns: { invoice: "Nota fiscal", action: "Ação no recebimento", approver: "Aprovado por", amount: "A pagar" },
    rule: "Regra",
  },

  proposta: {
    title: (numberOrId: string) => `Proposta da nota ${numberOrId}`,
    subtitle: "A ação no recebimento proposta, a evidência de cada divergência e a sua decisão.",
    loading: "Carregando a proposta…",
    error: "Não consegui ler esta proposta agora",
    empty: "Esta nota ainda não tem proposta.",
  },

  doca: {
    title: "Doca",
    subtitle:
      "Notas que chegam hoje neste destino e o que fazer com cada caminhão. Nada é descarregado antes da decisão.",
    noun: "doca",
    emptyIn: (shown: string | null) =>
      `Nenhuma nota com entrega prevista hoje ${shown ? `na ${shown}` : "neste destino"}.`,
    warning: "Segure o caminhão: a ação aparece aqui assim que a pessoa decidir.",
    words: {
      receive: "Descarregue tudo",
      refuse: "Devolva o caminhão inteiro",
      awaiting: "Não descarregue ainda",
    },
  },

  recebimentoLoja: {
    title: "Recebimento na loja",
    subtitle:
      "Notas que chegam hoje nesta loja e a ação que o app da loja recebeu para cada uma. Nada é recebido antes da decisão.",
    noun: "loja",
    emptyIn: (shown: string | null) =>
      `Nenhuma nota com entrega prevista hoje ${shown ? `na ${shown}` : "nesta loja"}.`,
    warning: "Segure o recebimento: a ação aparece aqui assim que a pessoa decidir.",
    words: {
      receive: "Receba tudo no app",
      refuse: "Recuse a nota inteira no app",
      awaiting: "Não receba ainda",
    },
  },

  /** O quadro de recebimento, o mesmo para a doca e para a loja. */
  recebimento: {
    loading: (noun: string) => `Carregando as notas da ${noun}…`,
    error: (noun: string) => `Não consegui ler as notas desta ${noun} agora`,
    awaitingTitle: (n: number) => `${n} ${n === 1 ? "nota aguarda" : "notas aguardam"} aprovação.`,
    tableEmpty: "Nenhuma nota.",
    columns: { invoice: "Nota fiscal", items: "Itens", whatToDo: "O que fazer" },
    itemCount: (n: number) => `${n} ${n === 1 ? "item" : "itens"}`,
    awaitingBadge: "Aguardando aprovação",
    hold: (list: string) => `Segure ${list}`,
    giveBack: (list: string) => `Devolva ${list}`,
    quantityOf: (quantity: string, sku: string) => `${quantity} de ${sku}`,
  },

  /** #125: o painel do pagamento errado evitado, na linguagem do glossário e do CFO. */
  valorBarrado: {
    title: "Pagamento errado evitado",
    subtitle: "O que foi evitado no mês, contra a perda de R$ 543 mil por mês.",
    loading: "Somando o pagamento errado evitado…",
    error: "Não consegui somar o pagamento errado evitado agora",
    empty: "Nada evitado neste mês ainda. O valor aparece aqui assim que a primeira proposta for aprovada.",
    statAvoided: {
      caption: (month: string) => `Evitado em ${month}`,
      context: (share: string) => `${share} da perda mensal, em propostas aprovadas que recusam ou recebem parcial`,
    },
    statLoss: {
      caption: "Perda mensal hoje",
      context: "pago sem mercadoria correspondente, menos o recuperado (P1)",
    },
    statDeciding: {
      caption: "Em decisão",
      context: (share: string) => `${share} da perda mensal, em propostas aguardando aprovação`,
    },
    statDouble: {
      caption: "Pagamento em dobro evitado",
      context: "duplicidade e pago fora do fluxo, fora da comparação com a perda mensal",
      decidingExtra: (amount: string) => `; mais ${amount} em decisão`,
    },
    monthPanel: (baseline: string) => `O mês contra a perda de ${baseline}`,
    progressValue: (sum: string, baseline: string) => `${sum} de ${baseline}`,
    segmentAvoided: "Evitado",
    segmentDeciding: "Em decisão",
    cumulativePanel: "Acumulado no mês",
    seriesAvoided: "Valor em risco, aprovado",
    seriesDeciding: "Valor em risco, em decisão",
    axisThousands: (n: number) => `${n} mil`,
    chartLabel: "Valor em risco acumulado por dia, com duplicidade e pago fora do fluxo",
    rankingPanel: "Valor em risco por exceção",
  },

  duplicadas: {
    title: "Notas duplicadas",
    subtitle:
      "Notas que cobram uma compra já cobrada, ao lado da original. O título fica bloqueado até a coordenação resolver.",
    loading: "Procurando duplicidades…",
    error: "Não consegui ler as duplicidades agora",
    empty: "Nenhuma nota duplicada neste mês.",
    statDuplicates: { caption: "Duplicadas", context: "notas bloqueadas" },
    statBlocked: { caption: "Pagamento em dobro evitado", context: "não pago duas vezes" },
    statWhy: { caption: "Por quê", context: "título já lançado · ordem sem saldo" },
    columns: {
      duplicate: "Nota duplicada",
      original: "Nota original",
      reason: "Por quê",
      blocked: "Valor evitado",
      title: "Título",
    },
    openInvoice: (number: string) => `Abrir a nota ${number}`,
    noOriginal: "sem título original: a ordem não tem saldo",
    reason: {
      titulo_lancado: "mesma ordem e mesmo valor de um título já lançado",
      ordem_sem_saldo: "duplicidade suspeita: a ordem não tem saldo",
    } satisfies Record<DuplicateReason, string>,
    badge: {
      bloqueado: "Título bloqueado",
      pendente: "Bloqueio pendente",
      liberado: "Título liberado",
      reduzido: "Título reduzido",
      naLista: "Título na lista do dia",
      other: (state: string) => `Título ${state}`,
    },
    alertDescription: {
      negative: "A coordenação resolve. A nota duplicada é recusada e não vai a pagamento.",
      waiting:
        "O contas a pagar ainda não bloqueou o título desta nota. Até bloquear, ela pode entrar na lista do dia.",
      info: "A nota é duplicada, mas o título dela não está bloqueado. A coordenação precisa olhar.",
    } satisfies Record<DuplicateTone, string>,
    drawerTitle: (number: string) => `NF ${number}, duplicada`,
    diffColumns: (original: string, duplicate: string): [string, string] => [`Original · NF ${original}`, `Duplicada · NF ${duplicate}`],
    fields: {
      number: "Número",
      accessKey: "Chave de acesso",
      sameInvoice: "a mesma nota (reenvio)",
      newInvoice: "nota nova",
      title: "Título",
    },
    detail: { why: "Por quê", supplier: "Fornecedor", issued: "Emissão", blocked: "Valor evitado" },
  },

  devolucoes: {
    title: "Notas de devolução",
    subtitle:
      "Devoluções que o fiscal emite no ERP. Marque como emitida com o número da NF-e de devolução.",
    loading: "Carregando as notas de devolução…",
    error: "Não consegui ler as notas de devolução agora",
    emptyPending:
      "Nenhuma devolução pendente de emissão.",
    emptyOther: "Nenhuma nota neste estado.",
    status: {
      pendente: "Pendentes de emissão",
      emitida: "Emitidas",
      cancelada: "Canceladas",
    } satisfies Record<ReturnStatus, string>,
    tableEmpty: "Nenhuma nota.",
    columns: {
      origin: "Nota de origem",
      items: "Itens a devolver",
      value: "Valor",
      reason: "Motivo",
      timePending: "Pendente",
      timeWasPending: "Esteve pendente",
    },
    moreItems: (n: number) => `e mais ${n}`,
    badgeEmitted: (number: string) => `NF-e ${number}`,
    badgeCancelled: "Cancelada",
    badgeAwaiting: "Aguardando emissão",
    lessThanMinute: "há menos de 1 min",
    minutesAgo: (m: number) => `há ${m} min`,
    hoursAgo: (h: number) => `há ${h} h`,
    hoursMinutesAgo: (h: number, m: number) => `há ${h} h ${m} min`,
    daysAgo: (d: number) => `há ${d} ${d === 1 ? "dia" : "dias"}`,
    quantityOf: (quantity: string, unit: string, description: string) => `${quantity} ${unit} de ${description}`,
    errors: {
      conflict: "Esta nota já foi decidida por outra pessoa.",
      notFound: "Esta nota não existe mais na fila.",
      badRequest: "A API não aceitou o que foi preenchido. Confira os campos.",
      other: "Não consegui registrar agora. Tente de novo em um minuto.",
    },
    drawerTitle: (number: string) => `Devolução da NF ${number}`,
    detail: {
      supplier: "Fornecedor",
      reason: "Motivo",
      value: "Valor",
      pending: "Pendente",
      emitted: "NF-e de devolução",
      emittedValue: (number: string, by: string) => `${number}, por ${by}`,
      cancelled: "Cancelada",
      cancelledValue: (justification: string, by: string) => `${justification}, por ${by}`,
    },
    nfeLabel: "Número da NF-e de devolução",
    nfeMissing: "Informe o número da NF-e de devolução.",
    emit: "Marcar como emitida",
    whyLabel: "Justificativa do cancelamento",
    whyMissing: "Explique por que a devolução foi cancelada.",
    cancel: "Cancelar nota",
  },

  proposalPanel: {
    state: {
      registrada: "Registrada",
      aguardando_aprovacao: "Aguardando aprovação",
      aprovada: "Aprovada",
      alterada: "Alterada",
    },
    errors: {
      forbidden: "Seu nível não aprova esta proposta.",
      conflict: "Esta proposta já foi decidida por outra pessoa.",
      unprocessable: "A decisão não foi aceita: confira a justificativa.",
      other: "Não consegui registrar a decisão agora. Tente de novo em um minuto.",
    },
    level: (label: string) => `Nível ${label}`,
    rows: {
      action: "Ação no recebimento proposta",
      risk: "Valor em risco",
      total: "Valor da nota",
      why: "Por que este nível",
      whyValue: (line: number, reason: string) => `Linha ${line} da régua: ${reason}`,
      supplier: "Fornecedor",
      destination: "Destino",
      justification: "Justificativa",
      accessKey: "Chave de acesso",
    },
    evidenceTitle: "Evidência por divergência",
    noDivergence: "Nenhuma divergência: a nota confere com a ordem.",
    decidedTitle: "Decisão registrada",
    decidedDescription: (action: string, title: string) => `Ação final: ${action}. O título está ${title}.`,
    form: {
      title: "Sua decisão",
      description:
        "Escolha o que a doca faz com a carga. A proposta do sistema vem marcada; escolher outra pede justificativa. A decisão é registrada uma vez.",
      note: "Justificativa",
      submit: "Registrar a decisão",
      proposed: "Proposta do sistema",
      options: {
        receber: "Receber",
        receber_parcial: "Receber parcial",
        recusar: "Recusar",
      },
      /** Depois da contagem a mercadoria já chegou: o verbo passa a confirmar o que foi contado. */
      afterCountOptions: {
        receber: "Confirmar recebimento",
        receber_parcial: "Confirmar recebimento parcial",
        recusar: "Recusar",
      },
    },
    partial: {
      title: "Itens do recebimento parcial",
      item: "Item",
      enters: (qty: string) => `Entra ${qty}`,
      holds: (qty: string) => `Segura ${qty}`,
      returns: (qty: string) => `Devolve ${qty}`,
      enterAll: (qty: string) => `Entra ${qty}`,
      inputTitle: "Receber parcial: itens a segurar ou devolver",
      inputHelp: "Vale só se você escolher Receber parcial. Informe a quantidade de cada item que não entra.",
      qtyLabel: (item: string) => `Quantidade a segurar ou devolver de ${item}`,
      dispositionLabel: (item: string) => `O que fazer com ${item}`,
      hold: "Segurar",
      giveBack: "Devolver",
      missingLines: "Receber parcial: informe ao menos um item e a quantidade a segurar ou devolver.",
    },
    needsLevel: (level: string) => `Esta proposta pede o nível ${level} ou acima.`,
    needsLevelDescription: "Você vê a proposta, sem aprovar. Quem tem o nível encontra a proposta na fila.",
  },

  dossier: {
    unavailableTitle: "Não há dossiê do Claude para esta proposta.",
    notGenerated: "O dossiê ainda não foi gerado. Decida pelas divergências e evidências da conferência.",
    ruleNote: "O Claude explica; quem decide é a regra ou você. A ação, o nível e o valor vêm da regra.",
    panelTitle: "Dossiê do Claude",
    badge: "Claude",
    evidenceLabel: "Evidências do dossiê",
    supplierHistory: "Histórico do fornecedor",
    source: {
      invoice: "Nota fiscal",
      purchase_order: "Ordem de compra",
      registry: "Cadastro",
      receipt: "Recebimento",
      history: "Histórico",
    },
  },
};
