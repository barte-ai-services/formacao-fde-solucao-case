-- #130 #38 Quem abriu o pedido do dossiê: o evento da proposta (#38) ou a pessoa na gaveta (#130).
-- #130 Com a linha do evento, a gaveta mostra "Gerando" também quando ninguém clicou (#38/AC-1), e um clique
-- durante o evento recebe 409. As linhas que já existem são da gaveta: o default as marca como on_demand.
alter table public.dossier_requests
  add column trigger text not null default 'on_demand' check (trigger in ('event', 'on_demand'));
