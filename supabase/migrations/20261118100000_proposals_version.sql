-- #249 #295 Trava otimista da proposta: `proposals.version` sobe a cada escrita, e a decisão (saveDecision) só vale se
-- #249 #295 a versão que ela leu ainda é a atual. A restrição única de approvals.proposal_id (regra 8) segue decidindo
-- #249 #295 quem chegou antes; a versão pega o resto: a proposta que mudou entre a leitura e a gravação (subida de nível,
-- #249 #295 outra decisão) não é sobrescrita às cegas.

-- #249 #295 AC-1: as linhas que já existem ficam com a versão 1.
alter table public.proposals
  add column version integer not null default 1;

-- #249 #295 AC-1: o gatilho sobe a versão em todo update, ignorando o que o cliente mandar em `version`. Assim todo
-- #249 #295 escritor incrementa sem mudar: raise_proposal_level, saveDecision e qualquer PATCH futuro.
create function public.proposals_bump_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;
revoke execute on function public.proposals_bump_version() from public, anon, authenticated;

create trigger proposals_bump_version
  before update on public.proposals
  for each row execute function public.proposals_bump_version();
