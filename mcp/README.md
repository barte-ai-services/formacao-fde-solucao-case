# MCP da fila de aprovação

O `formacao-fde-solucao-case-mcp` é um Python Worker da Cloudflare (conta Barte Academy), separado do Worker da
API. Ele fala MCP (JSON-RPC 2.0 por Streamable HTTP, `POST /mcp`) e expõe as tools de dados da #137:
`list_approval_queue`, `get_proposal` e `decide_proposal`. Cada uma chama a rota da API pelo service binding `API`,
repassando o cabeçalho `Cf-Access-Jwt-Assertion` de quem chamou. O MCP não decide nada: a régua, a regra 8 e o
estado da proposta ficam na API. Sem o cabeçalho, nenhuma chamada à API acontece.

O MCP não valida, não guarda e não registra o JWT, e não tem segredo nenhum. A conexão no Claude e o Access na
frente do MCP são do plano 3 (#275).

## Estrutura

- `src/worker.py`: o ponto de entrada, um adaptador fino (único arquivo que importa `workers`).
- `src/aplicacao.py`, `protocolo.py`, `ferramentas.py`, `entradas.py`, `traducao.py`, `cliente_api.py`,
  `erros.py`: a lógica, em Python puro. O cliente da API é uma porta; os testes usam um dublê.
- `src/*_test.py`: os testes, ao lado do código, com `unittest`.

## Testes

Da raiz do repositório (Python 3.10 ou mais novo, sem pacote de terceiros):

```sh
python3 -m unittest discover -s mcp/src -p '*_test.py'
```

O `make check` já roda esse comando.

## Publicação

Só pela esteira: o workflow `.github/workflows/deploy-mcp.yml` roda os testes e faz `wrangler deploy` a partir da
`main`, no environment `producao`. O Actions só publica; nunca roda o MCP.
