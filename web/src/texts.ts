/**
 * #126 AC-1: todo texto visível das rotas e das gavetas, num arquivo só, para revisão fácil.
 * O que depende de dado (contagem, nome, valor) é função; o resto é texto puro. Os rótulos de
 * nível, ação e exceção ficam em `approval/labels.ts` e `evidence/labels.ts`, que lêem daqui.
 */
import type { ApprovalLevel, DuplicateReason, EvidenceSource } from "./api/contract";

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

  /** #211 A faixa de automação no topo das telas, a gaveta das rodadas e os indicadores. */
  automation: {
    ok: (lastAt: string, ago: string, nextAt: string) => `Automático · última rodada às ${lastAt} (${ago}) · próxima às ${nextAt}`,
    figures: (f: { captured: number; checked: number; byRule: number; toPerson: number; published: number }) =>
      `${f.captured === 1 ? "1 nota capturada" : `${f.captured} notas capturadas`} · ${f.checked === 1 ? "1 conferida" : `${f.checked} conferidas`} · ${f.byRule === 1 ? "1 aprovada" : `${f.byRule} aprovadas`} pela regra · ${f.toPerson} para pessoa · ${f.published === 1 ? "1 ação publicada" : `${f.published} ações publicadas`} na doca`,
    failed: (lastAt: string, nextAt: string) => `A última rodada falhou às ${lastAt}. A próxima tenta de novo às ${nextAt}.`,
    stalled: (since: string) => `A automação está parada desde ${since}.`,
    neverRan: "A automação ainda não rodou.",
    seeRuns: "Ver rodadas",
    drawerTitle: "Últimas rodadas",
    ago: (minutes: number) => (minutes < 1 ? "agora" : minutes < 60 ? `há ${minutes} min` : `há ${Math.floor(minutes / 60)} h`),
    columns: { at: "Início", status: "Estado", captured: "Capturadas", checked: "Conferidas", byRule: "Pela regra", toPerson: "Para pessoa", published: "Publicadas" },
    statusOk: "Ok",
    statusFailed: "Falhou",
    noRuns: "Nenhuma rodada registrada ainda.",
    indicators: {
      withoutPerson: "Resolvidas sem pessoa",
      withoutPersonContext: (month: string) => `hoje · no mês: ${month}`,
      withoutPersonInfo: "Parte das notas decididas pela regra, sobre o total decidido.",
      captureToDecision: "Da captura à decisão",
      captureToDecisionContext: (withPerson: string) => `sem pessoa · com pessoa: ${withPerson}`,
      captureToDecisionInfo: "Tempo mediano entre a captura da nota e a decisão.",
      none: "—",
    },
  },

  /** #123 O estado vazio das telas: título, explicação e a ação para a fila. */
  emptyState: {
    action: "Ver a fila de aprovação",
    duplicadas: {
      title: "Nenhuma nota duplicada neste mês",
      description: "As notas cobradas em dobro aparecem aqui.",
    },
    valorBarrado: {
      title: "Nada evitado neste mês ainda",
      description: (baseline: string) => `Perda mensal hoje: ${baseline}.`,
    },
    queue: {
      title: "Nenhuma proposta espera a sua decisão",
      description: "As novas chegam depois da conferência.",
    },
    todayList: {
      title: "Nenhum título para pagar hoje",
      description: "Os títulos entram quando a proposta é aprovada.",
    },
    proposal: {
      title: "Esta nota ainda não tem proposta",
      description: "A proposta sai depois da conferência.",
    },
    returnNotes: {
      pendente: { // ADR-002
        title: "Nenhuma devolução pendente de emissão",
        description: "Recusas e recebimentos parciais geram devolução.",
      },
      emitida: { // ADR-002
        title: "Nenhuma devolução emitida",
        description: "As emitidas aparecem com o número da NF-e de devolução.",
      },
      cancelada: { // ADR-002
        title: "Nenhuma devolução cancelada",
        description: "As canceladas aparecem com a justificativa.",
      },
    },
    recebimento: {
      title: (noun: string) => `Nenhuma nota na ${noun} hoje`,
      description: (empty: string) => empty,
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

  /** O sistema de onde vem cada evidência. */
  source: {
    sefaz: "Nota da SEFAZ",
    erp_compras: "ERP · ordem de compra",
    erp_contas_a_pagar: "ERP · contas a pagar",
    erp_cadastro: "ERP · cadastro",
    banco: "Banco",
    wms: "WMS · recebimento",
  } satisfies Record<EvidenceSource, string>,

  decidedBy: {
    system: "Automático",
    rule: "Regra",
    claude: "Claude",
    engine: "Motor",
    person: "Pessoa",
    awaiting: "Aguardando pessoa",
    column: "Decidido por",
  },

  timeline: {
    title: "Como esta nota andou",
    empty: "Ainda não há passos registrados para esta nota.",
  },

  grid: {
    /** #209 O rótulo da linha da grid para leitor de tela. */
    openInvoice: (number: string) => `Abrir a nota ${number}`,
  },

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
      code: "Código",
      action: "Ação no recebimento",
      level: "Nível",
      risk: "Valor em risco",
      forwardedTo: "Encaminhada a",
    },
    filterLabel: "Filtrar a fila",
    filterAll: "Todas",
    filterMine: "Minhas",
    needsLevel: (level: string) => `Precisa de ${level}`,
    noPermission: "Sem permissão para decidir",
    drawerTitle: (number: string | null) => (number ? `Proposta da NF ${number}` : "Proposta"),
    drawerError: "Não consegui ler esta proposta agora.",
    drawerLoading: "Carregando a proposta…",
    noProposal: "Esta nota não tem proposta de aprovação.",
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
    columns: { invoice: "Nota fiscal", classification: "Exceção", code: "Código", action: "Ação no recebimento", approver: "Decidido por", amount: "A pagar" },
    rule: "Regra",
  },

  proposta: {
    title: (numberOrId: string) => `Proposta da nota ${numberOrId}`,
    subtitle: "Confira a proposta e decida.",
    loading: "Carregando a proposta…",
    error: "Não consegui ler esta proposta agora",
    empty: "Esta nota ainda não tem proposta.",
  },

  doca: {
    title: "Doca",
    subtitle: "Notas que chegam hoje e o que fazer com cada caminhão.",
    noun: "doca",
    emptyIn: (shown: string | null) =>
      `Nenhuma nota com entrega prevista hoje ${shown ? `na ${shown}` : "neste destino"}.`,
    warning: "Segure o caminhão até a decisão.",
    words: {
      receive: "Descarregue tudo",
      refuse: "Devolva o caminhão inteiro",
      awaiting: "Não descarregue ainda",
    },
  },

  recebimentoLoja: {
    title: "Recebimento na loja",
    subtitle: "Notas que chegam hoje e a ação para cada uma.",
    noun: "loja",
    emptyIn: (shown: string | null) =>
      `Nenhuma nota com entrega prevista hoje ${shown ? `na ${shown}` : "nesta loja"}.`,
    warning: "Segure o recebimento até a decisão.",
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
    subtitle: "O que deixou de ser pago errado neste mês.",
    loading: "Somando o pagamento errado evitado…",
    error: "Não consegui somar o pagamento errado evitado agora",
    empty: "Nada evitado neste mês ainda.",
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
      context: (share: string) => `${share} da perda mensal, aguardando aprovação`,
    },
    statDouble: {
      caption: "Pagamento em dobro evitado",
      context: "duplicidade e pago fora do fluxo, fora da perda mensal",
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
    seriesBaseline: (baseline: string) => `${baseline} por mês`,
    chartLabel: (baseline: string) => `Valor em risco acumulado por dia, sem duplicidade e pago fora do fluxo, contra ${baseline}`,
    rankingPanel: "Valor em risco por exceção",
  },

  duplicadas: {
    title: "Notas duplicadas",
    subtitle: "Notas cobradas em dobro. O título fica bloqueado até a coordenação decidir.",
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
      negative: "A coordenação decide. A nota é recusada e não vai a pagamento.",
      waiting: "O título ainda não foi bloqueado e a nota pode entrar na lista do dia.",
      info: "O título não está bloqueado. A coordenação precisa olhar.",
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
    subtitle: "Devoluções para o fiscal emitir e marcar como emitidas com o número da NF-e de devolução.",
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
    filterLabel: "Filtrar por situação",
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
      badRequest: "Confira os campos preenchidos.",
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
      description: "Escolha o que fazer com a carga. Trocar a proposta pede justificativa. A decisão vale uma vez.",
      note: "Justificativa",
      submit: "Registrar a decisão",
      proposed: "Proposta do sistema",
      options: {
        receber: "Receber",
        receber_parcial: "Receber parcial",
        recusar: "Recusar",
      },
      /** #134 Depois da contagem a mercadoria já chegou: o verbo passa a confirmar o que foi contado. */
      afterCountOptions: {
        receber: "Confirmar recebimento",
        receber_parcial: "Confirmar recebimento parcial",
        recusar: "Recusar",
      },
    },
    partial: {
      title: "Itens do recebimento parcial",
      item: "Item",
      /** #176 "Feijão (12 CX = 48 UN)": a quantidade da nota e, havendo fator de caixa, a de estoque. */
      itemQty: (item: string, qty: string, stock: string | null) => (stock ? `${item} (${qty} = ${stock})` : `${item} (${qty})`),
      enters: (qty: string) => `Entra ${qty}`,
      holds: (qty: string) => `Segura ${qty}`,
      returns: (qty: string) => `Devolve ${qty}`,
      enterAll: (qty: string) => `Entra ${qty}`,
      inputTitle: "Itens a segurar ou devolver",
      qtyLabel: (item: string) => `Quantidade a segurar ou devolver de ${item}`,
      dispositionLabel: (item: string) => `O que fazer com ${item}`,
      hold: "Segurar",
      giveBack: "Devolver",
      invalidQty: "Receber parcial: a quantidade precisa ser um número, por exemplo 4 ou 4,5.",
      missingLines: "Receber parcial: informe ao menos um item e a quantidade a segurar ou devolver.",
    },
    needsLevel: (level: string) => `Esta proposta pede o nível ${level} ou acima.`,
    needsLevelDescription: "Você só vê a proposta. Quem tem o nível decide na fila.",
  },

  /** #231 O bloco "Agente auditor" da gaveta, como no wireframe aprovado (docs/wireframes/auditor-gaveta.md). */
  auditor: {
    title: "Agente auditor",
    pending: "Auditoria pendente. Decida pelas evidências da conferência.",
    notAudited: "Não auditada",
    decideByEvidence: "Decida pelas evidências da conferência.",
    injectionNotice: "Aviso: um trecho da nota tentou dar ordem ao agente. Ele não obedeceu.",
    agrees: "Concorda com a regra",
    disagrees: (phrases: string) => `Discorda: ${phrases}`,
    differs: {
      classification: (auditor: string, proposed: string) => `classifica como ${auditor}, não ${proposed}`,
      dockAction: (auditor: string, proposed: string) => `ação na doca: ${auditor}, não ${proposed}`,
      routing: (level: string) => `encaminha para ${level}`,
    },
    raisedTo: (level: string) => `A proposta subiu para ${level}.`,
    auditedBy: (model: string, time: string) => `Auditado por ${model} às ${time}.`,
    notAuditedReason: {
      claude_falhou: "O Claude não conseguiu auditar esta nota.",
      erro_de_tool: "Uma ferramenta falhou durante a auditoria.",
      sem_auditoria: "Esta nota não teve auditoria.",
    },
  },

  dossier: {
    unavailableTitle: "Não há dossiê do Claude para esta proposta.",
    notGenerated: "Dossiê ainda não gerado. Decida pelas evidências da conferência.",
    ruleNote: "O Claude explica. Quem decide é a regra ou você. A ação, o nível e o valor vêm da regra.",
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
    // #130 Os estados da gaveta, como no wireframe da issue.
    generating: "O Claude está lendo a nota, a ordem e o cadastro…",
    requestedAt: (time: string) => `Pedido por você às ${time}`,
    // #38 O dossiê disparado pelo evento: ninguém pediu, começou quando a nota chegou.
    startedAt: (time: string) => `Começou quando a nota chegou, às ${time}`,
    // #130 AC-4 "Gerar de novo": o anterior fica na tela até o novo ficar pronto.
    renewing: "✦ O Claude está escrevendo uma versão nova. Esta continua valendo até lá.",
    renewFailed: "O Claude não conseguiu escrever a versão nova. Esta continua valendo.",
    // #130 O teto da espera chegou com o Claude ainda em generating.
    renewTimedOut: "O Claude ainda está escrevendo; tente de novo em alguns minutos.",
    writtenAt: (time: string) => `Escrito pelo Claude às ${time}. Os números vêm do banco.`,
    notYet: "Esta proposta ainda não tem dossiê. O Claude lê a nota, a ordem e o cadastro e explica o que diverge. Quem decide é você.",
    ask: "✦ Pedir ao Claude",
    again: "↻ Gerar de novo",
    retry: "↻ Tentar de novo",
    stillValid: "A proposta continua valendo e você pode decidir sem ele.",
    failed: {
      claude_failed: "O Claude não conseguiu escrever o dossiê agora.",
      timeout: "O Claude demorou demais para responder.",
      number_mismatch: "O dossiê citava um número que não bate com o banco, por isso não foi mostrado.",
      invalid_shape: "A resposta do Claude veio fora do formato, por isso não foi mostrada.",
    },
    request: {
      inFlight: "O Claude já está escrevendo este dossiê.",
      limit: "Muitos pedidos para esta proposta. Tente de novo em alguns minutos.",
      other: "Não consegui pedir o dossiê agora. Tente de novo.",
    },
  },
};
