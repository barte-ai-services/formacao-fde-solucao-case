import json, sys
D = sys.argv[1]; out = sys.argv[2]
g = {x['nota_id']: x for x in json.load(open(f'{D}/gabarito/gabarito.json'))}
notas = json.load(open(f'{D}/notas.json'))
forn = {f['fornecedor_id']: f for f in json.load(open(f'{D}/fornecedores.json'))}
lanc = json.load(open(f'{D}/notas_lancadas.json'))
rows = []
for n in notas:
    gb = g.get(n['nota_id'])
    if not gb: continue
    f = forn.get(n['fornecedor_id'], {})
    rows.append(dict(
        id=n['nota_id'], numero=n['numero'], chave=n['chave'], fornecedor=f.get('razao_social', n['fornecedor_id']),
        cnpj=f.get('cnpj'), bloqueado=f.get('bloqueado', False), destino=n['destino'], data=n['data_emissao'],
        ordem=n.get('pedido_referenciado') or None, canal=n['canal_entrada'], valor=n['valor_total'],
        classificacao=gb['classificacao'], acao=gb['acao_doca'], nivel=gb['encaminhamento'],
        risco=gb['valor_em_risco'], explicacao=gb['explicacao'],
        itens=[dict(desc=i['descricao'], qtd=i['quantidade'], un=i['unidade'], preco=i['preco_unitario'], valor=i['valor']) for i in n['itens']],
    ))
import re
bych = {l['chave']: l for l in lanc}; bynum = {l['numero']: l for l in lanc}
for r in rows:
    if r['classificacao'] != 'E6': continue
    o = bych.get(r['chave']); como = 'mesma chave'
    if o is None:
        m = re.search(r'da nota (\d+)', r['explicacao']); o = bynum.get(int(m.group(1))) if m else None; como = 'mesma ordem'
    if o: r['original'] = dict(numero=o['numero'], data=o['data_emissao'], canal=o['canal_entrada'], ordem=o.get('pedido_referenciado'), valor=round(sum(i['valor'] for i in o['itens']),2), como=como)
json.dump(dict(notas=rows), open(out, 'w'), ensure_ascii=False)
print(len(rows))
