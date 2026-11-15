"""Testes offline do provisionamento do Cloudflare Access (#54). Nenhum teste toca a rede."""
import contextlib
import io
import json
import unittest
from typing import Any

import cloudflare_access as ca

# Any: o corpo da API da Cloudflare só tem forma conhecida em tempo de execução (#54).
Json = Any

ACCOUNT = "conta-teste"
TOKEN = "token-secreto-de-teste"
OTP_ID = "idp-otp"
APP_ID = "app-1"
AUD = "aud-gerado"
AUTH_DOMAIN = "barte-academy.cloudflareaccess.com"


class FakeClient:
    """Responde como a API da Cloudflare a partir de um estado em memória e registra cada chamada."""

    def __init__(self, idps: list[Json] | None = None, apps: list[Json] | None = None,
                 not_enabled: bool = False) -> None:
        self.idps = list(idps or [])
        self.apps = list(apps or [])
        self.not_enabled = not_enabled
        self.calls: list[tuple[str, str, Json]] = []

    def request(self, method: str, path: str, body: Json = None) -> Json:
        self.calls.append((method, path, body))
        if self.not_enabled:
            raise ca.CloudflareError(method, path, 403, [{"code": 9999, "message": "access.api.error.not_enabled"}])
        base = f"/accounts/{ACCOUNT}/access"
        if (method, path) == ("GET", f"{base}/identity_providers"):
            return self.idps
        if (method, path) == ("POST", f"{base}/identity_providers"):
            created = {**body, "id": OTP_ID}
            self.idps.append(created)
            return created
        if (method, path) == ("GET", f"{base}/apps"):
            return self.apps
        if (method, path) == ("POST", f"{base}/apps"):
            created = {**body, "id": APP_ID, "aud": AUD}
            self.apps.append(created)
            return created
        if method == "PUT" and path.startswith(f"{base}/apps/"):
            app_id = path.rsplit("/", 1)[1]
            for i, app in enumerate(self.apps):
                if app["id"] == app_id:
                    self.apps[i] = {**body, "id": app_id, "aud": app["aud"]}
                    return self.apps[i]
        if (method, path) == ("GET", f"{base}/organizations"):
            return {"auth_domain": AUTH_DOMAIN, "name": "barte-academy"}
        raise AssertionError(f"chamada inesperada: {method} {path}")

    def writes(self) -> list[tuple[str, str, Json]]:
        return [c for c in self.calls if c[0] != "GET"]


def run(client: FakeClient, emails: list[str] | None = None, dry_run: bool = False) -> tuple[int, str]:
    out = io.StringIO()
    code = ca.provision(client, ACCOUNT, emails or [], dry_run=dry_run, out=out)
    return code, out.getvalue()


class EmailParsingTest(unittest.TestCase):
    def test_splits_on_comma_and_whitespace_trims_and_dedupes(self) -> None:
        raw = " a@x.com, b@y.com\nA@x.com  c@z.com,,b@y.com "
        self.assertEqual(["a@x.com", "b@y.com", "c@z.com"], ca.parse_emails(raw))

    def test_empty_or_missing_gives_empty_list(self) -> None:
        self.assertEqual([], ca.parse_emails(""))
        self.assertEqual([], ca.parse_emails(None))
        self.assertEqual([], ca.parse_emails(" , \n "))

    def test_rejects_value_that_is_not_an_email(self) -> None:
        with self.assertRaises(ca.ConfigError):
            ca.parse_emails("a@x.com, nao-e-email")


class ProvisionTest(unittest.TestCase):
    def test_create_path_creates_otp_and_app_and_prints_variables(self) -> None:
        client = FakeClient()
        code, out = run(client, ["aluno@gmail.com"])
        self.assertEqual(0, code)
        methods = [(m, p.rsplit("/", 1)[1]) for m, p, _ in client.writes()]
        self.assertEqual([("POST", "identity_providers"), ("POST", "apps")], methods)
        self.assertEqual({"type": "onetimepin", "name": "Código por e-mail", "config": {}}, client.writes()[0][2])
        app = client.writes()[1][2]
        self.assertEqual("formacao-fde-solucao-case", app["name"])
        self.assertEqual("self_hosted", app["type"])
        self.assertEqual("formacao-fde-solucao-case-api.barte-academy.workers.dev", app["domain"])
        self.assertEqual([OTP_ID], app["allowed_idps"])
        self.assertTrue(app["auto_redirect_to_identity"])
        self.assertEqual("24h", app["session_duration"])
        [policy] = app["policies"]
        self.assertEqual("formacao-fde-solucao-case: barte.com e alunos", policy["name"])
        self.assertEqual("allow", policy["decision"])
        self.assertEqual(1, policy["precedence"])
        self.assertEqual(
            [{"email_domain": {"domain": "barte.com"}}, {"email": {"email": "aluno@gmail.com"}}],
            policy["include"],
        )
        self.assertIn(f"ACCESS_AUD={AUD}\n", out)
        self.assertIn(f"ACCESS_TEAM_DOMAIN={AUTH_DOMAIN}\n", out)

    def test_second_run_updates_without_creating_anything(self) -> None:
        client = FakeClient()
        run(client, ["aluno@gmail.com"])
        state_after_first = json.dumps(client.apps, sort_keys=True)
        client.calls.clear()
        code, out = run(client, ["aluno@gmail.com"])
        self.assertEqual(0, code)
        self.assertEqual([("PUT", f"/accounts/{ACCOUNT}/access/apps/{APP_ID}")], [(m, p) for m, p, _ in client.writes()])
        self.assertEqual(1, len(client.apps))
        self.assertEqual(1, len(client.idps))
        self.assertEqual(state_after_first, json.dumps(client.apps, sort_keys=True))
        self.assertIn(f"ACCESS_AUD={AUD}\n", out)

    def test_update_keeps_the_id_of_the_existing_policy(self) -> None:
        existing = {"id": APP_ID, "name": ca.APP_NAME, "aud": AUD,
                    "policies": [{"id": "pol-1", "name": ca.POLICY_NAME}, {"id": "pol-x", "name": "outra"}]}
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing])
        run(client)
        [policy] = client.writes()[0][2]["policies"]
        self.assertEqual("pol-1", policy["id"])

    def test_otp_is_reused_when_present(self) -> None:
        client = FakeClient(idps=[{"id": "github", "type": "github"}, {"id": OTP_ID, "type": "onetimepin"}])
        run(client)
        self.assertEqual(["apps"], [p.rsplit("/", 1)[1] for _, p, _ in client.writes()])
        self.assertEqual([OTP_ID], client.writes()[0][2]["allowed_idps"])

    def test_without_students_only_barte_domain_is_included(self) -> None:
        client = FakeClient()
        run(client, [])
        include = client.writes()[1][2]["policies"][0]["include"]
        self.assertEqual([{"email_domain": {"domain": "barte.com"}}], include)

    def test_dry_run_writes_nothing_and_prints_payload(self) -> None:
        client = FakeClient()
        code, out = run(client, ["aluno@gmail.com"], dry_run=True)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())
        self.assertIn("POST", out)
        self.assertIn("aluno@gmail.com", out)
        self.assertIn('"onetimepin"', out)
        self.assertIn(f"ACCESS_TEAM_DOMAIN={AUTH_DOMAIN}\n", out)

    def test_not_enabled_explains_the_dashboard_step(self) -> None:
        client = FakeClient(not_enabled=True)
        with self.assertRaises(ca.AccessNotEnabled) as raised:
            run(client)
        message = str(raised.exception)
        self.assertIn("Zero Trust", message)
        self.assertIn("barte-academy", message)
        self.assertIn("Free", message)


class MainTest(unittest.TestCase):
    def main(self, env: dict[str, str], argv: list[str] | None = None,
             client: FakeClient | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        factory = (lambda token: client) if client else None
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ca.main(argv or [], env, client_factory=factory)
        return code, out.getvalue(), err.getvalue()

    def test_missing_env_names_the_variables_and_fails(self) -> None:
        code, _, err = self.main({})
        self.assertNotEqual(0, code)
        self.assertIn(ca.TOKEN_VAR, err)
        self.assertIn(ca.ACCOUNT_VAR, err)

    def test_missing_account_alone_fails(self) -> None:
        code, _, err = self.main({ca.TOKEN_VAR: TOKEN})
        self.assertNotEqual(0, code)
        self.assertNotIn(TOKEN, err)

    def test_reads_students_from_env_and_never_prints_the_token(self) -> None:
        client = FakeClient()
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.EMAILS_VAR: "aluno@gmail.com"}
        code, out, err = self.main(env, client=client)
        self.assertEqual(0, code)
        self.assertNotIn(TOKEN, out + err)
        include = client.writes()[1][2]["policies"][0]["include"]
        self.assertIn({"email": {"email": "aluno@gmail.com"}}, include)

    def test_not_enabled_exits_non_zero_with_portuguese_message(self) -> None:
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT}
        code, _, err = self.main(env, client=FakeClient(not_enabled=True))
        self.assertNotEqual(0, code)
        self.assertIn("Zero Trust", err)

    def test_api_error_prints_status_and_codes_only(self) -> None:
        class Failing(FakeClient):
            def request(self, method: str, path: str, body: Json = None) -> Json:
                raise ca.CloudflareError(method, path, 400, [{"code": 1234, "message": "detalhe-do-servidor"}])

        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT}
        code, _, err = self.main(env, client=Failing())
        self.assertNotEqual(0, code)
        self.assertIn("HTTP 400", err)
        self.assertIn("1234", err)
        self.assertNotIn("detalhe-do-servidor", err)

    def test_dry_run_flag_writes_nothing(self) -> None:
        client = FakeClient()
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT}
        code, _, _ = self.main(env, ["--dry-run"], client=client)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())


class HttpClientTest(unittest.TestCase):
    def test_not_enabled_is_detected_from_error_message(self) -> None:
        error = ca.CloudflareError("GET", "/x", 403, [{"code": 12130, "message": "access.api.error.not_enabled"}])
        self.assertTrue(error.not_enabled)
        self.assertFalse(ca.CloudflareError("GET", "/x", 400, [{"code": 1, "message": "outra"}]).not_enabled)


if __name__ == "__main__":
    unittest.main()
