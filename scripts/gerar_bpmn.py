"""Generates the BPMN 2.0 diagrams of the Já Chegou accounts payable process (#2).

Each process is data: lanes, nodes, flows and notes. The script lays the shapes out on a grid of
lanes, rows and columns and writes the XML with its diagram (BPMN DI), ready for bpmn.io or the
Camunda Modeler. Labels shown in the diagram stay in Portuguese, the language of the case.

    python3 scripts/gerar_bpmn.py
"""

from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import escape

COL_W = 160
ROW_H = 150
LANE_LABEL_W = 30
POOL_X = 100
POOL_Y = 80
SHAPE_TOP = 100
NOTE_W = 260
NOTE_H = 56

SIZES = {
    "task": (120, 70), "serviceTask": (120, 70), "userTask": (120, 70),
    "businessRuleTask": (120, 70),
    "startEvent": (36, 36), "endEvent": (36, 36), "intermediateCatchEvent": (36, 36),
    "exclusiveGateway": (50, 50), "parallelGateway": (50, 50),
}
EXTERNAL_LABEL = {"startEvent", "endEvent", "intermediateCatchEvent", "exclusiveGateway", "parallelGateway"}
NAMESPACES = (
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
    'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
    'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
    'xmlns:di="http://www.omg.org/spec/DD/20100524/DI"'
)


@dataclass
class Node:
    id: str
    kind: str
    name: str
    lane: str
    col: int
    row: int = 0
    message: bool = False


@dataclass
class Flow:
    source: str
    target: str
    name: str = ""
    offset: int = 0
    down: bool = False
    id: str = ""


@dataclass
class Note:
    node: str
    text: str


@dataclass
class Process:
    id: str
    name: str
    participant: str
    lanes: list[tuple[str, str, int]]
    nodes: list[Node]
    flows: list[Flow]
    notes: list[Note] = field(default_factory=list)


@dataclass
class Layout:
    lane_top: dict[str, tuple[float, float]]
    box: dict[str, tuple[float, float, float, float]]
    pool_w: float
    pool_h: float


def layout(p: Process) -> Layout:
    lane_top, y = {}, POOL_Y
    for lane_id, _, rows in p.lanes:
        lane_top[lane_id] = (y, rows * ROW_H)
        y += rows * ROW_H
    box = {}
    for n in p.nodes:
        w, h = SIZES[n.kind]
        cx = POOL_X + LANE_LABEL_W + 40 + n.col * COL_W + COL_W / 2
        cy = lane_top[n.lane][0] + n.row * ROW_H + SHAPE_TOP
        box[n.id] = (cx - w / 2, cy - h / 2, w, h)
    cols = max(n.col for n in p.nodes) + 1
    return Layout(lane_top, box, LANE_LABEL_W + 40 + cols * COL_W, y - POOL_Y)


def center(b: tuple[float, float, float, float]) -> tuple[float, float]:
    return b[0] + b[2] / 2, b[1] + b[3] / 2


def waypoints(f: Flow, lay: Layout) -> list[tuple[float, float]]:
    src, tgt = lay.box[f.source], lay.box[f.target]
    sx, sy = center(src)
    tx, ty = tgt[0], center(tgt)[1]
    if f.down:
        return [(sx, src[1] + src[3]), (sx, ty), (tx, ty)]
    start = (src[0] + src[2], sy)
    if abs(sy - ty) < 1:
        return [start, (tx, ty)]
    bend = tx - 18 - f.offset
    return [start, (bend, sy), (bend, ty), (tx, ty)]


def flow_label(points: list[tuple[float, float]], down: bool) -> tuple[float, float]:
    if down:
        return points[0][0] + 6, points[0][1] + 44
    if len(points) == 2:
        return points[0][0] + 6, points[0][1] - 22
    return points[1][0] - 86, points[-1][1] - 22


def semantic_xml(p: Process) -> list[str]:
    incoming = {n.id: [] for n in p.nodes}
    outgoing = {n.id: [] for n in p.nodes}
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
    for lane_id, lane_name, _ in p.lanes:
        out.append(f'      <bpmn:lane id="{lane_id}" name="{escape(lane_name)}">')
        out += [f"        <bpmn:flowNodeRef>{n.id}</bpmn:flowNodeRef>" for n in p.nodes if n.lane == lane_id]
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
    for i, note in enumerate(p.notes, 1):
        out.append(f'    <bpmn:textAnnotation id="Note_{i}"><bpmn:text>{escape(note.text)}</bpmn:text></bpmn:textAnnotation>')
        out.append(f'    <bpmn:association id="Assoc_{i}" sourceRef="{note.node}" targetRef="Note_{i}" />')
    out.append("  </bpmn:process>")
    return out


def shape(element: str, x: float, y: float, w: float, h: float, extra: str = "") -> list[str]:
    return [
        f'      <bpmndi:BPMNShape id="{element}_di" bpmnElement="{element}"{extra}>',
        f'        <dc:Bounds x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" />',
        "      </bpmndi:BPMNShape>",
    ]


def node_shapes(p: Process, lay: Layout) -> list[str]:
    out = shape(f"Part_{p.id}", POOL_X, POOL_Y, lay.pool_w, lay.pool_h, ' isHorizontal="true"')
    for lane_id, _, _ in p.lanes:
        top, height = lay.lane_top[lane_id]
        out += shape(lane_id, POOL_X + LANE_LABEL_W, top, lay.pool_w - LANE_LABEL_W, height, ' isHorizontal="true"')
    for n in p.nodes:
        x, y, w, h = lay.box[n.id]
        lines = shape(n.id, x, y, w, h)
        if n.kind in EXTERNAL_LABEL:
            label = f'        <bpmndi:BPMNLabel><dc:Bounds x="{x + w / 2 - 50:.0f}" y="{y + h + 6:.0f}" width="100" height="27" /></bpmndi:BPMNLabel>'
            lines.insert(2, label)
        out += lines
    return out


def flow_edges(p: Process, lay: Layout) -> list[str]:
    out = []
    for f in p.flows:
        points = waypoints(f, lay)
        out.append(f'      <bpmndi:BPMNEdge id="{f.id}_di" bpmnElement="{f.id}">')
        out += [f'        <di:waypoint x="{x:.0f}" y="{y:.0f}" />' for x, y in points]
        if f.name:
            lx, ly = flow_label(points, f.down)
            out.append(f'        <bpmndi:BPMNLabel><dc:Bounds x="{lx:.0f}" y="{ly:.0f}" width="80" height="18" /></bpmndi:BPMNLabel>')
        out.append("      </bpmndi:BPMNEdge>")
    return out


def note_shapes(p: Process, lay: Layout) -> list[str]:
    out = []
    nodes = {n.id: n for n in p.nodes}
    for i, note in enumerate(p.notes, 1):
        x, y, w, _ = lay.box[note.node]
        n = nodes[note.node]
        nx, ny = x + w / 2 + 8, lay.lane_top[n.lane][0] + n.row * ROW_H + 4
        out += shape(f"Note_{i}", nx, ny, NOTE_W, NOTE_H)
        out += [
            f'      <bpmndi:BPMNEdge id="Assoc_{i}_di" bpmnElement="Assoc_{i}">',
            f'        <di:waypoint x="{x + w / 2:.0f}" y="{y:.0f}" />',
            f'        <di:waypoint x="{nx + 12:.0f}" y="{ny + NOTE_H:.0f}" />',
            "      </bpmndi:BPMNEdge>",
        ]
    return out


def render(p: Process) -> str:
    lay = layout(p)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append(f'<bpmn:definitions {NAMESPACES} id="Defs_{p.id}" targetNamespace="https://barte.ai/formacao-fde/ja-chegou">')
    lines += semantic_xml(p)
    lines.append(f'  <bpmndi:BPMNDiagram id="Diagram_{p.id}">')
    lines.append(f'    <bpmndi:BPMNPlane id="Plane_{p.id}" bpmnElement="Collab_{p.id}">')
    lines += node_shapes(p, lay) + flow_edges(p, lay) + note_shapes(p, lay)
    lines += ["    </bpmndi:BPMNPlane>", "  </bpmndi:BPMNDiagram>", "</bpmn:definitions>"]
    return "\n".join(lines) + "\n"


N, F, T = Node, Flow, Note

CURRENT = Process(
    id="AccountsPayable_Current",
    name="Contas a pagar da Já Chegou: processo atual",
    participant="Já Chegou: contas a pagar hoje",
    lanes=[
        ("Lane_Purchasing", "Compras", 1),
        ("Lane_Supplier", "Fornecedor", 1),
        ("Lane_Dock", "Doca (CD e lojas)", 1),
        ("Lane_Matching", "Contas a pagar: conferência", 2),
        ("Lane_DailyList", "Contas a pagar: lista do dia", 1),
        ("Lane_CFO", "CFO", 1),
        ("Lane_Bank", "Banco", 1),
    ],
    nodes=[
        N("Start_NeedToBuy", "startEvent", "Precisa comprar", "Lane_Purchasing", 0),
        N("Task_IssueOrder", "task", "Emitir o pedido no ERP", "Lane_Purchasing", 1),
        N("Task_IssueInvoice", "task", "Emitir a nota antes de entregar", "Lane_Supplier", 2),
        N("Gateway_Split", "parallelGateway", "", "Lane_Supplier", 3),
        N("Task_Deliver", "task", "Entregar a mercadoria", "Lane_Supplier", 4),
        N("Task_Receive", "task", "Receber a mercadoria", "Lane_Dock", 5),
        N("Task_MatchByHand", "task", "Conferir nota, pedido e recebido à mão", "Lane_Matching", 6),
        N("Gateway_Differs", "exclusiveGateway", "Diverge?", "Lane_Matching", 7),
        N("End_Matched", "endEvent", "Nota conciliada", "Lane_Matching", 8),
        N("Task_Supplement", "task", "Abrir ordem complementar ou provisionar", "Lane_Matching", 8, 1),
        N("End_Provisioned", "endEvent", "Mês fecha com provisão", "Lane_Matching", 9, 1),
        N("Task_BuildList", "task", "Montar a lista do dia (ERP, e-mail, WhatsApp)", "Lane_DailyList", 4),
        N("Task_ApproveAll", "userTask", "Aprovar item a item, das 16h às 18h", "Lane_CFO", 5),
        N("Task_PayOneByOne", "task", "Pagar um boleto por vez", "Lane_Bank", 6),
        N("End_Paid", "endEvent", "Pago, conferido ou não", "Lane_Bank", 7),
    ],
    flows=[
        F("Start_NeedToBuy", "Task_IssueOrder"),
        F("Task_IssueOrder", "Task_IssueInvoice"),
        F("Task_IssueInvoice", "Gateway_Split"),
        F("Gateway_Split", "Task_Deliver"),
        F("Gateway_Split", "Task_BuildList"),
        F("Task_Deliver", "Task_Receive"),
        F("Task_Receive", "Task_MatchByHand"),
        F("Task_MatchByHand", "Gateway_Differs"),
        F("Gateway_Differs", "End_Matched", "não"),
        F("Gateway_Differs", "Task_Supplement", "sim"),
        F("Task_Supplement", "End_Provisioned"),
        F("Task_BuildList", "Task_ApproveAll"),
        F("Task_ApproveAll", "Task_PayOneByOne"),
        F("Task_PayOneByOne", "End_Paid"),
    ],
    notes=[
        T("Task_Receive", "Ninguém olhou a nota antes. Entra mesmo divergente, por pressão comercial."),
        T("Task_MatchByHand", "Até 14 dias no CD. Só 0,7% das notas casam sozinhas."),
        T("Task_PayOneByOne", "Pagar errado: R$ 543 mil por mês sem mercadoria, nada recuperado."),
    ],
)

TARGET = Process(
    id="AccountsPayable_Target",
    name="Contas a pagar da Já Chegou: processo-alvo",
    participant="Já Chegou: contas a pagar com o agente",
    lanes=[
        ("Lane_Capture", "Captura de notas", 1),
        ("Lane_Agent", "Agente", 1),
        ("Lane_Approver", "Aprovador da alçada", 1),
        ("Lane_Dock", "Doca (CD)", 1),
        ("Lane_Payables", "Contas a pagar", 3),
    ],
    nodes=[
        N("Start_InvoiceIssued", "startEvent", "Nota emitida na SEFAZ", "Lane_Capture", 0, message=True),
        N("Task_Capture", "serviceTask", "Capturar a nota", "Lane_Capture", 1),
        N("Task_Classify", "serviceTask", "Classificar a divergência", "Lane_Agent", 2),
        N("Gateway_Duplicate", "exclusiveGateway", "Duplicada?", "Lane_Agent", 3),
        N("Gateway_AlreadyPaid", "exclusiveGateway", "Já paga fora do fluxo?", "Lane_Agent", 4),
        N("Task_ProposeAction", "serviceTask", "Propor a ação na doca", "Lane_Agent", 5),
        N("Task_Approver", "businessRuleTask", "Definir o aprovador pela régua", "Lane_Agent", 6),
        N("Gateway_WhoDecides", "exclusiveGateway", "Quem decide?", "Lane_Agent", 7),
        N("Task_Confirm", "userTask", "Confirmar ou alterar a ação", "Lane_Approver", 8),
        N("Gateway_Join", "exclusiveGateway", "", "Lane_Dock", 9),
        N("Task_Plan", "userTask", "Planejar o recebimento", "Lane_Dock", 10),
        N("Event_Arrives", "intermediateCatchEvent", "Mercadoria chega", "Lane_Dock", 11, message=True),
        N("Task_Count", "userTask", "Contar a mercadoria na chegada", "Lane_Dock", 12),
        N("Task_Reconcile", "serviceTask", "Conciliar contagem, nota e pedido", "Lane_Agent", 13),
        N("Gateway_DockDecision", "exclusiveGateway", "Decisão na doca", "Lane_Dock", 14),
        N("Task_BlockDuplicate", "task", "Bloquear o título duplicado", "Lane_Payables", 4, 2),
        N("End_DuplicateBlocked", "endEvent", "Título bloqueado", "Lane_Payables", 5, 2),
        N("Task_LinkPayment", "task", "Vincular a nota ao pagamento já feito", "Lane_Payables", 5, 1),
        N("End_Regularized", "endEvent", "Entrada regularizada, sem novo pagamento", "Lane_Payables", 6, 1),
        N("Task_Release", "task", "Liberar o título para a lista do dia", "Lane_Payables", 16, 0),
        N("Task_ReturnNote", "task", "Emitir nota de devolução da diferença", "Lane_Payables", 15, 1),
        N("Task_Block", "task", "Bloquear o título", "Lane_Payables", 15, 2),
        N("End_OnList", "endEvent", "Título na lista do dia, conferido", "Lane_Payables", 17, 0),
        N("End_Refused", "endEvent", "Recusado na doca, título bloqueado", "Lane_Payables", 16, 2),
    ],
    flows=[
        F("Start_InvoiceIssued", "Task_Capture"),
        F("Task_Capture", "Task_Classify"),
        F("Task_Classify", "Gateway_Duplicate"),
        F("Gateway_Duplicate", "Task_BlockDuplicate", "sim", down=True),
        F("Gateway_Duplicate", "Gateway_AlreadyPaid", "não"),
        F("Task_BlockDuplicate", "End_DuplicateBlocked"),
        F("Gateway_AlreadyPaid", "Task_LinkPayment", "sim", down=True),
        F("Gateway_AlreadyPaid", "Task_ProposeAction", "não"),
        F("Task_LinkPayment", "End_Regularized"),
        F("Task_ProposeAction", "Task_Approver"),
        F("Task_Approver", "Gateway_WhoDecides"),
        F("Gateway_WhoDecides", "Task_Confirm", "pessoa"),
        F("Gateway_WhoDecides", "Gateway_Join", "regra", offset=14),
        F("Task_Confirm", "Gateway_Join"),
        F("Gateway_Join", "Task_Plan"),
        F("Task_Plan", "Event_Arrives"),
        F("Event_Arrives", "Task_Count"),
        F("Task_Count", "Task_Reconcile"),
        F("Task_Reconcile", "Gateway_DockDecision"),
        F("Gateway_DockDecision", "Task_Release", "receber"),
        F("Gateway_DockDecision", "Task_ReturnNote", "receber parcial"),
        F("Gateway_DockDecision", "Task_Block", "recusar", offset=14),
        F("Task_ReturnNote", "Task_Release"),
        F("Task_Release", "End_OnList"),
        F("Task_Block", "End_Refused"),
    ],
    notes=[
        T("Task_Classify", "Antes da doca, só com documentos: duplicidade, pedido, pago fora do fluxo, cadastro, item e unidade."),
        T("Gateway_WhoDecides", "Régua: o que bate passa direto (regra). A exceção vai a quem tem a alçada do valor."),
        T("Task_Plan", "A doca sabe antes do caminhão: receber, receber parcial ou recusar."),
        T("Task_Reconcile", "Com o caminhão na doca, antes do aceite: falta física e quantidade menor aparecem aqui."),
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
