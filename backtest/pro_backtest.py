"""Backtest de estratégias profissionais (carteira, métricas de fundo).

Estratégias:
  1. rompimento de volatilidade Larry Williams (day trade, sai no fim do dia)
  2. fluxo de ordens: desequilíbrio de agressão (taker) e open interest
  3. sazonalidade por hora do dia (horas escolhidas só no período de ajuste)
  4. pares (spread entre duas moedas, neutro ao mercado)
  5. seguidor de tendência Donchian / Tartarugas (diário)
  6. rotação por momentum (semanal)
  7. arbitragem de funding (compra spot + vende perpétuo)

Motor por posição: peso por moeda (-1..1, dividido pelo número de moedas),
posição decidida no fechamento do candle t vale para o candle t+1; custo
cobrado sobre a mudança de posição; em futuros a posição paga/recebe funding.
Métricas em retorno diário da carteira: retorno ao ano, Sharpe, drawdown.

Validação: parâmetros escolhidos pelo Sharpe no período de ajuste (IS);
o que vale é o período fora da amostra (OOS). Mostramos também a mediana do
Sharpe OOS de toda a grade (robustez) e o comprar-e-segurar como referência.
"""
import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from cripto_backtest import SIMBOLOS, CORTE_OOS, DADOS, INICIO, FIM, ema  # noqa: E402
from daytrade_backtest import baixar, _baixar_todos, _tempo, BASE, carregar_funding  # noqa: E402

CUSTO_LADO = {'spot': 0.0015, 'futuros': 0.0006}
CUSTO_CARRY = 0.002  # por troca de posição: spot + perpétuo + slippage
MOEDAS_OI = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK']
PARES = [('ETH', 'BTC'), ('SOL', 'ETH'), ('BNB', 'BTC'), ('LTC', 'BTC'),
         ('XRP', 'BTC'), ('LINK', 'ETH'), ('AVAX', 'SOL'), ('DOT', 'ADA')]
OOS = pd.Timestamp(CORTE_OOS, tz='UTC')


# ---------------------------------------------------------------- dados
def carregar_15m_taker(sim):
    arqs = _baixar_todos(sim, BASE + 'spot/monthly/klines/{s}USDT/15m/{s}USDT-15m-{m}.zip',
                         '{s}-15m-{m}.csv')
    if not arqs:
        return None
    df = pd.concat([pd.read_csv(a, header=None, usecols=[0, 1, 2, 3, 4, 5, 9]) for a in arqs])
    df = df.apply(pd.to_numeric, errors='coerce').dropna()
    df.index = _tempo(df[0])
    df = df[[1, 2, 3, 4, 5, 9]]
    df.columns = ['open', 'high', 'low', 'close', 'volume', 'taker']
    return df[~df.index.duplicated()].sort_index()


def carregar_oi(sim):
    os.makedirs(DADOS, exist_ok=True)
    dias = pd.date_range(INICIO + '-01', pd.Period(FIM).end_time.normalize(), freq='1D')

    def um(d):
        dd = d.strftime('%Y-%m-%d')
        url = BASE + f'futures/um/daily/metrics/{sim}USDT/{sim}USDT-metrics-{dd}.zip'
        return baixar(url, os.path.join(DADOS, f'{sim}-metrics-{dd}.csv'))
    with ThreadPoolExecutor(32) as ex:
        arqs = [a for a in ex.map(um, dias) if a]
    if not arqs:
        return None
    df = pd.concat([pd.read_csv(a) for a in arqs])
    s = pd.Series(pd.to_numeric(df['sum_open_interest'], errors='coerce').to_numpy(),
                  index=pd.to_datetime(df['create_time'], utc=True))
    s = s[~s.index.duplicated()].sort_index().dropna()
    return s.resample('15min', label='left', closed='left').last()


def sintetico(k):
    rng = np.random.default_rng(k)
    idx = pd.date_range(INICIO + '-01', FIM + '-28', freq='15min', tz='UTC')
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.004, len(idx))))
    o = np.r_[c[0], c[:-1]]
    sp = np.abs(rng.normal(0, 0.002, len(idx))) * c
    v = rng.lognormal(10, 0.5, len(idx))
    df = pd.DataFrame({'open': o, 'high': np.maximum(o, c) + sp, 'low': np.minimum(o, c) - sp,
                       'close': c, 'volume': v, 'taker': v * rng.uniform(0.3, 0.7, len(idx))},
                      index=idx)
    t = pd.date_range(idx[0], idx[-1], freq='8h')
    f = pd.Series(rng.normal(0.0001, 0.0002, len(t)), index=t)
    oi = pd.Series(np.exp(np.cumsum(rng.normal(0, 0.003, len(idx)))), index=idx)
    return df, f, oi


# ------------------------------------------------------------------ motor
def rodar(pos, ret, custo, fund=None):
    pos = pos.reindex(ret.index).fillna(0.0)
    prev = pos.shift(1).fillna(0.0)
    r = prev * ret.fillna(0.0) - custo * (pos - prev).abs()
    if fund is not None:
        r = r - prev * fund.reindex(index=ret.index, columns=ret.columns).fillna(0.0)
    diario = r.sum(axis=1).resample('1D').sum()
    trades = int(((pos != 0) & (prev == 0)).sum().sum())
    return diario, trades


def met(r):
    r = r.dropna()
    if len(r) < 30 or r.std() == 0:
        return dict(ret=np.nan, sharpe=np.nan, dd=np.nan)
    eq = (1 + r).cumprod()
    return dict(ret=r.mean() * 365, sharpe=r.mean() / r.std() * np.sqrt(365),
                dd=(1 - eq / eq.cummax()).max())


def fmt(m):
    if not np.isfinite(m['sharpe']):
        return '- | - | -'
    return f"{100 * m['ret']:+.1f}% | {m['sharpe']:.2f} | {100 * m['dd']:.1f}%"


def fund_em(fund, idx, regra):
    """Funding (taxa por evento) somado por candle do índice dado."""
    return pd.DataFrame({s: f.groupby(f.index.floor(regra)).sum() for s, f in fund.items()
                         if f is not None}).reindex(idx).fillna(0.0)


# ------------------------------------------------------------ estratégias
def e_larry_williams(P, regime15, n):
    C, O = P['close'], P['open']
    dia = C.index.floor('1D')
    D_o = O.groupby(dia).transform('first')
    faixa = (P['high'].groupby(dia).max() - P['low'].groupby(dia).min()).shift(1)
    faixa = faixa.reindex(dia).set_axis(C.index)
    ultimo = pd.Series((C.index + pd.Timedelta('15min')).floor('1D') != dia, C.index)
    out = []
    for k in (0.3, 0.5, 0.7):
        for stop in (False, True):
            for filtro in (False, True):
                def lado(cruza, sai):
                    dentro = cruza.astype(int).groupby(dia).cummax() > 0
                    if stop:
                        parou = (dentro & sai).astype(int).groupby(dia).cummax() > 0
                        dentro = dentro & ~parou
                    return dentro.where(~ultimo, False)
                lg = lado(C > D_o + k * faixa, C < D_o)
                ct = lado(C < D_o - k * faixa, C > D_o)
                if filtro:
                    lg = lg.mul(regime15, axis=0).astype(bool)
                    ct = ct.mul(~regime15, axis=0).astype(bool)
                var = f'k{k}_stop{"Abertura" if stop else "Nao"}_filtro{"BTC" if filtro else "Nao"}'
                out.append(('1_larry_williams', var, lg.astype(float) / n,
                            (lg.astype(float) - ct.astype(float)) / n, '15min'))
    return out


def e_fluxo(P, oi, n_todas):
    C, V, TB = P['close'], P['volume'], P['taker']
    imb = (2 * TB - V).rolling(4).sum() / V.rolling(4).sum()
    r1h = C.pct_change(4)
    out = []
    for thr in (0.15, 0.25, 0.35):
        for H in (4, 8):
            lg = ((imb > thr) & (r1h > 0)).astype(float).rolling(H, min_periods=1).max()
            ct = ((imb < -thr) & (r1h < 0)).astype(float).rolling(H, min_periods=1).max()
            out.append(('2a_fluxo_taker', f'lim{thr}_seg{H}', lg / n_todas,
                        (lg - ct) / n_todas, '15min'))
    if oi is not None and len(oi.columns):
        cols = list(oi.columns)
        oic = oi.reindex(C.index).ffill().pct_change(4)
        for thr in (0.15, 0.25):
            for othr in (0.005, 0.01):
                for H in (4, 8):
                    lg = ((imb[cols] > thr) & (r1h[cols] > 0) & (oic > othr)).astype(float)
                    ct = ((imb[cols] < -thr) & (r1h[cols] < 0) & (oic > othr)).astype(float)
                    lg = lg.rolling(H, min_periods=1).max()
                    ct = ct.rolling(H, min_periods=1).max()
                    k = len(cols)
                    out.append(('2b_fluxo_taker_OI', f'lim{thr}_oi{othr}_seg{H}',
                                lg / k, (lg - ct) / k, '15min'))
    return out


def e_sazonal(H1, n):
    ret = H1['close'].pct_change()
    is_ = ret[ret.index < OOS].stack().dropna()
    por_hora = is_.groupby(is_.index.get_level_values(0).hour)
    t = por_hora.mean() / (por_hora.std() / np.sqrt(por_hora.count()))
    boas, ruins = list(t[t > 2].index), list(t[t < -2].index)
    # posição no candle anterior à hora escolhida (vale para o candle seguinte)
    idx = H1['close'].index
    prox = pd.Series((idx + pd.Timedelta('1h')).hour, idx)
    lg = pd.DataFrame({c: prox.isin(boas).astype(float) for c in ret.columns}, index=idx)
    ct = pd.DataFrame({c: prox.isin(ruins).astype(float) for c in ret.columns}, index=idx)
    var = f'compra_h{boas}_venda_h{ruins}'
    return [('3_sazonal_hora', var, lg / n, (lg - ct) / n, '1h')], t


def e_pares(H1):
    lc = np.log(H1['close'])
    pares = [(a, b) for a, b in PARES if a in lc and b in lc]
    out = []
    for jan in (72, 168):
        for ent in (2.0, 2.5):
            pos = pd.DataFrame(0.0, index=H1['close'].index, columns=H1['close'].columns)
            for a, b in pares:
                sp = lc[a] - lc[b]
                z = ((sp - sp.rolling(jan).mean()) / sp.rolling(jan).std()).to_numpy()
                p = np.zeros(len(z))
                cur, desde = 0, 0
                for i in range(len(z)):
                    if not np.isfinite(z[i]):
                        cur = 0
                    elif cur == 0:
                        if z[i] > ent:
                            cur, desde = -1, i
                        elif z[i] < -ent:
                            cur, desde = 1, i
                    elif abs(z[i]) < 0.5 or i - desde >= 72:
                        cur = 0
                    p[i] = cur
                w = 0.5 / len(pares)
                pos[a] += p * w
                pos[b] -= p * w
            out.append(('4_pares', f'janela{jan}h_entrada{ent}', None, pos, '1h'))
    return out


def e_donchian(D, regime_d, n):
    C, H, L = D['close'], D['high'], D['low']
    out = []
    for ent, sai in ((20, 10), (55, 20)):
        mx, mn = H.rolling(ent).max().shift(), L.rolling(ent).min().shift()
        smx, smn = H.rolling(sai).max().shift(), L.rolling(sai).min().shift()
        lg = pd.DataFrame(0.0, index=C.index, columns=C.columns)
        ct = lg.copy()
        for col in C.columns:
            c, a, b, sa, sb = (x[col].to_numpy() for x in (C, mx, mn, smn, smx))
            pl, ps = np.zeros(len(c)), np.zeros(len(c))
            l_, s_ = 0, 0
            for i in range(len(c)):
                if l_ == 0 and c[i] > a[i]:
                    l_ = 1
                elif l_ == 1 and c[i] < sa[i]:
                    l_ = 0
                if s_ == 0 and c[i] < b[i]:
                    s_ = 1
                elif s_ == 1 and c[i] > sb[i]:
                    s_ = 0
                pl[i], ps[i] = l_, s_
            lg[col], ct[col] = pl, ps
        for filtro in (False, True):
            l2 = lg.mul(regime_d, axis=0) if filtro else lg
            c2 = ct.mul(~regime_d, axis=0) if filtro else ct
            out.append(('5_donchian', f'{ent}_{sai}_filtro{"BTC" if filtro else "Nao"}',
                        l2 / n, (l2 - c2) / n, '1D'))
    return out


def e_momentum(D, regime_d):
    C = D['close']
    segunda = pd.Series(C.index.dayofweek == 6, C.index)  # decide no fechamento de domingo
    out = []
    for jan in (7, 14, 28):
        mom = C.pct_change(jan)
        for k in (3, 5):
            for filtro in (False, True):
                pos = pd.DataFrame(np.nan, index=C.index, columns=C.columns)
                for t in C.index[segunda.to_numpy()]:
                    m = mom.loc[t].dropna()
                    esc = m[m > 0].nlargest(k).index
                    linha = pd.Series(0.0, index=C.columns)
                    if len(esc) and (not filtro or regime_d.get(t, False)):
                        linha[esc] = 1.0 / k
                    pos.loc[t] = linha
                pos = pos.ffill().fillna(0.0)
                out.append(('6_momentum_rotacao', f'janela{jan}d_top{k}_filtro{"BTC" if filtro else "Nao"}',
                            pos, pos, '1D'))
    return out


def e_carry(fund, n):
    """Retorna diretamente as séries diárias por variante (não usa o motor)."""
    out = []
    for lim in (0.00005, 0.0001, 0.0002):
        for jan in (3, 9):
            partes, trocas = [], 0
            for s, f in fund.items():
                if f is None or len(f) < 50:
                    continue
                media = f.rolling(jan).mean()
                pos = (media > lim).astype(float)
                prev = pos.shift(1).fillna(0.0)
                r = prev * f - CUSTO_CARRY * (pos - prev).abs()
                trocas += int(((pos == 1) & (prev == 0)).sum())
                partes.append(r.groupby(r.index.floor('1D')).sum())
            diario = pd.concat(partes, axis=1).fillna(0.0).sum(axis=1) / n
            out.append(('7_carry_funding', f'lim{lim:.3%}_media{jan}', diario, trocas))
    return out


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--synthetic', action='store_true')
    ap.add_argument('--saida', default='relatorio_pro.md')
    a = ap.parse_args()

    brutos, fund, ois = {}, {}, {}
    for k, s in enumerate(SIMBOLOS):
        if a.synthetic:
            df, f, oi = sintetico(k)
            oi = oi if s in MOEDAS_OI else None
        else:
            df, f = carregar_15m_taker(s), carregar_funding(s)
            oi = carregar_oi(s) if s in MOEDAS_OI else None
        if df is None or len(df) < 5000:
            continue
        brutos[s], fund[s] = df, f
        if oi is not None and len(oi) > 1000:
            ois[s] = oi
        print(f'{s}: {len(df)} candles, funding {0 if f is None else len(f)}, '
              f'OI {0 if oi is None else len(oi)}', file=sys.stderr)
    n = len(brutos)
    P = {c: pd.DataFrame({s: d[c] for s, d in brutos.items()})
         for c in ('open', 'high', 'low', 'close', 'volume', 'taker')}
    agg = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum',
           'taker': 'sum'}
    H1 = {c: P[c].resample('1h').agg(agg[c]) for c in P}
    D = {c: P[c].resample('1D').agg(agg[c]) for c in P}
    btc = D['close']['BTC']
    regime_d = (btc > ema(btc, 200)).shift(1).fillna(False).astype(bool)
    regime15 = regime_d.reindex(P['close'].index.floor('1D')).set_axis(P['close'].index)
    OI = pd.DataFrame(ois) if ois else None

    rets = {'15min': P['close'].pct_change(fill_method=None),
            '1h': H1['close'].pct_change(fill_method=None),
            '1D': D['close'].pct_change(fill_method=None)}
    funds = {r: fund_em(fund, rets[r].index, r) for r in rets}

    variantes = []
    variantes += e_larry_williams(P, regime15, n)
    print('larry ok', file=sys.stderr)
    variantes += e_fluxo(P, OI, n)
    print('fluxo ok', file=sys.stderr)
    saz, tstat_hora = e_sazonal(H1, n)
    variantes += saz
    variantes += e_pares(H1)
    print('pares ok', file=sys.stderr)
    variantes += e_donchian(D, regime_d, n)
    variantes += e_momentum(D, regime_d)
    print('swing ok', file=sys.stderr)

    anos = (pd.Timestamp(FIM, tz='UTC') - pd.Timestamp(INICIO, tz='UTC')).days / 365
    res = []  # (cenario, familia, variante, serie diaria, trades)
    for fam, var, pos_long, pos_fut, tf in variantes:
        ret = rets[tf]
        if pos_long is not None:
            d, tr = rodar(pos_long, ret.reindex(columns=pos_long.columns), CUSTO_LADO['spot'])
            res.append(('spot (só compra)', fam, var, d, tr))
        d, tr = rodar(pos_fut, ret.reindex(columns=pos_fut.columns), CUSTO_LADO['futuros'],
                      funds[tf].reindex(columns=pos_fut.columns))
        res.append(('futuros', fam, var, d, tr))
    for fam, var, d, tr in e_carry(fund, n):
        res.append(('spot + futuros (neutro)', fam, var, d, tr))

    def corta(d, oos):
        return d[d.index >= OOS] if oos else d[d.index < OOS]

    L = ['# Backtest de estratégias profissionais', '',
         f'{n} moedas, {INICIO} a {FIM}. Parâmetros escolhidos pelo Sharpe no ajuste '
         f'(até {CORTE_OOS}); **o que vale é a coluna fora da amostra (OOS)**.', '',
         'Formato: retorno ao ano | Sharpe | queda máxima. Custos: spot 0,15% por lado; '
         'futuros 0,06% por lado + funding pago/recebido; carry 0,20% por troca.', '',
         'Aprovada = Sharpe IS >= 0,5, Sharpe OOS >= 1,0 e mediana OOS da grade > 0.', '']
    bench = {'BTC comprar e segurar': rets['1D']['BTC'].fillna(0),
             'Cesta das 20 moedas (peso igual)': rets['1D'].mean(axis=1).fillna(0)}
    L += ['## Referência', '', '| Carteira | Ajuste (IS) | Fora da amostra (OOS) |',
          '|---|---|---|']
    for k, d in bench.items():
        L.append(f'| {k} | {fmt(met(corta(d, False)))} | {fmt(met(corta(d, True)))} |')
    L += ['', '## Resultado por estratégia', '',
          '| Mercado | Estratégia | Parâmetro escolhido | Ajuste (IS) | Fora da amostra (OOS) '
          '| Mediana Sharpe OOS (grade) | Trades/ano | Aprovada |',
          '|---|---|---|---|---|---|---|---|']
    tab = pd.DataFrame(res, columns=['cen', 'fam', 'var', 'd', 'tr'])
    grade, aprovadas, escolhidas = [], [], []
    for (cen, fam), g in tab.groupby(['cen', 'fam'], sort=True):
        g = g.assign(s_is=[met(corta(d, False))['sharpe'] for d in g.d],
                     s_oos=[met(corta(d, True))['sharpe'] for d in g.d])
        for _, r in g.iterrows():
            grade.append((cen, fam, r['var'], r.s_is, r.s_oos, r.tr))
        melhor = g.loc[g.s_is.fillna(-99).idxmax()]
        mi, mo = met(corta(melhor.d, False)), met(corta(melhor.d, True))
        med = np.nanmedian(g.s_oos) if g.s_oos.notna().any() else np.nan
        ok = (mi['sharpe'] >= 0.5 and mo['sharpe'] >= 1.0 and med > 0)
        L.append(f"| {cen} | {fam} | {melhor['var']} | {fmt(mi)} | {fmt(mo)} | {med:.2f} "
                 f"| {melhor.tr / anos:.0f} | {'✅' if ok else '❌'} |")
        escolhidas.append((cen, fam, melhor['var'], melhor.d))
        if ok:
            aprovadas.append(f"- **{fam}** ({cen}, {melhor['var']}): OOS {fmt(mo)}")
    L += ['', '## Ano a ano (parâmetro escolhido): retorno | Sharpe | queda', '',
          '| Mercado | Estratégia | ' + ' | '.join(str(y) for y in range(2023, 2027)) + ' |',
          '|---|---|' + '---|' * 4]
    for cen, fam, var, d in escolhidas:
        cel = [fmt(met(d[d.index.year == y])) for y in range(2023, 2027)]
        L.append(f'| {cen} | {fam} | ' + ' | '.join(c.replace(' | ', ' / ') for c in cel) + ' |')
    L += ['', '## Aprovadas', ''] + (aprovadas or ['- nenhuma passou em todos os critérios'])
    L += ['', '## Sazonalidade: estatística t do retorno por hora UTC (período de ajuste)', '',
          ' '.join(f'{h}h:{v:+.1f}' for h, v in tstat_hora.items())]
    txt = '\n'.join(L)
    with open(a.saida, 'w') as f:
        f.write(txt + '\n')
    pd.DataFrame(grade, columns=['mercado', 'familia', 'variante', 'sharpe_is', 'sharpe_oos',
                                 'trades']).to_csv(os.path.splitext(a.saida)[0] + '_grade.csv',
                                                   index=False)
    print(txt)


if __name__ == '__main__':
    main()
