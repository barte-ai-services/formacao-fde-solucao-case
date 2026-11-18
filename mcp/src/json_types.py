"""Os tipos do JSON que atravessa o MCP (#272)."""

from __future__ import annotations

from typing import Any

JsonValue = Any  # #272 JSON decodificado (da API ou do cliente MCP), conferido campo a campo onde é lido
JsonObject = dict[str, JsonValue]
