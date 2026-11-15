#!/usr/bin/env python3
"""Provisionamento idempotente do Cloudflare Access na frente do Worker (#54).

Garante o provedor de identidade de código por e-mail (one-time PIN) e a aplicação do Access
`formacao-fde-solucao-case`, com a política que libera quem é da barte.com e os alunos listados.
Rodar duas vezes deixa o mesmo estado: a segunda execução atualiza, nunca duplica.

No fim, imprime ACCESS_AUD=... e ACCESS_TEAM_DOMAIN=..., os valores das variáveis do repositório
BARTE_ACADEMY_ACCESS_AUD e BARTE_ACADEMY_ACCESS_TEAM_DOMAIN que a esteira passa ao Worker.

Variáveis de ambiente: BARTE_ACADEMY_CLOUDFLARE_API_TOKEN, BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID e,
opcional, BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS (e-mails dos alunos, separados por vírgula ou espaço).
Nunca imprime o token nem o corpo das respostas de erro.

Uso: python3 scripts/cloudflare_access.py [--dry-run]
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any, Protocol, TextIO

# Any: o JSON da API da Cloudflare só tem forma conhecida em tempo de execução (#54).
Json = Any

API = "https://api.cloudflare.com/client/v4"
TOKEN_VAR = "BARTE_ACADEMY_CLOUDFLARE_API_TOKEN"
ACCOUNT_VAR = "BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID"
EMAILS_VAR = "BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS"

APP_NAME = "formacao-fde-solucao-case"
APP_DOMAIN = "formacao-fde-solucao-case-api.barte-academy.workers.dev"
POLICY_NAME = "formacao-fde-solucao-case: barte.com e alunos"
ALLOWED_DOMAIN = "barte.com"
OTP_TYPE = "onetimepin"
OTP_NAME = "Código por e-mail"
TEAM_NAME = "barte-academy"
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PENDING_OTP = "<id do one-time PIN, criado na execução real>"

NOT_ENABLED_MESSAGE = (
    "O Cloudflare Zero Trust (Access) ainda não está ativo nesta conta. Ative uma vez no painel: "
    f"Zero Trust, crie o time com o nome '{TEAM_NAME}' e escolha o plano Free. "
    "Depois rode este script de novo."
)


class ConfigError(Exception):
    """Configuração ausente ou inválida. A mensagem nomeia a variável, nunca o valor de um segredo."""


class AccessNotEnabled(Exception):
    """A conta ainda não tem o Zero Trust ativo."""

    def __init__(self) -> None:
        super().__init__(NOT_ENABLED_MESSAGE)


class CloudflareError(Exception):
    """Falha da API. Guarda método, caminho, status e os erros da Cloudflare; só imprime os códigos."""

    def __init__(self, method: str, path: str, status: int | None, errors: list[Json]) -> None:
        self.method = method
        self.path = path
        self.status = status
        self.errors = errors
        super().__init__(self.describe())

    @property
    def not_enabled(self) -> bool:
        return any("not_enabled" in str(e.get("message", "")) for e in self.errors if isinstance(e, dict))

    def describe(self) -> str:
        codes = [str(e["code"]) for e in self.errors if isinstance(e, dict) and "code" in e]
        status = f"HTTP {self.status}" if self.status is not None else "falha de rede"
        suffix = f" (códigos {', '.join(codes)})" if codes else ""
        return f"falha em {self.method} {self.path}: {status}{suffix}"


class Client(Protocol):
    def request(self, method: str, path: str, body: Json = None) -> Json: ...


class HttpClient:
    """Cliente da API v4 da Cloudflare. Devolve o `result` do envelope."""

    def __init__(self, token: str) -> None:
        self._token = token

    def request(self, method: str, path: str, body: Json = None) -> Json:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(API + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                envelope = json.load(r)
        except urllib.error.HTTPError as e:
            raise CloudflareError(method, path, e.code, _errors(e)) from None
        except urllib.error.URLError:
            raise CloudflareError(method, path, None, []) from None
        if not envelope.get("success", False):
            raise CloudflareError(method, path, 200, envelope.get("errors") or [])
        return envelope.get("result")


def _errors(error: urllib.error.HTTPError) -> list[Json]:
    try:
        errors = json.load(error).get("errors")
    except (ValueError, AttributeError):
        return []
    return errors if isinstance(errors, list) else []


def parse_emails(raw: str | None) -> list[str]:
    """Os e-mails dos alunos: separa por vírgula ou espaço, apara, põe em minúsculas e tira repetidos."""
    emails: list[str] = []
    for item in re.split(r"[\s,]+", raw or ""):
        email = item.strip().lower()
        if not email or email in emails:
            continue
        if not EMAIL.match(email):
            raise ConfigError(f"{EMAILS_VAR} tem um valor que não é e-mail: {email!r}")
        emails.append(email)
    return emails


def policy(emails: list[str], policy_id: str | None = None) -> Json:
    include: list[Json] = [{"email_domain": {"domain": ALLOWED_DOMAIN}}]
    include += [{"email": {"email": email}} for email in emails]
    body: Json = {"name": POLICY_NAME, "decision": "allow", "precedence": 1, "include": include}
    if policy_id:
        body["id"] = policy_id
    return body


def app_payload(otp_id: str, emails: list[str], policy_id: str | None = None) -> Json:
    return {
        "name": APP_NAME,
        "type": "self_hosted",
        "domain": APP_DOMAIN,
        "allowed_idps": [otp_id],
        "auto_redirect_to_identity": True,
        "session_duration": "24h",
        "policies": [policy(emails, policy_id)],
    }


def _call(client: Client, method: str, path: str, body: Json = None) -> Json:
    try:
        return client.request(method, path, body)
    except CloudflareError as error:
        if error.not_enabled:
            raise AccessNotEnabled() from None
        raise


def _show(out: TextIO, method: str, path: str, body: Json) -> None:
    out.write(f"[dry-run] {method} {path}\n{json.dumps(body, ensure_ascii=False, indent=2)}\n")


def ensure_otp(client: Client, account: str, dry_run: bool, out: TextIO) -> str:
    path = f"/accounts/{account}/access/identity_providers"
    for idp in _call(client, "GET", path) or []:
        if idp.get("type") == OTP_TYPE:
            return str(idp["id"])
    body = {"type": OTP_TYPE, "name": OTP_NAME, "config": {}}
    if dry_run:
        _show(out, "POST", path, body)
        return PENDING_OTP
    out.write("Criado o provedor de código por e-mail (one-time PIN).\n")
    return str(_call(client, "POST", path, body)["id"])


def ensure_app(client: Client, account: str, otp_id: str, emails: list[str],
               dry_run: bool, out: TextIO) -> Json:
    path = f"/accounts/{account}/access/apps"
    existing = next((a for a in _call(client, "GET", path) or [] if a.get("name") == APP_NAME), None)
    if existing is None:
        body = app_payload(otp_id, emails)
        if dry_run:
            _show(out, "POST", path, body)
            return None
        out.write(f"Criada a aplicação do Access {APP_NAME}.\n")
        return _call(client, "POST", path, body)
    policy_id = next((p.get("id") for p in existing.get("policies") or []
                      if isinstance(p, dict) and p.get("name") == POLICY_NAME), None)
    body = app_payload(otp_id, emails, policy_id)
    app_path = f"{path}/{existing['id']}"
    if dry_run:
        _show(out, "PUT", app_path, body)
        return existing
    out.write(f"Atualizada a aplicação do Access {APP_NAME}.\n")
    return _call(client, "PUT", app_path, body)


def provision(client: Client, account: str, emails: list[str], dry_run: bool = False,
              out: TextIO = sys.stdout) -> int:
    otp_id = ensure_otp(client, account, dry_run, out)
    app = ensure_app(client, account, otp_id, emails, dry_run, out)
    organization = _call(client, "GET", f"/accounts/{account}/access/organizations") or {}
    if app and app.get("aud"):
        out.write(f"ACCESS_AUD={app['aud']}\n")
    else:
        out.write("# ACCESS_AUD sai na execução real, quando a aplicação for criada.\n")
    out.write(f"ACCESS_TEAM_DOMAIN={organization.get('auth_domain', '')}\n")
    return 0


def main(argv: list[str], env: Mapping[str, str] = os.environ,
         client_factory: Callable[[str], Client] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Provisiona o Cloudflare Access do Worker (#54).")
    parser.add_argument("--dry-run", action="store_true", help="mostra o que enviaria, sem gravar nada")
    args = parser.parse_args(argv)
    try:
        token, account = env.get(TOKEN_VAR, "").strip(), env.get(ACCOUNT_VAR, "").strip()
        if not token or not account:
            raise ConfigError(f"defina {TOKEN_VAR} e {ACCOUNT_VAR}")
        emails = parse_emails(env.get(EMAILS_VAR))
        client = (client_factory or HttpClient)(token)
        return provision(client, account, emails, dry_run=args.dry_run, out=sys.stdout)
    except (ConfigError, AccessNotEnabled, CloudflareError) as error:
        print(f"erro: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
