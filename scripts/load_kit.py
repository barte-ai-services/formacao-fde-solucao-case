#!/usr/bin/env python3
"""Carga idempotente de data/kit/*.json nas tabelas kit_ do Supabase (#52).

A transformação (JSON -> linhas por tabela) é pura e não toca a rede. A carga grava pela API
PostgREST com upsert na chave primária, então rodar duas vezes não muda nenhuma contagem.

Variáveis de ambiente: BARTE_ACADEMY_SUPABASE_URL e BARTE_ACADEMY_SUPABASE_SECRET_KEY.
Nunca imprime a chave nem os cabeçalhos da requisição.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

# Any: o JSON do contrato e da fonte só tem forma conhecida em tempo de execução (#52).
Json = Any
Row = dict[str, Json]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data", "kit")
BATCH_SIZE = 500
URL_VAR = "BARTE_ACADEMY_SUPABASE_URL"
KEY_VAR = "BARTE_ACADEMY_SUPABASE_SECRET_KEY"


def rest_url(url: str) -> str:
    return url.rstrip("/") + "/rest/v1/"


OPERATION_LABELS = {
    "write": "falha ao gravar",
    "count": "falha ao contar",
    "read": "falha ao ler",
    "network": "falha de rede",
    "config": f"defina {URL_VAR} e {KEY_VAR}",
}


class LoadError(Exception):
    """Falha da carga, só com campos nomeados: nunca carrega corpo de resposta nem cabeçalho (#52)."""

    def __init__(self, operation: str, table: str | None = None, status: int | None = None) -> None:
        super().__init__(operation)
        self.operation = operation
        self.table = table
        self.status = status


def describe(operation: str, table: str | None, status: int | None) -> str:
    """O texto impresso: a operação, a tabela e o status, e mais nada."""
    parts = [OPERATION_LABELS.get(operation, operation)]
    if table:
        parts.append(f"tabela {table}")
    if status is not None:
        parts.append(f"HTTP {status}")
    return ", ".join(parts)


def read_json(data_dir: str, name: str) -> Json:
    with open(os.path.join(data_dir, name), encoding="utf-8") as f:
        return json.load(f, parse_float=Decimal)


def load_contract(data_dir: str = DATA_DIR) -> Json:
    return read_json(data_dir, "contrato.json")


def file_records(table: Json, source: Json) -> list[Row]:
    """Os registros de nível mais alto do arquivo, na forma de lista."""
    rule = table["count_rule"]["rule"]
    if rule == "single_object":
        return [source]
    if rule == "object_keys":
        return [{"codigo": k, "descricao": v} for k, v in source.items()]  # ADR-001
    return list(source)


def expected_count(table: Json, data_dir: str = DATA_DIR) -> int:
    """Contagem que o contrato manda: registros, soma dos itens, 1 ou número de chaves."""
    source = read_json(data_dir, table["file"])
    records = file_records(table, source)
    if table["count_rule"]["rule"] == "items":
        return sum(len(r[table["count_rule"]["field"]]) for r in records)
    return len(records)


def item_row(parent: Row, item: Row, columns: list[str]) -> Row:
    """Uma linha do item; o que o item não tem vem do pai."""
    return {c: item[c] if c in item else parent.get(c) for c in columns}


def item_rows(table: Json, records: list[Row], columns: list[str]) -> list[Row]:
    """Uma linha por item de cada pai."""
    field = table["count_rule"]["field"]
    rows: list[Row] = []
    for parent in records:
        rows.extend(item_row(parent, item, columns) for item in parent[field])
    return rows


def build_rows(data_dir: str = DATA_DIR) -> dict[str, list[Row]]:
    """Devolve {tabela: [linha, ...]} na ordem do contrato (pais antes dos filhos)."""
    contract = load_contract(data_dir)
    rows: dict[str, list[Row]] = {}
    for t in contract["tables"]:
        columns = [c["name"] for c in t["columns"]]
        defaults = {c["name"]: c["default"] for c in t["columns"] if "default" in c}  # #349 kit_notas.origin = 'base'
        source = read_json(data_dir, t["file"])
        records = file_records(t, source)
        rows[t["name"]] = []
        if t["count_rule"]["rule"] == "items":
            rows[t["name"]] = item_rows(t, records, columns)
        elif t["name"] == "kit_regua":  # ADR-001
            rows[t["name"]].append({c: 1 if c == "id" else source[c] for c in columns})
        else:
            for r in records:
                rows[t["name"]].append({c: r.get(c, defaults.get(c)) for c in columns})
    return rows


def sum_column(rows: list[Row], column: str) -> Decimal:
    return sum((Decimal(str(r[column])) for r in rows), Decimal(0))


def base_rows_of(table: Json, stored: list[Row], base: list[Row]) -> list[Row]:
    """#349 Das linhas lidas do banco, só as que o JSON do kit tem, pela chave primária do contrato.

    O modo demonstração grava linhas novas nas tabelas do kit; a contagem e as somas do JSON valem só para as da base.
    """
    key = table["primary_key"]
    wanted = {tuple(r[c] for c in key) for r in base}
    return [r for r in stored if tuple(r[c] for c in key) in wanted]


class DecimalEncoder(json.JSONEncoder):
    """Decimal vai como texto JSON, sem passar por float; o PostgREST converte para numeric (#52)."""

    def default(self, o: object) -> object:
        if isinstance(o, Decimal):
            return str(o)
        return super().default(o)


def _serialize(rows: list[Row]) -> bytes:
    return json.dumps(rows, cls=DecimalEncoder, ensure_ascii=False).encode("utf-8")


class Supabase:
    """Cliente mínimo da API PostgREST. Não registra cabeçalhos."""

    def __init__(self, url: str, key: str) -> None:
        self.base = rest_url(url)
        self.key = key

    def _request(self, method: str, path: str, body: bytes | None = None,
                 extra: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
        headers = {"apikey": self.key, "Content-Type": "application/json"}
        if not self.key.startswith("sb_"):
            headers["Authorization"] = "Bearer " + self.key
        headers.update(extra or {})
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()
        except urllib.error.URLError as e:
            raise LoadError("network", table=path.split("?")[0]) from None

    def write(self, table: str, rows: list[Row], primary_key: list[str]) -> None:
        query = "?on_conflict=" + urllib.parse.quote(",".join(primary_key))
        extra = {"Prefer": "resolution=merge-duplicates,return=minimal"}
        for i in range(0, len(rows), BATCH_SIZE):
            status, _, _ = self._request("POST", table + query, _serialize(rows[i:i + BATCH_SIZE]), extra)
            if status >= 300:
                raise LoadError("write", table, status)

    def count(self, table: str, filters: str = "") -> int:
        status, headers, _ = self._request("GET", table + "?select=*" + filters, None,
                                           {"Prefer": "count=exact", "Range": "0-0", "Range-Unit": "items"})
        if status >= 300:
            raise LoadError("count", table, status)
        return int({k.lower(): v for k, v in headers.items()}["content-range"].split("/")[1])

    def read_rows(self, table: str, columns: list[str]) -> list[Row]:
        """#349 Lê as colunas pedidas de todas as linhas, paginando, em ordem estável. Números voltam como Decimal."""
        rows: list[Row] = []
        start = 0
        while True:
            status, _, body = self._request(
                "GET", f"{table}?select={','.join(columns)}&order={','.join(columns)}", None,
                {"Range": f"{start}-{start + 999}", "Range-Unit": "items"})
            if status >= 300:
                raise LoadError("read", table, status)
            page = json.loads(body, parse_float=Decimal)
            rows += page
            if len(page) < 1000:
                return rows
            start += 1000

    def read_column(self, table: str, column: str) -> list[Json]:
        """Lê uma coluna inteira, paginando. Números voltam como Decimal."""
        values: list[Json] = []
        start = 0
        while True:
            status, _, body = self._request(
                "GET", f"{table}?select={column}&order={column}", None,
                {"Range": f"{start}-{start + 999}", "Range-Unit": "items"})
            if status >= 300:
                raise LoadError("read", table, status)
            page = json.loads(body, parse_float=Decimal)
            values += [p[column] for p in page]
            if len(page) < 1000:
                return values
            start += 1000


def load(client: Supabase, data_dir: str = DATA_DIR) -> dict[str, int]:
    """Grava todas as tabelas, pais antes dos filhos. Devolve {tabela: linhas enviadas}."""
    contract = load_contract(data_dir)
    rows = build_rows(data_dir)
    for t in contract["tables"]:
        client.write(t["name"], rows[t["name"]], t["primary_key"])
    return {n: len(r) for n, r in rows.items()}


def client_from_env(env: Mapping[str, str] = os.environ) -> Supabase:
    url, key = env.get(URL_VAR), env.get(KEY_VAR)
    if not url or not key:
        raise LoadError("config")
    return Supabase(url, key)


def main() -> int:
    try:
        client = client_from_env()
        sent = load(client)
        for table, n in sent.items():
            print(f"{table}: {n} linhas gravadas, {client.count(table)} na tabela")
    except LoadError as e:
        message = describe(e.operation, e.table, e.status)
        print(f"erro: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
