"""Eval do agente auditor de notas contra o gabarito (#239, parte da #154).

Lê só o arquivo de auditorias exportado (uma linha por nota auditada, o contrato do
`record_audit` da #153) e o gabarito; não toca a rede, o banco nem a base do kit.
A medição (`measure`, `difference`, `markdown_report`) é pura; a leitura e a gravação ficam em `main`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

# Json e Record: o que vem do JSONL ou do gabarito só tem forma conhecida em execução, por isso `Any` (#239).
Json = Any
Record = dict[str, Json]

HERE = Path(__file__).resolve().parent
DEFAULT_ANSWER_KEY = HERE / "gabarito" / "gabarito.json"
DEFAULT_RUNS_DIR = HERE / "rodadas"

EXCEPTIONS = ["match", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]
# campo da auditoria, campo do gabarito (#239)
FIELDS = {"classification": "classificacao", "dock_action": "acao_doca", "routing": "encaminhamento"}
EXIT_E6_MISSED = 1
EXIT_USAGE = 2


class InvalidInput(ValueError):
    """O arquivo de auditorias ou o gabarito não tem o formato esperado."""


def normalize(classification_value: Json) -> Json:
    return "match" if classification_value == "MATCH" else classification_value


def parse_lines(text: str) -> list[Record]:
    """Lê o JSONL: ignora linhas em branco; recusa linha que não é objeto ou sem chave."""
    lines = []
    for number, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as error:
            raise InvalidInput(f"linha {number}: JSON inválido ({error.msg})") from error
        if not isinstance(obj, dict) or not obj.get("invoice_access_key"):
            raise InvalidInput(f"linha {number}: falta `invoice_access_key`")
        _check_line_shape(obj, number)
        lines.append(obj)
    return lines


def _check_line_shape(obj: Record, number: int) -> None:
    """Recusa, com mensagem fixa, a linha cujos campos estruturais não têm a forma do contrato (#239)."""
    if not isinstance(obj.get("rule"), dict):
        raise InvalidInput(f"linha {number}: `rule` ausente ou não é objeto")
    skipped = obj.get("not_audited")
    if skipped is not None and not (isinstance(skipped, dict) and isinstance(skipped.get("reason"), str)):
        raise InvalidInput(f"linha {number}: `not_audited` deve ser objeto com `reason` em texto")
    refusals = obj.get("refusals")
    if refusals is not None and not (isinstance(refusals, list) and all(isinstance(r, dict) for r in refusals)):
        raise InvalidInput(f"linha {number}: `refusals` deve ser lista de objetos")


def _is_not_audited(line: Record) -> bool:
    return line.get("not_audited") is not None


def deduplicate(lines: list[Record]) -> list[Record]:
    """A mesma chave duas vezes: a última linha vale."""
    return list({x["invoice_access_key"]: x for x in lines}.values())


def _hits(proposal: Record | None, note: Record) -> dict[str, bool]:
    """Acerto por campo de uma proposta (auditoria ou regra) contra uma nota do gabarito."""
    if proposal is None:
        return {field: False for field in FIELDS}
    return {
        field: normalize(proposal.get(field)) == note[target]
        for field, target in FIELDS.items()
    }


def _valid_audit(line: Record | None) -> Record | None:
    return None if line is None or _is_not_audited(line) else line


def _rate(part: int, total: int) -> float | None:
    return part / total if total else None


def _values(lines: list[Record], field: str) -> Json:
    distinct = sorted({x[field] for x in lines if x.get(field) is not None})
    if not distinct:
        return None
    return distinct[0] if len(distinct) == 1 else distinct


def _errors(answer_key: list[Record], by_key: dict[str, Record]) -> list[dict[str, str]]:
    found = []
    known = {note["chave"] for note in answer_key}
    for note in answer_key:
        line = by_key.get(note["chave"])
        if line is None:
            found.append({"invoice_access_key": note["chave"], "reason": "sem auditoria"})
        elif _is_not_audited(line):
            reason = line["not_audited"]["reason"]
            found.append({"invoice_access_key": note["chave"], "reason": f"não auditada: {reason}"})
    for key in by_key:
        if key not in known:
            found.append({"invoice_access_key": key, "reason": "chave fora do gabarito"})
    return found


def _count(answer_key: list[Record], proposal_of: Callable[[Record], Record | None]) -> dict[str, dict[str, int]]:
    """Por exceção do gabarito: total, acertos por campo e acerto completo."""
    counts = {c: {"total": 0, **{field: 0 for field in FIELDS}, "full": 0} for c in EXCEPTIONS}
    for note in answer_key:
        hits = _hits(proposal_of(note), note)
        target = counts[note["classificacao"]]
        target["total"] += 1
        for field, hit in hits.items():
            target[field] += hit
        target["full"] += all(hits.values())
    return counts


def _rates_vs_rule(agent: dict[str, dict[str, int]], rule: dict[str, dict[str, int]], keys: list[str]) -> Record:
    def add_up(counts: dict[str, dict[str, int]], field: str) -> int:
        return sum(counts[c][field] for c in keys)

    total = sum(agent[c]["total"] for c in keys)
    return {
        "agent_full": _rate(add_up(agent, "full"), total),
        "rule_full": _rate(add_up(rule, "full"), total),
        "agent_classification": _rate(add_up(agent, "classification"), total),
        "rule_classification": _rate(add_up(rule, "classification"), total),
    }


def _vs_baseline(agent: dict[str, dict[str, int]], rule: dict[str, dict[str, int]]) -> Record:
    return {
        "by_exception": {c: _rates_vs_rule(agent, rule, [c]) for c in EXCEPTIONS},
        "total": _rates_vs_rule(agent, rule, EXCEPTIONS),
    }


def _refusal_metrics(lines: list[Record], by_key: dict[str, Record], answer_key: list[Record]) -> tuple[int | None, float | None]:
    """Só sobre as notas auditadas do gabarito: recusas de alçada e parcela sem nenhuma delas (#239).

    Sem nenhuma chave `refusals` no arquivo as duas métricas não foram medidas (None). A recusa
    `invalid_field` não conta contra o encaminhamento de primeira; chave fora do gabarito não entra.
    """
    if not any("refusals" in x for x in lines):
        return None, None
    audited = [by_key[n["chave"]] for n in answer_key if by_key.get(n["chave"]) and not _is_not_audited(by_key[n["chave"]])]
    below_counts = [
        sum(1 for r in x.get("refusals") or [] if r.get("refusal") == "routing_below_regua") for x in audited
    ]
    first_try = sum(1 for count in below_counts if count == 0)
    return sum(below_counts), _rate(first_try, len(audited))


def measure(lines: list[Record], answer_key: list[Record]) -> Record:
    """Mede as auditorias contra o gabarito. Pura: sem arquivo, relógio nem rede."""
    lines = deduplicate(lines)
    by_key = {x["invoice_access_key"]: x for x in lines}
    agent = _count(answer_key, lambda n: _valid_audit(by_key.get(n["chave"])))
    rule = _count(answer_key, lambda n: (by_key.get(n["chave"]) or {}).get("rule"))
    total = len(answer_key)
    by_field = {field: _rate(sum(agent[c][field] for c in EXCEPTIONS), total) for field in FIELDS}
    below, first_try = _refusal_metrics(lines, by_key, answer_key)
    return {
        "model": _values(lines, "model"),
        "prompt_version": _values(lines, "prompt_version"),
        "notes_total": total,
        "full_match_rate": _rate(sum(agent[c]["full"] for c in EXCEPTIONS), total),
        "by_field": by_field,
        "by_exception": agent,
        "routing_below_regua": below,
        "first_try_routing_rate": first_try,
        "errors": _errors(answer_key, by_key),
        "vs_baseline": _vs_baseline(agent, rule),
    }


def e6_missed(run: Record) -> bool:
    """Alguma duplicidade (E6) do gabarito não foi classificada E6 pela auditoria."""
    e6 = run["by_exception"]["E6"]
    return e6["classification"] < e6["total"]


def _full_rate(run: Record, exception_name: str) -> float | None:
    counts = run["by_exception"][exception_name]
    return _rate(counts["full"], counts["total"])


def _delta(current: float | None, previous: float | None) -> float | None:
    return None if current is None or previous is None else current - previous


def difference(current: Record, previous: Record) -> Record:
    """Diferença (atual menos anterior) nas taxas; None onde uma das rodadas não mede."""
    return {
        "previous_run_id": previous["run_id"],
        "full_match_rate": _delta(current["full_match_rate"], previous["full_match_rate"]),
        "by_field": {c: _delta(current["by_field"][c], previous["by_field"][c]) for c in FIELDS},
        "by_exception": {
            e: _delta(_full_rate(current, e), _full_rate(previous, e)) for e in EXCEPTIONS
        },
    }


def make_run_id(now: datetime, content: bytes) -> str:
    """Timestamp UTC (ordenável) mais um hash curto do conteúdo do arquivo de auditorias."""
    stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{hashlib.sha256(content).hexdigest()[:8]}"


def _pct(value: float | None) -> str:
    return "não medido" if value is None else f"{value * 100:.1f}%"


def _pp(value: float | None) -> str:
    return "n/d" if value is None else f"{value * 100:+.1f} p.p."


def _value_text(value: Json) -> str:
    if value is None:
        return "não informado"
    return ", ".join(value) if isinstance(value, list) else str(value)


def _section_summary(r: Record) -> list[str]:
    below = "não medido" if r["routing_below_regua"] is None else str(r["routing_below_regua"])
    return [
        f"# Auditor de notas, rodada {r['run_id']}",
        "",
        f"- Modelo: {_value_text(r['model'])}",
        f"- Versão do prompt: {_value_text(r['prompt_version'])}",
        f"- Acerto completo: {_pct(r['full_match_rate'])} ({r['notes_total']} notas)",
        f"- Encaminhamentos abaixo da régua: {below}",
        f"- Encaminhamento certo de primeira: {_pct(r['first_try_routing_rate'])}",
        "",
        "## Por campo",
        "",
        *[f"- {field}: {_pct(rate)}" for field, rate in r["by_field"].items()],
        "",
    ]


def _section_exceptions(r: Record) -> list[str]:
    lines = ["## Por exceção", "", "| Exceção | Notas | Classificação | Ação na doca | Encaminhamento | Completo |",
              "|---|---|---|---|---|---|"]
    for e in EXCEPTIONS:
        c = r["by_exception"][e]
        lines.append(
            f"| {e} | {c['total']} | {c['classification']} | {c['dock_action']} | {c['routing']} | {c['full']} |"
        )
    return [*lines, ""]


def _section_rule(r: Record) -> list[str]:
    lines = ["## Agente contra a regra sem IA", "",
              "| Exceção | Agente (completo) | Regra (completo) | Agente (classificação) | Regra (classificação) |",
              "|---|---|---|---|---|"]
    vb = r["vs_baseline"]
    for name, v in [*vb["by_exception"].items(), ("Total", vb["total"])]:
        lines.append(
            f"| {name} | {_pct(v['agent_full'])} | {_pct(v['rule_full'])} | "
            f"{_pct(v['agent_classification'])} | {_pct(v['rule_classification'])} |"
        )
    return [*lines, ""]


def _section_previous(d: Record | None) -> list[str]:
    if d is None:
        return ["## Contra a rodada anterior", "", "Sem rodada anterior para comparar.", ""]
    return [
        "## Contra a rodada anterior", "",
        f"Rodada anterior: {d['previous_run_id']}", "",
        f"- Acerto completo: {_pp(d['full_match_rate'])}",
        *[f"- {field}: {_pp(v)}" for field, v in d["by_field"].items()],
        "", "| Exceção | Acerto completo |", "|---|---|",
        *[f"| {e} | {_pp(v)} |" for e, v in d["by_exception"].items()],
        "",
    ]


def _section_errors(r: Record) -> list[str]:
    if not r["errors"]:
        return ["## Erros", "", "Nenhum.", ""]
    return ["## Erros", "", *[f"- {e['invoice_access_key']}: {e['reason']}" for e in r["errors"]], ""]


def markdown_report(r: Record, previous: Record | None) -> str:
    """Relatório legível em português; `previous` é a diferença de `difference`, ou None."""
    sections = [_section_summary(r), _section_exceptions(r), _section_rule(r), _section_previous(previous), _section_errors(r)]
    return "\n".join(line for section in sections for line in section)


def previous_run(folder: Path, run_id: str) -> Record | None:
    """A última rodada gravada com run_id menor que o atual, ou None."""
    if not folder.is_dir():
        return None
    earlier = sorted(a for a in folder.glob("*.json") if a.stem < run_id)
    if not earlier:
        return None
    try:
        return json.loads(earlier[-1].read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise InvalidInput("rodada anterior ilegível ou corrompida na pasta de rodadas") from error


def _read_answer_key(path: Path) -> list[Record]:
    try:
        answer_key = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise InvalidInput(f"gabarito ilegível: {path}") from error
    if not isinstance(answer_key, list) or not all(_valid_note(n) for n in answer_key):
        raise InvalidInput("gabarito deve ser lista de notas com `chave`, `classificacao`, `acao_doca` e `encaminhamento`")
    return answer_key


def _valid_note(note: Json) -> bool:
    """Nota do gabarito com os campos do contrato e a classificação dentro de match/E1..E8 (#239)."""
    return (
        isinstance(note, dict)
        and isinstance(note.get("chave"), str)
        and note.get("classificacao") in EXCEPTIONS
        and all(field in note for field in ("acao_doca", "encaminhamento"))
    )


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Mede as auditorias do agente contra o gabarito (#239).")
    p.add_argument("audits", type=Path, help="JSONL com uma linha por nota auditada")
    p.add_argument("--answer-key", type=Path, default=DEFAULT_ANSWER_KEY)
    p.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR, help="pasta onde cada rodada é gravada")
    p.add_argument("--format", choices=["json", "md"], default="json")
    return p.parse_args(argv)


def _execute(args: argparse.Namespace, now: datetime) -> Record:
    try:
        content = args.audits.read_bytes()
    except OSError as error:
        raise InvalidInput(f"auditorias ilegíveis: {args.audits}") from error
    run = measure(parse_lines(content.decode("utf-8")), _read_answer_key(args.answer_key))
    run = {"run_id": make_run_id(now, content), **run}
    previous = previous_run(args.runs_dir, run["run_id"])
    if previous is not None:
        try:
            run["vs_previous"] = difference(run, previous)
        except (KeyError, TypeError) as error:
            raise InvalidInput("rodada anterior sem a forma de uma rodada na pasta de rodadas") from error
    try:
        args.runs_dir.mkdir(parents=True, exist_ok=True)
        (args.runs_dir / f"{run['run_id']}.json").write_text(
            json.dumps(run, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError as error:
        raise InvalidInput("não foi possível gravar a rodada na pasta de rodadas") from error
    return run


def main(argv: list[str] | None = None, now: Callable[[], datetime] | None = None) -> int:
    """0 sem E6 perdida; 1 só com E6 perdida; 2 para toda entrada ou uso inválidos."""
    try:
        args = _parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as exit_status:  # argparse sai com 0 em --help e com 2 em uso inválido (#239)
        return exit_status.code if isinstance(exit_status.code, int) else EXIT_USAGE
    try:
        run = _execute(args, (now or (lambda: datetime.now(timezone.utc)))())
    except (InvalidInput, UnicodeDecodeError) as error:
        print(f"erro: {error}", file=sys.stderr)
        return EXIT_USAGE
    if args.format == "md":
        print(markdown_report(run, run.get("vs_previous")))
    else:
        print(json.dumps(run, ensure_ascii=False, indent=2))
    if e6_missed(run):
        print("falha: alguma duplicidade (E6) do gabarito não foi classificada como E6", file=sys.stderr)
        return EXIT_E6_MISSED
    return 0


if __name__ == "__main__":
    sys.exit(main())
