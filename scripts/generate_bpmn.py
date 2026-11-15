"""Generates the BPMN 2.0 diagrams of the Já Chegou accounts payable process (#2).

Each process is data: lanes, nodes and flows. The script lays the shapes out on a grid of lanes,
rows and columns, colours every shape by who performs it, and writes the XML with its diagram
(BPMN DI and the BPMN in Color extension), ready for bpmn.io or the Camunda Modeler. Labels shown
in the diagram stay in Portuguese, the language of the case.

    python3 scripts/generate_bpmn.py
"""

from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape

COL_W = 170
ROW_H = 150
LANE_LABEL_W = 30
POOL_X = 60
POOL_Y = 60
SHAPE_TOP = 85
BEND_GAP = 20

SIZES = {
    "task": (130, 76), "serviceTask": (130, 76), "userTask": (130, 76), "businessRuleTask": (130, 76),
    "startEvent": (40, 40), "endEvent": (40, 40), "intermediateCatchEvent": (40, 40),
    "exclusiveGateway": (52, 52), "parallelGateway": (52, 52),
}
GATEWAYS = {"exclusiveGateway", "parallelGateway"}
EVENTS = {"startEvent", "endEvent", "intermediateCatchEvent"}

TONES = {
    "system": ("#E6F1FB", "#185FA5"),
    "agent": ("#EEEDFE", "#534AB7"),
    "person": ("#FAEEDA", "#854F0B"),
    "ok": ("#EAF3DE", "#3B6D11"),
    "block": ("#FCEBEB", "#A32D2D"),
    "neutral": ("#F1EFE8", "#5F5E5A"),
    "gateway": ("#FFFFFF", "#444441"),
}
LANE_TINTS = {
    "system": "#F4F8FD", "agent": "#F6F5FE", "person": "#FFF9F0", "neutral": "#F8F7F3", "block": "#FDF6F6",
}
FLOW_COLORS = {"default": "#5F5E5A", "block": "#A32D2D", "ok": "#3B6D11"}
NAMESPACES = (
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
    'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
    'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
    'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" '
    'xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0"'
)

Box = tuple[float, float, float, float]
Point = tuple[float, float]


@dataclass
class Lane:
    id: str
    name: str
    tone: str
    rows: int = 1


@dataclass
class Node:
    id: str
    kind: str
    name: str
    lane: str
    col: int
    row: int = 0
    tone: str = "neutral"
    message: bool = False


@dataclass
class Flow:
    source: str
    target: str
    name: str = ""
    exit: str = "right"
    entry: str = "left"
    tone: str = "default"
    id: str = ""


@dataclass
class Process:
    id: str
    name: str
    participant: str
    lanes: list[Lane]
    nodes: list[Node]
    flows: list[Flow]


@dataclass
class Layout:
    lane_box: dict[str, Box]
    box: dict[str, Box]
    pool: Box


def layout(p: Process) -> Layout:
    cols = max(n.col for n in p.nodes) + 1
    width = LANE_LABEL_W + 30 + cols * COL_W
    lane_box: dict[str, Box] = {}
    y: float = POOL_Y
    for lane in p.lanes:
        lane_box[lane.id] = (POOL_X + LANE_LABEL_W, y, width - LANE_LABEL_W, lane.rows * ROW_H)
        y += lane.rows * ROW_H
    box: dict[str, Box] = {}
    for n in p.nodes:
        w, h = SIZES[n.kind]
        cx = POOL_X + LANE_LABEL_W + 30 + n.col * COL_W + COL_W / 2
        cy = lane_box[n.lane][1] + n.row * ROW_H + SHAPE_TOP
        box[n.id] = (cx - w / 2, cy - h / 2, w, h)
    return Layout(lane_box, box, (POOL_X, POOL_Y, width, y - POOL_Y))


def center(b: Box) -> Point:
    return b[0] + b[2] / 2, b[1] + b[3] / 2


def entry_point(f: Flow, tgt: Box) -> Point:
    cx, cy = center(tgt)
    if f.entry == "top":
        return cx, tgt[1]
    if f.entry == "bottom":
        return cx, tgt[1] + tgt[3]
    return tgt[0], cy


def waypoints(f: Flow, lay: Layout) -> list[Point]:
    src, tgt = lay.box[f.source], lay.box[f.target]
    sx, sy = center(src)
    end = entry_point(f, lay.box[f.target])
    if f.exit == "bottom":
        start = (sx, src[1] + src[3])
        return [start, end] if f.entry == "top" else [start, (sx, end[1]), end]
    start = (src[0] + src[2], sy)
    if f.entry in ("top", "bottom"):
        return [start, (end[0], sy), end]
    if abs(sy - end[1]) < 1:
        return [start, end]
    bend = tgt[0] - BEND_GAP
    return [start, (bend, sy), (bend, end[1]), end]


def label_below(points: list[Point]) -> Point:
    return points[0][0] + 6, points[0][1] + 8


def label_beside(points: list[Point]) -> Point:
    if len(points) == 2:
        return points[0][0] + 8, points[0][1] - 22
    if len(points) == 3:
        return points[0][0] + 8, points[0][1] - 22
    return points[1][0] - 84, points[-1][1] - 22


def semantic_xml(p: Process) -> list[str]:
    incoming: dict[str, list[str]] = {n.id: [] for n in p.nodes}
    outgoing: dict[str, list[str]] = {n.id: [] for n in p.nodes}
    for i, f in enumerate(p.flows):
        f.id = f"Flow_{i + 1}"
        outgoing[f.source].append(f.id)
        incoming[f.target].append(f.id)
    out = [
        f'  <bpmn:collaboration id="Collab_{p.id}">',
        f'    <bpmn:participant id="Part_{p.id}" name="{escape(p.participant)}" processRef="{p.id}" />',
        "  </bpmn:collaboration>",
        f'  <bpmn:process id="{p.id}" name="{escape(p.name)}" isExecutable="false">',
        f'    <bpmn:laneSet id="LaneSet_{p.id}">',
    ]
    for lane in p.lanes:
        out.append(f'      <bpmn:lane id="{lane.id}" name="{escape(lane.name)}">')
        out += [f"        <bpmn:flowNodeRef>{n.id}</bpmn:flowNodeRef>" for n in p.nodes if n.lane == lane.id]
        out.append("      </bpmn:lane>")
    out.append("    </bpmn:laneSet>")
    for n in p.nodes:
        out.append(f'    <bpmn:{n.kind} id="{n.id}" name="{escape(n.name)}">')
        out += [f"      <bpmn:incoming>{fid}</bpmn:incoming>" for fid in incoming[n.id]]
        out += [f"      <bpmn:outgoing>{fid}</bpmn:outgoing>" for fid in outgoing[n.id]]
        if n.message:
            out.append("      <bpmn:messageEventDefinition />")
        out.append(f"    </bpmn:{n.kind}>")
    for f in p.flows:
        name = f' name="{escape(f.name)}"' if f.name else ""
        out.append(f'    <bpmn:sequenceFlow id="{f.id}"{name} sourceRef="{f.source}" targetRef="{f.target}" />')
    out.append("  </bpmn:process>")
    return out


def colors(fill: str, stroke: str) -> str:
    return f' color:background-color="{fill}" color:border-color="{stroke}"'


def shape(element: str, box: Box, extra: str = "", label: Box | None = None) -> list[str]:
    x, y, w, h = box
    out = [
        f'      <bpmndi:BPMNShape id="{element}_di" bpmnElement="{element}"{extra}>',
        f'        <dc:Bounds x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" />',
    ]
    if label:
        lx, ly, lw, lh = label
        out.append(f'        <bpmndi:BPMNLabel><dc:Bounds x="{lx:.0f}" y="{ly:.0f}" width="{lw:.0f}" height="{lh:.0f}" /></bpmndi:BPMNLabel>')
    out.append("      </bpmndi:BPMNShape>")
    return out


def external_label(n: Node, box: Box) -> Box | None:
    x, y, w, h = box
    if n.kind in GATEWAYS:
        return (x + w / 2 + 6, y - 30, 120, 28)
    if n.kind in EVENTS:
        return (x + w / 2 - 60, y + h + 6, 120, 28)
    return None


def node_shapes(p: Process, lay: Layout) -> list[str]:
    out = shape(f"Part_{p.id}", lay.pool, ' isHorizontal="true"' + colors("#FFFFFF", "#444441"))
    for lane in p.lanes:
        out += shape(lane.id, lay.lane_box[lane.id], ' isHorizontal="true"' + colors(LANE_TINTS[lane.tone], "#5F5E5A"))
    for n in p.nodes:
        tone = "gateway" if n.kind in GATEWAYS else n.tone
        out += shape(n.id, lay.box[n.id], colors(*TONES[tone]), external_label(n, lay.box[n.id]))
    return out


def flow_edges(p: Process, lay: Layout) -> list[str]:
    out = []
    for f in p.flows:
        points = waypoints(f, lay)
        out.append(f'      <bpmndi:BPMNEdge id="{f.id}_di" bpmnElement="{f.id}" color:border-color="{FLOW_COLORS[f.tone]}">')
        out += [f'        <di:waypoint x="{x:.0f}" y="{y:.0f}" />' for x, y in points]
        if f.name:
            lx, ly = label_below(points) if f.exit == "bottom" else label_beside(points)
            out.append(f'        <bpmndi:BPMNLabel><dc:Bounds x="{lx:.0f}" y="{ly:.0f}" width="80" height="18" /></bpmndi:BPMNLabel>')
        out.append("      </bpmndi:BPMNEdge>")
    return out


def render(p: Process) -> str:
    lay = layout(p)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append(f'<bpmn:definitions {NAMESPACES} id="Defs_{p.id}" targetNamespace="https://barte.ai/formacao-fde/ja-chegou">')
    lines += semantic_xml(p)
    lines.append(f'  <bpmndi:BPMNDiagram id="Diagram_{p.id}">')
    lines.append(f'    <bpmndi:BPMNPlane id="Plane_{p.id}" bpmnElement="Collab_{p.id}">')
    lines += node_shapes(p, lay) + flow_edges(p, lay)
    lines += ["    </bpmndi:BPMNPlane>", "  </bpmndi:BPMNDiagram>", "</bpmn:definitions>"]
    return "\n".join(lines) + "\n"


L, N, F = Lane, Node, Flow

CURRENT = Process(
    id="AccountsPayable_Current",
    name="Contas a pagar da Já Chegou: processo atual",
    participant="Já Chegou · contas a pagar hoje",
    lanes=[
        L("Lane_Purchasing", "Compras", "person"),
        L("Lane_Supplier", "Fornecedor", "neutral"),
        L("Lane_Dock", "Doca (CD e lojas)", "person"),
        L("Lane_Matching", "Conferência", "person", 2),
        L("Lane_DailyList", "Lista do dia", "person"),
        L("Lane_CFO", "CFO", "person"),
        L("Lane_Bank", "Banco", "system"),
    ],
    nodes=[
        N("Start_NeedToBuy", "startEvent", "Precisa comprar", "Lane_Purchasing", 0, tone="neutral"),
        N("Task_IssueOrder", "task", "Emitir o pedido no ERP", "Lane_Purchasing", 1, tone="person"),
        N("Task_IssueInvoice", "task", "Emitir a nota antes de entregar", "Lane_Supplier", 2, tone="neutral"),
        N("Gateway_Split", "parallelGateway", "Dois caminhos sem integração", "Lane_Supplier", 3),
        N("Task_Deliver", "task", "Entregar a mercadoria", "Lane_Supplier", 4, tone="neutral"),
        N("Task_Receive", "userTask", "Receber sem olhar a nota", "Lane_Dock", 5, tone="block"),
        N("Task_MatchByHand", "userTask", "Conferir à mão, até 14 dias depois", "Lane_Matching", 6, tone="person"),
        N("Gateway_Differs", "exclusiveGateway", "Diverge?", "Lane_Matching", 7),
        N("End_Matched", "endEvent", "Nota conciliada", "Lane_Matching", 8, tone="ok"),
        N("Task_Supplement", "userTask", "Ordem complementar ou provisão", "Lane_Matching", 8, 1, tone="block"),
        N("End_Provisioned", "endEvent", "Mês fecha com provisão", "Lane_Matching", 9, 1, tone="block"),
        N("Task_BuildList", "userTask", "Montar a lista com ERP, e-mail e WhatsApp", "Lane_DailyList", 4, tone="person"),
        N("Task_ApproveAll", "userTask", "Aprovar tudo, item a item", "Lane_CFO", 5, tone="person"),
        N("Task_PayOneByOne", "task", "Pagar sem esperar a conferência", "Lane_Bank", 6, tone="block"),
        N("End_Paid", "endEvent", "Pago sem mercadoria", "Lane_Bank", 7, tone="block"),
    ],
    flows=[
        F("Start_NeedToBuy", "Task_IssueOrder"),
        F("Task_IssueOrder", "Task_IssueInvoice"),
        F("Task_IssueInvoice", "Gateway_Split"),
        F("Gateway_Split", "Task_Deliver"),
        F("Gateway_Split", "Task_BuildList", exit="bottom"),
        F("Task_Deliver", "Task_Receive"),
        F("Task_Receive", "Task_MatchByHand"),
        F("Task_MatchByHand", "Gateway_Differs"),
        F("Gateway_Differs", "End_Matched", "não", tone="ok"),
        F("Gateway_Differs", "Task_Supplement", "sim", exit="bottom", tone="block"),
        F("Task_Supplement", "End_Provisioned", tone="block"),
        F("Task_BuildList", "Task_ApproveAll"),
        F("Task_ApproveAll", "Task_PayOneByOne"),
        F("Task_PayOneByOne", "End_Paid", tone="block"),
    ],
)

TARGET = Process(
    id="AccountsPayable_Target",
    name="Contas a pagar da Já Chegou: processo-alvo",
    participant="Já Chegou · contas a pagar com o agente",
    lanes=[
        L("Lane_Capture", "Captura de notas", "system"),
        L("Lane_Agent", "Agente", "agent", 2),
        L("Lane_Dock", "Doca (CD)", "person"),
        L("Lane_Approver", "Aprovador da alçada", "person"),
        L("Lane_Payables", "Contas a pagar", "neutral", 3),
    ],
    nodes=[
        N("Start_InvoiceIssued", "startEvent", "Nota emitida na SEFAZ", "Lane_Capture", 0, tone="system", message=True),
        N("Task_Capture", "serviceTask", "Capturar a nota", "Lane_Capture", 1, tone="system"),
        N("Task_Classify", "serviceTask", "Classificar a divergência", "Lane_Agent", 2, tone="agent"),
        N("Gateway_Duplicate", "exclusiveGateway", "Duplicada?", "Lane_Agent", 3),
        N("Task_BlockDuplicate", "serviceTask", "Bloquear o título duplicado", "Lane_Agent", 3, 1, tone="block"),
        N("End_DuplicateBlocked", "endEvent", "Título bloqueado", "Lane_Agent", 4, 1, tone="block"),
        N("Gateway_AlreadyPaid", "exclusiveGateway", "Já paga fora do fluxo?", "Lane_Agent", 5),
        N("Task_LinkPayment", "serviceTask", "Vincular ao pagamento já feito", "Lane_Agent", 5, 1, tone="agent"),
        N("End_Regularized", "endEvent", "Regularizada, sem novo pagamento", "Lane_Agent", 6, 1, tone="ok"),
        N("Task_ProposeAction", "serviceTask", "Propor a ação na doca", "Lane_Agent", 6, tone="agent"),
        N("Task_Approver", "businessRuleTask", "Definir o aprovador pela régua", "Lane_Agent", 7, tone="agent"),
        N("Gateway_WhoDecides", "exclusiveGateway", "Quem decide?", "Lane_Agent", 8),
        N("Task_Confirm", "userTask", "Confirmar ou alterar a ação", "Lane_Approver", 9, tone="person"),
        N("Gateway_Join", "exclusiveGateway", "", "Lane_Dock", 10),
        N("Task_Plan", "userTask", "Planejar o recebimento", "Lane_Dock", 11, tone="person"),
        N("Event_Arrives", "intermediateCatchEvent", "Mercadoria chega", "Lane_Dock", 12, tone="person", message=True),
        N("Task_Count", "userTask", "Contar a mercadoria", "Lane_Dock", 13, tone="person"),
        N("Task_Reconcile", "serviceTask", "Conciliar contagem, nota e pedido", "Lane_Agent", 14, tone="agent"),
        N("Gateway_DockDecision", "exclusiveGateway", "Decisão na doca", "Lane_Dock", 15),
        N("Task_ReturnNote", "task", "Emitir nota de devolução da diferença", "Lane_Payables", 16, 1, tone="neutral"),
        N("Task_Block", "task", "Bloquear o título", "Lane_Payables", 16, 2, tone="block"),
        N("Task_Release", "task", "Liberar o título para a lista do dia", "Lane_Payables", 17, 0, tone="ok"),
        N("End_Refused", "endEvent", "Recusado, título bloqueado", "Lane_Payables", 17, 2, tone="block"),
        N("End_OnList", "endEvent", "Na lista do dia, conferido", "Lane_Payables", 18, 0, tone="ok"),
    ],
    flows=[
        F("Start_InvoiceIssued", "Task_Capture"),
        F("Task_Capture", "Task_Classify"),
        F("Task_Classify", "Gateway_Duplicate"),
        F("Gateway_Duplicate", "Task_BlockDuplicate", "sim", exit="bottom", entry="top", tone="block"),
        F("Gateway_Duplicate", "Gateway_AlreadyPaid", "não"),
        F("Task_BlockDuplicate", "End_DuplicateBlocked", tone="block"),
        F("Gateway_AlreadyPaid", "Task_LinkPayment", "sim", exit="bottom", entry="top"),
        F("Gateway_AlreadyPaid", "Task_ProposeAction", "não"),
        F("Task_LinkPayment", "End_Regularized", tone="ok"),
        F("Task_ProposeAction", "Task_Approver"),
        F("Task_Approver", "Gateway_WhoDecides"),
        F("Gateway_WhoDecides", "Task_Confirm", "pessoa", exit="bottom"),
        F("Gateway_WhoDecides", "Gateway_Join", "regra", entry="top"),
        F("Task_Confirm", "Gateway_Join", entry="bottom"),
        F("Gateway_Join", "Task_Plan"),
        F("Task_Plan", "Event_Arrives"),
        F("Event_Arrives", "Task_Count"),
        F("Task_Count", "Task_Reconcile"),
        F("Task_Reconcile", "Gateway_DockDecision"),
        F("Gateway_DockDecision", "Task_Release", "receber", tone="ok"),
        F("Gateway_DockDecision", "Task_ReturnNote", "receber parcial"),
        F("Gateway_DockDecision", "Task_Block", "recusar", exit="bottom", tone="block"),
        F("Task_ReturnNote", "Task_Release", tone="ok"),
        F("Task_Release", "End_OnList", tone="ok"),
        F("Task_Block", "End_Refused", tone="block"),
    ],
)

OUTPUTS = {"processo-atual.bpmn": CURRENT, "processo-alvo.bpmn": TARGET}


def main() -> None:
    target_dir = Path(__file__).resolve().parent.parent / "docs" / "processo"
    target_dir.mkdir(parents=True, exist_ok=True)
    for file_name, process in OUTPUTS.items():
        (target_dir / file_name).write_text(render(process), encoding="utf-8")
    print(f"gerados em {target_dir}")


if __name__ == "__main__":
    main()
