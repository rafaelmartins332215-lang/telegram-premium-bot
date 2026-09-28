"""Rodada focada: os 4 caminhos mais promissores dos testes anteriores.

1. Sazonalidade com UMA entrada por dia: compra (ou vende) um bloco fixo de
   horas UTC. O bloco é escolhido entre 96 opções (início 0-23h, 1-4 horas)
   só no período de ajuste; o resultado que vale é o fora da amostra.
2. Rompimento com volume (a vencedora de 4h) em 2h, 4h, 6h, 8h, 12h e 1d,
   para ver se a vantagem é robusta nos tempos gráficos vizinhos.
3. Versão de venda do rompimento (futuros) quando o BTC está abaixo da
   EMA200 diária, e a versão combinada compra+venda.
4. Donchian e rotação por momentum SÓ com o filtro do BTC.
"""
import argparse
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import cripto_backtest as cb  # noqa: E402
from pro_backtest import rodar, met, fmt, fund_em, e_donchian, e_momentum, OOS  # noqa: E402
from daytrade_backtest import carregar_funding, funding_sintetico  # noqa: E402

CUSTO_LADO = {'spot': 0.0015, 'futuros': 0.0006}
CUSTO_RT = {'spot': 0.003, 'futuros': 0.0012}
TFS = ['2h', '4h', '6h', '8h', '12h', '1D']


def corta(d, oos):
    return d[d.index >= OOS] if oos else d[d.index < OOS]


# ------------------------------------------------ 1. sazonalidade em bloco
def sazonal(H1, fund1h, moedas):
    C = H1['close'][moedas]
    ret = C.pct_change(fill_method=None)
    prox = pd.Series((C.index + pd.Timedelta('1h')).hour, C.index)
    n = len(moedas)
    res = []
    for ini in range(24):
        for dur in range(1, 5):
            horas = [(ini + k) % 24 for k in range(dur)]
            dentro = prox.isin(horas).astype(float)
            pos = pd.DataFrame({c: dentro for c in moedas}) / n
            for lado, sinal in (('compra', 1), ('venda', -1)):
                for mercado in ('spot', 'futuros'):
                    if lado == 'venda' and mercado == 'spot':
                        continue
                    d, tr = rodar(sinal * pos, ret, CUSTO_LADO[mercado],
                                  fund1h[moedas] if mercado == 'futuros' else None)
                    res.append((mercado, lado, f'{ini:02d}h+{dur}h', d, tr))
    return res


# ---------------------------------------------- 2/3. rompimento multi-TF
def simular_dir(d, sinal, direcao, rr=2.0, stop_atr=1.5, max_hold=48):
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
        risco = stop_atr * atr[i]
        st, alvo = e - direcao * risco, e + direcao * rr * risco
        fim = min(n, i + 1 + max_hold)
        hh, ll = h[i + 1:fim], l[i + 1:fim]
        bs = np.flatnonzero(ll <= st) if direcao == 1 else np.flatnonzero(hh >= st)
        ba = np.flatnonzero(hh >= alvo) if direcao == 1 else np.flatnonzero(ll <= alvo)
        js = bs[0] if len(bs) else 10 ** 9
        ja = ba[0] if len(ba) else 10 ** 9
        if js == ja == 10 ** 9:
            j, saida = fim - 1, c[fim - 1]
        elif js <= ja:
            j = i + 1 + js
            saida = st if j == i + 1 else (min(o[j], st) if direcao == 1 else max(o[j], st))
        else:
            j, saida = i + 1 + ja, alvo
        out.append((idx[i + 1], idx[j], direcao * (saida - e) / risco, e / risco))
        livre = j + 1
    return out


def rompimento_tfs(brutos, regime):
    linhas = []
    for tf in TFS:
        for sim, df in brutos.items():
            d = cb.indicadores(cb.reamostrar(df, tf))
            d['min20'] = d.low.rolling(20).min().shift()
            reg = pd.Series(regime.reindex(d.index.floor('1D')).to_numpy(), d.index)
            reg = reg.fillna(False).astype(bool).to_numpy()
            vol = (d.volume > 2 * d.vol_med).to_numpy()
            c = d.close.to_numpy()
            longo = (c > d.max20.to_numpy()) & vol & (c > d.ema200.to_numpy()) & reg
            curto = (c < d.min20.to_numpy()) & vol & (c < d.ema200.to_numpy()) & ~reg
            for lado, sinal, dr in (('compra', longo, 1), ('venda', curto, -1)):
                for ent, sai, r, alav in simular_dir(d, sinal, dr):
                    linhas.append((tf, lado, sim, ent, sai, r, alav))
    t = pd.DataFrame(linhas, columns=['tf', 'lado', 'sim', 'entrada', 'saida', 'R_bruto', 'alav'])
    t['oos'] = t.entrada >= OOS
    t['ano'] = t.entrada.dt.year
    return t.sort_values('saida')


# ------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--synthetic', action='store_true')
    ap.add_argument('--saida', default='relatorio_foco.md')
    a = ap.parse_args()

    brutos, fund = {}, {}
    for k, s in enumerate(cb.SIMBOLOS):
        if a.synthetic:
            df = cb.sintetico(s, k, drift=0.0)
            f = funding_sintetico(df.index, k)
        else:
            df, f = cb.carregar(s), carregar_funding(s)
        if df is None or len(df) < 1000:
            continue
        brutos[s], fund[s] = df, f
        print(f'{s}: {len(df)} candles 1h', file=sys.stderr)
    moedas = list(brutos)
    n = len(moedas)
    regime = cb.regime_btc(brutos['BTC']).fillna(False).astype(bool)
    agg = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum'}
    H1 = {c: pd.DataFrame({s: d[c] for s, d in brutos.items()}) for c in agg}
    D = {c: H1[c].resample('1D').agg(agg[c]) for c in agg}
    fund1h = fund_em(fund, H1['close'].index, '1h')
    fund1d = fund_em(fund, D['close'].index, '1D')

    L = ['# Rodada focada: os 4 caminhos mais promissores', '',
         f'{n} moedas, {cb.INICIO} a {cb.FIM}, dados reais Binance. Escolha só no ajuste '
         f'(até {cb.CORTE_OOS}); **o que vale é fora da amostra (OOS)**.', '']

    # 1 ---------------------------------------------------------------
    L += ['## 1. Horário do dia (um bloco por dia)', '',
          'Retorno ao ano | Sharpe | queda máxima. Bloco escolhido entre 96 pelo Sharpe no ajuste.', '',
          '| Moedas | Mercado | Lado | Bloco escolhido (UTC) | Ajuste (IS) | Fora da amostra (OOS) '
          '| Mediana Sharpe OOS (96 blocos) | Trades/ano |', '|---|---|---|---|---|---|---|---|']
    anos = 3.0
    sel_saz = {}
    for nome, lista in (('20 moedas', moedas), ('BTC+ETH', ['BTC', 'ETH'])):
        res = pd.DataFrame(sazonal(H1, fund1h, lista), columns=['m', 'lado', 'bloco', 'd', 'tr'])
        for (m, lado), g in res.groupby(['m', 'lado']):
            s_is = np.array([met(corta(d, False))['sharpe'] for d in g.d])
            s_oos = np.array([met(corta(d, True))['sharpe'] for d in g.d])
            b = int(np.nanargmax(s_is))
            row = g.iloc[b]
            L.append(f"| {nome} | {m} | {lado} | {row.bloco} | {fmt(met(corta(row.d, False)))} | "
                     f"{fmt(met(corta(row.d, True)))} | {np.nanmedian(s_oos):.2f} | {row.tr / anos:.0f} |")
            sel_saz[(nome, m, lado)] = row.d
            # hipótese fixa vista nos testes anteriores: 21h-23h UTC
            if lado == 'compra':
                fixo = g[g.bloco == '21h+2h'].iloc[0]
                L.append(f"| {nome} | {m} | compra | 21h+2h (fixo) | {fmt(met(corta(fixo.d, False)))} | "
                         f"{fmt(met(corta(fixo.d, True)))} | - | {fixo.tr / anos:.0f} |")
                sel_saz[(nome, m, 'fixo21')] = fixo.d

    # 2/3 ---------------------------------------------------------------
    t = rompimento_tfs(brutos, regime)
    L += ['', '## 2 e 3. Rompimento com volume em vários tempos gráficos (alvo 2R, stop 1,5 ATR)', '',
          'Compra só com BTC acima da EMA200 diária; venda só com BTC abaixo. '
          'Formato: trades | acerto | média | PF | total | queda (em R).', '',
          '| TF | Lado | Mercado | Ajuste (IS) | Fora da amostra (OOS) | moedas + OOS |',
          '|---|---|---|---|---|---|']
    for tf in TFS:
        for lado in ('compra', 'venda', 'compra+venda'):
            g = t[t.tf == tf] if lado == 'compra+venda' else t[(t.tf == tf) & (t.lado == lado)]
            for mercado in ('spot', 'futuros'):
                if mercado == 'spot' and lado != 'compra':
                    continue
                r = g.R_bruto - CUSTO_RT[mercado] * g.alav
                gi, go = r[~g.oos], r[g.oos]
                pm = r[g.oos].groupby(g.sim[g.oos]).sum()
                pct = f'{(pm > 0).mean():.0%}' if len(pm) else '-'
                L.append(f'| {tf} | {lado} | {mercado} | {cb.fmt(cb.metricas(gi))} | '
                         f'{cb.fmt(cb.metricas(go))} | {pct} |')
    L += ['', '### Ano a ano (futuros, compra+venda)', '',
          '| TF | ' + ' | '.join(str(y) for y in range(2023, 2027)) + ' |', '|---|' + '---|' * 4]
    for tf in TFS:
        g = t[t.tf == tf]
        r = g.R_bruto - CUSTO_RT['futuros'] * g.alav
        cel = []
        for y in range(2023, 2027):
            m = cb.metricas(r[g.ano == y])
            cel.append(f"{m['n']} tr, {m['exp']:+.2f}R" if m['n'] else '-')
        L.append(f'| {tf} | ' + ' | '.join(cel) + ' |')

    # 4 ---------------------------------------------------------------
    regime_d = regime.reindex(D['close'].index).fillna(False).astype(bool)
    ret_d = D['close'].pct_change(fill_method=None)
    L += ['', '## 4. Donchian e momentum com filtro do BTC', '',
          'Retorno ao ano | Sharpe | queda máxima.', '',
          '| Estratégia | Mercado | Ajuste (IS) | Fora da amostra (OOS) | 2023 | 2024 | 2025 | 2026 |',
          '|---|---|---|---|---|---|---|---|']
    for fam, var, pl, pf, tf in e_donchian(D, regime_d, n) + e_momentum(D, regime_d):
        if 'filtroBTC' not in var:
            continue
        for mercado, pos in (('spot', pl), ('futuros', pf)):
            dd, _ = rodar(pos, ret_d[pos.columns], CUSTO_LADO[mercado],
                          fund1d[pos.columns] if mercado == 'futuros' else None)
            anos_c = [fmt(met(dd[dd.index.year == y])).split(' | ')[0] for y in range(2023, 2027)]
            L.append(f'| {fam} {var} | {mercado} | {fmt(met(corta(dd, False)))} | '
                     f'{fmt(met(corta(dd, True)))} | ' + ' | '.join(anos_c) + ' |')

    bench = ret_d['BTC'].fillna(0)
    L += ['', f'Referência BTC comprar e segurar: ajuste {fmt(met(corta(bench, False)))}; '
          f'fora da amostra {fmt(met(corta(bench, True)))}']
    txt = '\n'.join(L)
    with open(a.saida, 'w') as f:
        f.write(txt + '\n')
    print(txt)


if __name__ == '__main__':
    main()
