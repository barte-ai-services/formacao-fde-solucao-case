"""Teste online da exportação das auditorias (#240/AC-1), só de leitura.

Pula, sem falhar, quando BARTE_ACADEMY_SUPABASE_URL ou BARTE_ACADEMY_SUPABASE_SECRET_KEY não
estão no ambiente. Exporta para um arquivo temporário e confere o formato de cada linha.
Nenhum valor de chave é impresso.
"""
import json
import os
import tempfile
import unittest

import export_audits as ea

HAS_CREDENTIALS = bool(os.environ.get(ea.URL_VAR) and os.environ.get(ea.KEY_VAR))


@unittest.skipUnless(HAS_CREDENTIALS, "sem BARTE_ACADEMY_SUPABASE_URL e BARTE_ACADEMY_SUPABASE_SECRET_KEY")
class ExportAuditsOnlineTest(unittest.TestCase):
    def test_exported_lines_carry_the_key_and_the_rule(self) -> None:
        """#240/AC-1: cada linha exportada do banco real tem invoice_access_key e o objeto rule."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "auditorias.jsonl")
            self.assertEqual(ea.main([path]), 0)
            with open(path, encoding="utf-8") as f:
                lines = [json.loads(raw) for raw in f.read().splitlines()]
        for line in lines:
            self.assertIn("invoice_access_key", line)
            self.assertIsInstance(line["rule"], dict)


if __name__ == "__main__":
    unittest.main()
