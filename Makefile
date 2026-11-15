.PHONY: check eval

BPMN := docs/processo/processo-atual.bpmn docs/processo/processo-alvo.bpmn

# O web/ instala os kits do GitHub Packages, que pedem token até para ler (#60). Local, o do `gh`;
# na esteira, o GITHUB_TOKEN que o workflow exporta.
export NODE_AUTH_TOKEN ?= $(shell gh auth token 2>/dev/null)

# Os testes online da base do kit (scripts/kit_online_test.py, #52) pulam sem as credenciais do Supabase.
check:
	@python3 scripts/validar_bpmn.py $(BPMN)
	@python3 -m unittest discover -s scripts -p '*_test.py'
	@python3 -m unittest discover -s eval -p '*_test.py'
	@npm --prefix api ci --no-audit --no-fund --loglevel=error
	@npm --prefix api run typecheck
	@npm --prefix api test
	@npm --prefix web ci --no-audit --no-fund --loglevel=error
	@npm --prefix web run typecheck
	@npm --prefix web test
	@npm --prefix web run build

# O eval do auditor (#240): exporta as auditorias e as propostas da regra do banco (só leitura; lê
# BARTE_ACADEMY_SUPABASE_URL e BARTE_ACADEMY_SUPABASE_SECRET_KEY do ambiente ou do .env na raiz) e mede o resultado.
EVAL_AUDITORIAS := eval/saidas/auditorias.jsonl
eval:
	@python3 scripts/export_audits.py $(EVAL_AUDITORIAS)
	@python3 eval/auditor.py $(EVAL_AUDITORIAS) --format md
