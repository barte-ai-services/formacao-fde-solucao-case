-- #349 Modo demonstração: a fila nunca para. Cada rodada grava de 3 a 8 notas novas, geradas pela solução, nas tabelas do kit.
-- #349 Esta migração marca de onde vem cada nota (origin) e cria a função que grava o lote inteiro numa só chamada rpc.
-- #349 Expandir antes de usar: só cria a coluna e a função; o Worker passa a chamá-las no PR seguinte (#348).

-- #349 Toda nota é da base (carregada de data/kit/notas.json) ou da demonstração. A coluna é nova, obrigatória e vale 'base'
-- #349 por padrão: as 80 notas que já existem ficam 'base' sem tocar em nenhuma, e a carga da base não precisa mudar de ordem.
alter table public.kit_notas add column origin text not null default 'base' check (origin in ('base', 'demo'));

-- #349 Recebe o lote como um objeto jsonb com uma lista por tabela do kit (as chaves são os nomes das tabelas) e grava tudo na
-- #349 ordem das chaves estrangeiras, numa transação só: ou o lote inteiro entra, ou nada entra. `on conflict do nothing` em
-- #349 todos os inserts: repetir o lote não duplica nada, e a função nunca atualiza nem apaga linha (a carga da base, que faz
-- #349 upsert por chave, não toca as linhas da demonstração). Devolve quantas notas entraram.
-- #349 O cadastro (fornecedores e produtos) já existe e não é gravado aqui: a chave estrangeira falha se o lote citar um que não existe.
-- #349 Sem security definer: roda com os direitos de quem chama (a chave secreta do Worker). A origem da nota é sempre 'demo',
-- #349 qualquer que seja o que o lote traga.
create function public.kit_insert_demo_batch(p_batch jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_inserted_notes integer;
begin
  if p_batch is null or jsonb_typeof(p_batch) <> 'object' then
    raise exception 'lote da demonstração ausente ou fora do formato';
  end if;

  insert into public.kit_ordens (ordem_id, fornecedor_id, destino, data_emissao, status, motivo_status, valor_total)
  select ordem_id, fornecedor_id, destino, data_emissao, status, motivo_status, valor_total
    from jsonb_populate_recordset(null::public.kit_ordens, p_batch -> 'kit_ordens')
  on conflict do nothing;

  insert into public.kit_ordem_itens (ordem_id, codigo_fornecedor, sku, descricao, quantidade, unidade, preco_unitario)
  select ordem_id, codigo_fornecedor, sku, descricao, quantidade, unidade, preco_unitario
    from jsonb_populate_recordset(null::public.kit_ordem_itens, p_batch -> 'kit_ordem_itens')
  on conflict do nothing;

  insert into public.kit_notas_lancadas (chave, nota_id, numero, serie, fornecedor_id, destino, data_emissao, pedido_referenciado, canal_entrada, valor_total, situacao)
  select chave, nota_id, numero, serie, fornecedor_id, destino, data_emissao, pedido_referenciado, canal_entrada, valor_total, situacao
    from jsonb_populate_recordset(null::public.kit_notas_lancadas, p_batch -> 'kit_notas_lancadas')
  on conflict do nothing;

  insert into public.kit_nota_lancada_itens (chave, codigo_fornecedor, sku, descricao, quantidade, unidade, preco_unitario, valor)
  select chave, codigo_fornecedor, sku, descricao, quantidade, unidade, preco_unitario, valor
    from jsonb_populate_recordset(null::public.kit_nota_lancada_itens, p_batch -> 'kit_nota_lancada_itens')
  on conflict do nothing;

  insert into public.kit_notas (chave, nota_id, numero, serie, fornecedor_id, destino, data_emissao, pedido_referenciado, canal_entrada, valor_total, origin)
  select chave, nota_id, numero, serie, fornecedor_id, destino, data_emissao, pedido_referenciado, canal_entrada, valor_total, 'demo'
    from jsonb_populate_recordset(null::public.kit_notas, p_batch -> 'kit_notas')
  on conflict do nothing;
  get diagnostics v_inserted_notes = row_count;

  insert into public.kit_nota_itens (chave, codigo_fornecedor, sku, descricao, quantidade, unidade, preco_unitario, valor)
  select chave, codigo_fornecedor, sku, descricao, quantidade, unidade, preco_unitario, valor
    from jsonb_populate_recordset(null::public.kit_nota_itens, p_batch -> 'kit_nota_itens')
  on conflict do nothing;

  insert into public.kit_recebimentos (recebimento_id, nota_chave, ordem_id, fornecedor_id, destino, canal, data, observacao)
  select recebimento_id, nota_chave, ordem_id, fornecedor_id, destino, canal, data, observacao
    from jsonb_populate_recordset(null::public.kit_recebimentos, p_batch -> 'kit_recebimentos')
  on conflict do nothing;

  insert into public.kit_recebimento_itens (recebimento_id, codigo_fornecedor, descricao, quantidade, unidade)
  select recebimento_id, codigo_fornecedor, descricao, quantidade, unidade
    from jsonb_populate_recordset(null::public.kit_recebimento_itens, p_batch -> 'kit_recebimento_itens')
  on conflict do nothing;

  insert into public.kit_pagamentos (pagamento_id, fornecedor_id, destino, data, valor, forma, origem, nota_chave)
  select pagamento_id, fornecedor_id, destino, data, valor, forma, origem, nota_chave
    from jsonb_populate_recordset(null::public.kit_pagamentos, p_batch -> 'kit_pagamentos')
  on conflict do nothing;

  return v_inserted_notes;
end;
$$;
revoke execute on function public.kit_insert_demo_batch(jsonb) from public, anon, authenticated;
grant execute on function public.kit_insert_demo_batch(jsonb) to service_role;
