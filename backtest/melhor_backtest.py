"""Busca de melhorias sobre a estratégia vencedora (rompimento com volume).

Grade (72 variantes): tempo gráfico (4h, 6h) x volume mínimo (1,5x, 2x, 3x)
x filtro extra (nenhum, força relativa contra o BTC, preço não esticado)
x saída (alvo 2R, alvo 3R, stop móvel 2 ATR, stop móvel 3 ATR).

Validação dupla:
- escolha pelo Sharpe da carteira SÓ no período de ajuste, nas 20 moedas
  originais; resultado que vale é o do último ano (fora da amostra);
- mesma variante aplicada em 20 MOEDAS NOVAS que nunca entraram em nenhum
  teste (fora da amostra de moedas, período inteiro).

Carteira: arrisca 0,5% da banca por trade; custo de futuros 0,12% ida e volta.
"""
import argparse
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import cripto_backtest as cb  # noqa: E402
from pro_backtest import met, fmt, OOS  # noqa: E402

NOVAS = ['OP', 'ARB', 'SHIB', 'PEPE', 'WIF', 'TIA', 'SEI', 'RUNE', 'FET', 'STX',
         'IMX', 'HBAR', 'ETC', 'BCH', 'XLM', 'ALGO', 'SAND', 'GALA', 'LDO', 'CRV']
RISCO = 0.005
CUSTO = {'futuros': 0.0012, 'spot': 0.003}
BARRAS_DIA = {'4h': 6, '6h': 4}
SAIDAS = {'alvo2R': ('alvo', 2.0, 48), 'alvo3R': ('alvo', 3.0, 48),
          'movel2atr': ('movel', 2.0, 90), 'movel3atr': ('movel', 3.0, 90)}


def simular(d, sinal, saida):
    tipo, par, max_hold = SAIDAS[saida]
    o, h, l, c = (d[k].to_numpy() for k in ('open', 'high', 'low', 'close'))
    atr = d.atr.to_numpy()
    idx = d.index
    n = len(d)
    livre = 0
    out = []
    for i in np.flatnonzero(sinal):
        if i < livre or i + 1 >= n or i < 200 or not atr[i] > 0:
            continue
        e = o[i + 1]
        risco = 1.5 * atr[i]
        stop = e - risco
        alvo = e + par * risco if tipo == 'alvo' else np.inf
        topo = e
        fim = min(n - 1, i + max_hold)
        j, saida_p = fim, c[fim]
        for k in range(i + 1, fim + 1):
            if l[k] <= stop:
                j, saida_p = k, (min(o[k], stop) if k > i + 1 else stop)
                break
            if h[k] >= alvo:
                j, saida_p = k, alvo
                break
            if tipo == 'movel':  # atualiza depois do candle fechar
                topo = max(topo, h[k])
                stop = max(stop, topo - par * atr[i])
        out.append((idx[i + 1], idx[j], (saida_p - e) / risco, e / risco))
        livre = j + 1
    return out


def preparar(brutos, regime, tf):
    btc = cb.reamostrar(brutos['BTC'], tf).close
    res = {}
    for s, df in brutos.items():
        d = cb.indicadores(cb.reamostrar(df, tf))
        reg = pd.Series(regime.reindex(d.index.floor('1D')).to_numpy(), d.index)
        d['reg'] = reg.fillna(False).astype(bool)
        jan = 30 * BARRAS_DIA[tf]
        d['rs'] = d.close.pct_change(jan) > btc.reindex(d.index).pct_change(jan)
        res[s] = d
    return res


def carteira(t, custo):
    r = (t.R_bruto - custo * t.alav) * RISCO
    dia = r.groupby(t.saida.dt.floor('1D')).sum()
    idx = pd.date_range(pd.Timestamp(cb.INICIO + '-01', tz='UTC'),
                        pd.Timestamp(cb.FIM + '-28', tz='UTC'), freq='1D')
    return dia.reindex(idx).fillna(0.0)


def corta(d, oos):
    return d[d.index >= OOS] if oos else d[d.index < OOS]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--synthetic', action='store_true')
    ap.add_argument('--saida', default='relatorio_melhor.md')
    a = ap.parse_args()

    grupos = {'originais': {}, 'novas': {}}
    for k, s in enumerate(cb.SIMBOLOS + NOVAS):
        df = cb.sintetico(s, k, drift=0.0) if a.synthetic else cb.carregar(s)
        if df is None or len(df) < 3000:
            print(f'{s}: sem dados', file=sys.stderr)
            continue
        grupos['originais' if s in cb.SIMBOLOS else 'novas'][s] = df
        print(f'{s}: {len(df)} candles 1h desde {df.index[0].date()}', file=sys.stderr)
    regime = cb.regime_btc(grupos['originais']['BTC']).fillna(False).astype(bool)

    linhas = []
    for tf in ('4h', '6h'):
        todos = {**grupos['originais'], **grupos['novas']}
        ds = preparar(todos, regime, tf)
        for s, d in ds.items():
            grupo = 'originais' if s in grupos['originais'] else 'novas'
            d['ema20'] = cb.ema(d.close, 20)
            est = ((d.close - d.ema20) > 2 * d.atr).to_numpy()
            base_c = ((d.close > d.max20) & (d.close > d.ema200) & d.reg).to_numpy()
            for vm in (1.5, 2.0, 3.0):
                base = base_c & (d.volume > vm * d.vol_med).to_numpy()
                for filtro, extra in (('nenhum', True), ('forcaRel', d.rs.to_numpy()),
                                      ('naoEsticado', ~est)):
                    sinal = base & extra
                    for saida in SAIDAS:
                        var = f'{tf}_vol{vm}_{filtro}_{saida}'
                        for ent, sai, r, alav in simular(d, sinal, saida):
                            linhas.append((grupo, var, s, ent, sai, r, alav))
        print(f'{tf}: simulado', file=sys.stderr)
    t = pd.DataFrame(linhas, columns=['grupo', 'var', 'sim', 'entrada', 'saida', 'R_bruto', 'alav'])
    t['oos'] = t.entrada >= OOS
    base_var = '4h_vol2.0_nenhum_alvo2R'

    tab = []
    for var, g in t[t.grupo == 'originais'].groupby('var'):
        d = carteira(g, CUSTO['futuros'])
        tab.append((var, met(corta(d, False)), met(corta(d, True)), len(g)))
    tab.sort(key=lambda x: -(x[1]['sharpe'] if np.isfinite(x[1]['sharpe']) else -99))
    rank_is = {v: i + 1 for i, (v, *_) in enumerate(tab)}

    def linha(var):
        out = []
        for grupo in ('originais', 'novas'):
            g = t[(t.grupo == grupo) & (t['var'] == var)]
            d = carteira(g, CUSTO['futuros'])
            if grupo == 'originais':
                out += [fmt(met(corta(d, False))), fmt(met(corta(d, True)))]
            else:
                out += [fmt(met(d)), fmt(met(corta(d, True)))]
            gi = g.R_bruto - CUSTO['futuros'] * g.alav
            out.append(f'{len(g)} tr, {gi.mean():+.2f}R' if len(g) else '-')
        return out

    L = ['# Busca da melhor versão do rompimento com volume', '',
         f'72 variantes. Escolha pelo Sharpe do período de ajuste (até {cb.CORTE_OOS}) nas 20 '
         f'moedas originais. Validação no último ano e em {len(grupos["novas"])} moedas novas '
         'que nunca foram usadas.', '',
         'Carteira arriscando 0,5% por trade, futuros (0,12% ida e volta). '
         'Formato: retorno ao ano | Sharpe | queda máxima.', '',
         '| # ajuste | Variante | Originais: ajuste | Originais: último ano | Originais: trades |'
         ' Novas: período todo | Novas: último ano | Novas: trades |',
         '|---|---|---|---|---|---|---|---|']
    mostrar = [v for v, *_ in tab[:10]]
    if base_var not in mostrar:
        mostrar.append(base_var)
    for v in mostrar:
        c = linha(v)
        nome = f'**{v}** (atual)' if v == base_var else v
        L.append(f'| {rank_is[v]} | {nome} | ' + ' | '.join(c) + ' |')

    # robustez: média por dimensão (Sharpe OOS nas originais e período todo nas novas)
    L += ['', '## Efeito médio de cada escolha (Sharpe médio das variantes que a usam)', '',
          '| Dimensão | Opção | Originais ajuste | Originais último ano | Novas período todo |',
          '|---|---|---|---|---|']
    res = {}
    for var, g in t.groupby('var'):
        o = carteira(g[g.grupo == 'originais'], CUSTO['futuros'])
        nv = carteira(g[g.grupo == 'novas'], CUSTO['futuros'])
        res[var] = (met(corta(o, False))['sharpe'], met(corta(o, True))['sharpe'], met(nv)['sharpe'])
    partes = pd.DataFrame(res, index=['is', 'oos', 'novas']).T
    partes[['tf', 'vol', 'filtro', 'saida']] = partes.index.to_series().str.split('_', n=3, expand=True)
    for dim in ('tf', 'vol', 'filtro', 'saida'):
        for opc, g in partes.groupby(dim):
            L.append(f'| {dim} | {opc} | {g["is"].mean():.2f} | {g.oos.mean():.2f} | '
                     f'{g.novas.mean():.2f} |')

    melhor = tab[0][0]
    L += ['', f'## Ano a ano: escolhida ({melhor}) contra a atual ({base_var}), 20 moedas originais',
          '', '| Variante | ' + ' | '.join(str(y) for y in range(2023, 2027)) + ' |', '|---|' + '---|' * 4]
    for v in dict.fromkeys([melhor, base_var]):
        d = carteira(t[(t.grupo == 'originais') & (t['var'] == v)], CUSTO['futuros'])
        L.append(f'| {v} | ' + ' | '.join(fmt(met(d[d.index.year == y])).replace(' | ', ' / ')
                                           for y in range(2023, 2027)) + ' |')
    txt = '\n'.join(L)
    with open(a.saida, 'w') as f:
        f.write(txt + '\n')
    print(txt)


if __name__ == '__main__':
    main()
