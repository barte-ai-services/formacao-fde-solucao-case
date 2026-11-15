"""Gera os diagramas BPMN 2.0 do contas a pagar da Já Chegou: o processo atual e o processo-alvo.

Cada processo é descrito como dados (raias, elementos, fluxos e anotações). O script calcula a
posição de cada forma numa grade de raias e colunas e escreve o XML com o diagrama (BPMN DI),
pronto para abrir no bpmn.io ou no Camunda Modeler.

    python3 scripts/gerar_bpmn.py
"""

from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import escape

COL_W = 160      # largura de uma coluna
ROW_H = 150      # altura de uma linha dentro da raia
LABEL_W = 30     # faixa do nome da raia
POOL_X = 100
POOL_Y = 80
TOP_PAD = 100    # centro da forma em relação ao topo da linha (deixa espaço para anotações)

TAMANHOS = {
    "task": (120, 70), "serviceTask": (120, 70), "userTask": (120, 70),
    "businessRuleTask": (120, 70), "sendTask": (120, 70),
    "startEvent": (36, 36), "endEvent": (36, 36), "intermediateCatchEvent": (36, 36),
    "exclusiveGateway": (50, 50), "parallelGateway": (50, 50),
}
EVENTOS = {"startEvent", "endEvent", "intermediateCatchEvent"}
GATEWAYS = {"exclusiveGateway", "parallelGateway"}


@dataclass
class Elemento:
    id: str
    tipo: str
    nome: str
    raia: str
    col: int
    linha: int = 0
    mensagem: bool = False


@dataclass
class Fluxo:
    origem: str
    destino: str
    nome: str = ""
    desvio: int = 0   # afasta a descida vertical, para dois fluxos não se sobreporem


@dataclass
class Anotacao:
    elemento: str
    texto: str


@dataclass
class Processo:
    id: str
    nome: str
    participante: str
    raias: list[tuple[str, str, int]]           # (id, nome, linhas)
    elementos: list[Elemento]
    fluxos: list[Fluxo]
    anotacoes: list[Anotacao] = field(default_factory=list)


def gerar(p: Processo) -> str:
    # posição de cada raia
    raia_y, y = {}, POOL_Y
    for rid, _, linhas in p.raias:
        raia_y[rid] = (y, linhas * ROW_H)
        y += linhas * ROW_H
    pool_h = y - POOL_Y
    ncols = max(e.col for e in p.elementos) + 1
    pool_w = LABEL_W + 40 + ncols * COL_W

    centro, caixa = {}, {}
    for e in p.elementos:
        w, h = TAMANHOS[e.tipo]
        cx = POOL_X + LABEL_W + 40 + e.col * COL_W + COL_W / 2
        cy = raia_y[e.raia][0] + e.linha * ROW_H + TOP_PAD
        centro[e.id] = (cx, cy)
        caixa[e.id] = (cx - w / 2, cy - h / 2, w, h)

    entra = {e.id: [] for e in p.elementos}
    sai = {e.id: [] for e in p.elementos}
    for i, f in enumerate(p.fluxos):
        f.id = f"Flow_{i + 1}"
        sai[f.origem].append(f.id)
        entra[f.destino].append(f.id)

    x = []
    x.append('<?xml version="1.0" encoding="UTF-8"?>')
    x.append(
        '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
        'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
        'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
        'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" '
        f'id="Defs_{p.id}" targetNamespace="https://barte.ai/formacao-fde/ja-chegou">'
    )
    x.append(f'  <bpmn:collaboration id="Collab_{p.id}">')
    x.append(f'    <bpmn:participant id="Part_{p.id}" name="{escape(p.participante)}" processRef="{p.id}" />')
    x.append("  </bpmn:collaboration>")
    x.append(f'  <bpmn:process id="{p.id}" name="{escape(p.nome)}" isExecutable="false">')
    x.append(f'    <bpmn:laneSet id="LaneSet_{p.id}">')
    for rid, rnome, _ in p.raias:
        x.append(f'      <bpmn:lane id="{rid}" name="{escape(rnome)}">')
        for e in p.elementos:
            if e.raia == rid:
                x.append(f"        <bpmn:flowNodeRef>{e.id}</bpmn:flowNodeRef>")
        x.append("      </bpmn:lane>")
    x.append("    </bpmn:laneSet>")
    for e in p.elementos:
        x.append(f'    <bpmn:{e.tipo} id="{e.id}" name="{escape(e.nome)}">')
        for fid in entra[e.id]:
            x.append(f"      <bpmn:incoming>{fid}</bpmn:incoming>")
        for fid in sai[e.id]:
            x.append(f"      <bpmn:outgoing>{fid}</bpmn:outgoing>")
        if e.mensagem:
            x.append("      <bpmn:messageEventDefinition />")
        x.append(f"    </bpmn:{e.tipo}>")
    for f in p.fluxos:
        nome = f' name="{escape(f.nome)}"' if f.nome else ""
        x.append(f'    <bpmn:sequenceFlow id="{f.id}"{nome} sourceRef="{f.origem}" targetRef="{f.destino}" />')
    for i, a in enumerate(p.anotacoes):
        x.append(f'    <bpmn:textAnnotation id="Note_{i + 1}"><bpmn:text>{escape(a.texto)}</bpmn:text></bpmn:textAnnotation>')
        x.append(f'    <bpmn:association id="Assoc_{i + 1}" sourceRef="{a.elemento}" targetRef="Note_{i + 1}" />')
    x.append("  </bpmn:process>")

    # diagrama
    x.append(f'  <bpmndi:BPMNDiagram id="Diagram_{p.id}">')
    x.append(f'    <bpmndi:BPMNPlane id="Plane_{p.id}" bpmnElement="Collab_{p.id}">')
    x.append(f'      <bpmndi:BPMNShape id="Part_{p.id}_di" bpmnElement="Part_{p.id}" isHorizontal="true">')
    x.append(f'        <dc:Bounds x="{POOL_X}" y="{POOL_Y}" width="{pool_w}" height="{pool_h}" />')
    x.append("      </bpmndi:BPMNShape>")
    for rid, _, _ in p.raias:
        ry, rh = raia_y[rid]
        x.append(f'      <bpmndi:BPMNShape id="{rid}_di" bpmnElement="{rid}" isHorizontal="true">')
        x.append(f'        <dc:Bounds x="{POOL_X + LABEL_W}" y="{ry}" width="{pool_w - LABEL_W}" height="{rh}" />')
        x.append("      </bpmndi:BPMNShape>")
    for e in p.elementos:
        bx, by, w, h = caixa[e.id]
        x.append(f'      <bpmndi:BPMNShape id="{e.id}_di" bpmnElement="{e.id}">')
        x.append(f'        <dc:Bounds x="{bx:.0f}" y="{by:.0f}" width="{w}" height="{h}" />')
        if e.tipo in EVENTOS or e.tipo in GATEWAYS:
            x.append(f'        <bpmndi:BPMNLabel><dc:Bounds x="{bx + w / 2 - 50:.0f}" y="{by + h + 6:.0f}" width="100" height="27" /></bpmndi:BPMNLabel>')
        x.append("      </bpmndi:BPMNShape>")
    for f in p.fluxos:
        sx, sy, sw, _ = caixa[f.origem]
        tx, ty, _, th = caixa[f.destino]
        a = (sx + sw, centro[f.origem][1])
        b = (tx, centro[f.destino][1])
        if abs(a[1] - b[1]) < 1:
            pontos = [a, b]
        else:
            vx = b[0] - 18 - f.desvio
            pontos = [a, (vx, a[1]), (vx, b[1]), b]
        x.append(f'      <bpmndi:BPMNEdge id="{f.id}_di" bpmnElement="{f.id}">')
        for px, py in pontos:
            x.append(f'        <di:waypoint x="{px:.0f}" y="{py:.0f}" />')
        if f.nome:
            if len(pontos) == 2:
                lx, ly = a[0] + 6, a[1] - 22
            else:
                lx, ly = pontos[1][0] - 86, b[1] - 22
            x.append(f'        <bpmndi:BPMNLabel><dc:Bounds x="{lx:.0f}" y="{ly:.0f}" width="80" height="18" /></bpmndi:BPMNLabel>')
        x.append("      </bpmndi:BPMNEdge>")
    for i, a in enumerate(p.anotacoes):
        ex, ey, ew, _ = caixa[a.elemento]
        ry, _ = raia_y[next(e.raia for e in p.elementos if e.id == a.elemento)]
        linha = next(e.linha for e in p.elementos if e.id == a.elemento)
        nx, ny = ex + ew / 2 + 8, ry + linha * ROW_H + 4
        x.append(f'      <bpmndi:BPMNShape id="Note_{i + 1}_di" bpmnElement="Note_{i + 1}">')
        x.append(f'        <dc:Bounds x="{nx:.0f}" y="{ny:.0f}" width="260" height="56" />')
        x.append("      </bpmndi:BPMNShape>")
        x.append(f'      <bpmndi:BPMNEdge id="Assoc_{i + 1}_di" bpmnElement="Assoc_{i + 1}">')
        x.append(f'        <di:waypoint x="{ex + ew / 2:.0f}" y="{ey:.0f}" />')
        x.append(f'        <di:waypoint x="{nx + 12:.0f}" y="{ny + 56:.0f}" />')
        x.append("      </bpmndi:BPMNEdge>")
    x.append("    </bpmndi:BPMNPlane>")
    x.append("  </bpmndi:BPMNDiagram>")
    x.append("</bpmn:definitions>")
    return "\n".join(x) + "\n"


E, F, A = Elemento, Fluxo, Anotacao

# ---------------------------------------------------------------------------------------------
# Processo atual: a nota é conferida depois de a mercadoria entrar, e o pagamento não espera.
# ---------------------------------------------------------------------------------------------
ATUAL = Processo(
    id="ContasAPagar_Atual",
    nome="Contas a pagar da Já Chegou: processo atual",
    participante="Já Chegou: contas a pagar hoje",
    raias=[
        ("L_Compras", "Compras", 1),
        ("L_Fornecedor", "Fornecedor", 1),
        ("L_Doca", "Doca (CD e lojas)", 1),
        ("L_Conferencia", "Contas a pagar: conferência", 2),
        ("L_Lista", "Contas a pagar: lista do dia", 1),
        ("L_CFO", "CFO", 1),
        ("L_Banco", "Banco", 1),
    ],
    elementos=[
        E("A_Inicio", "startEvent", "Precisa comprar", "L_Compras", 0),
        E("A_Pedido", "task", "Emitir o pedido no ERP", "L_Compras", 1),
        E("A_Nota", "task", "Emitir a nota antes de entregar", "L_Fornecedor", 2),
        E("A_Divide", "parallelGateway", "", "L_Fornecedor", 3),
        E("A_Entrega", "task", "Entregar a mercadoria", "L_Fornecedor", 4),
        E("A_Recebe", "task", "Receber a mercadoria", "L_Doca", 5),
        E("A_Confere", "task", "Conferir nota, pedido e recebido à mão", "L_Conferencia", 6),
        E("A_Diverge", "exclusiveGateway", "Diverge?", "L_Conferencia", 7),
        E("A_Complementar", "task", "Abrir ordem complementar ou provisionar", "L_Conferencia", 8, 1),
        E("A_Conciliada", "endEvent", "Nota conciliada", "L_Conferencia", 8),
        E("A_Provisao", "endEvent", "Mês fecha com provisão", "L_Conferencia", 9, 1),
        E("A_Lista", "task", "Montar a lista do dia (ERP, e-mail, WhatsApp)", "L_Lista", 4),
        E("A_Aprova", "userTask", "Aprovar item a item, das 16h às 18h", "L_CFO", 5),
        E("A_Paga", "task", "Pagar um boleto por vez", "L_Banco", 6),
        E("A_Pago", "endEvent", "Pago, conferido ou não", "L_Banco", 7),
    ],
    fluxos=[
        F("A_Inicio", "A_Pedido"),
        F("A_Pedido", "A_Nota"),
        F("A_Nota", "A_Divide"),
        F("A_Divide", "A_Entrega"),
        F("A_Divide", "A_Lista", desvio=0),
        F("A_Entrega", "A_Recebe"),
        F("A_Recebe", "A_Confere"),
        F("A_Confere", "A_Diverge"),
        F("A_Diverge", "A_Conciliada", "não"),
        F("A_Diverge", "A_Complementar", "sim"),
        F("A_Complementar", "A_Provisao"),
        F("A_Lista", "A_Aprova"),
        F("A_Aprova", "A_Paga"),
        F("A_Paga", "A_Pago"),
    ],
    anotacoes=[
        A("A_Recebe", "Ninguém olhou a nota antes. Entra mesmo divergente, por pressão comercial."),
        A("A_Confere", "Até 14 dias no CD. Só 0,7% das notas casam sozinhas."),
        A("A_Paga", "Pagar errado: R$ 543 mil por mês sem mercadoria, nada recuperado."),
    ],
)

# ---------------------------------------------------------------------------------------------
# Processo-alvo: a nota é conferida quando é emitida, antes da doca. O que bate passa direto;
# a pessoa entra só na exceção, pela régua de alçadas; o título só vai para a lista conferido.
# ---------------------------------------------------------------------------------------------
ALVO = Processo(
    id="ContasAPagar_Alvo",
    nome="Contas a pagar da Já Chegou: processo-alvo",
    participante="Já Chegou: contas a pagar com o agente",
    raias=[
        ("L_Captura", "Captura de notas", 1),
        ("L_Agente", "Agente", 1),
        ("L_Aprovador", "Aprovador da alçada", 1),
        ("L_Doca", "Doca (CD)", 1),
        ("L_ContasPagar", "Contas a pagar", 3),
    ],
    elementos=[
        E("B_Emitida", "startEvent", "Nota emitida na SEFAZ", "L_Captura", 0, mensagem=True),
        E("B_Captura", "serviceTask", "Capturar a nota", "L_Captura", 1),
        E("B_Classifica", "serviceTask", "Classificar a divergência", "L_Agente", 2),
        E("B_Decide", "serviceTask", "Propor a ação na doca", "L_Agente", 3),
        E("B_Alcada", "businessRuleTask", "Definir o aprovador pela régua", "L_Agente", 4),
        E("B_QuemDecide", "exclusiveGateway", "Quem decide?", "L_Agente", 5),
        E("B_Aprova", "userTask", "Confirmar ou alterar a ação", "L_Aprovador", 6),
        E("B_Junta", "exclusiveGateway", "", "L_Doca", 7),
        E("B_Planeja", "userTask", "Planejar o recebimento", "L_Doca", 8),
        E("B_Chega", "intermediateCatchEvent", "Mercadoria chega", "L_Doca", 9, mensagem=True),
        E("B_Registra", "userTask", "Registrar o recebido no coletor", "L_Doca", 10),
        E("B_Concilia", "serviceTask", "Conciliar nota, pedido e recebido", "L_Agente", 11),
        E("B_Resultado", "exclusiveGateway", "Resultado na doca", "L_Agente", 12),
        E("B_Libera", "task", "Liberar o título para a lista do dia", "L_ContasPagar", 14, 0),
        E("B_Devolucao", "task", "Emitir nota de devolução da diferença", "L_ContasPagar", 13, 1),
        E("B_Bloqueia", "task", "Bloquear o título", "L_ContasPagar", 13, 2),
        E("B_NaLista", "endEvent", "Título na lista do dia, conferido", "L_ContasPagar", 15, 0),
        E("B_Bloqueado", "endEvent", "Título bloqueado", "L_ContasPagar", 14, 2),
    ],
    fluxos=[
        F("B_Emitida", "B_Captura"),
        F("B_Captura", "B_Classifica"),
        F("B_Classifica", "B_Decide"),
        F("B_Decide", "B_Alcada"),
        F("B_Alcada", "B_QuemDecide"),
        F("B_QuemDecide", "B_Aprova", "pessoa"),
        F("B_QuemDecide", "B_Junta", "regra", desvio=14),
        F("B_Aprova", "B_Junta"),
        F("B_Junta", "B_Planeja"),
        F("B_Planeja", "B_Chega"),
        F("B_Chega", "B_Registra"),
        F("B_Registra", "B_Concilia"),
        F("B_Concilia", "B_Resultado"),
        F("B_Resultado", "B_Libera", "receber"),
        F("B_Resultado", "B_Devolucao", "receber parcial", desvio=0),
        F("B_Resultado", "B_Bloqueia", "recusar", desvio=14),
        F("B_Devolucao", "B_Libera"),
        F("B_Libera", "B_NaLista"),
        F("B_Bloqueia", "B_Bloqueado"),
    ],
    anotacoes=[
        A("B_Classifica", "Antes da doca: duplicidade primeiro, depois pedido, pago fora do fluxo, cadastro, item e unidade."),
        A("B_QuemDecide", "Régua: o que bate passa direto (regra). Exceção vai à alçada; duplicidade é bloqueio."),
        A("B_Planeja", "A doca sabe antes do caminhão: receber, receber parcial ou recusar."),
        A("B_Concilia", "Falta física e quantidade menor aparecem aqui."),
    ],
)


def main() -> None:
    destino = Path(__file__).resolve().parent.parent / "docs" / "processo"
    destino.mkdir(parents=True, exist_ok=True)
    (destino / "processo-atual.bpmn").write_text(gerar(ATUAL), encoding="utf-8")
    (destino / "processo-alvo.bpmn").write_text(gerar(ALVO), encoding="utf-8")
    print(f"gerados em {destino}")


if __name__ == "__main__":
    main()
