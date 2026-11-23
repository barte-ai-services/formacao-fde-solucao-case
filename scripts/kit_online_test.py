"""Testes online da base do kit no Supabase (AC-1, AC-2, AC-3 do #52).

Pulam, sem falhar, quando BARTE_ACADEMY_SUPABASE_URL ou BARTE_ACADEMY_SUPABASE_SECRET_KEY não
estão no ambiente. A carga (scripts/load_kit.py) deve ter rodado antes, como no fluxo do
GitHub Actions. Para rodar local:

    set -a; . ./.dev.vars; set +a
    python3 scripts/load_kit.py
    python3 -m unittest discover -s scripts -p 'kit_online_test.py' -v

A chave pública vem de BARTE_ACADEMY_SUPABASE_PUBLISHABLE_KEY; se faltar, o teste a busca na API
de gestão com BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN e BARTE_ACADEMY_SUPABASE_PROJECT_ID. Sem
nenhuma das duas, só o teste da chave pública pula. Nenhum valor de chave é impresso.
"""
import json
import os
import unittest
import urllib.error
import urllib.request
from decimal import Decimal
from typing import Any

import load_kit as ck

# Any: o JSON do contrato e das respostas só tem forma conhecida em tempo de execução (#52).
Json = Any

URL = os.environ.get(ck.URL_VAR)
KEY = os.environ.get(ck.KEY_VAR)
HAS_CREDENTIALS = bool(URL and KEY)


def publishable_key() -> str | None:
    direct = os.environ.get("BARTE_ACADEMY_SUPABASE_PUBLISHABLE_KEY")
    if direct:
        return direct
    token = os.environ.get("BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN")
    project = os.environ.get("BARTE_ACADEMY_SUPABASE_PROJECT_ID")
    if not (token and project):
        return None
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{project}/api-keys",
                                 headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as r:
        keys = json.load(r)
    for kind in ("publishable", "legacy"):
        for k in keys:
            if k.get("type") == kind and (kind == "publishable" or k.get("name") == "anon"):
                return str(k["api_key"])
    return None


def read_with_key(key: str, table: str) -> tuple[int, list[Json]]:
    """Lê a tabela com a chave dada. Devolve (status, corpo); erro HTTP devolve corpo vazio."""
    assert URL
    headers = {"apikey": key}
    if not key.startswith("sb_"):
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(ck.rest_url(URL) + table + "?select=*", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return int(r.status), list(json.load(r))
    except urllib.error.HTTPError as e:
        return e.code, []


@unittest.skipUnless(HAS_CREDENTIALS, "sem BARTE_ACADEMY_SUPABASE_URL/_SECRET_KEY: teste online pulado")
class KitBaseOnlineTest(unittest.TestCase):
    contract: Json
    rows: dict[str, list[dict[str, Json]]]
    client: ck.Supabase

    @classmethod
    def setUpClass(cls) -> None:
        assert URL and KEY
        cls.contract = ck.load_contract()
        cls.rows = ck.build_rows()
        cls.client = ck.Supabase(URL, KEY)

    def counts(self) -> dict[str, int]:
        return {t["name"]: len(self.base_rows(t, [])) for t in self.contract["tables"]}  # #349 a base; a demonstração cresce sozinha

    def base_rows(self, t: Json, columns: list[str]) -> list[dict[str, Json]]:
        """#349 As linhas da base lidas do banco: as de demonstração ficam de fora (ver as decisões do contrato)."""
        key = list(t["primary_key"])
        stored = self.client.read_rows(t["name"], list(dict.fromkeys(key + columns)))
        return ck.base_rows_of(t, stored, self.rows[t["name"]])

    def test_ac1_count_of_each_table_equals_the_json(self) -> None:
        for t in self.contract["tables"]:
            with self.subTest(table=t["name"]):
                expected = ck.expected_count(t)
                found = len(self.base_rows(t, []))
                print(f"  AC-1 {t['name']}: json={expected} supabase(base)={found}")
                self.assertEqual(expected, found)

    def test_ac1_notes_marked_base_count_the_json(self) -> None:
        found = self.client.count("kit_notas", "&origin=eq.base")
        self.assertEqual(ck.expected_count(next(t for t in self.contract["tables"] if t["name"] == "kit_notas")), found)

    def test_ac1_sums_match_the_json_without_tolerance(self) -> None:
        for t in self.contract["tables"]:
            for column in t["sums"]:
                with self.subTest(table=t["name"], column=column):
                    json_sum = ck.sum_column(self.rows[t["name"]], column)
                    db_sum = ck.sum_column(self.base_rows(t, [column]), column)
                    print(f"  soma {t['name']}.{column}: json={json_sum} supabase(base)={db_sum}")
                    self.assertEqual(json_sum, db_sum)

    def test_ac2_repeated_load_changes_no_count(self) -> None:
        before = self.counts()
        ck.load(self.client)
        after = self.counts()
        print(f"  AC-2 antes={before}\n  AC-2 depois={after}")
        self.assertEqual(before, after)

    def test_ac3_publishable_key_reads_no_row(self) -> None:
        public = publishable_key()
        if not public:
            self.skipTest("sem chave pública nem token para buscá-la")
        for t in self.contract["tables"]:
            with self.subTest(table=t["name"]):
                self.assertGreater(self.client.count(t["name"]), 0, "tabela vazia não prova RLS")
                status, body = read_with_key(public, t["name"])
                print(f"  AC-3 {t['name']}: HTTP {status}, {len(body)} linhas")
                self.assertIn(status, (200, 401, 403))
                self.assertEqual([], body)


if __name__ == "__main__":
    unittest.main()
