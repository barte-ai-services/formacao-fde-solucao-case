-- #363 Modo demonstração: a contagem da doca e as respostas do fornecedor ganham origem e funções em lote (rpc).
-- #363 Expandir antes de usar: só cria colunas e funções; o Worker passa a chamá-las no mesmo PR, e as chamadas só acontecem com o modo ligado.
-- #363 Depende da #349 (20261123110000): lê kit_notas.origin. As funções são plpgsql, ligadas às colunas só na execução.
-- #363 Sem security definer: rodam com os direitos de quem chama (a chave secreta do Worker). RLS segue ligado e sem política nas tabelas.

-- #363 Toda resposta é da base ou da demonstração. Coluna nova, obrigatória e 'base' por padrão: o que já existe fica 'base' sem
-- #363 tocar em nenhuma linha. kit_recebimentos NÃO ganha coluna: é tabela do contrato de dados do kit (#349 já subiu a versão dele por
-- #363 kit_notas.origin), e a contagem da demonstração já se distingue pelo recebimento_id 'RC-DOCA-<chave>', que a base não usa.
alter table public.inbox_supplier_messages add column origin text not null default 'base' check (origin in ('base', 'demo'));

-- #363 As ações publicadas na doca ou na loja de notas da demonstração que ainda não têm contagem, da mais antiga para a mais nova,
-- #363 numa só leitura: a ação, a exceção e os itens da nota vêm juntos (uma requisição só, qualquer que seja o volume).
-- #363 Só notas origin = 'demo'. O pedido só vai junto se existe em kit_ordens (a chave estrangeira do recebimento).
create function public.demo_dock_count_pending()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(x.action order by x.published_at, x.action_id)
    from (
      select
        a.published_at,
        a.channel || '-' || a.id::text as action_id,
        jsonb_build_object(
          'actionId', a.channel || '-' || a.id::text,
          'channel', a.channel,
          'invoiceAccessKey', a.invoice_access_key,
          'publishedAt', a.published_at,
          'supplierId', i.supplier_id,
          'store', i.store,
          'purchaseOrderId', (select o.ordem_id from public.kit_ordens o where o.ordem_id = i.purchase_order_ref),
          'classification', i.classification,
          'items', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'supplierCode', e ->> 'supplierCode',
              'description', e ->> 'description',
              'quantity', (e -> 'quantity' ->> 'amount')::numeric,
              'unit', e -> 'quantity' ->> 'unit'
            )), '[]'::jsonb)
            from jsonb_array_elements(i.items) e
          )
        ) as action
      from (
        select id, invoice_access_key, published_at, 'dock' as channel from public.outbox_dock_actions
        union all
        select id, invoice_access_key, published_at, 'store' as channel from public.outbox_store_actions
      ) a
      join public.invoices i on i.access_key = a.invoice_access_key
      join public.kit_notas n on n.chave = a.invoice_access_key and n.origin = 'demo'
      where a.published_at > now() - interval '1 day'
        and not exists (select 1 from public.kit_recebimentos r where r.recebimento_id = 'RC-DOCA-' || a.invoice_access_key)
      order by a.published_at, a.id
      limit 200
    ) x
  ), '[]'::jsonb);
end;
$$;

-- #363 Grava as contagens do lote (recebimentos e itens) numa transação só: ou o lote inteiro entra, ou nada entra. `on conflict do
-- #363 nothing`: repetir o lote não duplica nada, e a função nunca atualiza nem apaga linha. Devolve quantos recebimentos entraram.
create function public.demo_insert_dock_counts(p_batch jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_inserted integer;
begin
  if p_batch is null or jsonb_typeof(p_batch) <> 'object' then
    raise exception 'lote da contagem ausente ou fora do formato';
  end if;

  insert into public.kit_recebimentos (recebimento_id, nota_chave, ordem_id, fornecedor_id, destino, canal, data, observacao)
  select recebimento_id, nota_chave, ordem_id, fornecedor_id, destino, canal, data, observacao
    from jsonb_populate_recordset(null::public.kit_recebimentos, p_batch -> 'kit_recebimentos')
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  insert into public.kit_recebimento_itens (recebimento_id, codigo_fornecedor, descricao, quantidade, unidade)
  select recebimento_id, codigo_fornecedor, descricao, quantidade, unidade
    from jsonb_populate_recordset(null::public.kit_recebimento_itens, p_batch -> 'kit_recebimento_itens')
  on conflict do nothing;

  return v_inserted;
end;
$$;

-- #363 Os pedidos enviados de notas da demonstração que ainda não têm resposta na caixa de entrada, do mais recente para o mais antigo,
-- #363 numa só leitura. A janela de um dia limita a leitura: quem "nunca responde" não volta a ser lido para sempre.
create function public.demo_supplier_replies_pending()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('requestId', x.id, 'recipient', x.recipient, 'sentAt', x.sent_at) order by x.sent_at desc, x.id)
    from (
      select e.id, e.recipient, e.sent_at
      from public.outbox_supplier_emails e
      join public.kit_notas n on n.chave = e.invoice_access_key and n.origin = 'demo'
      where e.status = 'sent'
        and e.sent_at > now() - interval '1 day'
        and not exists (select 1 from public.inbox_supplier_messages m where m.request_id = e.id)
      order by e.sent_at desc, e.id
      limit 200
    ) x
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.demo_dock_count_pending() from public, anon, authenticated;
revoke execute on function public.demo_insert_dock_counts(jsonb) from public, anon, authenticated;
revoke execute on function public.demo_supplier_replies_pending() from public, anon, authenticated;
grant execute on function public.demo_dock_count_pending() to service_role;
grant execute on function public.demo_insert_dock_counts(jsonb) to service_role;
grant execute on function public.demo_supplier_replies_pending() to service_role;
