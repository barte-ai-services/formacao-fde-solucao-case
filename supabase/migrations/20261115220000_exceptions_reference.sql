-- #128 Tabela de referência das exceções: código, nome do glossário e descrição.
-- A descrição de E1 a E8 repete data/kit/excecoes.json (um teste confere); esta migração é a fonte, e
-- não depende de `kit_excecoes` já estar carregada. MATCH e NAO_CATALOGADA não são do kit.
-- RLS ligado e nenhuma política: só o Worker lê, com a chave secreta.
create table public.exceptions (
  code text not null,
  name text not null,
  description text not null,
  constraint exceptions_pkey primary key (code)
);
alter table public.exceptions enable row level security;

insert into public.exceptions (code, name, description) values
  ('E1', 'Falta física', 'Falta física: o item veio na nota, mas não chegou na doca'),
  ('E2', 'Item trocado', 'Item trocado: a nota traz um item que não está na ordem, no lugar de um que está'),
  ('E3', 'Quantidade menor', 'Quantidade menor: chegou menos do que a nota cobra'),
  ('E4', 'Unidade de medida', 'Unidade de medida: ordem em unidade, nota em caixa; o preço unitário parece divergir cerca de 300%'),
  ('E5', 'Nota sem ordem', 'Nota sem ordem: ninguém sabe quem comprou'),
  ('E6', 'Duplicidade', 'Duplicidade: a mesma compra aparece em duas notas ou dois boletos'),
  ('E7', 'Pago fora do fluxo', 'Pago fora do fluxo: compra emergencial da loja, recebida e paga antes de a nota chegar'),
  ('E8', 'Item sem cadastro', 'Item sem cadastro: a ordem travou, a mercadoria entrou sob pressão comercial e a nota não integra no ERP'),
  ('NAO_CATALOGADA', 'Divergência não catalogada', 'Divergência que não cabe em nenhuma das oito exceções catalogadas'),
  ('MATCH', 'Confere', 'A nota bate com a ordem, exatamente ou dentro da tolerância');

-- As colunas de classificação passam a apontar para a referência. As chaves entram `not valid`: valem
-- para toda linha nova e não derrubam a migração por linha antiga fora dos dez códigos. Depois de
-- conferir (select classification from <tabela> where classification not in (select code from
-- public.exceptions)), `alter table ... validate constraint ...`.
alter table public.invoices
  add constraint invoices_classification_fkey foreign key (classification) references public.exceptions (code) not valid;
alter table public.divergences
  add constraint divergences_classification_fkey foreign key (classification) references public.exceptions (code) not valid;
alter table public.proposals
  add constraint proposals_classification_fkey foreign key (classification) references public.exceptions (code) not valid;
