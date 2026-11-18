"""Teste do contrato de dados da base do kit (offline, #52).

Lê data/kit/contrato.json e a migração supabase/migrations/*_base_do_kit.sql e confere que cada
tabela do contrato existe com exatamente as suas colunas, tipos, chave primária, chaves
estrangeiras, únicas e checks, com RLS ligado e nenhuma política.
"""
import glob
import json
import os
import re
import unittest
from typing import Any

# Any: o JSON do contrato só tem forma conhecida em tempo de execução (#52).
Json = Any
ColumnSpec = tuple[str, bool]
ForeignKey = tuple[tuple[str, ...], str, tuple[str, ...]]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTRACT = os.path.join(ROOT, "data", "kit", "contrato.json")
MIGRATIONS = os.path.join(ROOT, "supabase", "migrations")


class SqlTable:
    def __init__(self) -> None:
        self.columns: dict[str, ColumnSpec] = {}
        self.primary_key: list[str] = []
        self.foreign_keys: list[ForeignKey] = []
        self.unique: list[tuple[str, ...]] = []
        self.checks: list[str] = []


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower()).replace("( ", "(").replace(" )", ")")


def load_contract() -> Json:
    with open(CONTRACT, encoding="utf-8") as f:
        return json.load(f)


def load_sql() -> str:
    files = sorted(glob.glob(os.path.join(MIGRATIONS, "*_base_do_kit.sql")))
    if not files:
        raise AssertionError("migração *_base_do_kit.sql ausente em supabase/migrations/")
    with open(files[0], encoding="utf-8") as f:
        sql = f.read()
    return re.sub(r"--[^\n]*", "", sql)


def read_added_columns(tables: dict[str, "SqlTable"]) -> None:
    """Colunas que migrações posteriores à base acrescentam a uma tabela kit_ (alter table ... add column, #12)."""
    for path in sorted(glob.glob(os.path.join(MIGRATIONS, "*.sql"))):
        if path.endswith("_base_do_kit.sql"):
            continue
        with open(path, encoding="utf-8") as f:
            sql = re.sub(r"--[^\n]*", "", f.read())
        for m in re.finditer(r"alter table public\.(kit_\w+)\s+add column (\w+) (\w+)( not null)?", sql, re.I):
            tables[m.group(1)].columns[m.group(2)] = (m.group(3).lower(), m.group(4) is None)


def split_on_commas(body: str) -> list[str]:
    """Divide o corpo de um create table nas vírgulas de nível zero."""
    parts: list[str] = []
    depth = 0
    current = ""
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current)
    return [normalize(p) for p in parts if p.strip()]


def names_in(group: str) -> tuple[str, ...]:
    return tuple(x.strip() for x in group.split(","))


def read_tables(sql: str) -> dict[str, SqlTable]:
    tables: dict[str, SqlTable] = {}
    for m in re.finditer(r"create table public\.(\w+)\s*\((.*?)\n\);", sql, re.S | re.I):
        table = SqlTable()
        for part in split_on_commas(m.group(2)):
            part = re.sub(r"^constraint \w+ ", "", part)
            if part.startswith("primary key"):
                found = re.search(r"\((.*)\)", part)
                assert found
                table.primary_key = list(names_in(found.group(1)))
            elif part.startswith("foreign key"):
                g = re.match(r"foreign key \((.*?)\) references public\.(\w+) ?\((.*?)\)$", part)
                assert g
                table.foreign_keys.append((names_in(g.group(1)), g.group(2), names_in(g.group(3))))
            elif part.startswith("unique"):
                found = re.search(r"\((.*)\)", part)
                assert found
                table.unique.append(names_in(found.group(1)))
            elif part.startswith("check"):
                g = re.match(r"check \((.*)\)$", part)
                assert g
                table.checks.append(normalize(g.group(1)))
            else:
                g = re.match(r"(\w+) (.+?)( not null)?$", part)
                assert g
                table.columns[g.group(1)] = (g.group(2).replace(" ", ""), g.group(3) is None)
        tables[m.group(1)] = table
    return tables


class ContractTest(unittest.TestCase):
    contract: Json
    error: str | None
    sql: str
    tables: dict[str, SqlTable]

    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = load_contract()
        cls.error = None
        try:
            cls.sql = load_sql()
            cls.tables = read_tables(cls.sql)
            read_added_columns(cls.tables)
        except AssertionError as e:
            cls.error = str(e)

    def setUp(self) -> None:
        if self.error:
            self.fail(self.error)

    def test_contract_declares_the_essentials(self) -> None:
        c = self.contract
        for key in ("pinned_source", "freshness", "breaking_change", "consumer", "completeness",
                    "reconciliation", "tables"):
            self.assertIn(key, c)
        self.assertTrue(all(t["name"].startswith(c["table_prefix"]) for t in c["tables"]))

    def test_contract_points_to_the_naming_decision(self) -> None:
        self.assertEqual("ADR-001", self.contract["naming_decision"])
        self.assertTrue(os.path.exists(os.path.join(ROOT, "docs", "adr", "ADR-001-kit-base-names.md")))

    def test_only_contract_tables_exist(self) -> None:
        expected = {t["name"] for t in self.contract["tables"]}
        self.assertEqual(expected, set(self.tables))

    def test_each_table_has_the_contract_columns(self) -> None:
        for t in self.contract["tables"]:
            with self.subTest(table=t["name"]):
                expected = {c["name"]: (c["type"].replace(" ", ""), c["nullable"]) for c in t["columns"]}
                self.assertEqual(expected, self.tables[t["name"]].columns)
                self.assertEqual([c["name"] for c in t["columns"]], list(self.tables[t["name"]].columns))

    def test_every_supplier_column_the_contract_declares_comes_from_a_migration(self) -> None:
        # #12: o e-mail do fornecedor entra por migração posterior; o contrato o declara anulável.
        supplier = next(t for t in self.contract["tables"] if t["name"] == "kit_fornecedores")
        email = next(c for c in supplier["columns"] if c["name"] == "email")
        self.assertEqual({"name": "email", "type": "text", "nullable": True}, email)
        self.assertEqual(("text", True), self.tables["kit_fornecedores"].columns["email"])

    def test_primary_keys(self) -> None:
        for t in self.contract["tables"]:
            with self.subTest(table=t["name"]):
                self.assertEqual(t["primary_key"], self.tables[t["name"]].primary_key)

    def test_foreign_keys(self) -> None:
        for t in self.contract["tables"]:
            with self.subTest(table=t["name"]):
                expected = sorted((tuple(f["columns"]), f["ref_table"], tuple(f["ref_columns"]))
                                  for f in t["foreign_keys"])
                self.assertEqual(expected, sorted(self.tables[t["name"]].foreign_keys))

    def test_unique_and_checks(self) -> None:
        for t in self.contract["tables"]:
            with self.subTest(table=t["name"]):
                self.assertEqual(sorted(tuple(u) for u in t["unique"]), sorted(self.tables[t["name"]].unique))
                self.assertEqual(sorted(normalize(c) for c in t["checks"]), sorted(self.tables[t["name"]].checks))

    def test_rls_enabled_on_every_table(self) -> None:
        for t in self.contract["tables"]:
            with self.subTest(table=t["name"]):
                pattern = rf"alter table public\.{t['name']}\s+enable row level security\s*;"
                self.assertRegex(self.sql, re.compile(pattern, re.I))
        self.assertNotRegex(self.sql, re.compile(r"disable row level security", re.I))

    def test_no_policy(self) -> None:
        self.assertNotRegex(self.sql, re.compile(r"create\s+policy", re.I))

    def test_kit_declarations_carry_the_decision_pointer(self) -> None:
        with open(glob.glob(os.path.join(MIGRATIONS, "*_base_do_kit.sql"))[0], encoding="utf-8") as f:
            lines = f.read().splitlines()
        inside = False
        for number, line in enumerate(lines, 1):
            if line.startswith("create table"):
                inside = True
            elif line == ");":
                inside = False
                continue
            if inside or line.startswith("alter table"):
                with self.subTest(line=number):
                    self.assertIn("-- ADR-001", line)


if __name__ == "__main__":
    unittest.main()
