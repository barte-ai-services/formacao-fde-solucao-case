-- #128 Valida as três chaves estrangeiras de classification, criadas `not valid` em
-- 20261115220000_exceptions_reference.sql. A consulta de órfãos rodou na produção e não achou nenhum
-- (80 invoices, 82 divergences, 80 proposals só com códigos de public.exceptions).
alter table public.invoices validate constraint invoices_classification_fkey;
alter table public.divergences validate constraint divergences_classification_fkey;
alter table public.proposals validate constraint proposals_classification_fkey;
