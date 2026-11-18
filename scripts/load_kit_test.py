"""Testes offline da transformação JSON -> linhas da carga da base do kit (#52)."""
import contextlib
import io
import json
import os
import unittest
from decimal import Decimal
from typing import Any
from unittest import mock

import load_kit as ck

# Any: o JSON da fonte só tem forma conhecida em tempo de execução (#52).
Json = Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data", "kit")
EXPECTED = {
    "kit_fornecedores": 12, "kit_produtos": 37, "kit_ordens": 102, "kit_ordem_itens": 288,
    "kit_notas": 80, "kit_nota_itens": 218, "kit_notas_lancadas": 34, "kit_nota_lancada_itens": 98,
    "kit_pagamentos": 9, "kit_recebimentos": 71, "kit_recebimento_itens": 183,
    "kit_regua": 1, "kit_excecoes": 8,
}
SECRET_BODY = "corpo-secreto-do-servidor"


def source_file(name: str) -> Json:
    with open(os.path.join(DATA_DIR, name), encoding="utf-8") as f:
        return json.load(f, parse_float=Decimal)


class TransformTest(unittest.TestCase):
    contract: Json
    rows: dict[str, list[dict[str, Json]]]

    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = ck.load_contract(DATA_DIR)
        cls.rows = ck.build_rows(DATA_DIR)

    def test_count_per_table_matches_contract_rule(self) -> None:
        self.assertEqual(EXPECTED, {t: len(r) for t, r in self.rows.items()})
        for t in self.contract["tables"]:
            with self.subTest(table=t["name"]):
                self.assertEqual(ck.expected_count(t, DATA_DIR), len(self.rows[t["name"]]))

    def test_parents_come_before_children(self) -> None:
        order = list(self.rows)
        for t in self.contract["tables"]:
            for fk in t["foreign_keys"]:
                self.assertLess(order.index(fk["ref_table"]), order.index(t["name"]))

    def test_rows_have_exactly_the_contract_columns(self) -> None:
        for t in self.contract["tables"]:
            columns = [c["name"] for c in t["columns"]]
            for row in self.rows[t["name"]]:
                self.assertEqual(columns, list(row))

    def test_primary_key_is_unique_in_each_table(self) -> None:
        for t in self.contract["tables"]:
            keys = [tuple(r[c] for c in t["primary_key"]) for r in self.rows[t["name"]]]
            self.assertEqual(len(keys), len(set(keys)), t["name"])

    def test_same_input_gives_same_rows(self) -> None:
        self.assertEqual(self.rows, ck.build_rows(DATA_DIR))

    def test_every_supplier_has_a_fictitious_test_email(self) -> None:
        # #156: um e-mail de teste por fornecedor, em domínio .test (nunca um endereço real).
        emails = [r["email"] for r in self.rows["kit_fornecedores"]]
        self.assertEqual(12, len(emails))
        for email in emails:
            self.assertRegex(email, r"^[^@\s]+@[a-z0-9-]+\.test$")
        self.assertEqual(len(emails), len(set(emails)))

    def test_source_nulls_stay_null(self) -> None:
        notes = {r["chave"]: r for r in self.rows["kit_notas"]}
        self.assertEqual(19, sum(r["pedido_referenciado"] is None for r in notes.values()))
        self.assertEqual(9, sum(r["sku"] is None for r in self.rows["kit_nota_itens"]))
        self.assertEqual(9, sum(r["sku"] is None for r in self.rows["kit_ordem_itens"]))
        self.assertEqual(34, sum(r["nota_id"] is None for r in self.rows["kit_notas_lancadas"]))
        self.assertEqual(9, sum(r["nota_chave"] is None for r in self.rows["kit_pagamentos"]))
        self.assertEqual(9, sum(r["ordem_id"] is None for r in self.rows["kit_recebimentos"]))

    def test_ruler_becomes_one_row_with_id_1(self) -> None:
        (row,) = self.rows["kit_regua"]
        source = source_file("regua.json")
        self.assertEqual(1, row["id"])
        self.assertEqual(source["niveis"], row["niveis"])
        self.assertEqual(source["texto"], row["texto"])
        self.assertEqual(Decimal("0.005"), row["tolerancia_percentual"])

    def test_exceptions_become_one_row_per_key(self) -> None:
        source = source_file("excecoes.json")
        self.assertEqual(list(source.items()),
                         [(r["codigo"], r["descricao"]) for r in self.rows["kit_excecoes"]])

    def test_item_carries_parent_key_and_item_fields(self) -> None:
        parent = source_file("notas.json")[0]
        items = [r for r in self.rows["kit_nota_itens"] if r["chave"] == parent["chave"]]
        self.assertEqual(len(parent["itens"]), len(items))
        self.assertEqual(parent["itens"][0]["valor"], items[0]["valor"])

    def test_item_row_takes_missing_fields_from_parent(self) -> None:
        row = ck.item_row({"id": "k1", "valor": 1}, {"valor": 2, "sku": "s"}, ["id", "valor", "sku"])
        self.assertEqual({"id": "k1", "valor": 2, "sku": "s"}, row)

    def test_json_sum_is_exact_decimal(self) -> None:
        total = ck.sum_column(self.rows["kit_ordens"], "valor_total")
        self.assertIsInstance(total, Decimal)
        expected = sum((Decimal(str(o["valor_total"])) for o in source_file("ordens.json")), Decimal(0))
        self.assertEqual(expected, total)


class RepositoryTest(unittest.TestCase):
    def test_no_answer_key_in_the_repository(self) -> None:
        self.assertFalse(os.path.exists(os.path.join(DATA_DIR, "gabarito")))


class SerializationTest(unittest.TestCase):
    def test_decimal_goes_as_text_without_losing_precision(self) -> None:
        body = ck._serialize([{"valor": Decimal("12345678901.23")}])
        self.assertEqual([{"valor": "12345678901.23"}], json.loads(body))


class LoadErrorTest(unittest.TestCase):
    def failing_main(self, error: ck.LoadError) -> str:
        err = io.StringIO()
        with mock.patch.object(ck, "client_from_env", side_effect=error), contextlib.redirect_stderr(err):
            self.assertEqual(1, ck.main())
        return err.getvalue()

    def test_error_carries_named_fields(self) -> None:
        error = ck.LoadError(operation="write", table="kit_notas", status=500)
        self.assertEqual(("write", "kit_notas", 500), (error.operation, error.table, error.status))

    def test_printed_message_has_table_and_status_and_nothing_else(self) -> None:
        error = ck.LoadError(operation="write", table="kit_notas", status=500)
        error.args = (SECRET_BODY,)
        printed = self.failing_main(error)
        self.assertIn("kit_notas", printed)
        self.assertIn("500", printed)
        self.assertNotIn(SECRET_BODY, printed)

    def test_missing_credentials_name_the_variables_not_values(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ck.LoadError) as caught:
                ck.client_from_env()
        self.assertEqual("config", caught.exception.operation)
        printed = self.failing_main(caught.exception)
        self.assertIn(ck.URL_VAR, printed)
        self.assertIn(ck.KEY_VAR, printed)


if __name__ == "__main__":
    unittest.main()
