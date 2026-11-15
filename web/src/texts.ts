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
      "As propostas do agente que esperam uma pessoa decidir. O nível mais alto e o maior valor em risco vêm primeiro.",
    loading: "Carregando a fila…",
    error: "Não consegui ler a fila de aprovação agora",
    empty: "Nenhuma proposta esperando você. As novas aparecem aqui assim que o agente conferir a nota.",
    statWaiting: { caption: "Aguardando aprovação", context: "propostas na fila" },
    statRisk: { caption: "Valor em risco na fila", context: "se pagas como vieram" },
    statBlocked: { caption: "Bloqueadas por duplicidade", context: "ninguém paga até resolver" },
    tableEmpty: "Nenhuma proposta na fila.",
    columns: {
      invoice: "Nota fiscal",
      classification: "Divergência",
      action: "Ação na doca",
      level: "Nível",
      risk: "Valor em risco",
      canApprove: "Você aprova?",
    },
    match: "Confere",
    yes: "Sim",
    noOtherLevel: "Não, outro nível",
    drawerTitle: (number: string | null) => (number ? `Proposta da NF ${number}` : "Proposta"),
    drawerError: "Não consegui ler esta proposta agora.",
    drawerLoading: "Carregando a proposta…",
  },

  listaDoDia: {
    title: "Lista do dia",
    subtitle: (day: string) =>
      `Os títulos liberados para pagar em ${day}: pela regra, sem pessoa, ou por quem aprovou a proposta.`,
    today: "hoje",
    loading: "Carregando a lista do dia…",
    error: "Não consegui ler a lista do dia agora",
    empty: "Nenhum título liberado hoje. Eles aparecem aqui quando a regra ou uma pessoa aprova a proposta.",
    statTitles: { caption: "Títulos na lista", context: "liberados hoje" },
    statToPay: { caption: "A pagar", context: "soma dos títulos" },
    statByRule: { caption: "Liberados pela regra", context: "sem pessoa" },
    tableEmpty: "Nenhum título.",
    columns: { invoice: "Nota fiscal", action: "Ação na doca", approver: "Aprovado por", amount: "A pagar" },
    rule: "Regra",
  },

  proposta: {
    title: (numberOrId: string) => `Proposta da nota ${numberOrId}`,
    subtitle: "A ação na doca proposta pelo agente, a evidência por divergência e a sua decisão.",
    loading: "Carregando a proposta…",
    error: "Não consegui ler esta proposta agora",
    empty: "Esta proposta ainda não chegou. Ela aparece aqui assim que o agente conferir a nota.",
  },

  doca: {
    title: "Doca",
    subtitle:
      "As notas que chegam hoje neste destino e o que fazer com cada caminhão. Nada é descarregado antes da decisão.",
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
      "As notas que chegam hoje nesta loja e a ação que o app da loja recebeu para cada uma. Nada é recebido antes da decisão.",
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

  valorBarrado: {
    title: "Valor barrado",
    subtitle:
      "Quanto a conferência impediu de pagar errado neste mês, contra os R$ 543 mil por mês que a Já Chegou pagava sem a mercadoria.",
    loading: "Somando o valor barrado…",
    error: "Não consegui somar o valor barrado agora",
    empty: "Nada barrado neste mês ainda. O valor aparece aqui assim que a primeira proposta for aprovada.",
    statBarred: { caption: (month: string) => `Barrado em ${month}`, context: "propostas aprovadas" },
    statAgainst: {
      caption: "Contra o pagar errado",
      context: (baseline: string, withAll: string) => `de ${baseline} por mês; ${withAll} com tudo aprovado`,
    },
    statWaiting: { caption: "Ainda em risco", context: "aguardando aprovação" },
    monthPanel: (baseline: string) => `O mês contra os ${baseline}`,
    progressValue: (sum: string, baseline: string) => `${sum} de ${baseline}`,
    segmentBarred: "Barrado",
    segmentWaiting: "Aguardando aprovação",
    cumulativePanel: "Acumulado no mês",
    seriesBarred: "Barrado (aprovado)",
    seriesProposed: "Proposto, aguardando aprovação",
    seriesBaseline: (baseline: string) => `${baseline} por mês`,
    axisThousands: (n: number) => `${n} mil`,
    chartLabel: (baseline: string) => `Valor barrado acumulado por dia, contra ${baseline}`,
    rankingPanel: "Valor em risco por tipo de divergência",
  },

  duplicadas: {
    title: "Notas duplicadas",
    subtitle:
      "Cada nota que cobra uma compra já cobrada, ao lado da original. O título fica bloqueado: ninguém paga até a coordenação resolver.",
    loading: "Procurando duplicidades…",
    error: "Não consegui ler as duplicidades agora",
    empty: "Nenhuma nota duplicada neste mês. Quando uma nota cobrar uma compra já cobrada, ela aparece aqui, bloqueada.",
    statDuplicates: { caption: "Duplicadas", context: "notas barradas" },
    statBlocked: { caption: "Valor barrado", context: "não pago duas vezes" },
    statWhy: { caption: "Por quê", context: "título já lançado · ordem sem saldo" },
    columns: {
      duplicate: "Nota duplicada",
      original: "Nota original",
      reason: "Por quê",
      blocked: "Valor barrado",
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
    detail: { why: "Por quê", supplier: "Fornecedor", issued: "Emissão", blocked: "Valor barrado" },
  },

  devolucoes: {
    title: "Notas de devolução",
    subtitle:
      "As devoluções que o fiscal precisa emitir no ERP. Marque como emitida com o número da NF-e de devolução; o motivo mostra de qual exceção veio cada uma.",
    loading: "Carregando as notas de devolução…",
    error: "Não consegui ler as notas de devolução agora",
    emptyPending:
      "Nenhuma devolução pendente de emissão. As novas aparecem aqui quando uma proposta de receber parcial for aprovada.",
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
      action: "Ação na doca proposta",
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
        "Aprovar mantém a ação proposta. Alterar troca a ação e pede justificativa. A decisão é registrada uma vez.",
      note: "Justificativa",
      submit: "Registrar a decisão",
      approve: (action: string) => `Aprovar: ${action}`,
      change: (action: string) => `Alterar para ${action}`,
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
