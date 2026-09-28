"""Backtest das estratégias do scanner de cripto (spot, só compra).

Dados: candles de 1h do arquivo público da Binance (data.binance.vision),
reamostrados para 4h. Preço de referência serve para qualquer corretora
(Mercado Bitcoin, Foxbit etc. seguem o mesmo preço por arbitragem).

Regras comuns a todas as estratégias:
- sinal no fechamento do candle i, entrada na abertura do candle i+1;
- stop = entrada - 1,5 x ATR14, alvo = entrada + RR x risco;
- se stop e alvo caem no mesmo candle, conta stop (conservador);
- saída por tempo depois de MAX_HOLD candles;
- custo de 0,3% ida e volta (taxa 0,1% + slippage 0,05% por lado);
- uma posição por moeda por estratégia de cada vez.

Uso:
  python backtest/cripto_backtest.py            # baixa dados e roda
  python backtest/cripto_backtest.py --synthetic  # teste offline
"""
import argparse
import io
import os
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen
from urllib.error import HTTPError

import numpy as np
import pandas as pd

SIMBOLOS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK',
            'DOT', 'LTC', 'TRX', 'NEAR', 'SUI', 'APT', 'ATOM', 'UNI', 'AAVE',
            'FIL', 'INJ']
INICIO = '2023-09'
FIM = '2026-08'
CORTE_OOS = '2025-09-01'  # antes: amostra de ajuste; depois: fora da amostra
CUSTO = 0.003
STOP_ATR = 1.5
MAX_HOLD = 48
RRS = [1.0, 2.0, 3.0]
DADOS = os.path.join(os.path.dirname(__file__), 'dados')
URL = ('https://data.binance.vision/data/spot/monthly/klines/'
       '{s}USDT/1h/{s}USDT-1h-{m}.zip')


# ---------------------------------------------------------------- dados
def meses():
    return [p.strftime('%Y-%m') for p in pd.period_range(INICIO, FIM, freq='M')]


def baixar_mes(sim, mes):
    os.makedirs(DADOS, exist_ok=True)
    arq = os.path.join(DADOS, f'{sim}-{mes}.csv')
    if os.path.exists(arq):
        return arq
    try:
        with urlopen(URL.format(s=sim, m=mes), timeout=60) as r:
            z = zipfile.ZipFile(io.BytesIO(r.read()))
    except HTTPError as e:
        if e.code == 404:
            return None
        raise
    with open(arq, 'wb') as f:
        f.write(z.read(z.namelist()[0]))
    return arq


def carregar(sim):
    with ThreadPoolExecutor(8) as ex:
        arqs = [a for a in ex.map(lambda m: baixar_mes(sim, m), meses()) if a]
    if not arqs:
        return None
    df = pd.concat([pd.read_csv(a, header=None, usecols=range(6)) for a in arqs])
    df = df.apply(pd.to_numeric, errors='coerce').dropna()
    ts = df[0].astype('int64')
    ts = np.where(ts > 1e14, ts // 1000, ts)  # 2025+: microssegundos
    df.index = pd.to_datetime(ts, unit='ms', utc=True)
    df = df.iloc[:, 1:6]
    df.columns = ['open', 'high', 'low', 'close', 'volume']
    return df[~df.index.duplicated()].sort_index()


def sintetico(sim, seed, freq='1h', sd=0.008, drift=0.00005):
    rng = np.random.default_rng(seed)
    idx = pd.date_range(INICIO + '-01', FIM + '-28', freq=freq, tz='UTC')
    ret = rng.normal(drift, sd, len(idx))
    c = 100 * np.exp(np.cumsum(ret))
    o = np.r_[c[0], c[:-1]]
    sp = np.abs(rng.normal(0, sd / 2, len(idx))) * c
    return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + sp,
                         'low': np.minimum(o, c) - sp, 'close': c,
                         'volume': rng.lognormal(10, 0.5, len(idx))}, index=idx)


def reamostrar(df, regra):
    return df.resample(regra, label='left', closed='left').agg(
        {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last',
         'volume': 'sum'}).dropna()


# ----------------------------------------------------------- indicadores
def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def wilder(s, n):
    return s.ewm(alpha=1 / n, adjust=False).mean()


def indicadores(df):
    d = df.copy()
    c, h, l = d.close, d.high, d.low
    pc = c.shift()
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    d['atr'] = wilder(tr, 14)
    d['ema9'], d['ema21'] = ema(c, 9), ema(c, 21)
    d['ema50'], d['ema200'] = ema(c, 50), ema(c, 200)
    delta = c.diff()
    rs = wilder(delta.clip(lower=0), 14) / wilder((-delta).clip(lower=0), 14)
    d['rsi'] = 100 - 100 / (1 + rs)
    up, dn = h.diff(), -l.diff()
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    atr_w = wilder(tr, 14)
    pdi = 100 * wilder(pd.Series(pdm, d.index), 14) / atr_w
    mdi = 100 * wilder(pd.Series(mdm, d.index), 14) / atr_w
    d['adx'] = wilder(100 * (pdi - mdi).abs() / (pdi + mdi), 14)
    mid = c.rolling(20).mean()
    sd = c.rolling(20).std()
    d['bb_mid'], d['bb_up'], d['bb_lo'] = mid, mid + 2 * sd, mid - 2 * sd
    d['bbw'] = 4 * sd / mid
    d['vol_med'] = d.volume.rolling(20).mean()
    d['max20'] = h.rolling(20).max().shift()
    return d


def regime_btc(btc_1h):
    """True quando o BTC fechou o dia anterior acima da EMA200 diária."""
    dia = reamostrar(btc_1h, '1D')
    ok = (dia.close > ema(dia.close, 200)).shift(1)
    return ok


# ------------------------------------------------------------ estratégias
def sinais(d, rs_top=None):
    tend = d.close > d.ema200
    s = {}
    s['rompimento_volume'] = (d.close > d.max20) & (d.volume > 2 * d.vol_med) & tend
    cruz = (d.ema9 > d.ema21) & (d.ema9.shift() <= d.ema21.shift())
    s['cruzamento_ema'] = cruz & tend & (d.adx > 25)
    aperto = d.bbw.shift().rolling(5).min() <= d.bbw.rolling(100).min() * 1.05
    s['squeeze_bollinger'] = aperto & (d.close > d.bb_up) & tend
    s['reversao_rsi'] = (d.rsi < 30) & (d.close < d.bb_lo) & tend
    s['pullback_ema21'] = (tend & (d.ema50 > d.ema200) & (d.low <= d.ema21)
                           & (d.close > d.ema21) & d.rsi.between(40, 60))
    if rs_top is not None:
        top = rs_top.reindex(d.index).fillna(False).astype(bool)
        s['forca_relativa_btc'] = top & ~top.shift(fill_value=False) & tend & (d.rsi < 75)
    return {k: v.fillna(False).to_numpy() for k, v in s.items()}


def simular(d, sinal, rr):
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
        risco = STOP_ATR * atr[i]
        stop, alvo = e - risco, e + rr * risco
        fim = min(n, i + 1 + MAX_HOLD)
        bs = np.flatnonzero(l[i + 1:fim] <= stop)
        ba = np.flatnonzero(h[i + 1:fim] >= alvo)
        js = bs[0] if len(bs) else 10 ** 9
        ja = ba[0] if len(ba) else 10 ** 9
        if js == ja == 10 ** 9:
            j = fim - 1
            saida = c[j]
        elif js <= ja:
            j = i + 1 + js
            saida = min(o[j], stop) if j > i + 1 else stop
        else:
            j = i + 1 + ja
            saida = alvo
        r = (saida - e) / risco - CUSTO * e / risco
        out.append((idx[i + 1], idx[j], r))
        livre = j + 1
    return out


# ---------------------------------------------------------------- métricas
def metricas(r):
    r = np.asarray(r)
    if len(r) == 0:
        return dict(n=0, acerto=np.nan, exp=np.nan, pf=np.nan, total=0.0, dd=0.0)
    ganho, perda = r[r > 0].sum(), -r[r < 0].sum()
    eq = np.cumsum(r)
    dd = (np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]).max()
    return dict(n=len(r), acerto=(r > 0).mean(), exp=r.mean(),
                pf=ganho / perda if perda > 0 else np.inf, total=r.sum(), dd=dd)


def fmt(m):
    if m['n'] == 0:
        return '0 | - | - | - | - | -'
    return (f"{m['n']} | {100 * m['acerto']:.0f}% | {m['exp']:+.3f}R | "
            f"{m['pf']:.2f} | {m['total']:+.1f}R | {m['dd']:.1f}R")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--synthetic', action='store_true')
    ap.add_argument('--saida', default='relatorio_backtest.md')
    a = ap.parse_args()

    brutos = {}
    for k, sim in enumerate(SIMBOLOS):
        df = sintetico(sim, k) if a.synthetic else carregar(sim)
        if df is None or len(df) < 1000:
            print(f'{sim}: sem dados, ignorado', file=sys.stderr)
            continue
        brutos[sim] = df
        print(f'{sim}: {len(df)} candles {df.index[0].date()} -> {df.index[-1].date()}',
              file=sys.stderr)
    regime = regime_btc(brutos['BTC'])

    trades = []  # (tf, estrategia, rr, sim, entrada, saida, R, regime_ok)
    for tf, regra in (('1h', None), ('4h', '4h')):
        dfs = {s: indicadores(reamostrar(d, regra) if regra else d)
               for s, d in brutos.items()}
        closes = pd.DataFrame({s: d.close for s, d in dfs.items()})
        rs = closes.pct_change(24).sub(closes['BTC'].pct_change(24), axis=0)
        rs = rs.drop(columns='BTC')
        top = rs.rank(axis=1, ascending=False) <= 3
        for sim, d in dfs.items():
            rs_top = top[sim] if sim in top else None
            reg = regime.reindex(d.index.floor('1D')).to_numpy()
            reg_ok = pd.Series(reg, d.index).fillna(False).astype(bool)
            for est, sinal in sinais(d, rs_top).items():
                for rr in RRS:
                    for ent, sai, r in simular(d, sinal, rr):
                        trades.append((tf, est, rr, sim, ent, sai, r, bool(reg_ok[ent])))
    t = pd.DataFrame(trades, columns=['tf', 'estrategia', 'rr', 'sim', 'entrada',
                                      'saida', 'R', 'regime_ok'])
    t['oos'] = t.entrada >= pd.Timestamp(CORTE_OOS, tz='UTC')

    L = [f'# Backtest scanner cripto ({INICIO} a {FIM})', '',
         f'{len(brutos)} moedas USDT spot, só compra. Custo {CUSTO:.1%} ida e volta. '
         f'Stop {STOP_ATR} ATR. Fora da amostra (OOS) a partir de {CORTE_OOS}.', '',
         'Colunas: trades | acerto | expectativa por trade | profit factor | '
         'total | drawdown máximo (em R = unidades de risco).', '']
    cab = ('| TF | Estratégia | RR | Filtro BTC | Ajuste (IS) | Fora da amostra (OOS) |\n'
           '|---|---|---|---|---|---|')
    linhas = []
    for (tf, est, rr), g in t.groupby(['tf', 'estrategia', 'rr']):
        for filtro in (False, True):
            gg = g[g.regime_ok] if filtro else g
            gg = gg.sort_values('saida')
            mi, mo = metricas(gg[~gg.oos].R), metricas(gg[gg.oos].R)
            linhas.append((tf, est, rr, filtro, mi, mo))
    L.append('## Ranking (ordenado pela expectativa fora da amostra, mínimo 30 trades em cada período)')
    L.append('')
    L.append(cab)
    rank = [x for x in linhas if x[4]['n'] >= 30 and x[5]['n'] >= 30]
    rank.sort(key=lambda x: -x[5]['exp'])
    for tf, est, rr, f, mi, mo in rank:
        L.append(f"| {tf} | {est} | {rr:g} | {'sim' if f else 'não'} | {fmt(mi)} | {fmt(mo)} |")
    L += ['', '## Por ano (RR 2, com filtro BTC)', '',
          '| TF | Estratégia | Ano | trades | acerto | exp | PF | total | DD |',
          '|---|---|---|---|---|---|---|---|---|']
    t['ano'] = t.entrada.dt.year
    g2 = t[(t.rr == 2.0) & t.regime_ok]
    for (tf, est, ano), g in g2.groupby(['tf', 'estrategia', 'ano']):
        L.append(f'| {tf} | {est} | {ano} | {fmt(metricas(g.sort_values("saida").R))} |')
    bh = {s: d.close.iloc[-1] / d.close.iloc[0] - 1 for s, d in brutos.items()}
    L += ['', '## Referência: comprar e segurar no período', '',
          ', '.join(f'{s} {100 * v:+.0f}%' for s, v in bh.items())]
    txt = '\n'.join(L)
    with open(a.saida, 'w') as f:
        f.write(txt + '\n')
    t.to_csv(os.path.splitext(a.saida)[0] + '_trades.csv', index=False)
    print(txt)


if __name__ == '__main__':
    main()
