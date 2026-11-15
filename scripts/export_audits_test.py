"""Testes offline da exportação das auditorias para o eval do auditor (#240).

Sem rede: a leitura entra por uma função injetada. O formato de saída é conferido rodando o
próprio eval/auditor.py sobre o arquivo exportado.
"""
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from typing import Any

import export_audits as ea

# Any: o JSON das linhas só tem forma conhecida em tempo de execução (#240).
Json = Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDITOR = os.path.join(ROOT, "eval", "auditor.py")
SCRIPT = os.path.join(ROOT, "scripts", "export_audits.py")
MAKEFILE = os.path.join(ROOT, "Makefile")
KEY_A, KEY_B, KEY_C, KEY_D = "A" * 44, "B" * 44, "C" * 44, "D" * 44


def audited(key: str, row_id: int = 1, **over: Json) -> dict[str, Json]:
    row: dict[str, Json] = {
        "id": row_id, "invoice_access_key": key, "status": "audited", "reason": None,
        "classification": "E6", "dock_action": {"kind": "recusar"}, "routing": "analista",
        "justification": "duplicada", "amount_at_risk_cents": 12345, "model": "claude-x",
        "audited_at": "2026-11-16T10:00:00+00:00", "differing_fields": ["routing"],
        "requested_level": None, "requested_from_level": None, "injection_flag": None, "refusals": [],
    }
    row.update(over)
    return row


def not_audited(key: str, row_id: int = 2, reason: str = "claude_falhou") -> dict[str, Json]:
    return {
        "id": row_id, "invoice_access_key": key, "status": "nao_auditada", "reason": reason,
        "classification": None, "dock_action": None, "routing": None, "justification": None,
        "amount_at_risk_cents": None, "model": None, "audited_at": None, "differing_fields": None,
        "requested_level": None, "requested_from_level": None, "injection_flag": None, "refusals": [],
    }


def proposal(key: str, classification: str = "E1", kind: str = "receber_parcial",
             level: str = "regra") -> dict[str, Json]:
    return {"invoice_access_key": key, "classification": classification,
            "dock_action": {"kind": kind}, "approval_level": level}


class FakeReader:
    """Leitura injetada: guarda cada tabela pedida e devolve as linhas combinadas."""

    def __init__(self, tables: dict[str, list[dict[str, Json]]]) -> None:
        self.tables = tables
        self.calls: list[str] = []

    def __call__(self, table: str, order: str) -> list[dict[str, Json]]:
        self.calls.append(table)
        return list(self.tables[table])


class CurrentReadingTest(unittest.TestCase):
    def test_audited_row_wins_over_a_later_attempt(self) -> None:
        """#240/AC-1: a leitura corrente é a auditoria feita, mesmo com tentativa de id maior."""
        rows = [not_audited(KEY_A, row_id=9), audited(KEY_A, row_id=3)]
        self.assertEqual(ea.current_reading(rows)[KEY_A]["status"], "audited")

    def test_most_recent_attempt_when_none_audited(self) -> None:
        """#240/AC-3: sem auditoria feita, vale a tentativa mais recente."""
        rows = [not_audited(KEY_A, 1, "erro_de_tool"), not_audited(KEY_A, 5, "claude_falhou")]
        self.assertEqual(ea.current_reading(rows)[KEY_A]["reason"], "claude_falhou")


class BuildLinesTest(unittest.TestCase):
    def test_audited_note_goes_in_the_eval_input_format(self) -> None:
        """#240/AC-1: uma linha por nota auditada, nos campos do eval/auditor.py."""
        refusal = {"refusal": "routing_below_regua"}
        audits = [audited(KEY_A, refusals=[refusal])]
        lines = ea.build_lines(audits, [proposal(KEY_A, "E1", "receber_parcial", "analista")])
        self.assertEqual(lines, [{
            "invoice_access_key": KEY_A, "classification": "E6", "dock_action": "recusar",
            "routing": "analista", "justification": "duplicada", "amount_at_risk": {"cents": 12345},
            "model": "claude-x", "audited_at": "2026-11-16T10:00:00+00:00",
            "rule": {"classification": "E1", "dock_action": "receber_parcial", "routing": "analista"},
            "refusals": [refusal],
        }])

    def test_null_amount_stays_null(self) -> None:
        """#240/AC-1: sem valor em risco, amount_at_risk sai null."""
        lines = ea.build_lines([audited(KEY_A, amount_at_risk_cents=None)], [proposal(KEY_A)])
        self.assertIsNone(lines[0]["amount_at_risk"])

    def test_zero_amount_is_a_value_not_null(self) -> None:
        """#240/AC-1: zero centavos é valor, não ausência."""
        lines = ea.build_lines([audited(KEY_A, amount_at_risk_cents=0)], [proposal(KEY_A)])
        self.assertEqual(lines[0]["amount_at_risk"], {"cents": 0})

    def test_rule_routing_is_the_level_the_proposal_had_when_read(self) -> None:
        """#240/AC-1: se o auditor subiu o nível, a regra é o nível de antes (requested_from_level)."""
        audits = [audited(KEY_A, requested_level="coordenacao", requested_from_level="regra")]
        lines = ea.build_lines(audits, [proposal(KEY_A, level="coordenacao")])
        self.assertEqual(lines[0]["rule"]["routing"], "regra")

    def test_not_audited_note_goes_with_reason_and_rule(self) -> None:
        """#240/AC-3: nota 'não auditada' sai com not_audited.reason e a rule."""
        lines = ea.build_lines([not_audited(KEY_B, reason="sem_auditoria")], [proposal(KEY_B, "E2", "recusar", "diretoria")])
        self.assertEqual(lines, [{
            "invoice_access_key": KEY_B, "not_audited": {"reason": "sem_auditoria"},
            "rule": {"classification": "E2", "dock_action": "recusar", "routing": "diretoria"},
            "refusals": [],
        }])

    def test_note_without_audit_row_is_left_out(self) -> None:
        """#240/AC-3: nota só com proposta, sem linha de auditoria, fica fora do arquivo."""
        lines = ea.build_lines([audited(KEY_A)], [proposal(KEY_A), proposal(KEY_C)])
        self.assertEqual([x["invoice_access_key"] for x in lines], [KEY_A])

    def test_audit_without_proposal_is_an_error_naming_the_field_only(self) -> None:
        """#240/AC-1: a rule é obrigatória no eval; auditoria sem proposta para o export, sem eco da linha."""
        with self.assertRaises(ea.ExportError) as caught:
            ea.build_lines([audited(KEY_A)], [])
        self.assertNotIn(KEY_A, ea.describe(caught.exception))
        self.assertIn("proposta", ea.describe(caught.exception))

    def test_one_line_per_note_sorted_by_key(self) -> None:
        """#240/AC-1: uma linha por nota, em ordem estável."""
        audits = [audited(KEY_B, 4), not_audited(KEY_B, 7), audited(KEY_A, 2), not_audited(KEY_D, 1)]
        proposals = [proposal(k) for k in (KEY_D, KEY_B, KEY_A)]
        lines = ea.build_lines(audits, proposals)
        self.assertEqual([x["invoice_access_key"] for x in lines], [KEY_A, KEY_B, KEY_D])


class ExportReadsOnlyAuditAndProposalTest(unittest.TestCase):
    def test_export_reaches_only_the_two_tables(self) -> None:
        """#240/AC-2: a exportação lê invoice_audits e proposals, e só essas."""
        reader = FakeReader({"invoice_audits": [audited(KEY_A)], "proposals": [proposal(KEY_A)]})
        lines = ea.export(reader)
        self.assertEqual(sorted(reader.calls), ["invoice_audits", "proposals"])
        self.assertEqual(len(lines), 1)

    def test_client_refuses_any_other_table(self) -> None:
        """#240/AC-2: o cliente só conhece as duas tabelas da auditoria e da proposta."""
        client = ea.Reader("https://exemplo.invalid", "chave-de-teste")
        with self.assertRaises(ea.ExportError):
            client.read_all("kit_notas", "id")

    def test_source_is_get_only_and_never_names_the_answer_key(self) -> None:
        """#240/AC-2: o código só faz GET e não referencia o gabarito."""
        with open(SCRIPT, encoding="utf-8") as f:
            source = f.read()
        self.assertNotIn("gabarito", source.lower())
        self.assertEqual(set(re.findall(r'method="(\w+)"', source)), {"GET"})
        for verb in ("POST", "PATCH", "DELETE", "PUT"):
            self.assertNotRegex(source, rf"\b{verb}\b")

    def test_missing_credentials_name_the_variables_only(self) -> None:
        """#240/AC-2: sem credenciais, o erro nomeia as variáveis e não imprime valor."""
        with self.assertRaises(ea.ExportError) as caught:
            ea.reader_from_env({})
        self.assertIn(ea.URL_VAR, ea.describe(caught.exception))
        self.assertIn(ea.KEY_VAR, ea.describe(caught.exception))


class EvalAcceptsTheExportTest(unittest.TestCase):
    def test_auditor_eval_accepts_the_exported_file(self) -> None:
        """#240/AC-1 e AC-3: o eval/auditor.py roda sobre o arquivo; sem auditoria e não auditada contam como erro."""
        reader = FakeReader({
            "invoice_audits": [audited(KEY_A, classification="match", amount_at_risk_cents=None), not_audited(KEY_B)],
            "proposals": [proposal(KEY_A, "MATCH", "receber", "regra"), proposal(KEY_B), proposal(KEY_C)],
        })
        key = [
            {"chave": k, "classificacao": c, "acao_doca": "receber", "encaminhamento": "regra"}  # ADR-001
            for k, c in ((KEY_A, "match"), (KEY_B, "E1"), (KEY_C, "E1"))
        ]
        with tempfile.TemporaryDirectory() as tmp:
            audits_file = os.path.join(tmp, "auditorias.jsonl")
            key_file = os.path.join(tmp, "gabarito-teste.json")
            with open(key_file, "w", encoding="utf-8") as f:
                json.dump(key, f)
            ea.write_jsonl(audits_file, ea.export(reader))
            done = subprocess.run(
                [sys.executable, AUDITOR, audits_file, "--answer-key", key_file, "--runs-dir", os.path.join(tmp, "rodadas")],
                capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        run = json.loads(done.stdout)
        reasons = {e["invoice_access_key"]: e["reason"] for e in run["errors"]}
        self.assertEqual(reasons[KEY_B], "não auditada: claude_falhou")
        self.assertEqual(reasons[KEY_C], "sem auditoria")

    def test_main_writes_the_file_with_a_fake_reader(self) -> None:
        """#240/AC-1: main grava o arquivo e imprime só contagens."""
        reader = FakeReader({"invoice_audits": [audited(KEY_A)], "proposals": [proposal(KEY_A)]})
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(out):
            path = os.path.join(tmp, "saidas", "auditorias.jsonl")
            self.assertEqual(ea.main([path], reader=reader), 0)
            with open(path, encoding="utf-8") as f:
                self.assertEqual(len(f.read().splitlines()), 1)
        self.assertNotIn(KEY_A, out.getvalue())


class PaginationTest(unittest.TestCase):
    def test_short_pages_are_all_read_until_an_empty_page(self) -> None:
        """#240/AC-1: com max_rows do servidor menor que a página, nenhuma linha é descartada."""
        data = [{"id": i} for i in range(7)]
        starts: list[int] = []

        class ShortPages(ea.Reader):
            def _get(self, path: str, start: int) -> tuple[int, bytes]:
                starts.append(start)
                return 200, json.dumps(data[start:start + 3]).encode()

        rows = ShortPages("https://exemplo.invalid", "chave-de-teste").read_all("invoice_audits", "id")
        self.assertEqual(rows, data)
        self.assertEqual(starts, [0, 3, 6, 7])


class MakeTargetTest(unittest.TestCase):
    def test_make_eval_exports_then_runs_the_eval(self) -> None:
        """#240/AC-1: `make eval` é um comando só: exporta e roda o eval sobre o arquivo exportado."""
        done = subprocess.run(["make", "-n", "-C", ROOT, "eval"], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        commands = [x for x in done.stdout.splitlines() if x.strip()]
        export_at = next(i for i, c in enumerate(commands) if "scripts/export_audits.py" in c)
        eval_at = next(i for i, c in enumerate(commands) if "eval/auditor.py" in c)
        self.assertLess(export_at, eval_at)
        path = re.search(r"(eval/saidas/\S+\.jsonl)", commands[export_at])
        assert path
        self.assertIn(path.group(1), commands[eval_at])

    def test_eval_is_declared_phony(self) -> None:
        """#240/AC-1: eval entra no .PHONY, porque existe a pasta eval/."""
        with open(MAKEFILE, encoding="utf-8") as f:
            first = f.readline()
        self.assertRegex(first, r"^\.PHONY:.*\beval\b")


if __name__ == "__main__":
    unittest.main()
