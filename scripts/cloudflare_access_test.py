"""Testes offline do provisionamento do Cloudflare Access (#54, #232). Nenhum teste toca a rede."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import re
import unittest
from collections.abc import Callable
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
LEGACY_POLICY_NAME = "formacao-fde-solucao-case: barte.com e alunos"
EVERYONE = [{"everyone": {}}]
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
        self.reread: Callable[[Json], Json] = lambda app: app  # como a API devolve a aplicação na releitura
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
        if item:
            return self.reread(copy.deepcopy(next(a for a in self.apps if a["id"] == item)))
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


def options(**changes: Json) -> ca.Options:
    return ca.Options(**{"aud": AUD, **changes})


def run(client: FakeClient, **kwargs: Json) -> tuple[int, str]:
    out = io.StringIO()
    code = ca.provision(client, ACCOUNT, options(**kwargs), out=out)
    return code, out.getvalue()


class UpdateExistingAppTest(unittest.TestCase):
    def test_put_on_the_app_of_the_aud_and_no_post_to_apps(self) -> None:
        """#232/AC-1: com o AUD de uma aplicação existente, só há PUT nela."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        code, _ = run(client)
        self.assertEqual(0, code)
        self.assertEqual([("PUT", f"{BASE}/apps/{APP_ID}")], [(m, p) for m, p, _ in client.writes()])
        self.assertEqual(1, len(client.apps))

    def test_name_domain_and_aud_stay_as_they_were(self) -> None:
        """#232/AC-1: nome, domínio e AUD ficam como estavam."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client)
        sent = client.writes()[0][2]
        self.assertEqual("nome-vigente", sent["name"])
        self.assertEqual("vigente.example.com", sent["domain"])
        self.assertEqual(AUD, client.apps[0]["aud"])

    def test_session_and_login_settings_the_app_already_has_are_kept(self) -> None:
        """#232/AC-1: o PUT não sobrescreve ajustes que a aplicação já tem."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client)
        sent = client.writes()[0][2]
        self.assertEqual("12h", sent["session_duration"])
        self.assertFalse(sent["auto_redirect_to_identity"])
        self.assertEqual([OTP_ID], sent["allowed_idps"])

    def test_the_otp_becomes_the_only_identity_provider(self) -> None:
        """#232/AC-3: o código por e-mail é o único provedor; os outros saem."""
        client = FakeClient(apps=[existing_app(allowed_idps=["github"])])
        run(client)
        self.assertEqual([("POST", f"{BASE}/identity_providers"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])
        self.assertEqual([OTP_ID], client.writes()[1][2]["allowed_idps"])

    def test_policy_allows_everyone_and_keeps_its_id(self) -> None:
        """#232/AC-3: a política enviada é allow com include everyone."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client)
        policy = next(p for p in client.writes()[0][2]["policies"] if p["name"] == ca.POLICY_NAME)
        self.assertEqual("pol-1", policy["id"])
        self.assertEqual("allow", policy["decision"])
        self.assertEqual(EVERYONE, policy["include"])
        self.assertEqual("formacao-fde-solucao-case: qualquer e-mail", policy["name"])

    def test_policy_with_the_old_name_is_replaced_in_place_with_the_new_name(self) -> None:
        """#232/AC-3: a política de nome antigo é a do script: trocada no lugar, sem duplicar."""
        old = {"id": "pol-old", "name": LEGACY_POLICY_NAME, "precedence": 3,
               "include": [{"email_domain": {"domain": "barte.com"}}]}
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app(policies=[OTHER_POLICY, old])])
        run(client)
        policies = client.writes()[0][2]["policies"]
        self.assertEqual(["pol-x", "pol-old"], [p["id"] for p in policies])
        self.assertEqual((ca.POLICY_NAME, 3, EVERYONE), (policies[1]["name"], policies[1]["precedence"], policies[1]["include"]))

    def test_second_run_changes_nothing(self) -> None:
        """#232/AC-1: rodar de novo deixa o mesmo estado."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client)
        first = json.dumps(client.apps, sort_keys=True)
        run(client)
        self.assertEqual(first, json.dumps(client.apps, sort_keys=True))
        self.assertEqual(1, len(client.apps))

    def test_prints_team_domain_and_not_the_aud(self) -> None:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        _, out = run(client)
        self.assertIn(f"ACCESS_TEAM_DOMAIN={AUTH_DOMAIN}\n", out)
        self.assertNotIn(AUD, out)


class PreserveExistingAppTest(unittest.TestCase):
    def put_body(self, app: Json, idps: list[Json] | None = None) -> Json:
        client = FakeClient(idps=idps or [{"id": OTP_ID, "type": "onetimepin"}], apps=[app])
        run(client)
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

    def test_empty_allowed_idps_becomes_the_otp_only(self) -> None:
        """#232/AC-3: allowed_idps vazio é "todos os provedores"; passa a ser só o código por e-mail."""
        self.assertEqual([OTP_ID], self.put_body(existing_app(allowed_idps=[]))["allowed_idps"])

    def test_absent_allowed_idps_becomes_the_otp_only(self) -> None:
        """#232/AC-3: sem allowed_idps na aplicação, o corpo traz só o código por e-mail."""
        app = existing_app()
        del app["allowed_idps"]
        self.assertEqual([OTP_ID], self.put_body(app)["allowed_idps"])

    def test_app_request_decides_method_path_and_body_without_calling_the_api(self) -> None:
        method, route, body = ca.app_request(existing_app(), OTP_ID, options(), None)
        self.assertEqual(("PUT", f"/access/apps/{APP_ID}"), (method, route))
        self.assertEqual("nome-vigente", body["name"])
        method, route, body = ca.app_request(None, OTP_ID, options(
            aud="", create=True, app_domain=APP_DOMAIN), None)
        self.assertEqual(("POST", "/access/apps"), (method, route))
        self.assertEqual(APP_DOMAIN, body["domain"])


def script_policy(name: str = ca.POLICY_NAME, **changes: Json) -> Json:
    """A política do script como a conta a guarda: reutilizável, com o id `pol-r1`."""
    return {"id": "pol-r1", "name": name, "decision": "allow",
            "include": [{"email": {"email": "x@example.com"}}], **changes}


def other_policy() -> Json:
    return {**OTHER_POLICY, "id": "pol-r2", "created_at": "2026-01-01"}


def linked(policy: Json, precedence: int) -> Json:
    """Como o GET da aplicação devolve uma política reutilizável que ela liga."""
    return {k: v for k, v in policy.items() if k != "app_count"} | {"reusable": True, "precedence": precedence}


def reusable_client(account_policies: list[Json], app_policies: list[Json]) -> FakeClient:
    """Uma aplicação cujas políticas são reutilizáveis (as `app_policies`, já como o GET as devolve) e a conta."""
    return FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app(policies=app_policies)],
                      policies=account_policies)


def client_linking_script_policy(name: str = ca.POLICY_NAME, **changes: Json) -> FakeClient:
    """A aplicação liga a política do script e mais uma; as duas estão na conta."""
    mine, other = script_policy(name, **changes), other_policy()
    return reusable_client([mine, other], [linked(mine, 1), linked(other, 2)])


def client_without_script_policy() -> FakeClient:
    """A aplicação só liga uma política alheia, e a conta não tem a do script."""
    other = other_policy()
    return reusable_client([other], [linked(other, 2)])


def client_with_script_policy_not_linked(name: str = ca.POLICY_NAME, **changes: Json) -> FakeClient:
    """A conta tem a política do script, mas a aplicação liga só uma alheia."""
    other = other_policy()
    return reusable_client([script_policy(name, **changes), other], [linked(other, 2)])


class ReusablePoliciesTest(unittest.TestCase):
    def test_script_policy_found_by_name_is_updated_and_the_app_gets_only_links(self) -> None:
        """#232/AC-1: com política reutilizável, a do script é atualizada na conta e o PUT manda só links."""
        client = client_linking_script_policy()
        run(client)
        self.assertEqual([("PUT", f"{BASE}/policies/pol-r1"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])
        sent = client.writes()[0][2]
        self.assertEqual(EVERYONE, sent["include"])
        self.assertEqual(ca.POLICY_NAME, sent["name"])
        self.assertEqual([{"id": "pol-r1", "precedence": 1}, {"id": "pol-r2", "precedence": 2}],
                         client.writes()[1][2]["policies"])

    def test_reusable_policy_with_the_old_name_is_updated_in_place_with_the_new_name(self) -> None:
        """#232/AC-3: a reutilizável de nome antigo é a do script: atualizada, não duplicada."""
        client = client_linking_script_policy(LEGACY_POLICY_NAME)
        run(client)
        self.assertEqual([("PUT", f"{BASE}/policies/pol-r1"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])
        self.assertEqual((ca.POLICY_NAME, EVERYONE), (client.policies[0]["name"], client.policies[0]["include"]))
        self.assertEqual([{"id": "pol-r1", "precedence": 1}, {"id": "pol-r2", "precedence": 2}],
                         client.writes()[1][2]["policies"])

    def test_missing_script_policy_is_created_in_the_account_after_the_others(self) -> None:
        """#232/AC-1: sem a política do script na conta, POST em /access/policies; precedência maior+1."""
        client = client_without_script_policy()
        run(client)
        self.assertEqual([("POST", f"{BASE}/policies"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])
        self.assertEqual([{"id": "pol-r2", "precedence": 2}, {"id": POLICY_ID, "precedence": 3}],
                         client.writes()[1][2]["policies"])

    def test_no_post_to_apps_and_name_domain_and_aud_stay(self) -> None:
        """#232/AC-1: nesse caminho também só há PUT na aplicação."""
        client = client_without_script_policy()
        run(client)
        self.assertNotIn(("POST", f"{BASE}/apps"), [(m, p) for m, p, _ in client.writes()])
        self.assertEqual(("nome-vigente", "vigente.example.com", AUD),
                         (client.apps[0]["name"], client.apps[0]["domain"], client.apps[0]["aud"]))

    def test_second_run_changes_nothing(self) -> None:
        """#232/AC-1: rodar de novo, com política reutilizável, deixa o mesmo estado."""
        client = client_without_script_policy()
        run(client)
        first = json.dumps([client.apps, client.policies], sort_keys=True)
        run(client)
        self.assertEqual(first, json.dumps([client.apps, client.policies], sort_keys=True))

    def test_fake_refuses_a_put_that_mixes_link_and_inline(self) -> None:
        client = FakeClient(apps=[existing_app()])
        mixed = {"policies": [{"id": "pol-r1", "precedence": 1}, {"name": "x", "decision": "allow"}]}
        with self.assertRaises(AssertionError):
            client.request("PUT", f"{BASE}/apps/{APP_ID}", mixed)


class SharedReusablePolicyTest(unittest.TestCase):
    def assert_refused_without_writing(self, client: FakeClient, **kwargs: Json) -> None:
        with self.assertRaises(ca.ConfigError) as raised:
            run(client, **kwargs)
        self.assertIn("ligada a outra aplicação", str(raised.exception))
        self.assertIn("nada foi gravado", str(raised.exception))
        self.assertEqual([], client.writes())

    def test_refuses_when_the_policy_the_app_links_is_linked_by_two_apps(self) -> None:
        """#232/AC-3: com app_count 2, a política seria de outra aplicação também: recusa, sem gravar."""
        self.assert_refused_without_writing(client_linking_script_policy(app_count=2))

    def test_refuses_when_the_only_app_counted_is_another_one(self) -> None:
        """#232/AC-3: app_count 1 numa política que a vigente não liga é de outra aplicação: recusa."""
        self.assert_refused_without_writing(client_with_script_policy_not_linked(app_count=1))

    def test_refuses_an_unknown_app_count_when_the_app_does_not_link_it(self) -> None:
        """#232/AC-3: sem app_count, a política que a vigente não liga é tratada como compartilhada."""
        self.assert_refused_without_writing(client_with_script_policy_not_linked())

    def test_refuses_before_creating_the_one_time_pin_when_the_account_has_none(self) -> None:
        """#232/AC-3: sem OTP na conta, a recusa vem antes de qualquer gravação, inclusive a do provedor."""
        mine, other = script_policy(app_count=2), other_policy()
        client = FakeClient(apps=[existing_app(policies=[linked(mine, 1), linked(other, 2)])],
                            policies=[mine, other])
        self.assert_refused_without_writing(client)

    def test_dry_run_refuses_the_same_way_and_writes_nothing(self) -> None:
        """#232/AC-3: o dry-run aplica a mesma checagem."""
        self.assert_refused_without_writing(client_linking_script_policy(app_count=2), dry_run=True)

    def test_accepts_when_only_the_current_app_links_it(self) -> None:
        """#232/AC-3: app_count 1 e a vigente a liga: é só dela, atualiza."""
        client = client_linking_script_policy(app_count=1)
        run(client)
        self.assertEqual([("PUT", f"{BASE}/policies/pol-r1"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])

    def test_accepts_an_unknown_app_count_when_the_app_links_it(self) -> None:
        """#232/AC-3: sem app_count, mas a vigente a liga: atualiza."""
        client = client_linking_script_policy()
        run(client)
        self.assertEqual("PUT", client.writes()[0][0])

    def test_the_policy_the_app_links_wins_over_the_current_name_elsewhere_in_the_account(self) -> None:
        """#232/AC-3: a de nome antigo que a aplicação liga é a candidata, não a de nome atual solta na conta."""
        legacy, loose = script_policy(LEGACY_POLICY_NAME, app_count=1), script_policy(id="pol-loose", app_count=0)
        client = reusable_client([legacy, loose], [linked(legacy, 1)])
        run(client)
        self.assertEqual(f"{BASE}/policies/pol-r1", client.writes()[0][1])
        self.assertEqual("pol-loose", client.policies[1]["id"])
        self.assertEqual([{"id": "pol-r1", "precedence": 1}], client.writes()[1][2]["policies"])

    def test_a_legacy_named_policy_the_app_does_not_link_is_left_alone_and_a_new_one_is_created(self) -> None:
        """#232/AC-3: a de nome antigo fora da aplicação não é tocada; a do script é criada."""
        client = client_with_script_policy_not_linked(LEGACY_POLICY_NAME, app_count=3)
        before = json.dumps(client.policies[0], sort_keys=True)
        run(client)
        self.assertEqual([("POST", f"{BASE}/policies"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])
        self.assertEqual(before, json.dumps(client.policies[0], sort_keys=True))
        self.assertEqual({"id": POLICY_ID, "precedence": 3}, client.writes()[1][2]["policies"][-1])

    def test_the_current_name_in_the_account_is_the_candidate_when_the_app_links_none_of_the_script(self) -> None:
        """#232/AC-3: sem política do script na aplicação, a de nome atual na conta (sem outro uso) é atualizada."""
        client = client_with_script_policy_not_linked(app_count=0)
        run(client)
        self.assertEqual([("PUT", f"{BASE}/policies/pol-r1"), ("PUT", f"{BASE}/apps/{APP_ID}")],
                         [(m, p) for m, p, _ in client.writes()])


class UnknownAudTest(unittest.TestCase):
    def test_aud_that_matches_no_app_fails_naming_the_variable_and_writes_nothing(self) -> None:
        """#232/AC-2: AUD sem aplicação correspondente sai com erro que nomeia a variável."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        with self.assertRaises(ca.ConfigError) as raised:
            run(client, aud="aud-que-nao-existe")
        self.assertIn(ca.AUD_VAR, str(raised.exception))
        self.assertNotIn("aud-que-nao-existe", str(raised.exception))
        self.assertEqual([], client.writes())

    def test_app_with_the_same_name_but_another_aud_is_not_touched(self) -> None:
        """#232/AC-2: o nome não basta para achar a aplicação; só o AUD."""
        client = FakeClient(apps=[existing_app(name=ca.APP_NAME)])
        with self.assertRaises(ca.ConfigError):
            run(client, aud="outro-aud")
        self.assertEqual([], client.writes())

    def test_missing_aud_without_create_fails_naming_the_variable_before_any_call(self) -> None:
        """#232/AC-2: sem AUD e sem --create não se grava nem se consulta nada."""
        client = FakeClient(apps=[existing_app()])
        with self.assertRaises(ca.ConfigError) as raised:
            run(client, aud="")
        self.assertIn(ca.AUD_VAR, str(raised.exception))
        self.assertEqual([], client.calls)

    def test_main_exits_non_zero_naming_the_variable(self) -> None:
        """#232/AC-2: pela linha de comando, código != 0 e a mensagem nomeia a variável."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.AUD_VAR: "nenhum"}
        code, _, err = run_main(env, client=client)
        self.assertNotEqual(0, code)
        self.assertIn(ca.AUD_VAR, err)
        self.assertEqual([], client.writes())


class DryRunTest(unittest.TestCase):
    def test_dry_run_writes_nothing_and_says_the_policy_is_for_everyone(self) -> None:
        """#232/AC-3: o dry-run não grava e resume a política de qualquer e-mail."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        code, out = run(client, dry_run=True)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())
        self.assertIn("PUT", out)
        self.assertIn("qualquer e-mail", out)
        self.assertNotIn("barte.com", out)

    def test_dry_run_with_missing_otp_shows_the_post_and_writes_nothing(self) -> None:
        client = FakeClient(apps=[existing_app()])
        code, out = run(client, dry_run=True)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())
        self.assertIn("POST /access/identity_providers", out)
        self.assertIn("onetimepin", out)
        self.assertIn("allowed_idps: passa a ser só o código por e-mail", out)
        self.assertNotIn(ACCOUNT, out)

    def test_dry_run_summarizes_the_put_in_named_fields_without_the_other_policies_content(self) -> None:
        """#232/AC-5: o dry-run não imprime a configuração da aplicação, a política alheia nem a conta."""
        foreign = {"type": "public", "uri": "interno.alheio.example.com"}
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app(destinations=[
            {"type": "public", "uri": "vigente.example.com"}, foreign])])
        _, out = run(client, dry_run=True)
        self.assertIn("[dry-run] PUT na aplicação do AUD\n", out)
        self.assertIn("allowed_idps: inalterado", out)
        self.assertIn("policies: 2 no total; a do script na precedência 1, libera qualquer e-mail", out)
        self.assertIn("outras políticas: 1, mantidas", out)
        self.assertIn("política 2: precedence=None tipo=da aplicação\n", out)
        self.assertNotRegex(out, r"\boutra\b")
        # Só o domain da aplicação e o hostname do MCP saem pelo nome (#321); o destino alheio, nunca.
        for hidden in ("alheio", ACCOUNT, "nome-vigente", "vigente.example.com"):
            self.assertNotIn(hidden, out)

    def test_dry_run_says_allowed_idps_changes_without_listing_the_foreign_ids(self) -> None:
        """#232/AC-3: com outro provedor na aplicação, o resumo diz que muda, sem os ids alheios."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app(allowed_idps=["github-secreto"])])
        _, out = run(client, dry_run=True)
        self.assertIn("allowed_idps: passa a ser só o código por e-mail", out)
        self.assertNotIn("github-secreto", out)

    def test_dry_run_of_reusable_policies_says_the_path_and_touches_no_policy(self) -> None:
        """#232/AC-5: no dry-run, nenhum POST/PUT em /access/policies, e o resumo diz o caminho."""
        client = client_without_script_policy()
        _, out = run(client, dry_run=True)
        self.assertEqual([], client.writes())
        self.assertIn("reutilizáveis", out)
        self.assertNotRegex(out, r"\boutra\b")
        _, inline_out = run(FakeClient(idps=client.idps, apps=[existing_app()]), dry_run=True)
        self.assertIn("da aplicação", inline_out)


    def test_dry_run_prints_no_application_or_policy_id(self) -> None:
        """#232/AC-5: o log do Actions é público: nenhum id de aplicação ou de política sai no dry-run."""
        ids = (APP_ID, "pol-1", "pol-x", "pol-r1", "pol-r2", POLICY_ID)
        for client in (FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()]),
                       client_linking_script_policy(), client_without_script_policy()):
            _, out = run(client, dry_run=True)
            for identifier in ids:
                self.assertNotIn(identifier, out)
            self.assertIn("(do script)", out)


class CreateTest(unittest.TestCase):
    def test_create_flag_creates_otp_and_app_and_prints_the_new_aud(self) -> None:
        client = FakeClient()
        code, out = run(client, aud="", create=True, app_domain=APP_DOMAIN)
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
            run(client, aud="", create=True)
        self.assertIn(ca.APP_DOMAIN_VAR, str(raised.exception))
        self.assertEqual([], client.writes())

    def test_create_with_a_known_aud_still_only_updates(self) -> None:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client, create=True, app_domain=APP_DOMAIN)
        self.assertEqual(["PUT"], [m for m, _, _ in client.writes()])

    def test_create_with_an_unknown_aud_creates_instead_of_failing(self) -> None:
        client = FakeClient(apps=[existing_app()])
        code, _ = run(client, aud="novo", create=True, app_domain=APP_DOMAIN)
        self.assertEqual(0, code)
        self.assertIn("POST", [m for m, p, _ in client.writes() if p.endswith("/apps")])


class NotEnabledTest(unittest.TestCase):
    def test_not_enabled_explains_the_dashboard_step_without_naming_a_team(self) -> None:
        client = FakeClient(not_enabled=True)
        with self.assertRaises(ca.AccessNotEnabled) as raised:
            run(client)
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

    def test_real_run_needs_no_email_variable_and_never_prints_the_token(self) -> None:
        """#232/AC-3: sem BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS a execução real funciona."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.AUD_VAR: AUD}
        code, out, err = run_main(env, client=client)
        self.assertEqual(0, code)
        self.assertNotIn(TOKEN, out + err)
        self.assertEqual(EVERYONE, client.writes()[0][2]["policies"][0]["include"])

    def test_create_flag_reads_the_domain_from_env(self) -> None:
        client = FakeClient()
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.APP_DOMAIN_VAR: APP_DOMAIN}
        code, _, _ = run_main(env, ["--create"], client=client)
        self.assertEqual(0, code)
        self.assertEqual(APP_DOMAIN, client.writes()[1][2]["domain"])

    def test_not_enabled_exits_non_zero_with_portuguese_message(self) -> None:
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.AUD_VAR: AUD}
        code, _, err = run_main(env, client=FakeClient(not_enabled=True))
        self.assertNotEqual(0, code)
        self.assertIn("Zero Trust", err)

    def test_api_error_prints_status_and_codes_only(self) -> None:
        class Failing(FakeClient):
            def request(self, method: str, path: str, body: Json = None) -> Json:
                raise ca.CloudflareError(method, path, 400, [{"code": 1234, "message": "detalhe-do-servidor"}])

        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.AUD_VAR: AUD}
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
        """#232/AC-4: o script não cita mais barte-academy; só o hostname público do MCP (#321) a tem."""
        text = (ROOT / "scripts" / "cloudflare_access.py").read_text()
        self.assertNotIn("barte-academy", text.replace(ca.MCP_HOST, ""))

    def test_readme_describes_the_real_team_and_the_workflow(self) -> None:
        """#232/AC-4: o README descreve o time real e o passo a passo pelo workflow."""
        text = (ROOT / "api" / "README.md").read_text()
        self.assertNotIn("ALLOWED_EMAILS", text)
        self.assertIn("long-frost-f16b.cloudflareaccess.com", text)
        self.assertIn("cloudflare-access.yml", text)
        self.assertNotIn("barte-academy.cloudflareaccess.com", text)
        self.assertNotIn("time `barte-academy`", text)
        self.assertNotRegex(text, r"(?i)\bbarte-academy\b")

    def test_readme_records_that_any_authenticated_email_may_enter(self) -> None:
        """#232/AC-6: a tela vale para qualquer e-mail autenticado, e o Worker não filtra por e-mail."""
        text = " ".join((ROOT / "api" / "README.md").read_text().split())
        self.assertIn("qualquer e-mail autenticado", text)
        self.assertIn("decisão do CFO", text)
        self.assertIn("solução de referência", text)
        self.assertIn("não filtra por e-mail", text)
        self.assertIn("BARTE_ACADEMY_ADMIN_EMAILS", text)
        self.assertIn("BARTE_ACADEMY_APPROVER_LEVELS", text)

    def test_workflow_is_manual_main_only_and_least_privilege(self) -> None:
        """#232/AC-5: disparo manual, só na main, com permissões mínimas e checkout sem credencial."""
        text = self.workflow.read_text()
        self.assertIn("workflow_dispatch:", text)
        self.assertNotRegex(text, r"(?m)^\s+(push|pull_request|schedule):")
        self.assertIn("if: github.ref == 'refs/heads/main'", text)
        self.assertIn("contents: read", text)
        self.assertIn("persist-credentials: false", text)
        self.assertIn("timeout-minutes:", text)
        self.assertRegex(text, r"(?m)^    environment: producao$")
        self.assertIn("dry_run:", text)
        self.assertRegex(text, r"uses: actions/checkout@[0-9a-f]{40}")

    def test_workflow_passes_values_through_env_with_no_expression_in_commands(self) -> None:
        """#232/AC-5: nenhuma expressão do Actions na linha de comando; tudo entra pelo env."""
        text = self.workflow.read_text()
        commands = _run_commands(text)
        self.assertTrue(commands)
        self.assertEqual([], [c for c in commands if "${{" in c])
        for name in (ca.TOKEN_VAR, ca.ACCOUNT_VAR, ca.AUD_VAR):
            self.assertRegex(text, rf"{name}: \$\{{\{{ (secrets|vars)\.{name} \}}\}}")
        self.assertNotIn("ALLOWED_EMAILS", text)
        self.assertIn("DRY_RUN: ${{ inputs.dry_run }}", text)

    def test_workflow_prints_no_secret(self) -> None:
        """#232/AC-5: o workflow não ecoa segredo."""
        commands = "\n".join(_run_commands(self.workflow.read_text()))
        self.assertNotIn("echo", commands)
        self.assertNotIn("set -x", commands)
        self.assertNotIn(ca.TOKEN_VAR, commands)


class ErrorRouteTest(unittest.TestCase):
    def test_error_message_names_the_route_without_the_account_id(self) -> None:
        """#232/AC-5: o erro vai para o log público: a rota sai sem o `/accounts/<id>`."""
        error = ca.CloudflareError("PUT", f"{BASE}/apps/{APP_ID}", 500, [{"code": 7003}])
        self.assertNotIn(ACCOUNT, str(error))
        self.assertIn("falha em PUT /access/apps/<id>: HTTP 500 (códigos 7003)", str(error))

    def test_error_message_hides_the_application_and_policy_ids(self) -> None:
        """#232/AC-5: o id da aplicação e o da política também ficam fora do log público."""
        for path, resource_id in ((f"{BASE}/apps/{APP_ID}", APP_ID), (f"{BASE}/policies/pol-r1", "pol-r1"),
                                  (f"{BASE}/identity_providers/{OTP_ID}", OTP_ID)):
            with self.subTest(path=path):
                error = ca.CloudflareError("PUT", path, 500, [{"code": 7003}])
                self.assertNotIn(resource_id, str(error))
                self.assertNotIn(ACCOUNT, str(error))
                self.assertIn("/<id>:", str(error))

    def test_main_prints_no_account_id_on_an_api_failure(self) -> None:
        """#232/AC-5: pela linha de comando, o erro da API não traz o id da conta."""
        class Failing(FakeClient):
            def request(self, method: str, path: str, body: Json = None) -> Json:
                raise ca.CloudflareError(method, path, 400, [{"code": 1234}])

        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.AUD_VAR: AUD}
        _, _, err = run_main(env, client=Failing())
        self.assertNotIn(ACCOUNT, err)


class OtpDryRunTest(unittest.TestCase):
    def test_finding_the_provider_never_writes_and_creating_it_is_a_separate_step(self) -> None:
        """#232/AC-3: achar o provedor só lê; criar é outro passo, e o dry-run se decide em `provision`."""
        found = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}])
        self.assertEqual(OTP_ID, ca.find_otp(found, ACCOUNT))
        self.assertEqual([], found.writes())
        empty = FakeClient()
        self.assertIsNone(ca.find_otp(empty, ACCOUNT))
        self.assertEqual([], empty.writes())
        self.assertEqual(OTP_ID, ca.create_otp(empty, ACCOUNT))
        self.assertEqual(["POST"], [m for m, _, _ in empty.writes()])


class McpDestinationTest(unittest.TestCase):
    """O destino público do MCP entra na aplicação vigente, sem tirar nada (#321)."""

    MCP = ca.MCP_HOST

    def sent(self, app: Json) -> Json:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[app])
        run(client)
        return client.writes()[0][2]

    def test_the_mcp_host_is_the_public_worker_hostname(self) -> None:
        """#321/AC-1: o hostname do MCP é o do Worker do MCP."""
        self.assertEqual("formacao-fde-solucao-case-mcp.barte-academy.workers.dev", ca.MCP_HOST)

    def test_mcp_destination_is_appended_to_the_existing_ones(self) -> None:
        """#321/AC-1: o destino do MCP vai ao fim; a aplicação continua a mesma, sem POST."""
        existing = [{"type": "public", "uri": "vigente.example.com"}]
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}],
                            apps=[existing_app(destinations=existing)])
        run(client)
        self.assertEqual(["PUT"], [m for m, _, _ in client.writes()])
        self.assertEqual([*existing, {"type": "public", "uri": self.MCP}], client.writes()[0][2]["destinations"])

    def test_existing_destinations_are_kept_in_order_with_overrides_and_other_types(self) -> None:
        """#321/AC-1: nenhum destino existente sai nem muda, nem o com overrides, nem o de outro tipo."""
        existing = [
            {"type": "public", "uri": "vigente.example.com/api", "overrides": {"a": 1}},
            {"type": "private", "cidr": "10.0.0.0/8", "port_range": "443"},
            {"type": "public", "uri": "outro.example.com"},
        ]
        body = self.sent(existing_app(destinations=existing))
        self.assertEqual(existing, body["destinations"][:3])
        self.assertEqual({"type": "public", "uri": self.MCP}, body["destinations"][3])
        self.assertEqual(4, len(body["destinations"]))

    def test_app_with_only_a_domain_gets_the_domain_and_the_mcp_as_destinations(self) -> None:
        """#321/AC-1: sem destinations, o corpo traz o domain atual e o MCP, nessa ordem."""
        body = self.sent(existing_app())
        self.assertEqual([{"type": "public", "uri": "vigente.example.com"}, {"type": "public", "uri": self.MCP}],
                         body["destinations"])
        self.assertEqual("vigente.example.com", body["domain"])

    def test_without_destinations_the_fallback_starts_from_self_hosted_domains_keeping_every_extra(self) -> None:
        """#321/AC-1: sem destinations, o corpo parte de self_hosted_domains: nenhum hostname extra se perde."""
        body = self.sent(existing_app(self_hosted_domains=["vigente.example.com", "extra.example.com"]))
        self.assertEqual(
            [{"type": "public", "uri": "vigente.example.com"}, {"type": "public", "uri": "extra.example.com"},
             {"type": "public", "uri": self.MCP}], body["destinations"])
        self.assertEqual(["vigente.example.com", "extra.example.com"], body["self_hosted_domains"])

    def test_fallback_from_self_hosted_domains_does_not_repeat_the_mcp(self) -> None:
        """#321/AC-1: se self_hosted_domains já tem o MCP, o destino não se repete."""
        body = self.sent(existing_app(self_hosted_domains=["vigente.example.com", self.MCP]))
        self.assertEqual(["vigente.example.com", self.MCP], [d["uri"] for d in body["destinations"]])

    def test_empty_self_hosted_domains_fall_back_to_the_domain(self) -> None:
        """#321/AC-1: self_hosted_domains vazio ou ausente cai em [domain]."""
        body = self.sent(existing_app(self_hosted_domains=[]))
        self.assertEqual(["vigente.example.com", self.MCP], [d["uri"] for d in body["destinations"]])

    def test_destinations_win_over_self_hosted_domains(self) -> None:
        """#321/AC-1: com destinations, self_hosted_domains não entra na conta."""
        body = self.sent(existing_app(destinations=[{"type": "public", "uri": "a.example.com"}],
                                      self_hosted_domains=["b.example.com"]))
        self.assertEqual(["a.example.com", self.MCP], [d["uri"] for d in body["destinations"]])

    def test_empty_destinations_are_treated_as_absent(self) -> None:
        """#321/AC-1: destinations vazio vira domain mais MCP."""
        body = self.sent(existing_app(destinations=[]))
        self.assertEqual(["vigente.example.com", self.MCP], [d["uri"] for d in body["destinations"]])

    def test_domain_that_is_already_the_mcp_gives_a_single_destination(self) -> None:
        """#321/AC-1: se o domain já é o do MCP, o destino não se repete."""
        body = self.sent(existing_app(domain=self.MCP))
        self.assertEqual([{"type": "public", "uri": self.MCP}], body["destinations"])

    def test_second_run_does_not_duplicate_the_destination(self) -> None:
        """#321/AC-1: rodar de novo manda o mesmo PUT e o mesmo estado, com um só destino do MCP."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client)
        first_state = json.dumps(client.apps, sort_keys=True)
        first_body = client.writes()[0][2]
        run(client)
        self.assertEqual(first_state, json.dumps(client.apps, sort_keys=True))
        self.assertEqual(first_body, client.writes()[1][2])
        self.assertEqual(1, [d["uri"] for d in client.apps[0]["destinations"]].count(self.MCP))

    def test_trailing_slash_of_an_existing_mcp_destination_counts_as_present(self) -> None:
        """#321/AC-1: o uri do MCP com barra final já conta como presente, e fica como veio."""
        existing = [{"type": "public", "uri": f"{self.MCP}/"}]
        self.assertEqual(existing, self.sent(existing_app(destinations=existing))["destinations"])

    def test_self_hosted_domains_stay_as_they_came(self) -> None:
        """#321/AC-1: self_hosted_domains, se vier, não é tocado."""
        body = self.sent(existing_app(self_hosted_domains=["vigente.example.com"]))
        self.assertEqual(["vigente.example.com"], body["self_hosted_domains"])

    def test_domain_aud_policy_and_provider_stay(self) -> None:
        """#321/AC-3: domain, AUD, política e provedor ficam; o AUD que a API devolve é o mesmo."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client)
        body = client.writes()[0][2]
        self.assertEqual("vigente.example.com", body["domain"])
        self.assertEqual([OTP_ID], body["allowed_idps"])
        self.assertEqual(ca.POLICY_NAME, body["policies"][0]["name"])
        self.assertEqual("pol-1", body["policies"][0]["id"])
        self.assertEqual(AUD, client.apps[0]["aud"])
        self.assertNotIn("aud", body)

    def test_new_app_payload_is_unchanged_by_the_mcp_destination(self) -> None:
        """#321/AC-1: o --create fica como estava, sem destinations nem oauth_configuration."""
        body = ca.new_app_payload(OTP_ID, APP_DOMAIN)
        self.assertNotIn("destinations", body)
        self.assertNotIn("oauth_configuration", body)


class ManagedOauthTest(unittest.TestCase):
    """O OAuth gerenciado liga para o cliente MCP entrar com o login do Access (#321)."""

    CALLBACK = ca.CLAUDE_CALLBACK

    def sent(self, app: Json) -> Json:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[app])
        run(client)
        return client.writes()[0][2]

    def test_the_callback_is_the_one_of_claude(self) -> None:
        """#321/AC-2: a redirect URI é a do Claude para conectores MCP."""
        self.assertEqual("https://claude.ai/api/mcp/auth_callback", self.CALLBACK)

    def test_oauth_registration_and_callback_are_set_when_the_app_has_none(self) -> None:
        """#321/AC-2: sem oauth_configuration, liga o OAuth, o registro dinâmico e permite o callback do Claude."""
        self.assertEqual(
            {"enabled": True, "dynamic_client_registration": {
                "enabled": True, "allowed_uris": [self.CALLBACK],
                "allow_any_on_localhost": False, "allow_any_on_loopback": False}},
            self.sent(existing_app())["oauth_configuration"])

    def test_localhost_and_loopback_are_written_off(self) -> None:
        """#321/AC-2: o PUT grava allow_any_on_localhost e allow_any_on_loopback desligados."""
        registration = self.sent(existing_app())["oauth_configuration"]["dynamic_client_registration"]
        self.assertIs(False, registration["allow_any_on_localhost"])
        self.assertIs(False, registration["allow_any_on_loopback"])

    def test_localhost_and_loopback_turned_on_in_the_app_are_turned_off(self) -> None:
        """#321/AC-2: o que a aplicação tinha ligado nesses flags sai desligado no PUT."""
        current = {"enabled": False, "dynamic_client_registration": {
            "enabled": False, "allow_any_on_localhost": True, "allow_any_on_loopback": True}}
        registration = self.sent(existing_app(oauth_configuration=current))["oauth_configuration"][
            "dynamic_client_registration"]
        self.assertIs(False, registration["allow_any_on_localhost"])
        self.assertIs(False, registration["allow_any_on_loopback"])

    def test_other_redirect_uris_are_dropped_and_the_other_fields_are_preserved(self) -> None:
        """#321/AC-2: allowed_uris vira só o callback do Claude; o grant e o mais que vier ficam."""
        current = {"enabled": False,
                   "dynamic_client_registration": {"enabled": False, "allow_any_on_localhost": True,
                                                   "allowed_uris": ["https://outro.example.com/cb"],
                                                   "campo_novo": 1},
                   "grant": {"session_duration": "2h"}, "extra": "x"}
        oauth = self.sent(existing_app(oauth_configuration=current))["oauth_configuration"]
        self.assertEqual({"session_duration": "2h"}, oauth["grant"])
        self.assertEqual("x", oauth["extra"])
        registration = oauth["dynamic_client_registration"]
        self.assertEqual([self.CALLBACK], registration["allowed_uris"])
        self.assertIs(True, registration["enabled"])
        self.assertIs(False, registration["allow_any_on_localhost"])
        self.assertEqual(1, registration["campo_novo"])
        self.assertIs(True, oauth["enabled"])

    def test_callback_already_allowed_is_not_repeated(self) -> None:
        """#321/AC-2: com o callback já na lista, ele não se repete; só ele fica."""
        current = {"enabled": True, "dynamic_client_registration": {
            "enabled": True, "allowed_uris": [self.CALLBACK, "https://outro.example.com/cb"]}}
        uris = self.sent(existing_app(oauth_configuration=current))["oauth_configuration"][
            "dynamic_client_registration"]["allowed_uris"]
        self.assertEqual([self.CALLBACK], uris)

    def test_all_of_it_goes_in_the_same_put_of_the_same_app(self) -> None:
        """#321/AC-2: um só PUT na aplicação vigente, sem criar outra, leva destinos e OAuth juntos."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client)
        method, path, body = client.writes()[0]
        self.assertEqual(1, len(client.writes()))
        self.assertEqual(("PUT", f"{BASE}/apps/{APP_ID}"), (method, path))
        self.assertIn(self.CALLBACK, body["oauth_configuration"]["dynamic_client_registration"]["allowed_uris"])
        self.assertIn(ca.MCP_HOST, [d["uri"] for d in body["destinations"]])

    def test_second_run_keeps_oauth_enabled_and_equal(self) -> None:
        """#321/AC-2: rodar de novo deixa o OAuth ligado e o corpo igual."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app()])
        run(client)
        run(client)
        self.assertEqual(client.writes()[0][2], client.writes()[1][2])
        self.assertTrue(client.apps[0]["oauth_configuration"]["enabled"])


class McpDryRunTest(unittest.TestCase):
    """O dry-run mostra destinos e OAuth antes e depois, sem gravar e sem ids (#321)."""

    def dry(self, app: Json) -> tuple[FakeClient, str]:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[app])
        _, out = run(client, dry_run=True)
        return client, out

    def test_dry_run_shows_destinations_before_and_after_and_writes_nothing(self) -> None:
        """#321/AC-1: antes e depois dos destinos, dizendo que o do MCP é acrescentado."""
        client, out = self.dry(existing_app(destinations=[
            {"type": "public", "uri": "vigente.example.com"}, {"type": "private", "cidr": "10.0.0.0/8"}]))
        self.assertEqual([], client.writes())
        self.assertIn("destinos antes: 1 outro público, 1 de tipo private", out)
        self.assertIn(f"destinos depois: {ca.MCP_HOST}, 1 outro público, 1 de tipo private", out)
        self.assertIn("destino do MCP: acrescentado", out)
        self.assertIn("domain: inalterado", out)
        self.assertNotIn("10.0.0.0", out)
        self.assertNotIn("vigente.example.com", out)

    def test_dry_run_says_the_mcp_destination_was_already_there(self) -> None:
        """#321/AC-1: com o destino já presente, o dry-run diz que já estava."""
        _, out = self.dry(existing_app(destinations=[{"type": "public", "uri": ca.MCP_HOST}]))
        self.assertIn("destino do MCP: já estava", out)

    def test_dry_run_lists_the_domain_as_before_when_the_app_has_no_destinations(self) -> None:
        """#321/AC-1: sem destinations, o antes mostra o domain atual."""
        _, out = self.dry(existing_app())
        self.assertIn("destinos antes: 1 outro público (só domain)", out)
        self.assertIn(f"destinos depois: {ca.MCP_HOST}, 1 outro público", out)
        self.assertNotIn("vigente.example.com", out)

    def test_dry_run_shows_oauth_before_and_after(self) -> None:
        """#321/AC-2: o OAuth de cliente MCP passa de desligado para ligado, ou fica ligado inalterado."""
        _, off = self.dry(existing_app())
        self.assertIn("oauth_configuration.enabled: desligado -> ligado", off)
        _, on = self.dry(existing_app(oauth_configuration={"enabled": True}))
        self.assertIn("oauth_configuration.enabled: ligado, inalterado", on)

    def test_dry_run_names_only_the_mcp_and_counts_every_other_public_destination(self) -> None:
        """#232/AC-5 e #321/AC-1: o domain e o destino público alheio entram só pela contagem, nunca pelo nome."""
        client, out = self.dry(existing_app(destinations=[
            {"type": "public", "uri": "vigente.example.com"}, {"type": "public", "uri": "a.alheio.example.com"},
            {"type": "public", "uri": "b.alheio.example.com"}]))
        self.assertNotIn("alheio", out)
        self.assertNotIn("vigente.example.com", out)
        self.assertIn("destinos antes: 3 outros públicos", out)
        self.assertIn(f"destinos depois: {ca.MCP_HOST}, 3 outros públicos", out)

    def test_dry_run_counts_the_extra_self_hosted_domains_without_naming_them(self) -> None:
        """#321/AC-1: no fallback por self_hosted_domains, o extra também só aparece pela contagem."""
        _, out = self.dry(existing_app(self_hosted_domains=["vigente.example.com", "extra.alheio.example.com"]))
        self.assertNotIn("alheio", out)
        self.assertNotIn("vigente.example.com", out)
        self.assertIn("destinos antes: 2 outros públicos (só self_hosted_domains)", out)

    def test_dry_run_shows_the_oauth_keys_before_and_after(self) -> None:
        """#321/AC-2: o antes e o depois de enabled, do registro dinâmico e do callback do Claude."""
        _, out = self.dry(existing_app())
        self.assertIn("oauth_configuration.enabled: desligado -> ligado", out)
        self.assertIn("oauth_configuration.dynamic_client_registration.enabled: desligado -> ligado", out)
        self.assertIn("oauth_configuration.dynamic_client_registration.allowed_uris: só o callback do Claude "
                      "(outras URIs removidas: 0)", out)
        current = {"enabled": True, "dynamic_client_registration": {
            "enabled": True, "allowed_uris": [ca.CLAUDE_CALLBACK, "https://secreto.example.com/cb"]}}
        _, again = self.dry(existing_app(oauth_configuration=current))
        self.assertIn("oauth_configuration.dynamic_client_registration.enabled: ligado, inalterado", again)
        self.assertIn("allowed_uris: só o callback do Claude (outras URIs removidas: 1)", again)
        self.assertIn("allow_any_on_localhost: desligado, inalterado", again)
        self.assertIn("allow_any_on_loopback: desligado, inalterado", again)
        self.assertNotIn("secreto", again)

    def test_dry_run_prints_no_id_nor_oauth_subfields(self) -> None:
        """#321/AC-1: nada de id nem de subcampos do OAuth no log público."""
        _, out = self.dry(existing_app(oauth_configuration={"enabled": False, "grant": {"session_duration": "segredo-x"}}))
        for hidden in (APP_ID, "pol-1", "pol-x", ACCOUNT, "segredo-x"):
            self.assertNotIn(hidden, out)


class McpDryRunNewAppTest(unittest.TestCase):
    """O dry-run da aplicação nova resume em campos nomeados, sem o corpo nem o domínio (#321)."""

    def test_dry_run_of_a_new_app_dumps_no_body_and_prints_no_domain(self) -> None:
        """#321/AC-2: o log mostra só campos nomeados; o valor do APP_DOMAIN e do OTP não saem."""
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}])
        code, out = run(client, aud="", create=True, dry_run=True, app_domain=APP_DOMAIN)
        self.assertEqual(0, code)
        self.assertEqual([], client.writes())
        self.assertIn("[dry-run] POST /access/apps\n", out)
        self.assertIn("allowed_idps: só o código por e-mail", out)
        self.assertIn("policies: 1, libera qualquer e-mail", out)
        self.assertIn("domain: o de BARTE_ACADEMY_ACCESS_APP_DOMAIN, não impresso", out)
        for hidden in (APP_DOMAIN, OTP_ID, ACCOUNT, "{", '"'):
            self.assertNotIn(hidden, out)

    def test_dry_run_with_a_missing_otp_and_a_new_app_prints_only_constants(self) -> None:
        """#321/AC-2: sem OTP na conta, o resumo do POST do provedor também é em campos nomeados."""
        _, out = run(FakeClient(), aud="", create=True, dry_run=True, app_domain=APP_DOMAIN)
        self.assertIn("[dry-run] POST /access/identity_providers\n", out)
        self.assertNotIn(APP_DOMAIN, out)
        self.assertNotIn("{", out)


class DcrVerificationTest(unittest.TestCase):
    """Na execução real, a releitura da aplicação confirma o DCR restrito ao callback do Claude (#321)."""

    def client(self, reread: Callable[[Json], Json] | None = None, **changes: Json) -> FakeClient:
        client = FakeClient(idps=[{"id": OTP_ID, "type": "onetimepin"}], apps=[existing_app(**changes)])
        if reread is not None:
            client.reread = reread
        return client

    def fail(self, client: FakeClient) -> str:
        with self.assertRaises(ca.ConfigError) as raised:
            run(client)
        return str(raised.exception)

    @staticmethod
    def with_registration(**fields: Json) -> Callable[[Json], Json]:
        def tamper(app: Json) -> Json:
            app["oauth_configuration"]["dynamic_client_registration"].update(fields)
            return app
        return tamper

    def test_the_app_is_reread_after_the_put_and_the_run_passes(self) -> None:
        """#321/AC-2: depois do PUT, um GET da aplicação por id; DCR só no callback, nada em localhost."""
        client = self.client()
        code, _ = run(client)
        self.assertEqual(0, code)
        app_calls = [(m, p) for m, p, _ in client.calls if "/apps" in p]
        self.assertEqual([("GET", f"{BASE}/apps"), ("PUT", f"{BASE}/apps/{APP_ID}"),
                          ("GET", f"{BASE}/apps/{APP_ID}")], app_calls)

    def test_a_stale_oauth_uri_in_the_app_is_overwritten_so_the_reread_passes(self) -> None:
        """#321/AC-2: a URI alheia que a aplicação tinha sai no PUT; a releitura confirma."""
        current = {"enabled": True, "dynamic_client_registration": {
            "enabled": True, "allowed_uris": ["https://alheio.example.com/cb"], "allow_any_on_localhost": True}}
        client = self.client(oauth_configuration=current)
        code, _ = run(client)
        registration = client.apps[0]["oauth_configuration"]["dynamic_client_registration"]
        self.assertEqual(0, code)
        self.assertEqual([ca.CLAUDE_CALLBACK], registration["allowed_uris"])

    def test_an_extra_uri_on_the_reread_fails_without_naming_it(self) -> None:
        """#321/AC-2: URI extra na releitura: ConfigError nomeado, sem a URI alheia."""
        extra = "https://alheio.example.com/cb"
        message = self.fail(self.client(self.with_registration(allowed_uris=[ca.CLAUDE_CALLBACK, extra])))
        self.assertIn("allowed_uris", message)
        self.assertNotIn("alheio", message)

    def test_an_empty_or_missing_uri_list_on_the_reread_fails(self) -> None:
        """#321/AC-2: sem o callback do Claude na releitura, a execução falha."""
        self.assertIn("allowed_uris", self.fail(self.client(self.with_registration(allowed_uris=[]))))

    def test_localhost_turned_on_on_the_reread_fails(self) -> None:
        """#321/AC-2: allow_any_on_localhost ligado na releitura falha, nomeando o flag."""
        message = self.fail(self.client(self.with_registration(allow_any_on_localhost=True)))
        self.assertIn("allow_any_on_localhost", message)
        self.assertNotIn("allow_any_on_loopback", message)

    def test_loopback_turned_on_on_the_reread_fails(self) -> None:
        """#321/AC-2: allow_any_on_loopback ligado na releitura falha, nomeando o flag."""
        message = self.fail(self.client(self.with_registration(allow_any_on_loopback=True)))
        self.assertIn("allow_any_on_loopback", message)
        self.assertNotIn("allow_any_on_localhost", message)

    def test_an_app_reread_without_oauth_fails(self) -> None:
        """#321/AC-2: se a releitura não traz o registro dinâmico, o DCR não está restrito: falha."""
        def drop(app: Json) -> Json:
            app.pop("oauth_configuration")
            return app

        self.assertIn("allowed_uris", self.fail(self.client(drop)))

    def test_the_failure_message_carries_no_body_id_account_or_token(self) -> None:
        """#321/AC-2: a mensagem não leva corpo, id de aplicação, conta, domínio nem token."""
        tamper = self.with_registration(allowed_uris=["https://alheio.example.com/cb"],
                                        allow_any_on_localhost=True, allow_any_on_loopback=True)
        message = self.fail(self.client(tamper))
        for hidden in (APP_ID, ACCOUNT, TOKEN, AUD, "alheio", "vigente.example.com", "{", ca.MCP_HOST):
            self.assertNotIn(hidden, message)

    def test_main_exits_non_zero_with_the_named_message_on_stderr(self) -> None:
        """#321/AC-2: pela linha de comando, a releitura divergente sai com código 1 e mensagem nomeada."""
        client = self.client(self.with_registration(allow_any_on_localhost=True))
        env = {ca.TOKEN_VAR: TOKEN, ca.ACCOUNT_VAR: ACCOUNT, ca.AUD_VAR: AUD}
        code, _, err = run_main(env, client=client)
        self.assertEqual(1, code)
        self.assertIn("allow_any_on_localhost", err)
        for hidden in (APP_ID, ACCOUNT, TOKEN):
            self.assertNotIn(hidden, err)

    def test_dry_run_does_not_reread_the_app(self) -> None:
        """#321/AC-2: o dry-run não grava, então não relê a aplicação por id."""
        client = self.client()
        run(client, dry_run=True)
        self.assertEqual([], [p for _, p, _ in client.calls if p.endswith(f"/apps/{APP_ID}")])

    def test_a_new_app_is_not_reread(self) -> None:
        """#321/AC-2: o POST da aplicação nova não leva oauth_configuration; não há DCR a conferir."""
        client = FakeClient()
        code, _ = run(client, aud="", create=True, app_domain=APP_DOMAIN)
        self.assertEqual(0, code)
        self.assertEqual([], [p for _, p, _ in client.calls if p.endswith(f"/apps/{APP_ID}")])


class HttpClientTest(unittest.TestCase):
    def test_not_enabled_is_detected_from_error_message(self) -> None:
        error = ca.CloudflareError("GET", "/x", 403, [{"code": 12130, "message": "access.api.error.not_enabled"}])
        self.assertTrue(error.not_enabled)
        self.assertFalse(ca.CloudflareError("GET", "/x", 400, [{"code": 1, "message": "outra"}]).not_enabled)


if __name__ == "__main__":
    unittest.main()
