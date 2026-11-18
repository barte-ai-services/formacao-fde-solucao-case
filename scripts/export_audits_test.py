"""Testes offline da exportação das auditorias para o eval do auditor (#240).

Sem rede: a leitura entra por uma função injetada. O formato de saída é conferido rodando o
próprio eval/auditor.py sobre o arquivo exportado.
"""
import contextlib
import http.client
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import urllib.response
from typing import Any
from unittest import mock

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


    def test_non_https_url_is_refused_before_any_request(self) -> None:
        """#264/AC-2: http:// é recusado antes de qualquer pedido."""
        with mock.patch.object(ea._OPENER, "open") as opened:
            with self.assertRaises(ea.ExportError) as caught:
                ea.reader_from_env({ea.URL_VAR: "http://exemplo.invalid", ea.KEY_VAR: TEST_KEY})
        self.assertEqual(caught.exception.operation, "config_scheme")
        self.assertNotIn(TEST_KEY, ea.describe(caught.exception))
        opened.assert_not_called()


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


TEST_KEY = "chave-de-teste-secreta"


def reader_with(get: Any = None) -> ea.Reader:
    """Um Reader de teste; `get` troca o _get, para a página vir de onde o teste quiser."""
    reader = ea.Reader("https://exemplo.invalid", TEST_KEY)
    if get is not None:
        reader._get = get  # type: ignore[method-assign]
    return reader


class ReadFailureTest(unittest.TestCase):
    def test_refused_read_names_operation_table_and_status_only(self) -> None:
        """#240/AC-2: a recusa do banco vira ExportError read/invoice_audits/403, sem o corpo nem a chave."""
        reader = reader_with(lambda path, start: (403, b'{"message":"segredo"}'))
        with self.assertRaises(ea.ExportError) as caught:
            reader.read_all("invoice_audits", "id")
        error = caught.exception
        self.assertEqual((error.operation, error.table, error.status), ("read", "invoice_audits", 403))
        self.assertNotIn("segredo", ea.describe(error))
        self.assertNotIn(TEST_KEY, ea.describe(error))
        self.assertNotIn("segredo", str(error))

    def test_http_error_from_the_network_layer_becomes_a_read_error(self) -> None:
        """#240/AC-2: HTTPError 401 do urllib vira ExportError read com o status."""
        failure = urllib.error.HTTPError("https://exemplo.invalid", 401, "x", {}, None)  # type: ignore[arg-type]
        with mock.patch.object(ea._OPENER, "open", side_effect=failure):
            with self.assertRaises(ea.ExportError) as caught:
                reader_with().read_all("invoice_audits", "id")
        self.assertEqual((caught.exception.operation, caught.exception.status), ("read", 401))
        self.assertNotIn(TEST_KEY, ea.describe(caught.exception))

    def test_unreachable_server_becomes_a_network_error(self) -> None:
        """#240/AC-2: URLError vira ExportError network, sem o texto do erro."""
        with mock.patch.object(ea._OPENER, "open", side_effect=urllib.error.URLError("segredo")):
            with self.assertRaises(ea.ExportError) as caught:
                reader_with().read_all("invoice_audits", "id")
        self.assertEqual(caught.exception.operation, "network")
        self.assertNotIn("segredo", ea.describe(caught.exception))

    def test_redirect_becomes_a_read_error_without_a_second_request(self) -> None:
        """#264/AC-1: um 302 vira ExportError read com o status e o segundo pedido não é aberto."""
        opened: list[str] = []

        class Seen(urllib.request.BaseHandler):
            handler_order = 100

            def http_open(self, request: urllib.request.Request) -> Any:
                opened.append(request.full_url)
                headers = http.client.HTTPMessage()
                headers["Location"] = "http://outro.invalid/rest/v1/x"
                response = urllib.response.addinfourl(io.BytesIO(b""), headers, request.full_url, 302)
                response.msg = "Found"  # type: ignore[attr-defined]
                return response

            https_open = http_open

        opener = urllib.request.build_opener(ea._NoRedirect, Seen)
        with mock.patch.object(ea, "_OPENER", opener):
            with self.assertRaises(ea.ExportError) as caught:
                reader_with().read_all("invoice_audits", "id")
        self.assertEqual((caught.exception.operation, caught.exception.status), ("read", 302))
        self.assertEqual(len(opened), 1)
        self.assertNotIn(TEST_KEY, ea.describe(caught.exception))

    def test_timeout_becomes_a_network_error(self) -> None:
        """#264/AC-3: TimeoutError (OSError) vira ExportError network, sem o texto do erro."""
        with mock.patch.object(ea._OPENER, "open", side_effect=TimeoutError("segredo")):
            with self.assertRaises(ea.ExportError) as caught:
                reader_with().read_all("invoice_audits", "id")
        self.assertEqual(caught.exception.operation, "network")
        self.assertNotIn("segredo", ea.describe(caught.exception))

    def test_http_protocol_error_becomes_a_network_error(self) -> None:
        """#264/AC-3: HTTPException vira ExportError network."""
        with mock.patch.object(ea._OPENER, "open", side_effect=http.client.IncompleteRead(b"x")):
            with self.assertRaises(ea.ExportError) as caught:
                reader_with().read_all("invoice_audits", "id")
        self.assertEqual(caught.exception.operation, "network")

    def test_body_that_is_not_json_becomes_a_payload_error(self) -> None:
        """#264/AC-3: um 200 com HTML vira ExportError payload, sem o corpo."""
        with self.assertRaises(ea.ExportError) as caught:
            reader_with(lambda path, start: (200, b"<html>segredo")).read_all("invoice_audits", "id")
        self.assertEqual((caught.exception.operation, caught.exception.table), ("payload", "invoice_audits"))
        self.assertNotIn("segredo", ea.describe(caught.exception))

    def test_main_prints_the_fixed_line_and_writes_no_file(self) -> None:
        """#240/AC-2: falha de leitura sai com 1, a linha fixa em stderr e nenhum arquivo."""
        def failing(table: str, order: str) -> list[dict[str, Json]]:
            raise ea.ExportError("read", "proposals", 500)

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "auditorias.jsonl")
            err, out = io.StringIO(), io.StringIO()
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
                code = ea.main([path], reader=failing)
            self.assertFalse(os.path.exists(path))
        self.assertEqual(code, 1)
        self.assertEqual(err.getvalue(), "erro: falha ao ler, tabela proposals, HTTP 500\n")
        self.assertEqual(out.getvalue(), "")


class RunawayPaginationTest(unittest.TestCase):
    def test_page_larger_than_the_range_asked_stops_the_read(self) -> None:
        """#240/AC-2: servidor que ignora o Range e devolve mais que a página pedida: erro nomeado, sem eco."""
        big = [{"id": i, "texto": "segredo"} for i in range(ea.PAGE_SIZE + 1)]
        reader = reader_with(lambda path, start: (200, json.dumps(big).encode()))
        with self.assertRaises(ea.ExportError) as caught:
            reader.read_all("invoice_audits", "id")
        self.assertEqual((caught.exception.operation, caught.exception.table), ("pagination", "invoice_audits"))
        self.assertNotIn("segredo", ea.describe(caught.exception))

    def test_same_full_page_repeated_stops_the_read(self) -> None:
        """#240/AC-2: a mesma página cheia duas vezes seguidas (Range ignorado) para a leitura, sem laço."""
        full = [{"id": i} for i in range(ea.PAGE_SIZE)]
        calls: list[int] = []

        def same(path: str, start: int) -> tuple[int, bytes]:
            calls.append(start)
            return 200, json.dumps(full).encode()

        with self.assertRaises(ea.ExportError) as caught:
            reader_with(same).read_all("proposals", "id")
        self.assertEqual(caught.exception.operation, "pagination")
        self.assertEqual(len(calls), 2)


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
