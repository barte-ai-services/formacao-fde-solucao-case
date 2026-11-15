import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(); out = pathlib.Path(sys.argv[2])
styles = ''.join(re.findall(r'<style>.*?</style>', src, re.S))
script = re.search(r'<script type="module">.*?</script>', src, re.S).group(0)
page = ('<title>Wireframe do contas a pagar</title>\n'
        '<!-- Gerado a partir do shell-kit e do barte-ui-kit (main de cada repo). Fonte: artifacts/wireframe-contas-a-pagar/src. -->\n'
        + styles + '\n<div id="root"></div>\n' + script + '\n')
out.parent.mkdir(parents=True, exist_ok=True); out.write_text(page); print(out, len(page))
