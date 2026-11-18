#!/usr/bin/env python3
"""Provisionamento idempotente do Cloudflare Access na frente do Worker (#54, #232).

Atualiza a aplicação do Access que o Worker já usa, a que tem o AUD de BARTE_ACADEMY_ACCESS_AUD, e
garante o provedor de identidade de código por e-mail (one-time PIN). A política libera qualquer e-mail
(`allow` com `include: everyone`, decisão do CFO) e o código por e-mail é o único provedor. O PUT substitui
o recurso, então o corpo parte da aplicação inteira (menos os campos só de leitura, em READ_ONLY_APP_FIELDS)
e troca só duas coisas: `allowed_idps`, que vira exatamente o código por e-mail (vazio ou ausente, que na API
é "todos os provedores", também), e `policies`, onde a política do script (a de POLICY_NAME ou a de
LEGACY_POLICY_NAME, de antes) é trocada no lugar ou acrescentada. A Cloudflare não aceita política reutilizável
e da aplicação juntas no mesmo PUT: se alguma política existente é reutilizável, a do script também vira
(atualizada ou criada em /access/policies) e o PUT manda todas como link; senão as alheias vão só com as chaves
aceitas no pedido (INLINE_POLICY_KEYS). A política reutilizável é de quem a liga: a candidata é a que a própria
aplicação já liga com nome do script, ou, na falta, a da conta com o nome atual; se o `app_count` dela diz que outra
aplicação a usa, o script recusa e não grava nada, porque o `include: everyone` valeria lá também. Nome, domínio e
AUD não mudam. Rodar duas vezes deixa o mesmo estado.

O MCP (#321) entra pelo mesmo Access da API. O PUT agora troca também `destinations`, que só ganha o destino
público de MCP_HOST (se ainda não está; sem `destinations`, o corpo passa a ter o domínio atual e o do MCP), e
`oauth_configuration.enabled`, que vira ligado (OAuth gerenciado: o Claude abre o login do Access); os demais
campos de `oauth_configuration` ficam como vieram. O script nunca remove um destino nem desliga o OAuth.

Criar uma aplicação nova só por pedido explícito, com --create, e então o domínio vem de
BARTE_ACADEMY_ACCESS_APP_DOMAIN. Sem --create, um AUD que não bate com nenhuma aplicação é erro.

Variáveis de ambiente: BARTE_ACADEMY_CLOUDFLARE_API_TOKEN, BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID e
BARTE_ACADEMY_ACCESS_AUD.
Nunca imprime o token nem o corpo das respostas de erro. O --dry-run da aplicação existente
resume em campos nomeados (posição, precedência e tipo de cada política, destinos e OAuth antes e depois), sem a
configuração dela, sem a conta e sem id de aplicação ou de política: o log do Actions de um repositório público
é aberto.

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
AUD_VAR = "BARTE_ACADEMY_ACCESS_AUD"
APP_DOMAIN_VAR = "BARTE_ACADEMY_ACCESS_APP_DOMAIN"

APP_NAME = "formacao-fde-solucao-case"
POLICY_NAME = "formacao-fde-solucao-case: qualquer e-mail"
# O nome de antes do plano "qualquer e-mail": a política que já o tem também é a do script e é trocada no lugar. (#232)
LEGACY_POLICY_NAME = "formacao-fde-solucao-case: barte.com e alunos"
SCRIPT_POLICY_NAMES = (POLICY_NAME, LEGACY_POLICY_NAME)
# O destino público do MCP, que passa pelo mesmo Access da API para o login de cliente MCP. (#321)
MCP_HOST = "formacao-fde-solucao-case-mcp.barte-academy.workers.dev"
OTP_TYPE = "onetimepin"
OTP_NAME = "Código por e-mail"
# O que a API do Access devolve da aplicação e não aceita de volta no PUT: identificadores e carimbos. (#232)
READ_ONLY_APP_FIELDS = ("id", "uid", "aud", "created_at", "updated_at")
# As chaves que o item inline de `policies` aceita no PUT da aplicação, pelo schema público da Cloudflare. (#232)
INLINE_POLICY_KEYS = (
    "id", "name", "decision", "include", "exclude", "require", "precedence", "session_duration",
    "isolation_required", "approval_required", "approval_groups", "purpose_justification_required",
    "purpose_justification_prompt", "mfa_config",
)
PENDING_OTP = "<id do one-time PIN, criado na execução real>"
PENDING_POLICY = "<id da política reutilizável, criada na execução real>"

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
    """Falha da API. Guarda método, caminho, status e os erros da Cloudflare; só imprime a rota sem a conta e os códigos."""

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
        route = re.sub(r"^/accounts/[^/]+", "", self.path)
        route = re.sub(r"^(/access/(?:apps|policies|identity_providers))/[^/]+", r"\1/<id>", route)
        codes = [str(e["code"]) for e in self.errors if isinstance(e, dict) and "code" in e]
        status = f"HTTP {self.status}" if self.status is not None else "falha de rede"
        suffix = f" (códigos {', '.join(codes)})" if codes else ""
        return f"falha em {self.method} {route}: {status}{suffix}"


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


@dataclass(frozen=True)
class Options:
    """O que a execução pede: o AUD da aplicação e os dois interruptores."""

    aud: str
    create: bool = False
    dry_run: bool = False
    app_domain: str = ""


def validate(options: Options) -> None:
    """Recusa antes de qualquer chamada à API o que tornaria a execução gravar errado ou nada."""
    if not options.aud and not options.create:
        raise ConfigError(f"defina {AUD_VAR} com o AUD da aplicação do Access (ou use --create para criar uma)")


def policy_fields() -> Json:
    """O que a política do script diz, sem precedência: o corpo da política reutilizável da conta."""
    return {"name": POLICY_NAME, "decision": "allow", "include": [{"everyone": {}}]}


def is_script_policy(item: Json) -> bool:
    """A política é a do script: tem o nome atual ou o de antes."""
    return isinstance(item, dict) and item.get("name") in SCRIPT_POLICY_NAMES


def policy(current: Json = None, precedence: int = 1) -> Json:
    """A política do script. Se ela já existe na aplicação (`current`), reaproveita o id e a precedência."""
    body: Json = {**policy_fields(), "precedence": precedence}
    if current:
        body["precedence"] = current.get("precedence", precedence)
        if current.get("id"):
            body["id"] = current["id"]
    return body


def new_app_payload(otp_id: str, domain: str) -> Json:
    return {
        "name": APP_NAME,
        "type": "self_hosted",
        "domain": domain,
        "allowed_idps": [otp_id],
        "auto_redirect_to_identity": True,
        "session_duration": "24h",
        "policies": [policy()],
    }


def uses_reusable(existing: Json) -> bool:
    """A aplicação tem alguma política reutilizável (no GET, `reusable: true`)."""
    return any(isinstance(p, dict) and p.get("reusable") is True for p in existing.get("policies") or [])


def _next_precedence(existing: list[Json]) -> int:
    taken = [p["precedence"] for p in existing if isinstance(p, dict) and isinstance(p.get("precedence"), int)]
    return max(taken, default=0) + 1


def _inline(item: Json) -> Json:
    return {k: v for k, v in item.items() if k in INLINE_POLICY_KEYS} if isinstance(item, dict) else item


def merged_policies(existing: list[Json]) -> list[Json]:
    """Políticas da aplicação (inline): as alheias nas chaves aceitas, a do script no lugar ou ao fim."""
    mine = next((p for p in existing if is_script_policy(p)), None)
    if mine is not None:
        return [policy(mine) if p is mine else _inline(p) for p in existing]
    return [*map(_inline, existing), policy(precedence=_next_precedence(existing))]


def linked_policies(existing: list[Json], policy_id: str) -> list[Json]:
    """Políticas reutilizáveis: todas como link `{id, precedence}`; a do script no lugar ou ao fim."""
    mine = next((p for p in existing if p.get("id") == policy_id or is_script_policy(p)), None)
    own = {"id": policy_id, "precedence": (mine or {}).get("precedence", _next_precedence(existing))}
    links = [own if p is mine else {k: p[k] for k in ("id", "precedence") if k in p} for p in existing]
    return links if mine is not None else [*links, own]


def _is_mcp_destination(item: Json) -> bool:
    """O destino é público e é o do MCP (o uri sem barra final)."""
    return (isinstance(item, dict) and item.get("type") == "public"
            and str(item.get("uri", "")).rstrip("/") == MCP_HOST)


def merged_destinations(existing: Json) -> list[Json]:
    """Os destinos da aplicação como vieram, mais o do MCP ao fim se ainda não está. Nunca tira nenhum."""
    current = list(existing.get("destinations") or [])
    if not current:
        domain = existing.get("domain")
        current = [{"type": "public", "uri": domain}] if domain else []
    if any(_is_mcp_destination(d) for d in current):
        return current
    return [*current, {"type": "public", "uri": MCP_HOST}]


def oauth_enabled(existing: Json) -> Json:
    """`oauth_configuration` da aplicação com `enabled` ligado; os outros campos ficam como vieram."""
    current = existing.get("oauth_configuration")
    return {**(current if isinstance(current, dict) else {}), "enabled": True}


def updated_app_payload(existing: Json, otp_id: str, policy_id: str | None) -> Json:
    """O PUT substitui o recurso: o corpo parte da aplicação toda e troca `allowed_idps`, `policies`,
    `destinations` (só acrescenta o do MCP) e `oauth_configuration.enabled` (liga).

    `allowed_idps` vira exatamente o código por e-mail, qualquer que seja o valor atual.

    `policy_id` é o id da política reutilizável do script; None quando as políticas são da aplicação.
    """
    body = {key: value for key, value in existing.items() if key not in READ_ONLY_APP_FIELDS}
    body["allowed_idps"] = [otp_id]
    current = list(existing.get("policies") or [])
    body["policies"] = merged_policies(current) if policy_id is None else linked_policies(current, policy_id)
    body["destinations"] = merged_destinations(existing)
    body["oauth_configuration"] = oauth_enabled(existing)
    return body


def _call(client: Client, method: str, path: str, body: Json = None) -> Json:
    try:
        return client.request(method, path, body)
    except CloudflareError as error:
        if error.not_enabled:
            raise AccessNotEnabled() from None
        raise


def _show(out: TextIO, method: str, route: str, body: Json) -> None:
    """Dump do corpo que o script mesmo montou; a rota vai sem o `/accounts/<id>`."""
    out.write(f"[dry-run] {method} {route}\n{json.dumps(body, ensure_ascii=False, indent=2)}\n")


def _destinations_text(destinations: list[Json]) -> str:
    """Os uri públicos, que são hostnames; os de outro tipo só pela contagem e pelo tipo."""
    public = [str(d.get("uri", "")) for d in destinations if isinstance(d, dict) and d.get("type") == "public"]
    others: dict[str, int] = {}
    for d in destinations:
        if not (isinstance(d, dict) and d.get("type") == "public"):
            kind = str(d.get("type", "desconhecido")) if isinstance(d, dict) else "desconhecido"
            others[kind] = others.get(kind, 0) + 1
    parts = [*public, *(f"{n} de tipo {kind}" for kind, n in others.items())]
    return ", ".join(parts) if parts else "nenhum"


def _destination_lines(existing: Json, body: Json) -> list[str]:
    before = list(existing.get("destinations") or [])
    only_domain = not before
    if only_domain:
        before = [{"type": "public", "uri": existing["domain"]}] if existing.get("domain") else []
    added = not any(_is_mcp_destination(d) for d in before)
    return [
        f"destinos antes: {_destinations_text(before)}{' (só domain)' if only_domain else ''}",
        f"destinos depois: {_destinations_text(body['destinations'])}",
        f"destino do MCP: {'acrescentado' if added else 'já estava'}",
    ]


def _oauth_line(existing: Json) -> str:
    current = existing.get("oauth_configuration")
    was_on = isinstance(current, dict) and current.get("enabled") is True
    return "oauth_configuration.enabled: " + ("ligado, inalterado" if was_on else "desligado -> ligado")


def describe_put(existing: Json, body: Json, policy_id: str | None) -> str:
    """Resumo do PUT da aplicação em campos nomeados: nunca o corpo, que é a configuração inteira dela, nem ids."""
    policies = body["policies"]
    mine = next(p for p in policies if is_script_policy(p) or (policy_id and p.get("id") == policy_id))
    kind = "reutilizável" if policy_id is not None else "da aplicação"
    idps = "inalterado" if body.get("allowed_idps") == existing.get("allowed_idps") \
        else "passa a ser só o código por e-mail"
    path = "políticas reutilizáveis (na execução real, POST ou PUT em /access/policies)" if policy_id is not None \
        else "políticas da aplicação (inline)"
    lines = [
        "[dry-run] PUT na aplicação do AUD",
        f"allowed_idps: {idps}",
        f"policies: {len(policies)} no total; a do script na precedência {mine.get('precedence')}, "
        "libera qualquer e-mail",
        f"outras políticas: {len(policies) - 1}, mantidas",
        f"caminho: {path}",
        *_destination_lines(existing, body),
        _oauth_line(existing),
    ]
    lines += [f"  política {n}: precedence={p.get('precedence')} tipo={kind}{' (do script)' if p is mine else ''}"
              for n, p in enumerate(policies, start=1)]
    return "\n".join(lines) + "\n"


def find_otp(client: Client, account: str) -> str | None:
    """O id do provedor de código por e-mail da conta, ou None. Só lê."""
    for idp in _call(client, "GET", f"/accounts/{account}/access/identity_providers") or []:
        if idp.get("type") == OTP_TYPE:
            return str(idp["id"])
    return None


def create_otp(client: Client, account: str) -> str:
    body = {"type": OTP_TYPE, "name": OTP_NAME, "config": {}}
    return str(_call(client, "POST", f"/accounts/{account}/access/identity_providers", body)["id"])


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


def _linked_script_policy(existing: Json) -> Json:
    """A política com nome do script que a própria aplicação já liga, ou None."""
    return next((p for p in existing.get("policies") or [] if is_script_policy(p) and p.get("id")), None)


def reusable_candidate(client: Client, account: str, existing: Json) -> Json:
    """A política reutilizável que o script pode gravar, ou None se for criar uma.

    Primeiro a que a aplicação já liga com nome do script; senão a da conta com o nome atual. A de nome antigo
    que a aplicação não liga não é tocada. Recusa, sem gravar, a que outra aplicação também usa.
    """
    account_policies = _call(client, "GET", f"/accounts/{account}/access/policies") or []
    own = _linked_script_policy(existing)
    if own is not None:
        candidate = next((p for p in account_policies if p.get("id") == own["id"]), own)
    else:
        candidate = next((p for p in account_policies if p.get("name") == POLICY_NAME), None)
    if candidate is not None:
        _refuse_if_shared(candidate, linked=own is not None)
    return candidate


def _refuse_if_shared(candidate: Json, linked: bool) -> None:
    """Outra aplicação usa a política: `app_count` maior que 1, ou 1 sem ser a vigente, ou desconhecido e não ligada."""
    count = candidate.get("app_count")
    shared = (count > 1 or (count == 1 and not linked)) if isinstance(count, int) else not linked
    if shared:
        raise ConfigError("a política reutilizável do script está ligada a outra aplicação; nada foi gravado")


def write_script_policy(client: Client, account: str, candidate: Json) -> str:
    """Cria a política do script na conta, ou atualiza a candidata no lugar. Devolve o id."""
    path = f"/accounts/{account}/access/policies"
    if candidate is None:
        return str(_call(client, "POST", path, policy_fields())["id"])
    _call(client, "PUT", f"{path}/{candidate['id']}", policy_fields())
    return str(candidate["id"])


def app_request(existing: Json, otp_id: str, options: Options, policy_id: str | None) -> tuple[str, str, Json]:
    """Método, rota (sem `/accounts/<id>`) e corpo da gravação da aplicação: POST se nova, PUT na vigente."""
    if existing is None:
        return "POST", "/access/apps", new_app_payload(otp_id, options.app_domain)
    return "PUT", f"/access/apps/{existing['id']}", updated_app_payload(existing, otp_id, policy_id)


def report(out: TextIO, existing: Json, app: Json, organization: Json) -> None:
    """O fecho da execução: o que a política diz e os valores que o Worker lê. O AUD só sai de aplicação nova."""
    out.write("Política que libera qualquer e-mail, com o código por e-mail como único provedor.\n")
    if existing is None and app and app.get("aud"):
        out.write(f"ACCESS_AUD={app['aud']}\n")
    elif existing is None:
        out.write("# ACCESS_AUD sai na execução real, quando a aplicação for criada.\n")
    out.write(f"ACCESS_TEAM_DOMAIN={organization.get('auth_domain', '')}\n")


def provision(client: Client, account: str, options: Options, out: TextIO = sys.stdout) -> int:
    validate(options)
    existing = find_app(client, account, options)
    reusable = existing is not None and uses_reusable(existing)
    candidate = reusable_candidate(client, account, existing) if reusable else None  # recusa antes de gravar (#232)
    otp_id = find_otp(client, account)
    if otp_id is None and options.dry_run:
        _show(out, "POST", "/access/identity_providers", {"type": OTP_TYPE, "name": OTP_NAME, "config": {}})
        otp_id = PENDING_OTP
    elif otp_id is None:
        otp_id = create_otp(client, account)
        out.write("Criado o provedor de código por e-mail (one-time PIN).\n")
    policy_id: str | None = None  # None: as políticas são da aplicação (inline) (#232)
    if reusable and options.dry_run:
        policy_id = str(candidate["id"]) if candidate else PENDING_POLICY  # o dry-run só lê (#232)
    elif reusable:
        policy_id = write_script_policy(client, account, candidate)
    method, route, body = app_request(existing, otp_id, options, policy_id)
    if options.dry_run and existing is None:
        _show(out, method, route, body)
        app = existing
    elif options.dry_run:
        out.write(describe_put(existing, body, policy_id))
        app = existing
    else:
        app = _call(client, method, f"/accounts/{account}{route}", body)
        out.write("Criada a aplicação do Access.\n" if existing is None else "Atualizada a aplicação do Access.\n")
    organization = _call(client, "GET", f"/accounts/{account}/access/organizations") or {}
    report(out, existing, app, organization)
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
        options = Options(aud=env.get(AUD_VAR, "").strip(), create=args.create, dry_run=args.dry_run,
                          app_domain=env.get(APP_DOMAIN_VAR, "").strip())
        client = (client_factory or HttpClient)(token)
        return provision(client, account, options, out=sys.stdout)
    except (ConfigError, AccessNotEnabled, CloudflareError) as error:
        print(f"erro: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
