import re, sys, pathlib
dist = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2])
html = (dist / 'index.html').read_text()
def css(m: re.Match[str]) -> str:
    return '<style>' + (dist / m.group(1).lstrip('/')).read_text() + '</style>'
def js(m: re.Match[str]) -> str:
    code = (dist / m.group(1).lstrip('/')).read_text().replace('</script', '<\\/script')
    return '<script type="module">' + code + '</script>'
html = re.sub(r'<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>', css, html)
html = re.sub(r'<script type="module" crossorigin src="([^"]+)"></script>', js, html)
# #160 o script vai para o fim do body: o módulo inline roda na hora e precisa do #root
m = re.search(r'<script type="module">.*?</script>', html, re.S)
if m is None:
    sys.exit('inline.py: o index.html do build não tem <script type="module"> depois de embutir o código')
html = html.replace(m.group(0), '').replace('</body>', m.group(0) + '</body>')
out.write_text(html); print(out, len(html))
