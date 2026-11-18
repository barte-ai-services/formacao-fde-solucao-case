import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(); out = pathlib.Path(sys.argv[2])
styles = ''.join(re.findall(r'<style>.*?</style>', src, re.S))
found = re.search(r'<script type="module">.*?</script>', src, re.S)
if found is None:
    sys.exit('page.py: o HTML de entrada não tem <script type="module">')
script = found.group(0)
page = ('<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Wireframe da tabela com scroll infinito</title>\n'
        '<!-- Gerado a partir do shell-kit, do barte-ui-kit e do barte-design-system instalados em web/node_modules, e das grids de web/src. Fonte: artifacts/wireframe-tabela-scroll-infinito/src. -->\n'
        + styles + '\n<div id="root"></div>\n' + script + '\n')
out.parent.mkdir(parents=True, exist_ok=True); out.write_text(page); print(out, len(page))
