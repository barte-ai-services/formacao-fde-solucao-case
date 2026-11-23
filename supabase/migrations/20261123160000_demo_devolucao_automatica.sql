-- #353 Modo demonstração: o pedido de devolução de valor pequeno sai sozinho (emitido e enviado), com o limite no banco.
-- #353 Expandir antes de usar: só cria colunas e funções; o Worker passa a chamá-las no mesmo PR, e as chamadas só acontecem com o modo ligado.
-- #353 Depende da #349 (20261123110000): lê kit_notas.origin. As funções são plpgsql, ligadas às colunas só na execução.
-- #353 Sem security definer: rodam com os direitos de quem chama (a chave secreta do Worker). RLS segue ligado e sem política nas tabelas.

-- #353 AC-3 O limite é um parâmetro do banco, na linha do modo demonstração (a mesma que liga o ritmo de 1 minuto): centavos, R$ 5.000,00 por
-- #353 AC-3 padrão. Muda por UPDATE, sem deploy; zero desliga a devolução automática; negativo não existe. Só vale com demo_settings.enabled.
alter table public.demo_settings add column auto_return_limit_cents integer not null default 500000 check (auto_return_limit_cents >= 0);

-- #353 AC-1 Todo pedido é da base ou da demonstração. Coluna nova, obrigatória e 'base' por padrão: o que já existe fica 'base' sem tocar em linha.
alter table public.outbox_supplier_emails add column origin text not null default 'base' check (origin in ('base', 'demo'));

-- #353 AC-1 AC-2 As devoluções pendentes da fila que a automação pode enviar, numa só leitura: o limite do banco e, por devolução, a nota de origem, o
-- #353 AC-1 AC-2 e-mail do fornecedor, as linhas e o pedido ao fornecedor que já esteja aberto como rascunho (o do Claude), da mais antiga à mais nova.
-- #353 AC-1 AC-2 Só notas origin = 'demo' e só até o limite (o valor é quantidade x preço unitário de cada linha, a conta de return-notes.ts). Com o modo
-- #353 AC-1 AC-2 desligado ou o limite zerado a lista é vazia: o Worker nem precisa decidir. A decisão final é do Worker (a regra monta a nota).
create function public.demo_auto_return_pending()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_enabled boolean;
  v_limit integer;
begin
  select s.enabled, s.auto_return_limit_cents into v_enabled, v_limit from public.demo_settings s where s.id;
  if not coalesce(v_enabled, false) or coalesce(v_limit, 0) <= 0 then
    return jsonb_build_object('limitCents', coalesce(v_limit, 0), 'entries', '[]'::jsonb);
  end if;
  return jsonb_build_object('limitCents', v_limit, 'entries', coalesce((
    select jsonb_agg(x.entry order by x.queue_id)
    from (
      select
        q.id as queue_id,
        jsonb_build_object(
          'queueId', q.id,
          'invoice', jsonb_build_object(
            'access_key', i.access_key, 'number', i.number, 'series', i.series, 'supplier_id', i.supplier_id, 'store', i.store,
            'issued_on', i.issued_on, 'purchase_order_ref', i.purchase_order_ref, 'entry_channel', i.entry_channel,
            'total_cents', i.total_cents, 'items', i.items
          ),
          'lines', q.payload -> 'lines',
          'supplierEmail', f.email,
          'request', case when r.id is null then null else jsonb_build_object(
            'id', r.id, 'version', r.version, 'draftedOn', r.drafted_on, 'subject', r.subject, 'body', r.body, 'asks', r.asks
          ) end
        ) as entry
      from public.outbox_return_notes q
      join public.invoices i on i.access_key = q.invoice_access_key
      join public.kit_notas n on n.chave = q.invoice_access_key and n.origin = 'demo'
      join public.kit_fornecedores f on f.fornecedor_id = i.supplier_id and f.email is not null
      cross join lateral (
        select
          count(*) as lines,
          count(it.item) as found,
          sum(round((it.item ->> 'unitPriceCents')::numeric * (l ->> 'amount')::numeric)) as cents
        from jsonb_array_elements(q.payload -> 'lines') l
        left join lateral (
          select e as item from jsonb_array_elements(i.items) e where e ->> 'supplierCode' = l ->> 'supplierCode' limit 1
        ) it on true
      ) v
      left join lateral (
        select e.id, e.version, e.drafted_on, e.subject, e.body, e.asks
        from public.outbox_supplier_emails e
        where e.invoice_access_key = q.invoice_access_key
          and e.request_type = 'return_note'
          and e.status in ('draft', 'send_failed')
          and (e.send_claim is null or e.send_claimed_at < now() - interval '5 minutes')
        order by e.id desc
        limit 1
      ) r on true
      where q.status = 'pendente'
        and v.lines > 0 and v.lines = v.found and v.cents <= v_limit
        and not exists (
          select 1 from public.outbox_supplier_emails s
          where s.invoice_access_key = q.invoice_access_key and s.request_type = 'return_note' and s.status = 'sent'
        )
        and (r.id is not null or not exists (
          select 1 from public.outbox_supplier_emails s
          where s.invoice_access_key = q.invoice_access_key and s.request_type = 'return_note' and s.status in ('draft', 'send_failed')
        ))
      order by q.id
      limit 50
    ) x
  ), '[]'::jsonb));
end;
$$;

-- #353 AC-1 Emite e envia o lote numa transação só: por devolução, a nota emitida (issued_return_notes, uma por devolução), o pedido ao fornecedor
-- #353 AC-1 como enviado (canal mock, origin 'demo', sent_by 'automação', o histórico com a entrada do envio) e a fila movida para emitida
-- #353 AC-1 (emitted_by 'automação'). É o que o clique "Emitir e enviar" (#156) faz, sem o clique. Cada devolução roda num bloco próprio: a que
-- #353 AC-1 já não está pendente, a que mudou de versão ou a que o limite do banco já não aceita é pulada e não leva o lote junto. Devolve quantas saíram.
create function public.demo_auto_return_send(p_batch jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  e jsonb;
  v_enabled boolean;
  v_limit integer;
  v_queue bigint;
  v_key text;
  v_issued bigint;
  v_rows integer;
  v_now timestamptz := now();
  v_sent integer := 0;
  v_attachments jsonb;
  v_state jsonb;
  v_entry jsonb;
begin
  if p_batch is null or jsonb_typeof(p_batch) <> 'array' then
    raise exception 'lote da devolução automática ausente ou fora do formato';
  end if;
  select s.enabled, s.auto_return_limit_cents into v_enabled, v_limit from public.demo_settings s where s.id;
  if not coalesce(v_enabled, false) or coalesce(v_limit, 0) <= 0 then
    return 0;
  end if;

  for e in select value from jsonb_array_elements(p_batch) loop
    begin
      v_queue := (e ->> 'queueId')::bigint;
      v_key := e ->> 'invoiceAccessKey';
      -- #353 AC-2 O limite do banco vale também aqui: o valor da nota em centavos contra o limite, e só nota da demonstração.
      if not ((e -> 'note' ->> 'total')::numeric * 100 <= v_limit) then continue; end if;
      perform 1 from public.kit_notas n where n.chave = v_key and n.origin = 'demo';
      if not found then continue; end if;
      -- #353 AC-1 A devolução ainda pendente (trava a linha): quem chegou antes, a pessoa pelo clique, ganha.
      perform 1 from public.outbox_return_notes q where q.id = v_queue and q.invoice_access_key = v_key and q.status = 'pendente' for update;
      if not found then continue; end if;

      insert into public.issued_return_notes (queue_id, invoice_access_key, supplier_id, issued_on, note)
      values (v_queue, v_key, e ->> 'supplierId', (e ->> 'issuedOn')::date, e -> 'note')
      on conflict (queue_id) do nothing;
      select n.id into v_issued from public.issued_return_notes n where n.queue_id = v_queue;

      v_attachments := jsonb_build_array(
        jsonb_build_object('filename', 'nota-devolucao-ND-' || v_issued || '.json', 'content_type', 'application/json', 'issued_return_note_id', v_issued),
        jsonb_build_object('filename', 'nota-devolucao-ND-' || v_issued || '.pdf', 'content_type', 'application/pdf', 'issued_return_note_id', v_issued)
      );
      v_state := jsonb_build_object(
        'status', 'sent', 'body', e ->> 'body', 'discard_reason', null, 'send_failure_reason', null, 'issued_return_note_id', v_issued
      );

      if (e ->> 'requestId') is null then
        v_entry := jsonb_build_object('version', 1, 'at', v_now, 'by', 'automação', 'action', 'sent', 'state', v_state);
        insert into public.outbox_supplier_emails (
          invoice_access_key, queue_id, supplier_id, request_type, recipient, subject, body, asks, note, attachments, drafted_on, due_on, model,
          status, issued_return_note_id, channel, provider_message_id, sent_by, sent_at, origin, version, history
        ) values (
          v_key, v_queue, e ->> 'supplierId', 'return_note', e ->> 'recipient', e ->> 'subject', e ->> 'body', e -> 'asks', e -> 'note',
          v_attachments, (e ->> 'draftedOn')::date, (e ->> 'dueOn')::date, 'demo',
          'sent', v_issued, 'mock', 'mock-demo-' || gen_random_uuid(), 'automação', v_now, 'demo', 1, jsonb_build_array(v_entry)
        );
      else
        -- #353 AC-1 O rascunho que já existia (o do Claude) é o que sai, com o texto que ele já tem: só se ninguém o mexeu desde a leitura.
        v_entry := jsonb_build_object('version', (e ->> 'requestVersion')::integer + 1, 'at', v_now, 'by', 'automação', 'action', 'sent', 'state', v_state);
        update public.outbox_supplier_emails m set
          status = 'sent', issued_return_note_id = v_issued, channel = 'mock', provider_message_id = 'mock-demo-' || gen_random_uuid(),
          sent_by = 'automação', sent_at = v_now, origin = 'demo', attachments = v_attachments, send_failure_reason = null,
          send_claim = null, send_claimed_at = null, version = m.version + 1, history = m.history || v_entry, updated_at = v_now
        where m.id = (e ->> 'requestId')::bigint and m.version = (e ->> 'requestVersion')::integer
          and m.status in ('draft', 'send_failed') and m.invoice_access_key = v_key;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then raise exception 'o pedido mudou desde a leitura'; end if;
      end if;

      update public.outbox_return_notes set status = 'emitida', nfe_number = v_issued::text, emitted_by = 'automação', emitted_at = v_now
      where id = v_queue and status = 'pendente';
      v_sent := v_sent + 1;
    exception
      -- #353 AC-1 Só o que se espera pular: o pedido mudou (raise_exception) ou já há pedido aberto da nota (unique_violation).
      when raise_exception or unique_violation then
        continue;
    end;
  end loop;
  return v_sent;
end;
$$;

revoke execute on function public.demo_auto_return_pending() from public, anon, authenticated;
revoke execute on function public.demo_auto_return_send(jsonb) from public, anon, authenticated;
grant execute on function public.demo_auto_return_pending() to service_role;
grant execute on function public.demo_auto_return_send(jsonb) to service_role;
