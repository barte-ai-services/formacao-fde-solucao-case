# Eval do agente contra o gabarito

Mede as propostas de um agente contra o gabarito das 80 notas do kit: acerto na classificação, na ação na doca e no encaminhamento, por campo e por tipo de exceção. A nota só conta como acerto completo quando os três batem; nota sem proposta conta como erro. É o eval da #154 (grupo 4, agente auditor de notas).

Da raiz do repositório (a pasta `eval/saidas/` já vem no clone; ponha lá o `propostas.jsonl` do agente):

```bash
python3 eval/avaliar.py eval/saidas/propostas.jsonl
python3 eval/avaliar.py eval/saidas/propostas.jsonl --comparar eval/saidas/baseline.jsonl
```

O `propostas.jsonl` tem uma linha por nota, com `nota_id`, `classificacao`, `acao_doca` e `encaminhamento`. Se a mesma nota aparecer mais de uma vez, vale a última. Os dados das notas vêm de `data/kit/`; o gabarito fica em `eval/gabarito/` e a aplicação nunca o lê.

## Baseline

O `baseline/regras.py`, ao lado de `eval/`, é a referência sem IA: as regras que um time de operação escreveria numa primeira tentativa. O `eval/saidas/baseline.jsonl` já vem gerado (46% de acerto completo). Para gerar de novo e comparar o agente com ele:

```bash
python3 baseline/regras.py
python3 eval/avaliar.py eval/saidas/propostas.jsonl --comparar eval/saidas/baseline.jsonl
```

## Eval do auditor de notas (#239)

Mede as auditorias que o agente auditor gravou (`record_audit`, #153) contra o gabarito das 80 notas. O comando lê só o arquivo de auditorias e o gabarito; não usa rede, banco nem a base do kit, e nada do código do agente lê o gabarito.

```bash
python3 eval/auditor.py auditorias.jsonl                  # a rodada em JSON, na saída padrão
python3 eval/auditor.py auditorias.jsonl --format md     # o relatório legível, em português
```

Opções para teste: `--answer-key <arquivo>` (padrão `eval/gabarito/gabarito.json`) e `--runs-dir <pasta>` (padrão `eval/rodadas/`).

Do banco, num comando só: `make eval` exporta as auditorias e as propostas da regra (`scripts/export_audits.py`, só leitura nas tabelas `invoice_audits` e `proposals`, com `BARTE_ACADEMY_SUPABASE_URL` e `BARTE_ACADEMY_SUPABASE_SECRET_KEY` do ambiente ou do `.env`) para `eval/saidas/auditorias.jsonl` e roda o eval sobre ele. Nota sem auditoria fica fora do arquivo e conta como erro; nota com proposta `alterada` sai sem `rule`, e a exportação informa quantas.

### Formato de entrada

`auditorias.jsonl` tem uma linha por nota auditada, ligada ao gabarito por `invoice_access_key` == `chave`. Se a mesma chave aparecer mais de uma vez, vale a última linha. Campos:

- `invoice_access_key`, `classification` (`MATCH`, `E1` a `E8` ou `NAO_CATALOGADA`, que nunca é acerto), `dock_action` (`receber`, `receber_parcial`, `recusar`), `routing` (`regra`, `analista`, `coordenacao`, `diretoria`, `bloqueio`), `justification`, `amount_at_risk` (`{"cents": int}` ou `null`), `model`, `audited_at`;
- `rule` (opcional, um objeto): a proposta da regra para a mesma nota, a baseline sem IA, com `classification`, `dock_action` e `routing`. Falta quando a proposta original não pode ser lida: a proposta `alterada` pela pessoa guarda a edição, não a regra, e a original não fica no banco (#262). A nota sem `rule` fica fora da comparação com a regra, dos dois lados, e é contada em `notes_without_rule`; o acerto do agente sobre o gabarito não muda;
- `not_audited` (opcional): `{"reason": "..."}`; a nota conta como erro e entra em `errors[]` com o motivo;
- `refusals` (opcional): lista de recusas do `record_audit`, cada uma com `refusal` igual a `routing_below_regua` ou `invalid_field`;
- `prompt_version` (opcional).

### Saída

Por rodada: `run_id` (data e hora UTC mais um hash curto do arquivo), `model` e `prompt_version` (o valor único, ou a lista ordenada se variarem; `null` se ausentes), `full_match_rate` (classificação, ação na doca e encaminhamento iguais ao gabarito, sobre todas as notas do gabarito), `by_field`, `by_exception` (`match` e `E1` a `E8`: total e acertos por campo e completo), `routing_below_regua`, `first_try_routing_rate`, `errors[]`, `notes_without_rule` e `vs_baseline` (por exceção e no total, o acerto do agente contra o da regra, sobre as notas que têm `rule`). Nota do gabarito sem linha conta como erro; chave fora do gabarito entra em `errors[]` e não muda o denominador.

Sem nenhuma linha com `refusals` no arquivo, `routing_below_regua` e `first_try_routing_rate` saem `null` ("não medido" no Markdown), nunca 0. Com `refusals`, as duas contam só as notas auditadas do gabarito (linha com a chave no gabarito e sem `not_audited`); linha de chave fora do gabarito não entra em nenhuma. `routing_below_regua` conta as recusas `routing_below_regua` dessas notas, e `first_try_routing_rate` é a parcela delas sem nenhuma recusa `routing_below_regua`; uma recusa `invalid_field` não conta contra o encaminhamento de primeira.

Cada rodada é gravada em `eval/rodadas/<run_id>.json` (a pasta não vai para o git). Quando há uma rodada anterior, a saída traz `vs_previous` com a diferença de `full_match_rate`, de `by_field` e do acerto completo por exceção.

### Códigos de saída

- `0`: medido, e toda duplicidade (E6) do gabarito foi classificada como E6;
- `1`: alguma E6 do gabarito não foi classificada E6 (inclusive sem auditoria ou não auditada), qualquer que seja o resto, inclusive uma falha da saída padrão depois de gravar a rodada: nesse caso sai `1`, com a mensagem da falha da saída e a linha da E6 na saída de erro;
- `2`: uso ou entrada inválidos, sempre com uma mensagem fixa em português na saída de erro e sem eco do objeto: arquivo ilegível, linha que não é JSON ou sem `invoice_access_key`, `rule` que não é objeto (ausente ou `null` vale), `not_audited` que não é objeto com `reason` em texto, `refusals` que não é lista de objetos, gabarito que não é lista de notas com `chave`, `classificacao` (`match` ou `E1` a `E8`), `acao_doca` e `encaminhamento`, e arquivo de rodada anterior corrompido ou ilegível na pasta de rodadas. Toda outra exceção do comando (inteiro de mais de 4300 dígitos, aninhamento profundo demais, surrogate isolado, inteiro gigante numa rodada anterior, ou um defeito do próprio programa) também sai `2`, com a mesma mensagem fixa `erro: não foi possível processar a entrada; nada foi gravado`, sem o valor, sem o nome da exceção e sem rastro. A rodada é gravada num temporário na pasta de rodadas e renomeada, depois de montado tudo o que sai no stdout. Falha ao gravar sai `2` com `erro: não foi possível gravar a rodada na pasta de rodadas` e não deixa arquivo na pasta; saída padrão que não representa o relatório (por exemplo `PYTHONIOENCODING=ascii` com `--format md`, que tem acentos) sai `2` com `erro: a saída padrão não representa o relatório; nada foi gravado`, antes de gravar, e não deixa arquivo; com `PYTHONIOENCODING=ascii:backslashreplace` o stream escreve os escapes e a rodada vale. Falha ao escrever no stdout depois de gravar sai `2` com `erro: a rodada foi gravada, mas a saída padrão falhou`, e a rodada fica gravada (com uma E6 perdida, o `1` vence, como acima). O código `1` fica reservado à E6 perdida; nenhuma entrada malformada sai por ele.
