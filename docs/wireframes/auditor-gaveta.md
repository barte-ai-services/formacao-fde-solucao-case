# Wireframe: bloco "Agente auditor" na gaveta da nota

Issue #231, parte de #153.

Estado: APROVADO.
Aprovação: a pessoa (dona do design), na sessão da #153, 15/11/2026. Aprovou o wireframe como desenhado, com todas as recomendações.

Decisões da aprovação:
- Auditoria nula mostra "Auditoria pendente. Decida pelas evidências da conferência."
- O bloco fica depois de Evidências e dos itens parciais, antes de "Dossiê do Claude".
- O encaminhamento diz "encaminha para <nível>", sem "não X".
- O rodapé "Auditado por <modelo> às HH:MM." fica.
- Os textos de `sem_auditoria` ficam como abaixo.
- `refusals` e `amountAtRisk` da auditoria não aparecem.
- A pasta `docs/wireframes/` é sancionada por esta aprovação.

## Onde fica

Gaveta (InvoiceDrawer > ProposalPanel), de cima para baixo:

    badges (estado, nível) / DataList / Evidências / Itens parciais
    >>> Agente auditor (NOVO) <<<
    Dossiê do Claude / Como esta nota andou / decisão

## Estados (cópia exata)

Cada estado: título "Agente auditor", linha de veredito e justificativa. Texto puro, sem marcação.

### A1 Concorda (AC-1), tom positivo

    +-- Agente auditor ------------------------------+
    | Concorda com a regra                           |
    | <justificativa do auditor>                     |
    | Auditado por <modelo> às 14:32.                |
    +------------------------------------------------+

### A2 Discorda em 1 a 3 campos (AC-2), tom de alerta

    +-- Agente auditor ------------------------------+
    | Discorda: classifica como E2, não E4           |
    | <justificativa>                                |
    | Auditado por <modelo> às 14:32.                |
    +------------------------------------------------+

Uma frase por campo, na ordem classificação, ação, encaminhamento, ligadas por " · ":

- classification: "classifica como E2, não E4"
- dockAction: "ação na doca: Recusar, não Receber"
- routing: "encaminha para Coordenação"

Duas: "Discorda: classifica como E2, não E4 · encaminha para Coordenação".
Três: "Discorda: classifica como E2, não E4 · ação na doca: Recusar, não Receber · encaminha para Coordenação".

O valor "não X" vem da proposta. Os nomes de nível e de ação vêm de `texts.level` e `texts.action`.
No encaminhamento não há "não X".

### A3 Discorda e a proposta subiu (AC-3, `raisedLevel` não nulo), tom de alerta

    +-- Agente auditor ------------------------------+
    | Discorda: encaminha para Diretoria             |
    | A proposta subiu para Diretoria.               |
    | <justificativa>                                |
    | Auditado por <modelo> às 14:32.                |
    +------------------------------------------------+

### A4 Discorda sem subida (AC-3, `raisedLevel` nulo)

Só o A2, sem a linha "A proposta subiu". O alerta é a discordância.

### A5 Aviso de injeção (AC-4), junto de A1, A2 ou A3

Fica abaixo do veredito e acima da justificativa. Tom de alerta.

    +-- Agente auditor ------------------------------+
    | Concorda com a regra                           |
    | Aviso: um trecho da nota tentou dar ordem ao   |
    | agente. Ele não obedeceu.                      |
    |   "<trecho da nota, como texto>"               |
    | <justificativa>                                |
    +------------------------------------------------+

O trecho entra como nó de texto (nunca HTML), em citação, com quebra de linha.

### N Não auditada (AC-5), tom neutro

    +-- Agente auditor ------------------------------+
    | Não auditada                                   |
    | <motivo>                                       |
    | Decida pelas evidências da conferência.        |
    +------------------------------------------------+

- claude_falhou: "O Claude não conseguiu auditar esta nota."
- erro_de_tool: "Uma ferramenta falhou durante a auditoria."
- sem_auditoria: "Esta nota não teve auditoria."

### P Pendente (auditoria nula), tom neutro, uma linha

    +-- Agente auditor ------------------------------+
    | Auditoria pendente. Decida pelas evidências    |
    | da conferência.                                |
    +------------------------------------------------+

### Gaveta carregando ou com erro

O bloco não aparece. Valem só os textos atuais da gaveta (`drawerLoading`, `drawerError`, `noProposal`).
O bloco só existe com a proposta pronta.

## Fora do bloco

`refusals` e `amountAtRisk` da auditoria não aparecem. MCP App: #137.

## Fluxo

Abrir a gaveta, carregar, proposta pronta: o bloco mostra um dos estados acima, conforme `audit`.
Sem interação; o bloco só lê. Decidir (aprovar ou alterar) segue como hoje.

## Teste (esqueleto vermelho)

`web/test/auditor-gaveta.test.tsx`, Vitest com Testing Library, uma prova por critério, nome "#231/AC-n ...".
