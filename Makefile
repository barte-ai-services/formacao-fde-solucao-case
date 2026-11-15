.PHONY: check

BPMN := docs/processo/processo-atual.bpmn docs/processo/processo-alvo.bpmn

# Os testes online da base do kit (scripts/kit_online_test.py, #52) pulam sem as credenciais do Supabase.
check:
	@python3 scripts/validar_bpmn.py $(BPMN)
	@python3 -m unittest discover -s scripts -p '*_test.py'
	@npm --prefix api ci --no-audit --no-fund --loglevel=error
	@npm --prefix api run typecheck
	@npm --prefix api test
