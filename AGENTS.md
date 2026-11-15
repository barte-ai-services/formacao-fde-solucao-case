# Regras do repositório da solução

- **Interno.** A solução de referência não vai para o `formacao-fde-case`, que é público, nem
  para nenhum fork da turma.
- **Nenhum nome de cliente real.** A Já Chegou é fictícia.
- **Nada de segredo** no git. Credenciais ficam no `.env`, que o git ignora.
- **Prosa em português.**
- **O gate** é `make check` e passa antes de cada commit.

<!-- ahrena:agency:start -->
## Build work enters through the agency

Build work enters through the `athena` agent (`ahrena-engineering-development:athena`
on Claude Code). She plans the issue, routes the
concern, and delegates each layer to `iris` (frontend), `apollo` (backend) or
`clio` (data), running the develop→Argos loop (at most three rounds) before each
stacked pull request. Do not implement build work directly — delegate to the
agency. Athena orchestrates; she does not write production code, pass a review
verdict, or apply a fix.
<!-- ahrena:agency:end -->
