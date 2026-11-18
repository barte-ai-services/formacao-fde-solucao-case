# MCP da fila de aprovação

O `formacao-fde-solucao-case-mcp` é um Python Worker da Cloudflare (conta Barte Academy), separado do Worker da
API. Ele fala MCP (JSON-RPC 2.0 por Streamable HTTP, `POST /mcp`) e expõe as tools de dados da #137:
`list_approval_queue`, `get_proposal` e `decide_proposal`, e abre a tela da fila (MCP App) pela tool `open_approval_app`. Cada uma de dados chama a rota da API pelo service binding `API`,
repassando o cabeçalho `Cf-Access-Jwt-Assertion` de quem chamou. O MCP não decide nada: a régua, a regra 8 e o
estado da proposta ficam na API. Sem o cabeçalho, nenhuma chamada à API acontece.

O MCP não valida, não guarda e não registra o JWT, e não tem segredo nenhum. A conexão no Claude e o Access na
frente do MCP são do plano 3 (#275).

## Estrutura

- `src/worker.py`: o ponto de entrada, um adaptador fino (único arquivo que importa `workers` e `js`).
  Chama a API pelo service binding com prazo de 10 s; o estouro vira o erro genérico `unavailable` para a pessoa.
- `src/app.py`, `protocol.py`, `tools.py`, `inputs.py`, `translation.py`, `api_client.py`, `errors.py`,
  `json_types.py`: a lógica, em Python puro. O cliente da API é uma porta; os testes usam um dublê.
- `src/*_test.py`: os testes, ao lado do código, com `unittest`. `src/test_support.py` é o apoio deles (o dublê da
  API e as respostas de exemplo) e não é coletado como teste. O `worker_test.py` roda o `worker.py` no CPython com
  dublês dos módulos do runtime.
- Nomes de bastidor em inglês (ADR-002); ficam em português, marcados com `# ADR-002`, os literais do glossário e os
  nomes de teste escritos como frase.

## A tela (MCP App, #274)

`open_approval_app` (`view`: `queue`, `proposal` com `invoice_access_key`, ou `report`) não chama a API e não exige
sessão: só diz à tela o que abrir (`structuredContent`: `view` e a chave). Está ligada ao recurso
`ui://formacao-fde/approval` pelo `_meta.ui.resourceUri`; o texto do resultado manda um host sem MCP Apps
usar `list_approval_queue`. Sem sessão a tela ainda abre: é ela que mostra "Sua sessão expirou" ao chamar as tools
de dados, e o botão Entrar repete a chamada que falhou.

`resources/list` e `resources/read` (`src/resources.py`, registrados na tabela de métodos) servem a tela com o tipo
`text/html;profile=mcp-app`. URI desconhecida responde `-32002`. `initialize` anuncia `resources`.

- **Fonte da tela:** `ui/approval.html`, um HTML só, com CSS e JS embutidos, a CSP no próprio arquivo, os tokens do
  `barte-ui-kit` (via `barte-design-tokens`, tema claro) como variáveis CSS, nada da rede e sem fonte externa.
- **Entrega ao Worker:** o Python Worker só sobe `.py`, então `python3 mcp/scripts/generate_ui.py` gera
  `src/approval_screen.py` com o HTML como literal. Depois de editar o HTML, rode o script e comite os dois: o teste
  `approval_screen_test.py` falha se o módulo estiver desatualizado.
- **A tela não calcula.** Todo número vem de uma tool. Para isso as tools devolvem o que a tela precisaria somar ou
  derivar: `list_approval_queue` traz `waiting_for_you` (contagem e valor em risco do cabeçalho), `get_proposal` traz
  `proposed_partial_lines` (a proposta da regra para a tabela do receber parcial, porte de
  `web/src/approval/partial-prefill.ts`), `engine.similar_cases_count` e `approval.decided_hour` (nulo quando a API só
  tem o dia).
- **`decide_proposal` só sai no clique em Registrar.** Texto de tool entra por `textContent`.

Para ver a tela à mão, sem o Claude: o teste abre a tela num host falso (`ui/host.mjs`, `ui/fixtures.mjs`); para
olhar no navegador, sirva a pasta `mcp/ui` e abra `approval.html` num iframe de uma página que responda ao
`ui/initialize` e aos `tools/call` com os dados de `fixtures.mjs`.

## Protocolo

JSON-RPC 2.0 por Streamable HTTP, uma mensagem por `POST /mcp`, sem lote e sem estado. As versões do protocolo
suportadas são `2025-11-25` e `2025-06-18`, as que não admitem lote; quem pede outra recebe a mais recente.

## Proteção contra POST de outro site

- O `POST /mcp` exige `Content-Type: application/json`; qualquer outro responde 415, sem chamar nada.
- Se a requisição traz o cabeçalho `Origin` (um navegador), ele só passa se estiver na variável `MCP_ALLOWED_ORIGINS`
  (origens separadas por vírgula, em `wrangler.jsonc`). Vazia, que é o padrão, todo `Origin` presente é recusado com 403.
  Requisição sem `Origin`, que é o caso de um cliente de servidor como o Claude, segue.
- O plano 3 (#275) liga o Claude e o Access na frente do MCP e ajusta essa lista se precisar.

## Testes

Da raiz do repositório (Python 3.10 ou mais novo, sem pacote de terceiros):

```sh
python3 -m unittest discover -s mcp/src -p '*_test.py'
```

O teste da tela roda com o Node (jsdom 31.0.1, só em `mcp/`, instalado do `package-lock.json`):

```sh
npm --prefix mcp ci --ignore-scripts && npm --prefix mcp test
```

O `make check` roda os dois, e o workflow de publicação roda o teste da tela antes do deploy.

## Publicação

Só pela esteira: o workflow `.github/workflows/deploy-mcp.yml` roda os testes, instala as dependências com `npm ci`
a partir do `package-lock.json` (num passo sem secrets) e faz `npx wrangler deploy`, com o wrangler em versão exata
(`package.json`), a partir da `main`, no environment `producao`. Só o passo do deploy vê as credenciais da Cloudflare.
O Actions só publica; nunca roda o MCP.
