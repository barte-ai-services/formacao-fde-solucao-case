#!/usr/bin/env python3
"""Provisionamento idempotente do Cloudflare Access na frente do Worker (#54, #232).

Atualiza a aplicação do Access que o Worker já usa, a que tem o AUD de BARTE_ACADEMY_ACCESS_AUD, e
garante o provedor de identidade de código por e-mail (one-time PIN). A política libera quem é da
barte.com e os alunos listados. O PUT substitui o recurso, então o corpo parte da aplicação inteira (menos
os campos só de leitura, em READ_ONLY_APP_FIELDS) e troca só duas coisas: `allowed_idps`, onde o código por
e-mail entra se faltar (vazio ou ausente, que na API é "todos os provedores", fica como está), e `policies`,
onde a política do script é trocada no lugar ou acrescentada, e as outras políticas ficam na forma em que
vieram. Nome, domínio e AUD não mudam. Rodar duas vezes deixa o mesmo estado.

Criar uma aplicação nova só por pedido explícito, com --create, e então o domínio vem de
BARTE_ACADEMY_ACCESS_APP_DOMAIN. Sem --create, um AUD que não bate com nenhuma aplicação é erro.

Variáveis de ambiente: BARTE_ACADEMY_CLOUDFLARE_API_TOKEN, BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID,
BARTE_ACADEMY_ACCESS_AUD e BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS (e-mails dos alunos, separados por
vírgula ou espaço; obrigatória fora do --dry-run; no workflow é secret, porque o Actions imprime o `env`
do step e só mascara secrets).
Nunca imprime o token, o corpo das respostas de erro nem os e-mails: o --dry-run os mascara.

Uso: python3 scripts/cloudflare_access.py [--dry-run] [--create]
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, TextIO

# Any: o JSON da API da Cloudflare só tem forma conhecida em tempo de execução (#54).
Json = Any

API = "https://api.cloudflare.com/client/v4"
TOKEN_VAR = "BARTE_ACADEMY_CLOUDFLARE_API_TOKEN"
ACCOUNT_VAR = "BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID"
EMAILS_VAR = "BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS"
AUD_VAR = "BARTE_ACADEMY_ACCESS_AUD"
APP_DOMAIN_VAR = "BARTE_ACADEMY_ACCESS_APP_DOMAIN"

APP_NAME = "formacao-fde-solucao-case"
POLICY_NAME = "formacao-fde-solucao-case: barte.com e alunos"
ALLOWED_DOMAIN = "barte.com"
OTP_TYPE = "onetimepin"
OTP_NAME = "Código por e-mail"
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# O que a API do Access devolve da aplicação e não aceita de volta no PUT: identificadores e carimbos.
READ_ONLY_APP_FIELDS = ("id", "uid", "aud", "created_at", "updated_at")
PENDING_OTP = "<id do one-time PIN, criado na execução real>"

NOT_ENABLED_MESSAGE = (
    "O Cloudflare Zero Trust (Access) ainda não está ativo nesta conta. Ative uma vez no painel: "
    "Zero Trust, crie o time e escolha o plano Free. "
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
    """Os e-mails dos alunos: separa por vírgula ou espaço, apara, põe em minúsculas e tira repetidos.

    Um item inválido é nomeado pela posição, nunca pelo valor: o e-mail de um aluno não vai ao log da esteira.
    """
    emails: list[str] = []
    for position, item in enumerate(re.split(r"[\s,]+", raw or ""), start=1):
        email = item.strip().lower()
        if not email or email in emails:
            continue
        if not EMAIL.match(email):
            raise ConfigError(f"{EMAILS_VAR} tem um item que não é e-mail, na posição {position}")
        emails.append(email)
    return emails


@dataclass(frozen=True)
class Options:
    """O que a execução pede: o AUD da aplicação, os e-mails, e os dois interruptores."""

    aud: str
    emails: tuple[str, ...]
    create: bool = False
    dry_run: bool = False
    app_domain: str = ""


def validate(options: Options) -> None:
    """Recusa antes de qualquer chamada à API o que tornaria a execução gravar errado ou nada."""
    if not options.aud and not options.create:
        raise ConfigError(f"defina {AUD_VAR} com o AUD da aplicação do Access (ou use --create para criar uma)")
    if not options.emails and not options.dry_run:
        raise ConfigError(f"defina {EMAILS_VAR}: sem e-mails a política deixaria os alunos de fora")


def policy(emails: tuple[str, ...], current: Json = None, precedence: int = 1) -> Json:
    """A política do script. Se ela já existe na aplicação (`current`), reaproveita o id e a precedência."""
    include: list[Json] = [{"email_domain": {"domain": ALLOWED_DOMAIN}}]
    include += [{"email": {"email": email}} for email in emails]
    body: Json = {"name": POLICY_NAME, "decision": "allow", "precedence": precedence, "include": include}
    if current:
        body["precedence"] = current.get("precedence", precedence)
        if current.get("id"):
            body["id"] = current["id"]
    return body


def new_app_payload(otp_id: str, emails: tuple[str, ...], domain: str) -> Json:
    return {
        "name": APP_NAME,
        "type": "self_hosted",
        "domain": domain,
        "allowed_idps": [otp_id],
        "auto_redirect_to_identity": True,
        "session_duration": "24h",
        "policies": [policy(emails)],
    }


def merged_policies(existing: list[Json], emails: tuple[str, ...]) -> list[Json]:
    """As políticas da aplicação como vieram, com a do script trocada no lugar ou acrescentada ao fim."""
    mine = next((p for p in existing if isinstance(p, dict) and p.get("name") == POLICY_NAME), None)
    if mine is not None:
        return [policy(emails, mine) if p is mine else p for p in existing]
    taken = [p["precedence"] for p in existing if isinstance(p, dict) and isinstance(p.get("precedence"), int)]
    return [*existing, policy(emails, precedence=max(taken, default=0) + 1)]


def merged_idps(existing: Json, otp_id: str) -> list[str] | None:
    """`allowed_idps` vazio ou ausente é "todos os provedores da conta": fica como está, sem fixar no OTP."""
    if not existing.get("allowed_idps"):
        return None
    idps = [str(i) for i in existing["allowed_idps"]]
    return idps if otp_id in idps else [*idps, otp_id]


def updated_app_payload(existing: Json, otp_id: str, emails: tuple[str, ...]) -> Json:
    """O PUT substitui o recurso: o corpo parte da aplicação toda e troca só `allowed_idps` e `policies`."""
    body = {key: value for key, value in existing.items() if key not in READ_ONLY_APP_FIELDS}
    idps = merged_idps(existing, otp_id)
    if idps is not None:
        body["allowed_idps"] = idps
    body["policies"] = merged_policies(list(existing.get("policies") or []), emails)
    return body


def _call(client: Client, method: str, path: str, body: Json = None) -> Json:
    try:
        return client.request(method, path, body)
    except CloudflareError as error:
        if error.not_enabled:
            raise AccessNotEnabled() from None
        raise


def _masked(value: Json) -> Json:
    """Cópia do corpo com cada e-mail de aluno trocado por ***, para o dry-run."""
    if isinstance(value, dict):
        if isinstance(value.get("email"), dict) and isinstance(value["email"].get("email"), str):
            return {**value, "email": {**value["email"], "email": "***"}}
        return {key: _masked(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_masked(item) for item in value]
    return value


def _show(out: TextIO, method: str, path: str, body: Json) -> None:
    out.write(f"[dry-run] {method} {path}\n{json.dumps(_masked(body), ensure_ascii=False, indent=2)}\n")


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


def find_app(client: Client, account: str, options: Options) -> Json:
    """A aplicação do AUD informado, ou None quando --create autoriza criar. Só o AUD identifica."""
    apps = _call(client, "GET", f"/accounts/{account}/access/apps") or []
    existing = next((a for a in apps if options.aud and a.get("aud") == options.aud), None)
    if existing is None and not options.create:
        raise ConfigError(f"{AUD_VAR} não corresponde a nenhuma aplicação do Access desta conta; "
                          "confira a variável, nada foi gravado")
    if existing is None and not options.app_domain:
        raise ConfigError(f"defina {APP_DOMAIN_VAR} com o domínio da aplicação nova, nada foi gravado")
    return existing


def app_request(account: str, existing: Json, otp_id: str, options: Options) -> tuple[str, str, Json]:
    """Método, caminho e corpo da gravação da aplicação: POST se for nova, PUT na vigente."""
    path = f"/accounts/{account}/access/apps"
    if existing is None:
        return "POST", path, new_app_payload(otp_id, options.emails, options.app_domain)
    return "PUT", f"{path}/{existing['id']}", updated_app_payload(existing, otp_id, options.emails)


def provision(client: Client, account: str, options: Options, out: TextIO = sys.stdout) -> int:
    validate(options)
    existing = find_app(client, account, options)
    otp_id = ensure_otp(client, account, options.dry_run, out)
    method, path, body = app_request(account, existing, otp_id, options)
    if options.dry_run:
        _show(out, method, path, body)
        app = existing
    else:
        out.write("Criada a aplicação do Access.\n" if existing is None else "Atualizada a aplicação do Access.\n")
        app = _call(client, method, path, body)
    organization = _call(client, "GET", f"/accounts/{account}/access/organizations") or {}
    out.write(f"Política com {len(options.emails)} e-mail(s) de aluno e a barte.com.\n")
    if existing is None and app and app.get("aud"):
        out.write(f"ACCESS_AUD={app['aud']}\n")
    elif existing is None:
        out.write("# ACCESS_AUD sai na execução real, quando a aplicação for criada.\n")
    out.write(f"ACCESS_TEAM_DOMAIN={organization.get('auth_domain', '')}\n")
    return 0


def main(argv: list[str], env: Mapping[str, str] = os.environ,
         client_factory: Callable[[str], Client] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Provisiona o Cloudflare Access do Worker (#54, #232).")
    parser.add_argument("--dry-run", action="store_true", help="mostra o que enviaria, sem gravar nada")
    parser.add_argument("--create", action="store_true", help="cria a aplicação se o AUD não bater com nenhuma")
    args = parser.parse_args(argv)
    try:
        token, account = env.get(TOKEN_VAR, "").strip(), env.get(ACCOUNT_VAR, "").strip()
        if not token or not account:
            raise ConfigError(f"defina {TOKEN_VAR} e {ACCOUNT_VAR}")
        options = Options(aud=env.get(AUD_VAR, "").strip(), emails=tuple(parse_emails(env.get(EMAILS_VAR))),
                          create=args.create, dry_run=args.dry_run,
                          app_domain=env.get(APP_DOMAIN_VAR, "").strip())
        client = (client_factory or HttpClient)(token)
        return provision(client, account, options, out=sys.stdout)
    except (ConfigError, AccessNotEnabled, CloudflareError) as error:
        print(f"erro: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
