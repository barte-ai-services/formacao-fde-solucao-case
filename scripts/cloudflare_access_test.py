"""Testes offline do provisionamento do Cloudflare Access (#54, #232). Nenhum teste toca a rede."""
from __future__ import annotations

import contextlib
import io
import json
import re
import unittest
from pathlib import Path
from typing import Any

import cloudflare_access as ca

# Any: o corpo da API da Cloudflare só tem forma conhecida em tempo de execução (#54).
Json = Any

ACCOUNT = "conta-teste"
TOKEN = "token-secreto-de-teste"
OTP_ID = "idp-otp"
POLICY_ID = "pol-new"
APP_ID = "app-1"
AUD = "aud-gerado"
AUTH_DOMAIN = "long-frost-f16b.cloudflareaccess.com"
APP_DOMAIN = "api.example.com"
STUDENT_EMAIL = "aluno@example.com"
ROOT = Path(__file__).resolve().parent.parent
BASE = f"/accounts/{ACCOUNT}/access"


class FakeClient:
    """Responde como a API da Cloudflare a partir de um estado em memória e registra cada chamada."""

    def __init__(self, idps: list[Json] | None = None, apps: list[Json] | None = None,
                 policies: list[Json] | None = None, not_enabled: bool = False) -> None:
        self.idps = list(idps or [])
        self.apps = list(apps or [])
        self.policies = list(policies or [])
        self.not_enabled = not_enabled
        self.calls: list[tuple[str, str, Json]] = []

    def request(self, method: str, path: str, body: Json = None) -> Json:
        self.calls.append((method, path, body))
        if self.not_enabled:
            raise ca.CloudflareError(method, path, 403, [{"code": 9999, "message": "access.api.error.not_enabled"}])
        kind, _, item = path.removeprefix(BASE).lstrip("/").partition("/")
        handler = getattr(self, f"_{method.lower()}_{kind}", None)
        if handler is None:
            raise AssertionError(f"chamada inesperada: {method} {path}")
        return handler(item, body)

    def writes(self) -> list[tuple[str, str, Json]]:
        return [c for c in self.calls if c[0] != "GET"]

    def _get_identity_providers(self, item: str, body: Json) -> Json:
        return self.idps

    def _post_identity_providers(self, item: str, body: Json) -> Json:
        created = {**body, "id": OTP_ID}
        self.idps.append(created)
        return created

    def _get_apps(self, item: str, body: Json) -> Json:
        return self.apps

    def _post_apps(self, item: str, body: Json) -> Json:
        created = {**body, "id": APP_ID, "aud": AUD}
        self.apps.append(created)
        return created

    def _put_apps(self, item: str, body: Json) -> Json:
        """Recusa o que a Cloudflare recusa: política reutilizável (link) e da aplicação (inline) no mesmo PUT."""
        policies = body.get("policies") or []
        if len({_is_link(p) for p in policies}) > 1:
            raise AssertionError("o PUT da aplicação mistura link e política inline")
        for i, app in enumerate(self.apps):
            if app["id"] == item:
                stored = [self._hydrate(p) if _is_link(p) else p for p in policies]
                self.apps[i] = {**body, "policies": stored, "id": item, "aud": app["aud"]}
                return self.apps[i]
        raise AssertionError(f"aplicação desconhecida: {item}")

    def _hydrate(self, link: Json) -> Json:
        """Como o GET devolve um link: a política reutilizável inteira, com `reusable` e a precedência do link."""
        policy_id = link if isinstance(link, str) else link["id"]
        known = next(p for p in self.policies if p["id"] == policy_id)
        return {**known, "reusable": True, **({} if isinstance(link, str) else link)}

    def _get_policies(self, item: str, body: Json) -> Json:
        return self.policies

    def _post_policies(self, item: str, body: Json) -> Json:
        created = {**body, "id": POLICY_ID}
        self.policies.append(created)
        return created

    def _put_policies(self, item: str, body: Json) -> Json:
        for i, known in enumerate(self.policies):
            if known["id"] == item:
                self.policies[i] = {**body, "id": item}
                return self.policies[i]
        raise AssertionError(f"política desconhecida: {item}")

    def _get_organizations(self, item: str, body: Json) -> Json:
        return {"auth_domain": AUTH_DOMAIN, "name": "time-de-teste"}


def _is_link(policy: Json) -> bool:
    """Um item de `policies` do PUT é link se for o UUID ou só `id` e `precedence`; o resto é inline (#232)."""
    return isinstance(policy, str) or set(policy) <= {"id", "precedence"}


OTHER_POLICY = {"id": "pol-x", "name": "outra", "decision": "allow",
                "include": [{"email_domain": {"domain": "alheio.example.com"}}]}


def existing_app(**changes: Json) -> Json:
    """Uma aplicação criada fora do script, com nome, domínio e ajustes próprios."""
    app = {"id": APP_ID, "name": "nome-vigente", "domain": "vigente.example.com", "type": "self_hosted",
           "aud": AUD, "allowed_idps": [OTP_ID], "session_duration": "12h",
           "auto_redirect_to_identity": False,
           "policies": [{"id": "pol-1", "name": ca.POLICY_NAME}, OTHER_POLICY]}
    return {**app, **changes}


def options(emails: list[str] | None = None, **changes: Json) -> ca.Options:
    return ca.Options(**{"aud": AUD, **changes, "emails": tuple(emails or ())})


def run(client: FakeClient, **kwargs: Json) -> tuple[int, str]:
    out = io.StringIO()
    code = ca.provision(client, ACCOUNT, options(**kwargs), out=out)
    return code, out.getvalue()


class EmailParsingTest(unittest.TestCase):
    def test_splits_on_comma_and_whitespace_trims_and_dedupes(self) -> None:
        raw = " a@x.com, b@y.com\nA@x.com  c@z.com,,b@y.com "
        self.assertEqual(["a@x.com", "b@y.com", "c@z.com"], ca.parse_emails(raw))

    def test_empty_or_missing_gives_empty_list(self) -> None:
        self.assertEqual([], ca.parse_emails(""))
        self.assertEqual([], ca.parse_emails(None))
        self.assertEqual([], ca.parse_emails(" , \n "))

    def test_rejects_value_that_is_not_an_email_without_echoing_it(self) -> None:
        with self.assertRaises(ca.ConfigError) as raised:
            ca.parse_emails("a@x.com, nao-e-email")
        self.assertIn(ca.EMAILS_VAR, str(raised.exception))
        self.assertNotIn("nao-e-email", str(raised.exception))


class UpdateExistingAppTest(unittest.TestCase):
    def test_put_on_the_app_of_the_aud_and_no_post_to_apps(self) -> None:
        """#232/AC-1: com o AUD de uma aplicação existente, só há PUT nela."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        code, _ = run(client, emails=[STUDENT_EMAIL])
        self.assertEqual(0, code)
        self.assertEqual([("PUT", f"{BASE}/apps/{APP_ID}")], [(m, p) for m, p, _ in client.writes()])
        self.assertEqual(1, len(client.apps))

    def test_name_domain_and_aud_stay_as_they_were(self) -> None:
        """#232/AC-1: nome, domínio e AUD ficam como estavam."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client, emails=[STUDENT_EMAIL])
        sent = client.writes()[0][2]
        self.assertEqual("nome-vigente", sent["name"])
        self.assertEqual("vigente.example.com", sent["domain"])
        self.assertEqual(AUD, client.apps[0]["aud"])

    def test_session_and_login_settings_the_app_already_has_are_kept(self) -> None:
        """#232/AC-1: o PUT não sobrescreve ajustes que a aplicação já tem."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client, emails=[STUDENT_EMAIL])
        sent = client.writes()[0][2]
        self.assertEqual("12h", sent["session_duration"])
        self.assertFalse(sent["auto_redirect_to_identity"])
        self.assertEqual([OTP_ID], sent["allowed_idps"])

    def test_other_identity_providers_are_kept_and_the_otp_is_added(self) -> None:
        """#232/AC-1: os provedores que a aplicação já tem ficam, e o código por e-mail entra."""
        client = FakeClient(apps=[existing_app(allowed_idps=["github"])])
        run(client, emails=[STUDENT_EMAIL])
        self.assertEqual([("POST", f"{BASE}/identity_providers"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])
        self.assertEqual(["github", OTP_ID], client.writes()[1][2]["allowed_idps"])

    def test_policy_has_barte_domain_and_every_email_and_keeps_its_id(self) -> None:
        """#232/AC-3: a política enviada inclui barte.com e cada e-mail."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client, emails=[STUDENT_EMAIL, "outra@example.com"])
        policy = next(p for p in client.writes()[0][2]["policies"] if p["name"] == ca.POLICY_NAME)
        self.assertEqual("pol-1", policy["id"])
        self.assertEqual("allow", policy["decision"])
        self.assertEqual(
            [{"email_domain": {"domain": "barte.com"}}, {"email": {"email": STUDENT_EMAIL}},
             {"email": {"email": "outra@example.com"}}],
            policy["include"],
        )

    def test_second_run_changes_nothing(self) -> None:
        """#232/AC-1: rodar de novo deixa o mesmo estado."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client, emails=[STUDENT_EMAIL])
        first = json.dumps(client.apps, sort_keys=True)
        run(client, emails=[STUDENT_EMAIL])
        self.assertEqual(first, json.dumps(client.apps, sort_keys=True))
        self.assertEqual(1, len(client.apps))

    def test_prints_team_domain_and_not_the_aud(self) -> None:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        _, out = run(client, emails=[STUDENT_EMAIL])
        self.assertIn(f"ACCESS_TEAM_DOMAIN={AUTH_DOMAIN}\n", out)
        self.assertNotIn(AUD, out)


class PreserveExistingAppTest(unittest.TestCase):
    def put_body(self, app: Json, idps: list[Json] | None = None) -> Json:
        client = FakeClient(idps=idps or [{"id": OTP_ID, "type": "onetimepin"}], apps=[app])
        run(client, emails=[STUDENT_EMAIL])
        return client.writes()[0][2]

    def test_extra_fields_of_the_app_survive_the_put(self) -> None:
        """#232/AC-1: o PUT parte da aplicação existente; campos que o script não conhece ficam."""
        body = self.put_body(existing_app(cors_headers={"allow_all_origins": True}, tags=["fde"]))
        self.assertEqual({"allow_all_origins": True}, body["cors_headers"])
        self.assertEqual(["fde"], body["tags"])

    def test_read_only_fields_are_not_sent(self) -> None:
        """#232/AC-1: id, aud e carimbos de data são só leitura e não vão no corpo."""
        body = self.put_body(existing_app(created_at="2026-01-01", updated_at="2026-02-01"))
        for field in ca.READ_ONLY_APP_FIELDS:
            self.assertNotIn(field, body)

    def test_another_policy_of_the_app_survives_in_the_form_it_came(self) -> None:
        """#232/AC-1: a política da aplicação com outro nome fica, e a do script é a única trocada."""
        body = self.put_body(existing_app())
        self.assertEqual(["pol-1", "pol-x"], [p["id"] for p in body["policies"]])
        self.assertEqual(OTHER_POLICY, body["policies"][1])
        self.assertEqual(ca.POLICY_NAME, body["policies"][0]["name"])

    def test_other_policy_is_reduced_to_the_keys_the_inline_request_accepts(self) -> None:
        """#232/AC-1: sem política reutilizável, as alheias vão sem os campos só de leitura."""
        extra = {"created_at": "2026-01-01", "updated_at": "2026-02-01", "account_id": ACCOUNT, "reusable": False}
        body = self.put_body(existing_app(policies=[{**OTHER_POLICY, **extra, "precedence": 1}]))
        self.assertEqual({**OTHER_POLICY, "precedence": 1}, body["policies"][0])
        self.assertLessEqual(set(body["policies"][0]), set(ca.INLINE_POLICY_KEYS))

    def test_script_policy_is_appended_when_the_app_has_none_of_its_own(self) -> None:
        """#232/AC-3: sem política do script, ela entra depois das que a aplicação já tem."""
        body = self.put_body(existing_app(policies=[{"id": "pol-x", "name": "outra", "precedence": 1}]))
        self.assertEqual(["outra", ca.POLICY_NAME], [p["name"] for p in body["policies"]])
        self.assertNotIn("id", body["policies"][1])
        self.assertEqual(2, body["policies"][1]["precedence"])

    def test_empty_allowed_idps_is_kept_empty_because_it_means_every_idp(self) -> None:
        """#232/AC-1: allowed_idps vazio é "todos os provedores"; não vira só o código por e-mail."""
        self.assertEqual([], self.put_body(existing_app(allowed_idps=[]))["allowed_idps"])

    def test_absent_allowed_idps_stays_absent(self) -> None:
        """#232/AC-1: sem allowed_idps na aplicação, o corpo também não os traz."""
        app = existing_app()
        del app["allowed_idps"]
        self.assertNotIn("allowed_idps", self.put_body(app))

    def test_options_emails_are_immutable(self) -> None:
        self.assertIsInstance(options(emails=[STUDENT_EMAIL]).emails, tuple)

    def test_app_request_decides_method_path_and_body_without_calling_the_api(self) -> None:
        method, route, body = ca.app_request(existing_app(), OTP_ID, options(emails=[STUDENT_EMAIL]), None)
        self.assertEqual(("PUT", f"/access/apps/{APP_ID}"), (method, route))
        self.assertEqual("nome-vigente", body["name"])
        method, route, body = ca.app_request(None, OTP_ID, options(
            emails=[STUDENT_EMAIL], aud="", create=True, app_domain=APP_DOMAIN), None)
        self.assertEqual(("POST", "/access/apps"), (method, route))
        self.assertEqual(APP_DOMAIN, body["domain"])


def reusable_client(script_policy_in_account: bool) -> FakeClient:
    """Uma aplicação cujas políticas são reutilizáveis, como o GET as devolve, e a conta que as guarda."""
    mine = {"id": "pol-r1", "name": ca.POLICY_NAME, "decision": "allow", "include": [{"email": {"email": "x@example.com"}}]}
    other = {**OTHER_POLICY, "id": "pol-r2", "created_at": "2026-01-01"}
    app_policies = [{**mine, "reusable": True, "precedence": 1}, {**other, "reusable": True, "precedence": 2}]
    if not script_policy_in_account:
        app_policies = app_policies[1:]
    account = ([mine] if script_policy_in_account else []) + [other]
    return FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app(policies=app_policies)],
                      policies=account)


class ReusablePoliciesTest(unittest.TestCase):
    def test_script_policy_found_by_name_is_updated_and_the_app_gets_only_links(self) -> None:
        """#232/AC-1: com política reutilizável, a do script é atualizada na conta e o PUT manda só links."""
        client = reusable_client(script_policy_in_account=True)
        run(client, emails=[STUDENT_EMAIL])
        self.assertEqual([("PUT", f"{BASE}/policies/pol-r1"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])
        sent = client.writes()[0][2]
        self.assertIn({"email": {"email": STUDENT_EMAIL}}, sent["include"])
        self.assertIn({"email_domain": {"domain": "barte.com"}}, sent["include"])
        self.assertEqual([{"id": "pol-r1", "precedence": 1}, {"id": "pol-r2", "precedence": 2}],
                         client.writes()[1][2]["policies"])

    def test_missing_script_policy_is_created_in_the_account_after_the_others(self) -> None:
        """#232/AC-1: sem a política do script na conta, POST em /access/policies; precedência maior+1."""
        client = reusable_client(script_policy_in_account=False)
        run(client, emails=[STUDENT_EMAIL])
        self.assertEqual([("POST", f"{BASE}/policies"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])
        self.assertEqual([{"id": "pol-r2", "precedence": 2}, {"id": POLICY_ID, "precedence": 3}],
                         client.writes()[1][2]["policies"])

    def test_no_post_to_apps_and_name_domain_and_aud_stay(self) -> None:
        """#232/AC-1: nesse caminho também só há PUT na aplicação."""
        client = reusable_client(script_policy_in_account=False)
        run(client, emails=[STUDENT_EMAIL])
        self.assertNotIn(("POST", f"{BASE}/apps"), [(m, p) for m, p, _ in client.writes()])
        self.assertEqual(("nome-vigente", "vigente.example.com", AUD),
                         (client.apps[0]["name"], client.apps[0]["domain"], client.apps[0]["aud"]))

    def test_second_run_changes_nothing(self) -> None:
        """#232/AC-1: rodar de novo, com política reutilizável, deixa o mesmo estado."""
        client = reusable_client(script_policy_in_account=False)
        run(client, emails=[STUDENT_EMAIL])
        first = json.dumps([client.apps, client.policies], sort_keys=True)
        run(client, emails=[STUDENT_EMAIL])
        self.assertEqual(first, json.dumps([client.apps, client.policies], sort_keys=True))

    def test_fake_refuses_a_put_that_mixes_link_and_inline(self) -> None:
        client = FakeClient(apps=[existing_app()])
        mixed = {"policies": [{"id": "pol-r1", "precedence": 1}, {"name": "x", "decision": "allow"}]}
        with self.assertRaises(AssertionError):
            client.request("PUT", f"{BASE}/apps/{APP_ID}", mixed)


class UnknownAudTest(unittest.TestCase):
    def test_aud_that_matches_no_app_fails_naming_the_variable_and_writes_nothing(self) -> None:
        """#232/AC-2: AUD sem aplicação correspondente sai com erro que nomeia a variável."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        with self.assertRaises(ca.ConfigError) as raised:
            run(client, emails=[STUDENT_EMAIL], aud="aud-que-nao-existe")
        self.assertIn(ca.AUD_VAR, str(raised.exception))
        self.assertNotIn("aud-que-nao-existe", str(raised.exception))
        self.assertEqual([], client.writes())

    def test_app_with_the_same_name_but_another_aud_is_not_touched(self) -> None:
        """#232/AC-2: o nome não basta para achar a aplicação; só o AUD."""
        client = FakeClient(apps=[existing_app(name=ca.APP_NAME)])
        with self.assertRaises(ca.ConfigError):
            run(client, emails=[STUDENT_EMAIL], aud="outro-aud")
        self.assertEqual([], client.writes())

    def test_missing_aud_without_create_fails_naming_the_variable_before_any_call(self) -> None:
        """#232/AC-2: sem AUD e sem --create não se grava nem se consulta nada."""
        client = FakeClient(apps=[existing_app()])
        with self.assertRaises(ca.ConfigError) as raised:
            run(client, emails=[STUDENT_EMAIL], aud="")
        self.assertIn(ca.AUD_VAR, str(raised.exception))
        self.assertEqual([], client.calls)

    def test_main_exits_non_zero_naming_the_variable(self) -> None:
        """#232/AC-2: pela linha de comando, código != 0 e a mensagem nomeia a variável."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.EMAILS_VAR: STUDENT_EMAIL, ca.AUD_VAR: "nenhum"}
        code, _, err = run_main(env, client=client)
        self.assertNotEqual(0, code)
        self.assertIn(ca.AUD_VAR, err)
        self.assertEqual([], client.writes())


class EmailsRequiredTest(unittest.TestCase):
    def test_real_run_without_emails_refuses_and_writes_nothing(self) -> None:
        """#232/AC-3: execução real sem e-mails recusa com erro e não grava nada."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        with self.assertRaises(ca.ConfigError) as raised:
            run(client, emails=[])
        self.assertIn(ca.EMAILS_VAR, str(raised.exception))
        self.assertEqual([], client.calls)

    def test_main_real_run_without_emails_exits_non_zero(self) -> None:
        """#232/AC-3: pela linha de comando, sem e-mails, código != 0 e nada gravado."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        code, _, err = run_main({ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.AUD_VAR: AUD}, client=client)
        self.assertNotEqual(0, code)
        self.assertIn(ca.EMAILS_VAR, err)
        self.assertEqual([], client.writes())

    def test_dry_run_without_emails_is_allowed(self) -> None:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        code, _ = run(client, emails=[], dry_run=True)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())


class DryRunTest(unittest.TestCase):
    def test_dry_run_writes_nothing_and_shows_the_put_without_the_emails(self) -> None:
        """#232/AC-3, #232/AC-5: o dry-run mostra o PUT, mascara os e-mails e conta quantos são."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        code, out = run(client, emails=[STUDENT_EMAIL, "outra@example.com"], dry_run=True)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())
        self.assertIn("PUT", out)
        self.assertIn("barte.com", out)
        self.assertNotIn(STUDENT_EMAIL, out)
        self.assertNotIn("outra@example.com", out)
        self.assertIn("2 e-mail(s)", out)

    def test_dry_run_with_missing_otp_shows_the_post_and_writes_nothing(self) -> None:
        client = FakeClient(apps=[existing_app()])
        code, out = run(client, emails=[STUDENT_EMAIL], dry_run=True)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())
        self.assertIn('"onetimepin"', out)
        self.assertIn("+ código por e-mail", out)
        self.assertNotIn(ACCOUNT, out)

    def test_dry_run_summarizes_the_put_in_named_fields_without_the_other_policies_content(self) -> None:
        """#232/AC-5: o dry-run não imprime a configuração da aplicação, a política alheia nem a conta."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        _, out = run(client, emails=[STUDENT_EMAIL], dry_run=True)
        self.assertIn(f"[dry-run] PUT /access/apps/{APP_ID}\n", out)
        self.assertIn("allowed_idps: inalterado", out)
        self.assertIn("policies: 2 no total; a do script na precedência 1, com barte.com e 1 e-mail(s)", out)
        self.assertIn("outras políticas: 1, mantidas", out)
        self.assertIn("pol-x", out)
        self.assertNotRegex(out, r"\boutra\b")
        for hidden in ("alheio", ACCOUNT, "nome-vigente", "vigente.example.com", STUDENT_EMAIL):
            self.assertNotIn(hidden, out)

    def test_dry_run_of_reusable_policies_says_the_path_and_touches_no_policy(self) -> None:
        """#232/AC-5: no dry-run, nenhum POST/PUT em /access/policies, e o resumo diz o caminho."""
        client = reusable_client(script_policy_in_account=False)
        _, out = run(client, emails=[STUDENT_EMAIL], dry_run=True)
        self.assertEqual([], client.writes())
        self.assertIn("reutilizáveis", out)
        self.assertNotRegex(out, r"\boutra\b")
        _, inline_out = run(FakeClient(idps=client.idps, apps=[existing_app()]), emails=[STUDENT_EMAIL], dry_run=True)
        self.assertIn("da aplicação", inline_out)


class CreateTest(unittest.TestCase):
    def test_create_flag_creates_otp_and_app_and_prints_the_new_aud(self) -> None:
        client = FakeClient()
        code, out = run(client, emails=[STUDENT_EMAIL], aud="", create=True, app_domain=APP_DOMAIN)
        self.assertEqual(0, code)
        self.assertEqual([("POST", f"{BASE}/identity_providers"), ("POST", f"{BASE}/apps")],
                         [(m, p) for m, p, _ in client.writes()])
        app = client.writes()[1][2]
        self.assertEqual(ca.APP_NAME, app["name"])
        self.assertEqual(APP_DOMAIN, app["domain"])
        self.assertEqual([OTP_ID], app["allowed_idps"])
        self.assertIn(f"ACCESS_AUD={AUD}\n", out)

    def test_create_needs_the_domain_and_writes_nothing_without_it(self) -> None:
        client = FakeClient()
        with self.assertRaises(ca.ConfigError) as raised:
            run(client, emails=[STUDENT_EMAIL], aud="", create=True)
        self.assertIn(ca.APP_DOMAIN_VAR, str(raised.exception))
        self.assertEqual([], client.writes())

    def test_create_with_a_known_aud_still_only_updates(self) -> None:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client, emails=[STUDENT_EMAIL], create=True, app_domain=APP_DOMAIN)
        self.assertEqual(["PUT"], [m for m, _, _ in client.writes()])

    def test_create_with_an_unknown_aud_creates_instead_of_failing(self) -> None:
        client = FakeClient(apps=[existing_app()])
        code, _ = run(client, emails=[STUDENT_EMAIL], aud="novo", create=True, app_domain=APP_DOMAIN)
        self.assertEqual(0, code)
        self.assertIn("POST", [m for m, p, _ in client.writes() if p.endswith("/apps")])


class NotEnabledTest(unittest.TestCase):
    def test_not_enabled_explains_the_dashboard_step_without_naming_a_team(self) -> None:
        client = FakeClient(not_enabled=True)
        with self.assertRaises(ca.AccessNotEnabled) as raised:
            run(client, emails=[STUDENT_EMAIL])
        message = str(raised.exception)
        self.assertIn("Zero Trust", message)
        self.assertIn("Free", message)
        self.assertNotIn("barte-academy", message)


def run_main(env: dict[str, str], argv: list[str] | None = None,
             client: FakeClient | None = None) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    factory = (lambda token: client) if client else None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = ca.main(argv or [], env, client_factory=factory)
    return code, out.getvalue(), err.getvalue()


class MainTest(unittest.TestCase):
    def test_missing_env_names_the_variables_and_fails(self) -> None:
        code, _, err = run_main({})
        self.assertNotEqual(0, code)
        self.assertIn(ca.TOKEN_VAR, err)
        self.assertIn(ca.ACCOUNT_VAR, err)

    def test_missing_account_alone_fails(self) -> None:
        code, _, err = run_main({ca.TOKEN_VAR: TOKEN})
        self.assertNotEqual(0, code)
        self.assertNotIn(TOKEN, err)

    def test_reads_students_and_aud_from_env_and_never_prints_the_token(self) -> None:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.EMAILS_VAR: STUDENT_EMAIL, ca.AUD_VAR: AUD}
        code, out, err = run_main(env, client=client)
        self.assertEqual(0, code)
        self.assertNotIn(TOKEN, out + err)
        self.assertNotIn(STUDENT_EMAIL, out + err)
        self.assertIn({"email": {"email": STUDENT_EMAIL}}, client.writes()[0][2]["policies"][0]["include"])

    def test_create_flag_reads_the_domain_from_env(self) -> None:
        client = FakeClient()
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.EMAILS_VAR: STUDENT_EMAIL, ca.APP_DOMAIN_VAR: APP_DOMAIN}
        code, _, _ = run_main(env, ["--create"], client=client)
        self.assertEqual(0, code)
        self.assertEqual(APP_DOMAIN, client.writes()[1][2]["domain"])

    def test_not_enabled_exits_non_zero_with_portuguese_message(self) -> None:
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.EMAILS_VAR: STUDENT_EMAIL, ca.AUD_VAR: AUD}
        code, _, err = run_main(env, client=FakeClient(not_enabled=True))
        self.assertNotEqual(0, code)
        self.assertIn("Zero Trust", err)

    def test_invalid_email_does_not_echo_the_value(self) -> None:
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.EMAILS_VAR: "aluno-sem-arroba", ca.AUD_VAR: AUD}
        code, _, err = run_main(env, client=FakeClient())
        self.assertNotEqual(0, code)
        self.assertNotIn("aluno-sem-arroba", err)

    def test_api_error_prints_status_and_codes_only(self) -> None:
        class Failing(FakeClient):
            def request(self, method: str, path: str, body: Json = None) -> Json:
                raise ca.CloudflareError(method, path, 400, [{"code": 1234, "message": "detalhe-do-servidor"}])

        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.EMAILS_VAR: STUDENT_EMAIL, ca.AUD_VAR: AUD}
        code, _, err = run_main(env, client=Failing())
        self.assertNotEqual(0, code)
        self.assertIn("HTTP 400", err)
        self.assertIn("1234", err)
        self.assertNotIn("detalhe-do-servidor", err)

    def test_dry_run_flag_writes_nothing(self) -> None:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.AUD_VAR: AUD}
        code, _, _ = run_main(env, ["--dry-run"], client=client)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())


def _run_commands(text: str) -> list[str]:
    """As linhas de comando de cada `run:` do workflow, em linha ou em bloco."""
    lines, commands = text.splitlines(), []
    for i, line in enumerate(lines):
        found = re.match(r"^(\s*)(?:- )?run:\s*(.*)$", line)
        if not found:
            continue
        if found.group(2) not in ("|", ">", "|-", ">-"):
            commands.append(found.group(2))
            continue
        indent = len(found.group(1))
        for body in lines[i + 1:]:
            if body.strip() and len(body) - len(body.lstrip()) <= indent + 1:
                break
            commands.append(body)
    return commands


class DocsAndWorkflowTest(unittest.TestCase):
    workflow = (ROOT / ".github" / "workflows" / "cloudflare-access.yml")

    def test_script_does_not_name_barte_academy_as_team(self) -> None:
        """#232/AC-4: o script não cita mais barte-academy."""
        self.assertNotIn("barte-academy", (ROOT / "scripts" / "cloudflare_access.py").read_text())

    def test_readme_describes_the_real_team_and_the_workflow(self) -> None:
        """#232/AC-4: o README descreve o time real e o passo a passo pelo workflow."""
        text = (ROOT / "api" / "README.md").read_text()
        self.assertIn("long-frost-f16b.cloudflareaccess.com", text)
        self.assertIn("cloudflare-access.yml", text)
        self.assertNotIn("barte-academy.cloudflareaccess.com", text)
        self.assertNotIn("time `barte-academy`", text)

    def test_workflow_is_manual_main_only_and_least_privilege(self) -> None:
        """#232/AC-5: disparo manual, só na main, com permissões mínimas e checkout sem credencial."""
        text = self.workflow.read_text()
        self.assertIn("workflow_dispatch:", text)
        self.assertNotRegex(text, r"(?m)^\s+(push|pull_request|schedule):")
        self.assertIn("if: github.ref == 'refs/heads/main'", text)
        self.assertIn("contents: read", text)
        self.assertIn("persist-credentials: false", text)
        self.assertIn("timeout-minutes:", text)
        self.assertIn("dry_run:", text)
        self.assertRegex(text, r"uses: actions/checkout@[0-9a-f]{40}")

    def test_workflow_passes_values_through_env_with_no_expression_in_commands(self) -> None:
        """#232/AC-5: nenhuma expressão do Actions na linha de comando; tudo entra pelo env."""
        text = self.workflow.read_text()
        commands = _run_commands(text)
        self.assertTrue(commands)
        self.assertEqual([], [c for c in commands if "${{" in c])
        for name in (ca.TOKEN_VAR, ca.ACCOUNT_VAR, ca.AUD_VAR, ca.EMAILS_VAR):
            self.assertRegex(text, rf"{name}: \$\{{\{{ (secrets|vars)\.{name} \}}\}}")
        # O Actions imprime o bloco env no cabeçalho do step e só mascara secrets: e-mails só como secret. (#232)
        self.assertIn(f"{ca.EMAILS_VAR}: ${{{{ secrets.{ca.EMAILS_VAR} }}}}", text)
        self.assertNotIn(f"vars.{ca.EMAILS_VAR}", text)
        self.assertIn("DRY_RUN: ${{ inputs.dry_run }}", text)

    def test_workflow_prints_no_secret_and_no_email(self) -> None:
        """#232/AC-5: o workflow não ecoa segredo nem e-mail."""
        commands = "\n".join(_run_commands(self.workflow.read_text()))
        self.assertNotIn("echo", commands)
        self.assertNotIn("set -x", commands)
        self.assertNotIn(ca.TOKEN_VAR, commands)
        self.assertNotIn(ca.EMAILS_VAR, commands)


class HttpClientTest(unittest.TestCase):
    def test_not_enabled_is_detected_from_error_message(self) -> None:
        error = ca.CloudflareError("GET", "/x", 403, [{"code": 12130, "message": "access.api.error.not_enabled"}])
        self.assertTrue(error.not_enabled)
        self.assertFalse(ca.CloudflareError("GET", "/x", 400, [{"code": 1, "message": "outra"}]).not_enabled)


if __name__ == "__main__":
    unittest.main()
