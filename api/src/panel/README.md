# Painel do valor barrado

Quanto a conferência impediu de pagar errado no mês, contra os R$ 543 mil por mês que a Já Chegou
pagava sem a mercadoria (#71, história #39). Servido em `GET /api/valor-barrado?mes=AAAA-MM`,
atrás do Cloudflare Access.

- `barred-amount.ts`: a soma, pura, sem rede.
- `proposals-reader.ts`: lê `proposals` e `approvals` pelo PostgREST, valida cada linha e junta.
- `../http/barred-amount.ts`: a rota.

## O que conta

| Bloco | Quais propostas | Data que decide o mês |
|---|---|---|
| `barred` | `aprovada` ou `alterada`, com a ação vigente `recusar` ou `receber_parcial` | `approvals.approved_at`; sem linha em `approvals` (aprovação pela regra), `proposals.created_at` |
| `ifApprovedAsProposed` | `aguardando_aprovacao`, com a ação proposta `recusar` ou `receber_parcial` | `proposals.created_at` |

- Em `alterada`, a ação vigente é a gravada em `dock_action`, que já é a da pessoa.
- `registrada` nunca entra. `receber` nunca soma.
- O valor somado é o `amount_at_risk_cents` da proposta, com `Money`, em centavos inteiros.
- MATCH com ação que barra não deveria existir. Se aparecer, fica de fora da soma e a rota registra
  um aviso com os ids.
- O mês é o de Brasília, UTC-3 fixo, sem horário de verão: `2026-12-01T02:00Z` ainda é novembro.
- `baselineCents` é sempre `54300000`.

## Resposta

```json
{
  "month": "2026-11",
  "baselineCents": 54300000,
  "barred": { "totalCents": 120000, "byException": [{ "classification": "E6", "cents": 120000, "count": 1 }] },
  "ifApprovedAsProposed": { "totalCents": 3000, "byException": [{ "classification": "E1", "cents": 3000, "count": 1 }] },
  "daily": [{ "day": "2026-11-04", "barredCumulativeCents": 0, "proposedCumulativeCents": 3000, "doublePaymentCumulativeCents": 0 }]
}
```

`byException` segue a precedência de `domain/classification.ts` e lista só as exceções com ao menos
uma proposta. `daily` traz o acumulado do mês nos dias com movimento, para o gráfico da tela, em duas
séries (#170): `barredCumulativeCents` e `proposedCumulativeCents` sem E6 e E7 (o último ponto do
primeiro bate com o "Evitado"), e `doublePaymentCumulativeCents` com o E6 e E7 decididos, fora da
comparação com a linha de base.

| Situação | Resposta |
|---|---|
| `mes` fora de `AAAA-MM` (ou vazio) | 400 `mes_invalido` |
| Sem as credenciais do Supabase | 503 `supabase_nao_configurado` |
| PostgREST com erro ou linha fora do formato | 502 `supabase_indisponivel` |

## Limite conhecido

O leitor traz todas as propostas não registradas e todas as aprovações, sem filtro de data no
banco, porque a decisão de um mês pode ser de uma proposta criada antes e a data vem de outra
tabela. Serve para o volume da Já Chegou; se crescer, o caminho é uma view no banco.

As duas leituras não formam um snapshot. `approvals` é lida depois de `proposals`, então uma
aprovação que grave a linha em `approvals` antes de trocar o estado, ou na mesma transação,
nunca aparece como decidida sem a data.
