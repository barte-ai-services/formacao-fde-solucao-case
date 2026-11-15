"""Checks the BPMN files of the solution (#2): valid XML, every flow links two flow nodes of
the same process, and every element has a shape in the diagram.

    python3 scripts/validar_bpmn.py docs/processo/processo-atual.bpmn docs/processo/processo-alvo.bpmn
"""

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

BPMN = "{http://www.omg.org/spec/BPMN/20100524/MODEL}"
FLOW_NODES = {
    "task", "serviceTask", "userTask", "businessRuleTask", "sendTask", "receiveTask",
    "manualTask", "scriptTask", "subProcess", "callActivity",
    "startEvent", "endEvent", "intermediateCatchEvent", "intermediateThrowEvent", "boundaryEvent",
    "exclusiveGateway", "parallelGateway", "inclusiveGateway", "eventBasedGateway",
}
NEEDS_SHAPE = FLOW_NODES | {"sequenceFlow", "lane", "participant", "textAnnotation", "association"}


def local(tag: str) -> str:
    return tag.replace(BPMN, "")


def dangling_ends(process: ET.Element, nodes: set[str]) -> list[str]:
    return [
        f"{flow.get('id')}: {end} {flow.get(end)} não é um elemento do processo"
        for flow in process.iter(f"{BPMN}sequenceFlow")
        for end in ("sourceRef", "targetRef")
        if flow.get(end) not in nodes
    ]


def check(path: Path) -> list[str]:
    root = ET.parse(path).getroot()
    errors = []
    for process in root.iter(f"{BPMN}process"):
        nodes = {el.get("id", "") for el in process.iter() if local(el.tag) in FLOW_NODES}
        if not nodes:
            errors.append(f"{process.get('id')}: processo sem nenhum elemento")
        errors += dangling_ends(process, nodes)
    drawn = {el.get("bpmnElement") for el in root.iter() if el.get("bpmnElement")}
    for el in root.iter():
        if el.tag.startswith(BPMN) and local(el.tag) in NEEDS_SHAPE and el.get("id") not in drawn:
            errors.append(f"{el.get('id')} ({local(el.tag)}) não tem forma no diagrama")
    return errors


def main(paths: list[str]) -> int:
    if not paths:
        print("nenhum arquivo .bpmn informado")
        return 1
    failed = False
    for name in paths:
        path = Path(name)
        if not path.is_file():
            print(f"{name}: arquivo não encontrado")
            failed = True
            continue
        errors = check(path)
        for error in errors:
            print(f"{name}: {error}")
        print(f"{name}: ok" if not errors else f"{name}: {len(errors)} erro(s)")
        failed = failed or bool(errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
