-- #351 Modo demonstração (épico #347): a delegação do analista liga com o modo e, desligado o modo, volta ao valor de
-- #351 antes. Esta coluna guarda esse valor enquanto o modo está ligado; nula com o modo desligado.
-- #351 RLS continua ligado e sem política: só a chave secreta (o Worker) lê e grava.

alter table public.engine_settings
  add column if not exists delegation_before_demo boolean;

alter table public.engine_settings enable row level security;
