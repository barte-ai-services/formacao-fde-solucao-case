.PHONY: check

BPMN := docs/processo/processo-atual.bpmn docs/processo/processo-alvo.bpmn

check:
	@python3 scripts/validar_bpmn.py $(BPMN)
	@python3 -m unittest discover -s scripts -p '*_test.py'
