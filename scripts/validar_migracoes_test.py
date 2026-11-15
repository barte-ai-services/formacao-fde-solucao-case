import unittest

from validar_migracoes import repetidas


class Repetidas(unittest.TestCase):
    def test_acusa_a_mesma_versao_em_dois_arquivos(self):
        self.assertEqual(
            repetidas(["20261116110000_a.sql", "20261116110000_b.sql", "20261117000000_c.sql"]),
            {"20261116110000": ["20261116110000_a.sql", "20261116110000_b.sql"]},
        )

    def test_versoes_distintas_passam(self):
        self.assertEqual(repetidas(["20261116110000_a.sql", "20261116120000_b.sql", "leia.md"]), {})


if __name__ == "__main__":
    unittest.main()
