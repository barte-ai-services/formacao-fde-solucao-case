#!/usr/bin/env python3
"""Exporta as auditorias e as propostas da regra do banco para o eval do auditor (#240, parte da #154).

Lê, só por GET, as tabelas invoice_audits e proposals pela API PostgREST e grava o JSONL no
formato de entrada do eval/auditor.py (eval/README.md, "Formato de entrada"). Não escreve no
banco. A transformação (linhas do banco -> linhas do JSONL) é pura e não toca a rede.

Uma nota entra com a leitura corrente da auditoria: a auditoria feita, ou a tentativa mais
recente. Nota sem nenhuma linha de auditoria fica fora do arquivo; o eval a conta como erro.

A proposta `alterada` guarda a edição da pessoa, e a original não fica em lugar nenhum: essa nota sai
sem `rule` e o eval a deixa fora da comparação com a regra (#262). A saída conta quantas ficaram assim.

Variáveis: BARTE_ACADEMY_SUPABASE_URL e BARTE_ACADEMY_SUPABASE_SECRET_KEY, do ambiente ou do
.env na raiz. Nunca imprime a chave, os cabeçalhos nem o corpo das respostas.
"""
import http.client
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

# Any: as linhas do banco e do JSONL só têm forma conhecida em tempo de execução (#240).
Json = Any
Row = dict[str, Json]
# Leitura de uma tabela inteira: (tabela, ordem) -> linhas. Injetada nos testes (#240).
ReadTable = Callable[[str, str], list[Row]]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUTPUT = os.path.join(ROOT, "eval", "saidas", "auditorias.jsonl")
URL_VAR = "BARTE_ACADEMY_SUPABASE_URL"
KEY_VAR = "BARTE_ACADEMY_SUPABASE_SECRET_KEY"
ENV_FILE = ".env"
AUDITS_TABLE = "invoice_audits"
PROPOSALS_TABLE = "proposals"
READABLE_TABLES = (AUDITS_TABLE, PROPOSALS_TABLE)
PAGE_SIZE = 1000
AUDITED = "audited"
# Estados da proposta em que a linha guarda a edição da pessoa, não a proposta da regra (#262).
# A proposta alterada sobrescreve a original no banco e nenhuma tabela guarda a anterior.
EDITED_STATES = frozenset({"alterada"})

OPERATION_LABELS = {
    "read": "falha ao ler",
    "network": "falha de rede",
    "pagination": "paginação sem fim: o servidor ignorou o Range",
    "table": "tabela fora da exportação",
    "proposal": "auditoria sem proposta da regra",
    "config_scheme": "a URL do Supabase precisa ser https",
    "payload": "resposta fora do formato",
    "config": f"defina {URL_VAR} e {KEY_VAR}",
}


class ExportError(Exception):
    """Falha da exportação, só com campos nomeados: nunca carrega corpo de resposta nem cabeçalho."""

    def __init__(self, operation: str, table: str | None = None, status: int | None = None) -> None:
        super().__init__(operation)
        self.operation = operation
        self.table = table
        self.status = status


def describe(error: ExportError) -> str:
    """O texto impresso: a operação, a tabela e o status, e mais nada."""
    parts = [OPERATION_LABELS.get(error.operation, error.operation)]
    if error.table:
        parts.append(f"tabela {error.table}")
    if error.status is not None:
        parts.append(f"HTTP {error.status}")
    return ", ".join(parts)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Não segue redirecionamento: o urllib copiaria apikey e Authorization para o novo host (#264)."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


# Um 3xx sobe como HTTPError e vira ExportError("read", tabela, status) (#264).
_OPENER = urllib.request.build_opener(_NoRedirect)


def rest_url(url: str) -> str:
    return url.rstrip("/") + "/rest/v1/"


class Reader:
    """Cliente mínimo e só de leitura da API PostgREST. Não registra cabeçalhos."""

    def __init__(self, url: str, key: str) -> None:
        self.base = rest_url(url)
        self.key = key

    def _get(self, path: str, start: int) -> tuple[int, bytes]:
        headers = {"apikey": self.key, "Range": f"{start}-{start + PAGE_SIZE - 1}", "Range-Unit": "items"}
        if not self.key.startswith("sb_"):
            headers["Authorization"] = "Bearer " + self.key
        request = urllib.request.Request(self.base + path, method="GET", headers=headers)
        table = path.split("?")[0]
        try:
            with _OPENER.open(request, timeout=60) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, b""
        except (urllib.error.URLError, http.client.HTTPException, OSError):
            raise ExportError("network", table=table) from None

    def read_all(self, table: str, order: str) -> list[Row]:
        """Lê a tabela inteira, na ordem dada, até a primeira página vazia: o teto de linhas do servidor não trunca."""
        if table not in READABLE_TABLES:
            raise ExportError("table", table=table)
        path = f"{table}?select=*&order={urllib.parse.quote(order, safe=',.')}"
        rows: list[Row] = []
        start = 0
        previous: list[Row] | None = None
        while True:
            status, body = self._get(path, start)
            if status >= 300:
                raise ExportError("read", table, status)
            try:
                page = json.loads(body)
            except ValueError:
                raise ExportError("payload", table, status) from None
            if not page:
                return rows
            if len(page) > PAGE_SIZE or page == previous:
                raise ExportError("pagination", table=table)
            previous = page
            rows += page
            start += len(page)

    def __call__(self, table: str, order: str) -> list[Row]:
        return self.read_all(table, order)


def current_reading(audits: list[Row]) -> dict[str, Row]:
    """A leitura corrente por nota: a auditoria feita, ou a tentativa mais recente (status asc, id desc)."""
    ranked = sorted(audits, key=lambda r: (r["invoice_access_key"], r["status"], -r["id"]))
    current: dict[str, Row] = {}
    for row in ranked:
        current.setdefault(row["invoice_access_key"], row)
    return current


def _kind(dock_action: Json) -> str | None:
    return None if dock_action is None else str(dock_action["kind"])


def _rule(audit: Row, proposal: Row) -> Row:
    """A proposta da regra. Se o auditor subiu o nível, o da regra é o que a proposta tinha quando a nota foi lida."""
    level = audit.get("requested_from_level") or proposal["approval_level"]
    return {"classification": proposal["classification"], "dock_action": _kind(proposal["dock_action"]), "routing": level}


def _rule_is_readable(proposal: Row) -> bool:
    """A proposta ainda é a da regra: o estado é lido e não é de edição da pessoa (#262). Sem estado, não é."""
    state = proposal.get("state")
    return state is not None and state not in EDITED_STATES


def _line(audit: Row, proposal: Row) -> Row:
    line: Row = {"invoice_access_key": audit["invoice_access_key"]}
    if audit["status"] == AUDITED:
        cents = audit["amount_at_risk_cents"]
        line.update(
            classification=audit["classification"],
            dock_action=_kind(audit["dock_action"]),
            routing=audit["routing"],
            justification=audit["justification"],
            amount_at_risk=None if cents is None else {"cents": cents},
            model=audit["model"],
            audited_at=audit["audited_at"],
        )
    else:
        line["not_audited"] = {"reason": audit["reason"]}
    if _rule_is_readable(proposal):
        line["rule"] = _rule(audit, proposal)
    line["refusals"] = list(audit.get("refusals") or [])
    return line


def build_lines(audits: list[Row], proposals: list[Row]) -> list[Row]:
    """Uma linha por nota com auditoria, em ordem de chave. Pura: sem arquivo, relógio nem rede."""
    by_note = {p["invoice_access_key"]: p for p in proposals}
    current = current_reading(audits)
    lines = []
    for key in sorted(current):
        if key not in by_note:
            raise ExportError("proposal", table=PROPOSALS_TABLE)
        lines.append(_line(current[key], by_note[key]))
    return lines


def without_rule(lines: list[Row]) -> int:
    """Quantas linhas saíram sem `rule`: só a contagem (#262)."""
    return sum(1 for line in lines if "rule" not in line)


def export(read_table: ReadTable) -> list[Row]:
    """Lê as duas tabelas, só elas, e devolve as linhas do JSONL."""
    audits = read_table(AUDITS_TABLE, "invoice_access_key,status.asc,id.desc")
    proposals = read_table(PROPOSALS_TABLE, "invoice_access_key")
    return build_lines(audits, proposals)


def write_jsonl(path: str, lines: list[Row]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")


def env_from_files(root: str = ROOT) -> dict[str, str]:
    """As duas variáveis, lidas das linhas CHAVE=valor do .env da raiz, se existir."""
    found: dict[str, str] = {}
    try:
        with open(os.path.join(root, ENV_FILE), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return found
    for raw in text.splitlines():
        name_part, _, value = raw.strip().removeprefix("export ").partition("=")
        if name_part in (URL_VAR, KEY_VAR):
            found[name_part] = value.strip().strip("\"'")
    return found


def reader_from_env(env: Mapping[str, str]) -> Reader:
    url, key = env.get(URL_VAR), env.get(KEY_VAR)
    if not url or not key:
        raise ExportError("config")
    if urllib.parse.urlsplit(url).scheme != "https":
        raise ExportError("config_scheme")
    return Reader(url, key)


def main(argv: list[str] | None = None, reader: ReadTable | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    path = args[0] if args else DEFAULT_OUTPUT
    try:
        read_table = reader or reader_from_env({**env_from_files(), **os.environ})
        lines = export(read_table)
        write_jsonl(path, lines)
    except ExportError as error:
        print(f"erro: {describe(error)}", file=sys.stderr)
        return 1
    print(f"{len(lines)} auditorias exportadas, {without_rule(lines)} sem rule (proposta alterada pela pessoa); "
          "nota sem auditoria fica fora do arquivo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
