"""Testes do eval do auditor (#239), com um gabarito mínimo e sem ler o do kit."""
import contextlib
import errno
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import auditor

# Json e Record: o que vem do JSONL ou do gabarito só tem forma conhecida em execução, por isso `Any` (#239).
Json = Any
Record = dict[str, Json]

ROOT = Path(__file__).resolve().parent.parent

ANSWER_KEY = [
    {"nota_id": "N1", "chave": "K1", "classificacao": "match", "acao_doca": "receber", "encaminhamento": "regra"},  # ADR-001
    {"nota_id": "N2", "chave": "K2", "classificacao": "E6", "acao_doca": "recusar", "encaminhamento": "bloqueio"},  # ADR-001
    {"nota_id": "N3", "chave": "K3", "classificacao": "E4", "acao_doca": "receber_parcial", "encaminhamento": "analista"},  # ADR-001
]

BAD_RULE = {"classification": "MATCH", "dock_action": "receber", "routing": "regra"}


def audit_line(key: str, cls: str, action: str, routing: str, **extra: Json) -> Record:
    base = {
        "invoice_access_key": key,
        "classification": cls,
        "dock_action": action,
        "routing": routing,
        "justification": "porque sim",
        "amount_at_risk": None,
        "model": "modelo-a",
        "audited_at": "2026-11-15T10:00:00Z",
        "rule": BAD_RULE,
    }
    base.update(extra)
    return base


def all_correct() -> list[Record]:
    return [
        audit_line("K1", "MATCH", "receber", "regra"),
        audit_line("K2", "E6", "recusar", "bloqueio"),
        audit_line("K3", "E4", "receber_parcial", "analista"),
    ]


NOW = datetime(2026, 11, 15, 12, 0, 0, tzinfo=timezone.utc)


def run_cli(argv: list[str], now: datetime = NOW) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = auditor.main(argv, now=lambda: now)
    return code, out.getvalue(), err.getvalue()


class MeasurementTest(unittest.TestCase):
    def measure(self, lines: list[Record], answer_key: list[Record] | None = None) -> Record:
        return auditor.measure(lines, ANSWER_KEY if answer_key is None else answer_key)

    def test_ac1_returns_every_report_field(self) -> None:
        """#239/AC-1: o relatório traz os campos do contrato."""
        r = self.measure(all_correct())
        for field in ("model", "prompt_version", "full_match_rate", "by_field", "by_exception",
                      "routing_below_regua", "first_try_routing_rate", "errors", "vs_baseline"):
            self.assertIn(field, r)
        self.assertEqual(r["model"], "modelo-a")
        self.assertIsNone(r["prompt_version"])
        self.assertEqual(r["full_match_rate"], 1.0)
        self.assertEqual(r["by_field"], {"classification": 1.0, "dock_action": 1.0, "routing": 1.0})
        self.assertEqual(r["by_exception"]["E6"], {"total": 1, "classification": 1, "dock_action": 1, "routing": 1, "full": 1})
        self.assertEqual(r["by_exception"]["E1"]["total"], 0)
        self.assertEqual(r["errors"], [])

    def test_ac1_denominator_is_the_80_answer_key_notes(self) -> None:
        """#239/AC-1: a taxa é sobre todas as notas do gabarito."""
        key_data = [{"nota_id": f"N{i}", "chave": f"K{i}", "classificacao": "match", "acao_doca": "receber",  # ADR-001
                "encaminhamento": "regra"} for i in range(80)]
        lines = [audit_line(f"K{i}", "MATCH", "receber", "regra") for i in range(20)]
        r = self.measure(lines, key_data)
        self.assertEqual(r["notes_total"], 80)
        self.assertEqual(r["full_match_rate"], 0.25)
        self.assertEqual(len(r["errors"]), 60)

    def test_ac1_hit_rate_per_field_and_distinct_models_sorted(self) -> None:
        """#239/AC-1: acerto por campo, e model/prompt_version distintos saem ordenados."""
        lines = all_correct()
        lines[2] = audit_line("K3", "E1", "receber_parcial", "diretoria", model="modelo-b", prompt_version="v2")
        lines[0]["prompt_version"] = "v1"
        r = self.measure(lines)
        self.assertEqual(r["model"], ["modelo-a", "modelo-b"])
        self.assertEqual(r["prompt_version"], ["v1", "v2"])
        self.assertAlmostEqual(r["by_field"]["classification"], 2 / 3)
        self.assertAlmostEqual(r["by_field"]["dock_action"], 1.0)
        self.assertAlmostEqual(r["by_field"]["routing"], 2 / 3)
        self.assertAlmostEqual(r["full_match_rate"], 2 / 3)
        self.assertEqual(r["by_exception"]["E4"]["full"], 0)
        self.assertEqual(r["by_exception"]["E4"]["dock_action"], 1)

    def test_ac1_missing_not_audited_and_unknown_key(self) -> None:
        """#239/AC-1: faltante e não auditada são erro; chave fora do gabarito não muda o denominador."""
        lines = [
            audit_line("K1", "MATCH", "receber", "regra"),
            audit_line("K3", "E4", "receber_parcial", "analista", not_audited={"reason": "sem XML"}),
            audit_line("KX", "E1", "recusar", "bloqueio"),
        ]
        r = self.measure(lines)
        self.assertEqual(r["notes_total"], 3)
        self.assertAlmostEqual(r["full_match_rate"], 1 / 3)
        by_key = {e["invoice_access_key"]: e["reason"] for e in r["errors"]}
        self.assertEqual(by_key["K2"], "sem auditoria")
        self.assertEqual(by_key["K3"], "não auditada: sem XML")
        self.assertIn("KX", by_key)
        self.assertEqual(r["by_exception"]["E4"]["full"], 0)

    def test_ac1_uncatalogued_never_hits_and_last_line_wins(self) -> None:
        """#239/AC-1: NAO_CATALOGADA erra; a mesma chave duas vezes vale a última."""
        lines = all_correct() + [audit_line("K1", "NAO_CATALOGADA", "receber", "regra")]
        r = self.measure(auditor.deduplicate(lines))
        self.assertEqual(r["by_exception"]["match"]["classification"], 0)
        self.assertEqual(r["by_exception"]["match"]["full"], 0)

    def test_ac5_vs_baseline_per_exception_agent_against_rule(self) -> None:
        """#239/AC-5: por exceção, o acerto do agente contra o da regra sem IA."""
        r = self.measure(all_correct())
        vb = r["vs_baseline"]
        self.assertEqual(vb["by_exception"]["match"]["agent_full"], 1.0)
        self.assertEqual(vb["by_exception"]["match"]["rule_full"], 1.0)
        self.assertEqual(vb["by_exception"]["E6"]["agent_full"], 1.0)
        self.assertEqual(vb["by_exception"]["E6"]["rule_full"], 0.0)
        self.assertEqual(vb["by_exception"]["E6"]["agent_classification"], 1.0)
        self.assertEqual(vb["by_exception"]["E6"]["rule_classification"], 0.0)
        self.assertIsNone(vb["by_exception"]["E1"]["agent_full"])
        self.assertAlmostEqual(vb["total"]["agent_full"], 1.0)
        self.assertAlmostEqual(vb["total"]["rule_full"], 1 / 3)

    def test_note_without_rule_is_left_out_of_the_rule_comparison(self) -> None:
        """#262/AC-2: sem `rule`, a nota sai da comparação com a regra nos dois lados e é contada; o agente não muda."""
        with_rule = self.measure(all_correct())
        lines = all_correct()
        del lines[1]["rule"]  # K2, a E6: a regra errava essa nota (#262)
        r = self.measure(lines)
        self.assertEqual(r["notes_without_rule"], 1)
        self.assertEqual(with_rule["notes_without_rule"], 0)
        self.assertEqual(r["full_match_rate"], with_rule["full_match_rate"])
        self.assertEqual(r["by_exception"], with_rule["by_exception"])
        vb = r["vs_baseline"]
        self.assertIsNone(vb["by_exception"]["E6"]["agent_full"])
        self.assertIsNone(vb["by_exception"]["E6"]["rule_full"])
        self.assertEqual(vb["total"]["agent_full"], 1.0)
        self.assertAlmostEqual(vb["total"]["rule_full"], 1 / 2)

    def test_note_without_rule_is_not_an_error_and_counts_in_the_report(self) -> None:
        """#262/AC-2: a nota sem `rule` não entra em errors[]; o Markdown diz quantas ficaram fora da comparação."""
        lines = all_correct()
        del lines[0]["rule"]
        r = self.measure(lines)
        self.assertEqual(r["errors"], [])
        r["run_id"] = "x"
        self.assertIn("1 nota(s) sem `rule`", auditor.markdown_report(r, None))

    def test_rule_null_counts_as_missing(self) -> None:
        """#262/AC-2: `rule: null` vale como ausente."""
        lines = all_correct()
        lines[0]["rule"] = None
        self.assertEqual(self.measure(lines)["notes_without_rule"], 1)

    def test_ac6_without_refusals_in_file_metrics_are_not_measured(self) -> None:
        """#239/AC-6: sem `refusals` no arquivo, as duas métricas são null, nunca 0."""
        r = self.measure(all_correct())
        self.assertIsNone(r["routing_below_regua"])
        self.assertIsNone(r["first_try_routing_rate"])
        self.assertIn("não medido", auditor.markdown_report(dict(r, run_id="x"), None))

    def test_ac6_with_refusals_counts_below_regua_and_first_try(self) -> None:
        """#239/AC-6: com `refusals`, contam as recusas de alçada e as linhas sem recusa."""
        lines = all_correct()
        lines[0]["refusals"] = []
        lines[1]["refusals"] = [{"refusal": "routing_below_regua"}, {"refusal": "invalid_field"}]
        lines[2]["refusals"] = [{"refusal": "routing_below_regua"}]
        r = self.measure(lines)
        self.assertEqual(r["routing_below_regua"], 2)
        self.assertAlmostEqual(r["first_try_routing_rate"], 1 / 3)

    def test_ac6_invalid_field_refusal_does_not_count_against_first_try(self) -> None:
        """#239/AC-6: só `routing_below_regua` tira o encaminhamento de primeira; `invalid_field` não."""
        lines = all_correct()
        for item in lines:
            item["refusals"] = [{"refusal": "invalid_field"}]
        r = self.measure(lines)
        self.assertEqual(r["routing_below_regua"], 0)
        self.assertEqual(r["first_try_routing_rate"], 1.0)

    def test_ac6_lines_outside_the_answer_key_enter_neither_metric(self) -> None:
        """#239/AC-6: linha de chave fora do gabarito não entra em nenhuma das duas métricas."""
        lines = all_correct()
        lines[0]["refusals"] = []
        lines.append(audit_line("KX", "E1", "recusar", "bloqueio", refusals=[{"refusal": "routing_below_regua"}]))
        r = self.measure(lines)
        self.assertEqual(r["routing_below_regua"], 0)
        self.assertEqual(r["first_try_routing_rate"], 1.0)

    def test_ac6_not_audited_notes_are_outside_the_first_try_denominator(self) -> None:
        """#239/AC-6: nota não auditada ou sem linha não entra no denominador do encaminhamento de primeira."""
        lines = all_correct()[:2]
        lines[0]["refusals"] = [{"refusal": "routing_below_regua"}]
        lines[1] = audit_line("K2", "E6", "recusar", "bloqueio", not_audited={"reason": "x"},
                              refusals=[{"refusal": "routing_below_regua"}])
        r = self.measure(lines)
        self.assertEqual(r["routing_below_regua"], 1)
        self.assertEqual(r["first_try_routing_rate"], 0.0)

    def test_ac6_a_refusal_on_a_line_outside_the_key_still_means_measured(self) -> None:
        """#239/AC-6: `refusals` em qualquer linha do arquivo basta para as métricas serem medidas."""
        lines = all_correct()
        lines.append(audit_line("KX", "E1", "recusar", "bloqueio", refusals=[]))
        r = self.measure(lines)
        self.assertEqual(r["routing_below_regua"], 0)
        self.assertEqual(r["first_try_routing_rate"], 1.0)

    def test_ac4_missed_e6_blocks_and_correct_e6_does_not(self) -> None:
        """#239/AC-4: E6 do gabarito não classificada E6 (inclusive ausente ou não auditada) barra."""
        self.assertFalse(auditor.e6_missed(self.measure(all_correct())))
        wrong = all_correct()
        wrong[1] = audit_line("K2", "E1", "recusar", "bloqueio")
        self.assertTrue(auditor.e6_missed(self.measure(wrong)))
        self.assertTrue(auditor.e6_missed(self.measure([all_correct()[0]])))
        not_audited_lines = all_correct()
        not_audited_lines[1] = audit_line("K2", "E6", "recusar", "bloqueio", not_audited={"reason": "x"})
        self.assertTrue(auditor.e6_missed(self.measure(not_audited_lines)))

    def test_ac3_difference_against_previous_run(self) -> None:
        """#239/AC-3: a diferença traz full_match_rate, por campo e por exceção."""
        previous = self.measure(all_correct())
        worse = all_correct()
        worse[2] = audit_line("K3", "E1", "receber_parcial", "analista")
        current = self.measure(worse)
        d = auditor.difference(current, dict(previous, run_id="antes"))
        self.assertEqual(d["previous_run_id"], "antes")
        self.assertAlmostEqual(d["full_match_rate"], -1 / 3)
        self.assertAlmostEqual(d["by_field"]["classification"], -1 / 3)
        self.assertEqual(d["by_field"]["routing"], 0.0)
        self.assertEqual(d["by_exception"]["E4"], -1.0)
        self.assertIsNone(d["by_exception"]["E1"])

    def test_ac3_run_id_is_deterministic_and_sortable(self) -> None:
        """#239/AC-3: o run_id é timestamp UTC mais hash curto do conteúdo."""
        a = auditor.make_run_id(NOW, b"abc")
        self.assertEqual(a, auditor.make_run_id(NOW, b"abc"))
        self.assertRegex(a, r"^20261115T120000Z-[0-9a-f]{8}$")
        self.assertNotEqual(a, auditor.make_run_id(NOW, b"abd"))
        later_id = auditor.make_run_id(datetime(2026, 11, 16, tzinfo=timezone.utc), b"abc")
        self.assertGreater(later_id, a)


class CommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.folder = Path(self._tmp.name)
        self.answer_key = self.folder / "gabarito.json"
        self.answer_key.write_text(json.dumps(ANSWER_KEY), encoding="utf-8")
        self.runs_dir = self.folder / "rodadas"

    def write_lines(self, lines: list[Record], name: str = "auditorias.jsonl") -> str:
        file = self.folder / name
        file.write_text("\n".join(json.dumps(x) for x in lines) + "\n\n", encoding="utf-8")
        return str(file)

    def run_command(self, lines: list[Record], *extra: str, now: datetime = NOW, name: str = "auditorias.jsonl") -> tuple[int, str, str]:
        argv = [self.write_lines(lines, name), "--answer-key", str(self.answer_key), "--runs-dir", str(self.runs_dir), *extra]
        return run_cli(argv, now)

    def test_ac1_prints_run_json_and_exits_zero(self) -> None:
        """#239/AC-1: por padrão, o comando imprime a rodada em JSON e sai 0."""
        code, out, _ = self.run_command(all_correct())
        self.assertEqual(code, 0)
        run_data = json.loads(out)
        self.assertEqual(run_data["full_match_rate"], 1.0)
        self.assertRegex(run_data["run_id"], r"^20261115T120000Z-[0-9a-f]{8}$")
        self.assertIsNone(run_data["routing_below_regua"])

    def test_ac3_saves_run_and_compares_with_previous(self) -> None:
        """#239/AC-3: grava eval/rodadas/<run_id>.json e mostra a diferença contra a anterior."""
        _, out_one, _ = self.run_command(all_correct())
        first_id = json.loads(out_one)["run_id"]
        self.assertTrue((self.runs_dir / f"{first_id}.json").is_file())
        self.assertNotIn("vs_previous", json.loads(out_one))
        worse = all_correct()
        worse[2] = audit_line("K3", "E1", "receber_parcial", "analista")
        later = datetime(2026, 11, 15, 13, 0, 0, tzinfo=timezone.utc)
        _, out_two, _ = self.run_command(worse, now=later, name="outro.jsonl")
        run_two = json.loads(out_two)
        self.assertEqual(run_two["vs_previous"]["previous_run_id"], first_id)
        self.assertAlmostEqual(run_two["vs_previous"]["full_match_rate"], -1 / 3)
        saved = json.loads((self.runs_dir / f"{run_two['run_id']}.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["run_id"], run_two["run_id"])
        self.assertEqual(len(list(self.runs_dir.glob("*.json"))), 2)

    def test_ac3_markdown_report_shows_difference_and_rule(self) -> None:
        """#239/AC-3 e #239/AC-5: o Markdown traz a diferença e a tabela contra a regra."""
        self.run_command(all_correct())
        later = datetime(2026, 11, 15, 13, 0, 0, tzinfo=timezone.utc)
        code, out, _ = self.run_command(all_correct()[:2], "--format", "md", now=later, name="b.jsonl")
        self.assertEqual(code, 0)
        self.assertIn("## Contra a rodada anterior", out)
        self.assertIn("## Agente contra a regra sem IA", out)
        self.assertIn("| E6 |", out)
        self.assertIn("Erros", out)

    def test_ac4_missed_e6_exits_one_with_the_rest_correct(self) -> None:
        """#239/AC-4: uma E6 perdida faz o comando sair 1, mesmo com todo o resto certo."""
        lines = all_correct()
        lines[1] = audit_line("K2", "E1", "recusar", "bloqueio")
        code, out, err = self.run_command(lines)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["by_field"]["dock_action"], 1.0)
        self.assertIn("E6", err)

    def test_ac1_invalid_input_exits_two(self) -> None:
        """#239/AC-1: arquivo inexistente ou linha que não é JSON é erro de uso: código 2."""
        code, _, err = run_cli(["nao-existe.jsonl", "--answer-key", str(self.answer_key), "--runs-dir", str(self.runs_dir)])
        self.assertEqual(code, 2)
        self.assertTrue(err)
        bad = self.folder / "ruim.jsonl"
        bad.write_text("{nao é json\n", encoding="utf-8")
        code, _, _ = run_cli([str(bad), "--answer-key", str(self.answer_key), "--runs-dir", str(self.runs_dir)])
        self.assertEqual(code, 2)


class MalformedInputTest(unittest.TestCase):
    """O código 1 é só de E6 perdida: toda entrada malformada sai 2, com mensagem fixa, sem eco do objeto."""

    SENTINEL = "SEGREDO-NAO-ECOAR"

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.folder = Path(self._tmp.name)
        self.key_file = self.folder / "gabarito.json"
        self.key_file.write_text(json.dumps(ANSWER_KEY), encoding="utf-8")
        self.runs_dir = self.folder / "rodadas"

    def exit_of(self, lines: list[Record], key_data: Json = None) -> tuple[int, str, str]:
        if key_data is not None:
            self.key_file.write_text(json.dumps(key_data), encoding="utf-8")
        audits = self.folder / "auditorias.jsonl"
        audits.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
        argv = [str(audits), "--answer-key", str(self.key_file), "--runs-dir", str(self.runs_dir)]
        return run_cli(argv)

    def assert_invalid(self, result: tuple[int, str, str]) -> None:
        code, out, err = result
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("erro: "))
        self.assertNotIn(self.SENTINEL, err)
        self.assertNotIn("Traceback", err)

    def with_field(self, **field: Json) -> list[Record]:
        lines = all_correct()
        lines[0].update(field)
        return lines

    def test_ac1_audits_not_utf8_exits_two_with_fixed_message(self) -> None:
        """#239/AC-1: auditorias com byte fora de UTF-8 saem 2, com mensagem fixa."""
        audits = self.folder / "auditorias.jsonl"
        audits.write_bytes(b'{"invoice_access_key": "\xff"}\n')
        argv = [str(audits), "--answer-key", str(self.key_file), "--runs-dir", str(self.runs_dir)]
        result = run_cli(argv)
        self.assert_invalid(result)
        self.assertEqual(result[2], "erro: auditorias não estão em UTF-8\n")

    def test_ac1_not_audited_not_an_object_exits_two(self) -> None:
        """#239/AC-1: `not_audited` que não é objeto sai 2."""
        self.assert_invalid(self.exit_of(self.with_field(not_audited=True)))
        self.assert_invalid(self.exit_of(self.with_field(not_audited=[self.SENTINEL])))

    def test_ac1_not_audited_without_string_reason_exits_two(self) -> None:
        """#239/AC-1: `not_audited` sem `reason` em texto sai 2, sem ecoar o objeto."""
        self.assert_invalid(self.exit_of(self.with_field(not_audited={})))
        self.assert_invalid(self.exit_of(self.with_field(not_audited={"reason": 5, "x": self.SENTINEL})))

    def test_rule_missing_is_accepted(self) -> None:
        """#262/AC-2: linha sem `rule` é entrada válida: a nota fica fora da comparação com a regra."""
        lines = all_correct()
        del lines[0]["rule"]
        self.assertEqual(self.exit_of(lines)[0], 0)

    def test_ac1_rule_not_an_object_exits_two(self) -> None:
        """#239/AC-1: `rule` que não é objeto sai 2."""
        self.assert_invalid(self.exit_of(self.with_field(rule="regra")))
        self.assert_invalid(self.exit_of(self.with_field(rule=[self.SENTINEL])))

    def test_ac1_refusals_not_a_list_exits_two(self) -> None:
        """#239/AC-1: `refusals` que não é lista sai 2."""
        self.assert_invalid(self.exit_of(self.with_field(refusals={"refusal": self.SENTINEL})))

    def test_ac1_refusal_item_not_an_object_exits_two(self) -> None:
        """#239/AC-1: item de `refusals` que não é objeto sai 2."""
        self.assert_invalid(self.exit_of(self.with_field(refusals=["routing_below_regua"])))
        self.assert_invalid(self.exit_of(self.with_field(refusals=[None])))

    def test_ac1_access_key_not_a_string_exits_two(self) -> None:
        """#239/AC-1: `invoice_access_key` que não é texto (lista, objeto, número) sai 2."""
        for bad in (["K1"], {"k": self.SENTINEL}, 7, True):
            self.assert_invalid(self.exit_of(self.with_field(invoice_access_key=bad)))

    def test_ac1_model_not_a_string_exits_two(self) -> None:
        """#239/AC-1: `model` que não é texto nem nulo sai 2, em json e em md."""
        for bad in ({"x": 1}, ["v"], 3, True):
            self.assert_invalid(self.exit_of(self.with_field(model=bad)))

    def test_ac1_prompt_version_not_a_string_exits_two(self) -> None:
        """#239/AC-1: `prompt_version` que não é texto nem nulo sai 2."""
        for bad in (["v"], {"x": 1}, 2):
            self.assert_invalid(self.exit_of(self.with_field(prompt_version=bad)))

    def test_ac1_model_of_mixed_types_across_lines_exits_two(self) -> None:
        """#239/AC-1: `model` texto numa linha e número noutra sai 2, não falha na ordenação."""
        lines = all_correct()
        lines[0]["model"] = "a"
        lines[1]["model"] = 3
        self.assert_invalid(self.exit_of(lines))

    def test_ac1_model_numbers_with_markdown_format_exits_two_and_writes_no_run(self) -> None:
        """#239/AC-1: `model` numérico com `--format md` sai 2 e não grava rodada."""
        lines = all_correct()
        lines[0]["model"] = 1
        lines[1]["model"] = 2
        audits = self.folder / "auditorias.jsonl"
        audits.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
        argv = [str(audits), "--answer-key", str(self.key_file), "--runs-dir", str(self.runs_dir), "--format", "md"]
        self.assert_invalid(run_cli(argv))
        self.assertFalse(self.runs_dir.exists())

    def test_ac1_null_model_and_prompt_version_are_accepted(self) -> None:
        """#239/AC-1: `model` e `prompt_version` nulos continuam valendo como não informados."""
        code, _, _ = self.exit_of(self.with_field(model=None, prompt_version=None))
        self.assertEqual(code, 0)

    def test_ac1_scalar_fields_of_any_shape_never_escape_as_an_exception(self) -> None:
        """#239/AC-1: classificação, ação, encaminhamento, `refusal` e `reason` de qualquer forma saem 0, 1 ou 2."""
        shapes = (None, 1, ["x"], {"x": 1}, True)
        for shape in shapes:
            for field in ("classification", "dock_action", "routing"):
                self.assertIn(self.exit_of(self.with_field(**{field: shape}))[0], (0, 1, 2))
                rule = dict(all_correct()[0]["rule"], **{field: shape})
                self.assertIn(self.exit_of(self.with_field(rule=rule))[0], (0, 1, 2))
            self.assertIn(self.exit_of(self.with_field(refusals=[{"refusal": shape}]))[0], (0, 1, 2))
            self.assertIn(self.exit_of(self.with_field(not_audited={"reason": shape}))[0], (0, 1, 2))

    def test_ac1_answer_key_classification_outside_the_set_exits_two(self) -> None:
        """#239/AC-1: `classificacao` do gabarito fora de match/E1..E8 sai 2."""
        bad = [dict(ANSWER_KEY[0], classificacao="E9"), *ANSWER_KEY[1:]]
        self.assert_invalid(self.exit_of(all_correct(), bad))

    def test_ac1_answer_key_not_a_list_exits_two(self) -> None:
        """#239/AC-1: gabarito que não é lista, ou com item que não é objeto, sai 2."""
        self.assert_invalid(self.exit_of(all_correct(), {"chave": self.SENTINEL}))  # ADR-001
        self.assert_invalid(self.exit_of(all_correct(), [ANSWER_KEY[0], "K2"]))

    def test_ac1_answer_key_note_missing_a_field_exits_two(self) -> None:
        """#239/AC-1: nota do gabarito sem `acao_doca` ou `encaminhamento` sai 2."""
        bad = {k: v for k, v in ANSWER_KEY[0].items() if k != "acao_doca"}
        self.assert_invalid(self.exit_of(all_correct(), [bad, *ANSWER_KEY[1:]]))

    def test_ac3_corrupt_earlier_run_file_exits_two(self) -> None:
        """#239/AC-3: arquivo de rodada anterior corrompido sai 2."""
        self.runs_dir.mkdir()
        (self.runs_dir / "00000000T000000Z-aaaaaaaa.json").write_text("{corrompido", encoding="utf-8")
        self.assert_invalid(self.exit_of(all_correct()))

    def test_ac3_earlier_run_file_without_the_run_shape_exits_two(self) -> None:
        """#239/AC-3: rodada anterior que é JSON mas não tem a forma de uma rodada sai 2."""
        self.runs_dir.mkdir()
        (self.runs_dir / "00000000T000000Z-aaaaaaaa.json").write_text("[]", encoding="utf-8")
        self.assert_invalid(self.exit_of(all_correct()))
        (self.runs_dir / "00000000T000000Z-aaaaaaaa.json").write_text('{"x": 1}', encoding="utf-8")
        self.assert_invalid(self.exit_of(all_correct()))
        (self.runs_dir / "00000000T000000Z-aaaaaaaa.json").write_text("null", encoding="utf-8")
        self.assert_invalid(self.exit_of(all_correct()))
        (self.runs_dir / "00000000T000000Z-aaaaaaaa.json").write_text('"texto"', encoding="utf-8")
        self.assert_invalid(self.exit_of(all_correct()))

    def test_ac3_unreadable_earlier_run_file_exits_two(self) -> None:
        """#239/AC-3: rodada anterior ilegível (aqui, uma pasta no lugar do arquivo) sai 2."""
        (self.runs_dir / "00000000T000000Z-aaaaaaaa.json").mkdir(parents=True)
        self.assert_invalid(self.exit_of(all_correct()))


UNEXPECTED_FAILURE = "não foi possível processar a entrada; nada foi gravado"
SAVE_FAILURE = "não foi possível gravar a rodada na pasta de rodadas"
STDOUT_FAILURE = "a rodada foi gravada, mas a saída padrão falhou"


class BrokenStdout(io.StringIO):
    """Saída padrão que falha ao escrever, como um pipe fechado."""

    def write(self, text: str) -> int:
        raise BrokenPipeError(errno.EPIPE, "Broken pipe")


class ClosedClassTest(unittest.TestCase):
    """#245: a classe fechada no ponto de entrada. Toda exceção que não é o desfecho da E6 sai 2, com mensagem fixa."""

    SURROGATE = "K\ud800"

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.folder = Path(self._tmp.name)
        self.key_file = self.folder / "gabarito.json"
        self.key_file.write_text(json.dumps(ANSWER_KEY), encoding="utf-8")
        self.runs_dir = self.folder / "rodadas"
        self.audits = self.folder / "auditorias.jsonl"

    def run_with(self, text: str, *extra: str, now: datetime = NOW) -> tuple[int, str, str]:
        self.audits.write_text(text, encoding="utf-8")
        argv = [str(self.audits), "--answer-key", str(self.key_file), "--runs-dir", str(self.runs_dir), *extra]
        return run_cli(argv, now)

    def run_lines(self, lines: list[Record], *extra: str, now: datetime = NOW) -> tuple[int, str, str]:
        return self.run_with("\n".join(json.dumps(x) for x in lines) + "\n", *extra, now=now)

    def run_files(self) -> list[str]:
        return sorted(x.name for x in self.runs_dir.iterdir()) if self.runs_dir.exists() else []

    def assert_fixed_two(
        self,
        result: tuple[int, str, str],
        forbidden: str = "",
        kept: list[str] | None = None,
        message: str = UNEXPECTED_FAILURE,
    ) -> None:
        code, out, err = result
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertEqual(err, f"erro: {message}\n")
        self.assertNotIn("Traceback", err)
        if forbidden:
            self.assertNotIn(forbidden, err)
        self.assertEqual(self.run_files(), kept or [])

    def test_ac2_closed_stdout_pipe_exits_two_without_python_noise(self) -> None:
        """#245/AC-2: com o stdout num pipe de leitura fechada o processo sai 2 (não 120), só com a mensagem fixa no stderr."""
        self.audits.write_text("\n".join(json.dumps(x) for x in all_correct()) + "\n", encoding="utf-8")
        read_end, write_end = os.pipe()
        os.close(read_end)
        argv = [sys.executable, str(ROOT / "eval" / "auditor.py"), str(self.audits),
                "--answer-key", str(self.key_file), "--runs-dir", str(self.runs_dir)]
        with subprocess.Popen(argv, stdout=write_end, stderr=subprocess.PIPE, text=True) as process:
            os.close(write_end)
            _, err = process.communicate(timeout=60)
        self.assertEqual(process.returncode, 2)
        self.assertEqual(err, "erro: a rodada foi gravada, mas a saída padrão falhou\n")
        self.assertEqual(len(list(self.runs_dir.glob("*.json"))), 1)

    def test_ac1_integer_over_4300_digits_in_audits_exits_two(self) -> None:
        """#245/AC-1: inteiro com mais de 4300 dígitos numa linha do JSONL sai 2, sem rastro."""
        line = '{"invoice_access_key": "K1", "x": ' + "9" * 5000 + "}"
        self.assert_fixed_two(self.run_with(line + "\n"), "9" * 50)

    def test_ac1_integer_over_4300_digits_in_answer_key_exits_two(self) -> None:
        """#245/AC-1: inteiro com mais de 4300 dígitos no gabarito sai 2, sem rastro."""
        self.key_file.write_text('[{"chave": "K1", "x": ' + "9" * 5000 + "}]", encoding="utf-8")
        self.assert_fixed_two(self.run_lines(all_correct()), "9" * 50)

    def test_ac1_nesting_of_200_thousand_levels_in_audits_exits_two(self) -> None:
        """#245/AC-1: JSON aninhado em 200 mil níveis numa linha sai 2 (RecursionError), sem rastro."""
        self.assert_fixed_two(self.run_with("[" * 200_000 + "\n"))

    def test_ac1_nesting_of_200_thousand_levels_in_answer_key_exits_two(self) -> None:
        """#245/AC-1: JSON aninhado em 200 mil níveis no gabarito sai 2, sem rastro."""
        self.key_file.write_text("[" * 200_000, encoding="utf-8")
        self.assert_fixed_two(self.run_lines(all_correct()))

    def test_ac1_lone_surrogate_in_access_key_exits_two_with_nothing_written(self) -> None:
        """#245/AC-1: surrogate isolado em `invoice_access_key` sai 2 antes de gravar ou imprimir."""
        lines = all_correct()
        lines[0]["invoice_access_key"] = self.SURROGATE
        self.assert_fixed_two(self.run_lines(lines))
        self.assert_fixed_two(self.run_lines(lines, "--format", "md"))

    def test_ac1_lone_surrogate_in_model_exits_two_with_nothing_written(self) -> None:
        """#245/AC-1: surrogate isolado em `model` sai 2 antes de gravar ou imprimir, em json e em md."""
        lines = all_correct()
        lines[0]["model"] = "\ud800"
        self.assert_fixed_two(self.run_lines(lines))
        self.assert_fixed_two(self.run_lines(lines, "--format", "md"))

    def seed_previous_run(self) -> Path:
        first = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(self.run_lines(all_correct(), now=first)[0], 0)
        (saved,) = self.runs_dir.glob("*.json")
        return saved

    def test_ac1_huge_integer_in_earlier_run_rate_exits_two(self) -> None:
        """#245/AC-1: inteiro gigante numa taxa da rodada anterior sai 2 (OverflowError), sem gravar."""
        saved = self.seed_previous_run()
        data = json.loads(saved.read_text(encoding="utf-8"))
        data["full_match_rate"] = 10**400
        saved.write_text(json.dumps(data), encoding="utf-8")
        self.assert_fixed_two(self.run_lines(all_correct()), "0" * 50, kept=[saved.name])

    def test_ac1_huge_integer_in_earlier_run_counts_exits_two(self) -> None:
        """#245/AC-1: inteiro gigante nas contagens da rodada anterior sai 2, sem gravar."""
        saved = self.seed_previous_run()
        data = json.loads(saved.read_text(encoding="utf-8"))
        data["by_exception"]["E6"]["full"] = 10**400
        saved.write_text(json.dumps(data), encoding="utf-8")
        self.assert_fixed_two(self.run_lines(all_correct()), "0" * 50, kept=[saved.name])

    def test_ac2_failed_write_leaves_no_file_and_next_run_succeeds(self) -> None:
        """#245/AC-2: gravação que falha não deixa arquivo (nem temporário) e a rodada seguinte sai 0."""
        with mock.patch("auditor.os.replace", side_effect=OSError("disco cheio")):
            self.assert_fixed_two(self.run_lines(all_correct()), "disco cheio", message=SAVE_FAILURE)
        code, out, _ = self.run_lines(all_correct())
        self.assertEqual(code, 0)
        self.assertEqual(self.run_files(), [f"{json.loads(out)['run_id']}.json"])

    def test_ac2_no_space_on_write_exits_two_with_save_message_and_leaves_nothing(self) -> None:
        """#245/AC-2: falha ao abrir o temporário para escrita (ENOSPC, como disco cheio) sai 2 com a mensagem de gravação; nada sobra."""
        with mock.patch("auditor.os.fdopen", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            self.assert_fixed_two(self.run_lines(all_correct()), "No space", message=SAVE_FAILURE)
        self.assertEqual(self.run_files(), [])

    def test_ac2_no_space_on_replace_exits_two_with_save_message_and_leaves_nothing(self) -> None:
        """#245/AC-2: disco cheio no `os.replace` sai 2 com a mensagem de gravação; nem o temporário sobra."""
        with mock.patch("auditor.os.replace", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            self.assert_fixed_two(self.run_lines(all_correct()), "No space", message=SAVE_FAILURE)
        self.assertEqual(self.run_files(), [])

    def test_ac2_broken_stdout_after_save_exits_two_and_keeps_the_run(self) -> None:
        """#245/AC-2: stdout que falha depois de gravar sai 2 com a mensagem nova; a rodada continua gravada."""
        err = io.StringIO()
        self.audits.write_text("\n".join(json.dumps(x) for x in all_correct()) + "\n", encoding="utf-8")
        argv = [str(self.audits), "--answer-key", str(self.key_file), "--runs-dir", str(self.runs_dir)]
        with contextlib.redirect_stdout(BrokenStdout()), contextlib.redirect_stderr(err):
            code = auditor.main(argv, now=lambda: NOW)
        self.assertEqual(code, 2)
        self.assertEqual(err.getvalue(), f"erro: {STDOUT_FAILURE}\n")
        self.assertNotIn("nada foi gravado", err.getvalue())
        self.assertEqual(len(self.run_files()), 1)
        self.assertTrue(self.run_files()[0].endswith(".json"))

    def test_ac2_surrogate_failure_then_valid_run_succeeds(self) -> None:
        """#245/AC-2: depois de uma rodada recusada por surrogate, a rodada válida roda e grava um só arquivo."""
        bad = all_correct()
        bad[0]["model"] = "\ud800"
        self.assert_fixed_two(self.run_lines(bad))
        code, _, _ = self.run_lines(all_correct())
        self.assertEqual(code, 0)
        self.assertEqual(len(self.run_files()), 1)
        self.assertTrue(self.run_files()[0].endswith(".json"))

    def test_ac3_missed_e6_still_exits_one(self) -> None:
        """#245/AC-3: E6 perdida continua saindo 1, com a rodada impressa e gravada."""
        lines = all_correct()
        lines[1] = audit_line("K2", "E1", "recusar", "bloqueio")
        code, out, err = self.run_lines(lines)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["by_exception"]["E6"]["classification"], 0)
        self.assertIn("E6", err)
        self.assertEqual(len(self.run_files()), 1)

    def test_ac3_malformed_input_never_exits_one(self) -> None:
        """#245/AC-3: nenhuma forma malformada sai 1, nem com a E6 perdida no mesmo arquivo."""
        lines = all_correct()
        lines[1] = audit_line("K2", "E1", "recusar", "bloqueio")
        lines[0]["model"] = "\ud800"
        self.assertEqual(self.run_lines(lines)[0], 2)
        self.assertEqual(self.run_with("[" * 200_000 + "\n")[0], 2)


class AgentNeverReadsAnswerKeyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root_dir = ROOT

    def test_ac2_nothing_in_agent_or_web_reads_answer_key(self) -> None:
        """#239/AC-2: nenhum arquivo de api/ e web/src referencia o caminho do gabarito."""
        found = []
        for root_dir in (self.root_dir / "api", self.root_dir / "web" / "src"):
            for file in root_dir.rglob("*"):
                if not file.is_file() or "node_modules" in file.parts or file.suffix in {".png", ".ico", ".woff2", ".jpg"}:
                    continue
                text = file.read_text(encoding="utf-8", errors="ignore")
                if re.search(r"eval/gabarito|gabarito\.json", text):
                    found.append(str(file.relative_to(self.root_dir)))
        self.assertEqual(found, [])

    def test_ac2_command_reads_only_file_and_answer_key(self) -> None:
        """#239/AC-2: o módulo não importa rede nem a base do kit."""
        source = (self.root_dir / "eval" / "auditor.py").read_text(encoding="utf-8")
        for forbidden in ("urllib", "requests", "socket", "http.client", "jachegou", "data/kit"):
            self.assertNotIn(forbidden, source)


class RunsIgnoredTest(unittest.TestCase):
    def test_ac3_runs_stay_out_of_git(self) -> None:
        """#239/AC-3: eval/rodadas/ está no .gitignore."""
        self.assertIn("eval/rodadas/", (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines())


if __name__ == "__main__":
    unittest.main()
