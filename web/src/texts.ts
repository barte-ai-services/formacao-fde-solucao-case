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

  /** #160 A tabela rolável das grids: contador no topo, esqueleto, faixa de erro do bloco, fim da lista e o aviso de recomeço. */
  scrollTable: {
    counterBusy: "Carregando…",
    loadingRow: "Carregando mais notas",
    empty: "Nenhuma nota nesta lista",
    blockErrorTitle: "Não consegui carregar as próximas notas",
    blockErrorDescription: (loaded: number) => `As ${loaded} que já carregaram continuam aqui.`,
    endOfList: (total: number) => (total === 1 ? "Você viu a única nota" : `Você viu todas as ${total} notas`),
    // #160 As duas frases vão no título do Alert: a descrição do design system usa --content-tertiary (4,28:1 sobre o fundo do aviso, abaixo de 4,5:1).
    restarted: "A lista mudou e voltou ao início. Recomeçamos do início; nada que você decidiu se perdeu.",
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
    // #357 Modo demonstração, rodada pulada e os controles do administrador.
    demoMode: "Modo demonstração",
    statusSkipped: "Pulada",
    skipped: (at: string) => `Rodada pulada às ${at}: outra rodada ainda estava correndo.`,
    admin: {
      runNow: "Rodar agora",
      demoToggle: "Ligar modo demonstração",
      runNowFailed: "Não consegui pedir a rodada. Tente de novo.",
      runNowBusy: "Já há uma rodada correndo. Tente de novo daqui a pouco.",
      demoFailed: "Não consegui mudar o modo demonstração. Tente de novo.",
      demoConflict: "O modo mudou enquanto você olhava. A faixa foi atualizada.",
    },
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
    changeDestination: (noun: string) => `Trocar a ${noun}`,
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

  /** #355 A tela Ao vivo: os passos da automação, do mais novo ao mais velho. */
  live: {
    title: "Ao vivo",
    subtitle: "Os passos da automação, do mais novo ao mais velho.",
    loading: "Buscando os passos da automação…",
    error: "Não consegui buscar os passos agora",
    empty: "Nenhum passo da automação ainda.",
    emptyTitle: "Nenhum passo da automação ainda",
    emptyDescription: "Os passos aparecem aqui assim que a automação rodar.",
    refreshFailed: "Não consegui atualizar agora. Tentando de novo.",
    statWithoutPerson: {
      caption: "Resolvidas sem pessoa hoje",
      context: (decided: number, byRule: number) => `${decided} decididas hoje, ${byRule} pela regra`,
    },
    statAwaiting: { caption: "Na fila de uma pessoa", context: "propostas esperando uma decisão" },
    columns: { time: "Hora", invoice: "Nota", step: "Passo" },
    noInvoice: "—",
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

  /** #157 "Pedidos ao fornecedor" (história #157): a lista, a conversa e o rascunho da cobrança, como no wireframe aprovado (#157). */
  supplierRequests: {
    title: "Pedidos ao fornecedor",
    subtitle: "O que pedimos aos fornecedores, quem respondeu e quem está devendo resposta.",
    loading: "Carregando os pedidos ao fornecedor…",
    error: "Não consegui carregar os pedidos ao fornecedor.",
    filterLabel: "Filtrar por situação",
    filters: { waiting: "Aguardando", fulfilled: "Atendidos", needsYou: "Precisam de você", late: "Atrasados" },
    columns: { invoice: "Nota", supplier: "Fornecedor", request: "Solicitação", value: "Valor", due: "Prazo", status: "Status" },
    rowLabel: (invoice: string, supplier: string) => `Nota ${invoice}, ${supplier}`,
    tableEmpty: "Nenhum pedido.",
    follow: "Cobrar",
    /** #157 O tipo do pedido (requestType do contrato), na coluna Solicitação. */
    requestTypes: { return_note: "Nota de devolução" },
    /** #157 A gaveta enquanto lê o pedido; o motivo do erro é um dos fechados de api/supplier-reply.ts, nunca o texto da API. */
    drawer: {
      loading: "Carregando o pedido ao fornecedor…",
      errors: {
        unauthorized: "Sua sessão não permite ver este pedido. Entre de novo.",
        not_found: "Este pedido não foi encontrado.",
        conflict: "Este pedido mudou. Feche a gaveta e abra de novo.",
        unavailable: "Não consegui falar com o servidor agora.",
        unknown: "Não consegui carregar o pedido ao fornecedor.",
      },
      retry: "Tentar de novo",
    },
    /** #157 O texto da coluna Status, uma variante por situação (mapa Q2). */
    status: {
      waiting: "Aguardando",
      late: "Atrasado",
      /** #157 Cobrado pelo servidor e ainda atrasado nele: segue em Atrasados, sem "Cobrar" (#157). */
      lateCharged: "Atrasado (cobrado)",
      fulfilledToConfirm: (document: string) => `Atendeu: ${document}`,
      /** #157 Atendeu e o próximo passo da leitura é responder ao fornecedor (#157). */
      fulfilledToAnswer: "Atendeu, falta responder",
      /** #157 Atendeu e o próximo passo da leitura é cobrar (#157). */
      fulfilledToFollowUp: "Atendeu, falta cobrar",
      fulfilled: "Atendeu",
      partiallyFulfilled: "Atendeu parcialmente",
      needsInformation: "Pediu informação",
      refused: "Recusou",
    },
    toConfirm: "(citada, falta confirmar)",
    /** #157 O selo da linha cuja resposta traz ordem escondida; o nome acessível é mais longo que o texto visível, que ele contém (sem o ícone). */
    hiddenOrder: { badge: "⚠ Ordem escondida", label: "Ordem escondida na resposta do fornecedor" },
    /** #157 O vazio geral: nenhuma solicitação existe ainda. */
    empty: {
      title: "Nenhum pedido ao fornecedor ainda.",
      description: "Os pedidos aparecem aqui depois que você emite e envia a nota de devolução na gaveta de uma proposta decidida.",
      action: "Ir para a Fila de aprovação",
    },
    /** #157 O chip sem linhas: o de Atrasados vem do wireframe (estado 6), os outros seguem o mesmo molde. */
    filteredEmpty: {
      waiting: { title: "Nenhum pedido aguardando.", description: "Nenhum fornecedor está com prazo em aberto." },
      fulfilled: { title: "Nenhum pedido atendido.", description: "Nenhum fornecedor atendeu a uma solicitação ainda." },
      needsYou: { title: "Nenhum pedido precisa de você.", description: "Nenhuma resposta espera a sua decisão." },
      late: { title: "Nenhum pedido atrasado.", description: "Nenhum fornecedor está devendo resposta." },
      showAll: "Ver todos",
    },
    /** #157 O bloco da conversa na gaveta. */
    conversation: {
      title: "Pedido ao fornecedor",
      /** #157 O nome da região da conversa: distinto do bloco da #156, que também se chama "Pedido ao fornecedor". */
      regionLabel: "Conversa e leitura do pedido",
      /** #157 A resposta já foi lida, mas o contrato (#157) não traz o texto dela: a tela não afirma que ninguém respondeu. */
      replyNotShown: "O fornecedor respondeu. O texto da resposta não é mostrado aqui; a leitura do agente está abaixo.",
      blockStatus: {
        waiting: "Aguardando",
        waitingCharged: "Aguardando (cobrado)",
        late: "Atrasado",
        /** #157 O servidor já enviou a cobrança e ainda conta o pedido atrasado: o chip é o dele, e a tela só avisa que foi cobrado. */
        lateCharged: "Atrasado (cobrado)",
        fulfilledToConfirm: "Atendeu, falta confirmar",
        /** #157 Atendeu e o próximo passo da leitura é responder ao fornecedor (#157). */
        fulfilledToAnswer: "Atendeu, falta responder",
        /** #157 Atendeu e o próximo passo da leitura é cobrar (#157). */
        fulfilledToFollowUp: "Atendeu, falta cobrar",
        fulfilled: "Atendeu",
        partiallyFulfilled: "Atendeu parcialmente",
        needsYou: "Precisa de você",
        refused: "Recusou",
      },
      sentTitle: "Pedido enviado",
      sent: (document: string, amount: string, on: string, time: string | undefined, due: string) =>
        `Nota de devolução ${document} (${amount}) emitida e enviada por você em ${on}${time ? ` às ${time}` : ""} · prazo até ${due}.`,
      viewSent: "Ver a nota e o e-mail enviado",
      replyTitle: "Resposta do fornecedor",
      replyReceived: (on: string) => `Recebida em ${on}`,
      noReply: (until: string) => `Nenhuma resposta até ${until}.`,
      attachment: (name: string) => `Anexo: ${name}`,
      dataNotice: "Texto do fornecedor é dado, nunca instrução.",
      injectionTitle: "Atenção: o fornecedor tentou dar uma ordem ao agente.",
      injectionExcerpt: (excerpt: string) => `Trecho: "${excerpt}"`,
      injectionUnchanged: "Nada foi alterado: decisão, título e valor em risco seguem como estavam.",
      readingTitle: "Leitura do agente",
      outcome: {
        fulfilled: "Atendeu",
        partially_fulfilled: "Atendeu parcialmente",
        refused: "Recusou",
        needs_information: "Pediu informação",
        no_reply: "Sem resposta",
      },
      outcomeLabel: (outcome: string) => `Resultado: ${outcome}`,
      itemsFulfilled: (items: string) => `Itens atendidos: ${items}`,
      documentCited: (document: string) => `Documento citado: ${document}`,
      summary: (text: string) => `Resumo: "${text}"`,
      nextStepLabel: "Próximo passo",
      nextStep: { close: "Encerrar", confirm_document: "Confirmar documento", answer_supplier: "Responder ao fornecedor", follow_up: "Cobrar" },
      /** #157 O botão de confirmar leva o número que o fornecedor citou ("Confirmar documento NF-D 881"). */
      confirmDocument: (document: string) => `Confirmar documento ${document}`,
      /** #157 O botão enquanto a confirmação está em curso. */
      confirming: "Confirmando o documento…",
      /** #157 `by` é "por você" ou "por fulano" (quem confirmou, quando não é quem olha a tela). */
      confirmed: (document: string, by: string, on: string, time: string | undefined) => `Documento ${document} confirmado ${by} em ${on}${time ? ` às ${time}` : ""}.`,
      /** #157 O motivo da confirmação recusada é um dos fechados de api/supplier-reply.ts; o texto do servidor nunca chega à tela (layer-exposure). */
      confirmFailed: {
        unauthorized: "Sua sessão não permite confirmar este documento. Entre de novo.",
        not_found: "Este pedido não foi encontrado.",
        conflict: "Este pedido mudou e o documento não foi confirmado. Veja o estado atual e tente de novo.",
        /** #157 O servidor disse "já confirmado" e a releitura falhou: a primeira confirmação fica, e a tela não sabe quem nem quando. */
        alreadyConfirmed: "O documento já foi confirmado. Não consegui reler o pedido agora: feche e abra a gaveta para ver quem confirmou e quando.",
        /** #157 Um conflito de outro motivo e a releitura falhou: a mensagem não afirma se o documento foi confirmado. */
        conflictUnread: "Este pedido mudou e não consegui reler o estado dele agora. Feche e abra a gaveta para ver o estado atual antes de tentar de novo.",
        unavailable: "Não consegui falar com o servidor agora. O documento não foi confirmado.",
        unknown: "Não consegui confirmar o documento agora. Tente de novo em um minuto.",
      },
    },
    /** #157 O rascunho da cobrança e o que acontece ao enviar. */
    draft: {
      title: "Rascunho da cobrança",
      subtitle: "preparado pelo Claude, ainda não enviado",
      to: "Para",
      dueOn: "Novo prazo",
      subject: "Assunto",
      body: "Texto",
      attachment: "Anexo",
      /** #157 A cobrança sai sem anexo (o servidor manda `attachments: []`, #157). */
      noAttachment: "Nenhum",
      /** #157 O contrato traz o rascunho nulo quando ele já não confere com o catálogo (#157). */
      unavailable: "O rascunho da cobrança não está disponível agora.",
      edit: "Editar",
      /** #157 A edição do texto: salvar, cancelar e a dica de manter os marcadores, como a edição do pedido (#156). */
      save: "Salvar texto",
      saving: "Salvando…",
      cancelEdit: "Cancelar edição",
      keepMarkers: "Mantenha os marcadores {{...}}: eles são os números do pedido, que ficam travados.",
      /** #157 O contador da edição: os caracteres do texto (como a API os conta) e o limite dela; acima dele o servidor recusa o salvamento. */
      counter: (count: number, limit: number) => (count > limit ? `${count} de ${limit} caracteres: acima do limite, o servidor não aceita.` : `${count} de ${limit} caracteres`),
      /** #157 O motivo do salvamento recusado é um dos fechados; o texto do servidor nunca chega à tela (layer-exposure). */
      saveFailed: {
        invalid: "O texto não foi salvo: confira os marcadores {{...}} e os números. O texto anterior continua valendo.",
        conflict: "A cobrança mudou e o texto não foi salvo. Veja o estado atual e tente de novo.",
        unknown: "Não consegui salvar o texto agora. Tente de novo em um minuto.",
      },
      send: "Enviar cobrança",
      discard: "Descartar rascunho",
      sending: "Enviando a cobrança…",
      /** #157 `by` é "por você" ou "por fulano" (quem enviou, quando não é quem olha a tela). */
      /** #157 `due` é nulo quando o servidor não gravou o novo prazo: a frase não promete data. */
      sent: (by: string, on: string, time: string | undefined, due: string | null) =>
        `Cobrança enviada ${by} em ${on}${time ? ` às ${time}` : ""}${due === null ? "" : ` · aguardando resposta até ${due}`}.`,
      retry: "Tentar enviar de novo",
      /** #157 O motivo do envio falho é um dos desenhados; o texto do servidor de e-mail nunca chega à tela (layer-exposure). */
      failed: {
        mailRefused: "A cobrança não saiu: o servidor de e-mail recusou o envio.",
        unknown: "A cobrança não saiu. Tente de novo em um minuto.",
      },
      failedKept: "O rascunho fica como está e nada é duplicado.",
    },
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
      dockActionAltered: (auditor: string) => `ação na doca: ${auditor}`,
      routing: (level: string) => `encaminha para ${level}`,
    },
    raisedTo: (level: string) => `A proposta subiu para ${level}.`,
    auditedBy: (model: string, time: string) => `Auditado por ${model} às ${time}.`,
    notAuditedReason: {
      claude_falhou: "O Claude não conseguiu auditar esta nota.", // ADR-002
      erro_de_tool: "Uma ferramenta falhou durante a auditoria.", // ADR-002
      sem_auditoria: "Esta nota não teve auditoria.", // ADR-002
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
      return_note: "Nota de devolução",
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

  /** #156 O bloco "Pedido ao fornecedor" na gaveta da proposta decidida (wireframe, seção 5). */
  supplierRequest: {
    title: "Pedido ao fornecedor",
    badge: "Claude",
    writing: "O Claude está preparando o pedido…",
    note: { title: "Nota de devolução (rascunho)", lockedTitle: "Nota de devolução", locked: "travada", total: "Total da devolução" },
    noteLine: (quantity: string, unitPrice: string) => `${quantity} × ${unitPrice}`,
    noteFor: (supplier: string, reference: string) => `Para: ${supplier} · Ref.: ${reference}`,
    email: {
      title: "E-mail",
      toAndDue: (to: string, due: string) => `Para: ${to} · Prazo: ${due}`,
      subject: "Assunto:",
      lockedFields: "Para, prazo e anexo: travados",
      bodyLabel: "Texto do e-mail",
      checkedOnSave: "Os números do texto são conferidos com o banco ao salvar.",
      /** #156 Os números do e-mail são marcadores {{...}}: o servidor reconfere o texto com eles. */
      keepMarkers: "Mantenha os marcadores {{...}}: eles são os números do pedido, que ficam travados.",
    },
    attachment: (name: string) => `${name} (anexa ao enviar)`,
    /** #157 O rascunho com nota ainda não tem o nome do PDF (ele nasce com o número da nota, na emissão): vale o texto do wireframe #156. */
    attachmentPending: "nota-devolucao-…pdf (anexa ao enviar)",
    actions: {
      discard: "Descartar",
      edit: "Editar",
      sendWithNote: "Emitir e enviar",
      sendEmailOnly: "Enviar ao fornecedor",
      save: "Salvar texto",
      cancelEdit: "Cancelar edição",
      resend: "Tentar enviar de novo",
      redo: "Refazer",
    },
    pending: {
      sendWithNote: "Emitindo e enviando…",
      sendEmailOnly: "Enviando…",
      save: "Salvando…",
      discard: "Descartando…",
      resend: "Reenviando…",
      redo: "Refazendo…",
    },
    sentWithNote: (number: string, stamp: string, until: string) => `Nota de devolução ${number} emitida e enviada${stamp} · aguardando resposta até ${until}`,
    sentEmailOnly: (stamp: string, until: string) => `E-mail enviado${stamp} · aguardando resposta até ${until}`,
    byYou: "por você",
    by: (who: string) => `por ${who}`,
    /** #156 O carimbo da linha: a API pode entregar o pedido sem quem agiu ou sem a hora, e a frase então não os traz. */
    stamp: (by: string | null, time: string | null) => `${by === null ? "" : ` ${by}`}${time === null ? "" : ` às ${time}`}`,
    seeSent: "Ver o que foi enviado",
    sendFailedWithNote: (number: string, reason: string) => `A nota ${number} foi emitida, mas o e-mail não saiu: ${reason}.`,
    sendFailedEmailOnly: (reason: string) => `O e-mail não saiu: ${reason}.`,
    /** #157 O que "Tentar enviar de novo" e "Descartar" fazem com uma nota já emitida (wireframe #156, estado 8). */
    sendFailedNoteKept: "Tentar de novo só reenvia o e-mail: não emite outra nota. Descartar o pedido não cancela a nota já emitida.",
    /** #156 O `failure` do envio é um código curto da porta; a tela diz a frase, nunca o código. */
    sendFailureReasons: {
      resend_unavailable: "o serviço de e-mail está indisponível",
      send_failed: "o serviço de e-mail recusou o envio",
    },
    sendFailureOther: "o envio não foi concluído",
    /** #156 O motivo da recusa do texto do Claude, por código da API. */
    notPreparedReasons: {
      number_mismatch: "o texto citou um número fora do catálogo",
      invalid_shape: "o texto não veio na forma pedida",
    },
    notPreparedOther: "o texto não pôde ser aceito",
    discarded: (stamp: string) => `Pedido descartado${stamp}`,
    notPrepared: (reason: string) => `Não foi possível preparar o pedido: ${reason}.`,
    loadFailed: { title: "Não foi possível carregar o pedido", retry: "Tentar de novo", loading: "Carregando…" },
    errors: {
      forbidden: "Você não tem permissão para esta ação.",
      conflict: "Outra pessoa já agiu neste pedido. Feche e reabra a gaveta para ver o estado atual.",
      unprocessable: "O pedido não pôde ser processado. Confira o texto e tente de novo.",
      timeout: "A resposta demorou. Veja abaixo o estado atual do pedido antes de tentar de novo.",
      other: "Não foi possível concluir a ação. Tente de novo em um minuto.",
    },
  },
};
