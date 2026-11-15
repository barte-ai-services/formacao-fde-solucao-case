-- #140 Fila de notas de devolução: a caixa outbox_return_notes vira fila de trabalho do fiscal.
-- #140 pendente de emissão → emitida (NF-e de devolução, quem, quando) ou cancelada (justificativa, quem, quando).
-- #140 As linhas que já estão na caixa entram como pendentes. RLS segue ligado e sem política (AC-6 do #59).

alter table public.outbox_return_notes
  add column status text not null default 'pendente',
  add column nfe_number text,
  add column emitted_by text,
  add column emitted_at timestamptz,
  add column cancel_justification text,
  add column cancelled_by text,
  add column cancelled_at timestamptz;

alter table public.outbox_return_notes
  add constraint outbox_return_notes_status_check check (status in ('pendente', 'emitida', 'cancelada')),
  add constraint outbox_return_notes_emitida_check check (
    (status = 'emitida') = (nfe_number is not null and emitted_by is not null and emitted_at is not null)
  ),
  add constraint outbox_return_notes_cancelada_check check (
    (status = 'cancelada') = (cancel_justification is not null and cancelled_by is not null and cancelled_at is not null)
  );

create index outbox_return_notes_status_idx on public.outbox_return_notes (status, id);
alter table public.outbox_return_notes enable row level security;
