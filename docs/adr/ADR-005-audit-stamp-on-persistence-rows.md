# ADR-005: O carimbo de auditoria fica nas linhas de persistência, não nas raízes do domínio

- **Status:** accepted
- **Date:** 2026-11-15

## Context

O pedido ao fornecedor (#10) e as demais raízes do domínio da api precisam de carimbo de auditoria: quando a linha nasceu e mudou (`created_at`, `updated_at`) e quem e quando fez um ato humano, como o envio (`sent_by`, `sent_at`). A raiz `SupplierRequest` não tem esses campos, e a revisão perguntou onde eles moram. Pelas regras de domínio (ADR-002 e a regra `domain-model`), o domínio não importa mecanismo: relógio, usuário da sessão e coluna de banco são mecanismo.

## Decision

O carimbo de auditoria vive nas linhas de persistência, para toda raiz, e não nas raízes do domínio. A camada de persistência preenche `created_at` e `updated_at` ao gravar e `sent_by` e `sent_at` quando o caso de uso registra o envio, com o relógio e o usuário que o caso de uso recebe. A raiz guarda só o que a regra de negócio lê, como o estado, o prazo e os motivos (`discardReason`, `sendFailureReason`). Nenhuma raiz ganha campo de carimbo por causa desta decisão.

## Consequences

- As raízes ficam sem relógio e sem usuário, e seus testes continuam sem doubles.
- A camada de persistência (OLTP) é quem declara as colunas de carimbo e as preenche, na mesma transação do caso de uso.
- Uma regra que dependa de quando ou de quem (por exemplo, um prazo contado do envio) recebe esse dado como parâmetro, e não o lê da raiz.
- Ler o carimbo de volta para a tela é consulta da camada de persistência, fora do agregado.

## Alternatives considered

- Carimbo como campos das raízes. Rejeitada: obriga o domínio a conhecer relógio e usuário, e cada raiz repetiria os mesmos campos sem que nenhuma invariante os use.
- Tabela de auditoria separada, alimentada por gatilho. Rejeitada: esconde a escrita do caso de uso e não traz nada que as colunas na própria linha não deem para o que o produto precisa hoje.
