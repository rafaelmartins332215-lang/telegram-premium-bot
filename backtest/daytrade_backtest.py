"""Backtest de estratégias de day trade (candles de 15 minutos).

Validação:
- cada família de estratégia tem uma grade pequena de parâmetros;
- os parâmetros são escolhidos SÓ no período de ajuste (IS, até CORTE_OOS);
- o resultado que importa é o do período fora da amostra (OOS), que a
  escolha não viu; também mostramos ano a ano, % de moedas positivas e a
  estatística t da média OOS.

Dois cenários de custo (ida e volta, taxa + slippage):
- spot_taker: 0,30% (ordem a mercado no spot). Só compras.
- futuros_reduzido: 0,12% (futuros com ordem limitada na entrada). Compra e venda.

Regras de execução: sinal no fechamento do candle i, entrada na abertura
de i+1; stop e alvo no mesmo candle contam como stop; saída por tempo.

Uso:
  python backtest/daytrade_backtest.py
  python backtest/daytrade_backtest.py --synthetic   # teste offline
"""
import argparse
import io
import os
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import urlopen

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from cripto_backtest import (SIMBOLOS, CORTE_OOS, DADOS, ema, wilder,  # noqa: E402
                             reamostrar, metricas, fmt, meses, sintetico)

CUSTOS = {'spot_taker': 0.003, 'futuros_reduzido': 0.0012}
MIN_TRADES_IS = 100
MAX_HOLD = 48  # 12 horas em candles de 15 min
BASE = 'https://data.binance.vision/data/'


# ---------------------------------------------------------------- dados
def baixar(url, arq):
    if os.path.exists(arq):
        return arq
    try:
        with urlopen(url, timeout=60) as r:
            z = zipfile.ZipFile(io.BytesIO(r.read()))
    except HTTPError as e:
        if e.code == 404:
            return None
        raise
    with open(arq, 'wb') as f:
        f.write(z.read(z.namelist()[0]))
    return arq


def _baixar_todos(sim, url_fmt, nome):
    os.makedirs(DADOS, exist_ok=True)

    def um(m):
        return baixar(url_fmt.format(s=sim, m=m), os.path.join(DADOS, nome.format(s=sim, m=m)))
    with ThreadPoolExecutor(8) as ex:
        return [a for a in ex.map(um, meses()) if a]


def _tempo(col):
    ts = col.astype('int64')
    ts = np.where(ts > 1e14, ts // 1000, ts)
    return pd.to_datetime(ts, unit='ms', utc=True)


def carregar_15m(sim):
    arqs = _baixar_todos(sim, BASE + 'spot/monthly/klines/{s}USDT/15m/{s}USDT-15m-{m}.zip',
                         '{s}-15m-{m}.csv')
    if not arqs:
        return None
    df = pd.concat([pd.read_csv(a, header=None, usecols=range(6)) for a in arqs])
    df = df.apply(pd.to_numeric, errors='coerce').dropna()
    df.index = _tempo(df[0])
    df = df.iloc[:, 1:6]
    df.columns = ['open', 'high', 'low', 'close', 'volume']
    return df[~df.index.duplicated()].sort_index()


def carregar_funding(sim):
    arqs = _baixar_todos(sim, BASE + 'futures/um/monthly/fundingRate/{s}USDT/'
                         '{s}USDT-fundingRate-{m}.zip', '{s}-funding-{m}.csv')
    if not arqs:
        return None
    df = pd.concat([pd.read_csv(a, header=None) for a in arqs])
    df = df.apply(pd.to_numeric, errors='coerce').dropna(subset=[0, 2])
    s = pd.Series(df[2].to_numpy(), index=_tempo(df[0]))
    return s[~s.index.duplicated()].sort_index()


def funding_sintetico(idx, seed):
    rng = np.random.default_rng(seed + 100)
    t = pd.date_range(idx[0].floor('8h'), idx[-1], freq='8h')
    return pd.Series(rng.normal(0.0001, 0.0002, len(t)), index=t)


# ----------------------------------------------------------- indicadores
def contexto(d15, regra, fn):
    """Calcula fn no tempo gráfico maior e leva para 15m só depois do fechamento."""
    alto = fn(reamostrar(d15, regra)).shift(1)
    return alto.reindex(d15.index, method='ffill')


def adx(d):
    h, l, c = d.high, d.low, d.close
    pc = c.shift()
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    up, dn = h.diff(), -l.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), d.index)
    mdm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), d.index)
    a = wilder(tr, 14)
    pdi, mdi = 100 * wilder(pdm, 14) / a, 100 * wilder(mdm, 14) / a
    return wilder(100 * (pdi - mdi).abs() / (pdi + mdi), 14)


def preparar(df, funding, regime_btc):
    d = df.copy()
    c, h, l, v = d.close, d.high, d.low, d.volume
    pc = c.shift()
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    d['atr'] = wilder(tr, 14)
    d['ema20'], d['ema50'] = ema(c, 20), ema(c, 50)
    delta = c.diff()
    rs = wilder(delta.clip(lower=0), 14) / wilder((-delta).clip(lower=0), 14)
    d['rsi'] = 100 - 100 / (1 + rs)
    d['vol_med'] = v.rolling(20).mean()
    d['max20'] = h.rolling(20).max().shift()
    d['min20'] = l.rolling(20).min().shift()
    # VWAP do dia (UTC) e desvio padrão ponderado
    dia = d.index.floor('1D')
    tp = (h + l + c) / 3
    cv = v.groupby(dia).cumsum()
    d['vwap'] = (tp * v).groupby(dia).cumsum() / cv
    var = (tp * tp * v).groupby(dia).cumsum() / cv - d.vwap ** 2
    d['vwap_sd'] = np.sqrt(var.clip(lower=0))
    d['barra_dia'] = d.groupby(dia).cumcount()

    # contexto 1h e 4h sem olhar o futuro
    def tend1h(x):
        e50, e200 = ema(x.close, 50), ema(x.close, 200)
        return ((e50 > e200) & (x.close > e50)).astype(float)
    d['tend1h'] = contexto(d, '1h', tend1h).fillna(0).astype(bool)
    d['adx1h'] = contexto(d, '1h', adx)

    def setup4h(x):
        e200 = ema(x.close, 200)
        rompe = ((x.close > x.high.rolling(20).max().shift())
                 & (x.volume > 2 * x.volume.rolling(20).mean()) & (x.close > e200))
        return rompe.astype(float).rolling(6).max()  # setup vale por 24h
    d['setup4h'] = contexto(d, '4h', setup4h).fillna(0).astype(bool)
    d['regime'] = regime_btc.reindex(d.index.floor('1D')).to_numpy()
    d['regime'] = d.regime.fillna(False).astype(bool)
    d['funding'] = funding.reindex(d.index, method='ffill') if funding is not None else np.nan
    # sessão de Nova York (abertura 9:30 local, cobre horário de verão)
    ny = d.index.tz_convert('America/New_York')
    d['ny_min'] = ny.hour * 60 + ny.minute
    d['ny_dia'] = ny.normalize()
    return d


# ------------------------------------------------------------ estratégias
# Cada variante devolve (sinal, direção, stop, alvo_preco ou None, rr, fim)
# stop é preço; fim é o índice máximo de saída (ou None para MAX_HOLD).

def estrategias(d):
    c, o, h, l = d.close, d.open, d.high, d.low
    atr = d.atr
    n = len(d)
    out = []
    vol_ok = d.volume > 2 * d.vol_med

    # A) rompimento 4h como filtro, entrada no recuo à EMA20 de 15m
    base = d.setup4h & d.regime & (l <= d.ema20) & (c > d.ema20) & (c > d.vwap)
    for sa in (1.5, 2.5):
        for rr in (1.5, 2.0, 3.0):
            out.append(('A_filtro4h_recuo15m', f'stop{sa}atr_rr{rr}', base, 1,
                        c - sa * atr, None, rr, None))

    # B) rompimento da primeira hora de NY
    abertura = (d.ny_min >= 570) & (d.ny_min < 630)
    grupo = d.ny_dia
    r_max = h.where(abertura).groupby(grupo).transform('max')
    r_min = l.where(abertura).groupby(grupo).transform('min')
    janela = (d.ny_min >= 630) & (d.ny_min < 960)
    # fim do pregão NY 20:00 local -> índice do último candle do dia NY
    pos = pd.Series(np.arange(n), d.index)
    fim_dia = pos.where(d.ny_min < 1200).groupby(grupo).transform('max').fillna(n - 1)
    fim_dia = fim_dia.astype(int).to_numpy()
    rompe_c = janela & (c > r_max) & (c.shift() <= r_max) & (d.volume > 1.5 * d.vol_med)
    rompe_v = janela & (c < r_min) & (c.shift() >= r_min) & (d.volume > 1.5 * d.vol_med)
    # só o primeiro rompimento do dia
    rompe_c = rompe_c & (rompe_c.astype(int).groupby(grupo).cumsum() == 1)
    rompe_v = rompe_v & (rompe_v.astype(int).groupby(grupo).cumsum() == 1)
    meio = (r_max + r_min) / 2
    for nome_stop, sc, sv in (('fundo', r_min, r_max), ('meio', meio, meio)):
        for rr in (1.5, 2.0, 3.0):
            out.append(('B_abertura_NY_compra', f'stop_{nome_stop}_rr{rr}',
                        rompe_c & d.regime, 1, sc, None, rr, fim_dia))
            out.append(('B_abertura_NY_venda', f'stop_{nome_stop}_rr{rr}',
                        rompe_v, -1, sv, None, rr, fim_dia))

    # C) recuo à VWAP em dia de tendência (1h em alta)
    base = (d.tend1h & (d.barra_dia >= 8) & (l <= d.vwap * 1.001) & (c > d.vwap)
            & (c > o) & (d.ema20 > d.vwap))
    for sa in (1.5, 2.5):
        for rr in (1.5, 2.0, 3.0):
            out.append(('C_recuo_VWAP', f'stop{sa}atr_rr{rr}', base, 1,
                        c - sa * atr, None, rr, None))

    # D) reversão à VWAP em mercado lateral (ADX 1h baixo); alvo = VWAP
    for banda in (2.0, 2.5):
        base = ((d.adx1h < 20) & (d.barra_dia >= 8) & (c < d.vwap - banda * d.vwap_sd)
                & (d.rsi < 25))
        for sa in (1.5, 2.5):
            out.append(('D_reversao_VWAP', f'banda{banda}_stop{sa}atr', base, 1,
                        c - sa * atr, d.vwap, None, None))

    # E) funding extremo (futuros): muito positivo + perde a mínima -> venda;
    #    negativo + rompe a máxima -> compra
    for lim in (0.0003, 0.0005):
        base = (d.funding >= lim) & (c < d.min20) & vol_ok
        for rr in (1.5, 2.0, 3.0):
            out.append(('E_funding_venda', f'fund>={lim:.2%}_rr{rr}', base, -1,
                        c + 1.5 * atr, None, rr, None))
    for lim in (-0.0001, -0.0003):
        base = (d.funding <= lim) & (c > d.max20) & vol_ok
        for rr in (1.5, 2.0, 3.0):
            out.append(('E_funding_compra', f'fund<={lim:.2%}_rr{rr}', base, 1,
                        c - 1.5 * atr, None, rr, None))

    # F) referência: rompimento simples de 15m com volume
    base = (c > d.max20) & vol_ok & (c > d.ema50)
    for filtro in (False, True):
        s = base & d.regime if filtro else base
        for rr in (1.5, 2.0, 3.0):
            out.append(('F_rompimento15m' + ('_filtroBTC' if filtro else ''),
                        f'rr{rr}', s, 1, c - 1.5 * atr, None, rr, None))
    return out


def simular(d, sinal, direcao, stop, alvo_p, rr, fim):
    o, h, l, c = (d[k].to_numpy() for k in ('open', 'high', 'low', 'close'))
    atr = d.atr.to_numpy()
    idx = d.index
    sinal = np.asarray(sinal.fillna(False), bool)
    stop = np.asarray(stop, float)
    alvo_p = None if alvo_p is None else np.asarray(alvo_p, float)
    n = len(d)
    livre = 0
    res = []
    for i in np.flatnonzero(sinal):
        if i < livre or i + 1 >= n or i < 800 or not atr[i] > 0:
            continue
        e = o[i + 1]
        st = stop[i]
        risco = (e - st) * direcao
        if not np.isfinite(risco) or risco < 0.2 * atr[i]:
            continue
        if alvo_p is not None:
            alvo = alvo_p[i]
            if not np.isfinite(alvo) or (alvo - e) * direcao <= 0:
                continue
        else:
            alvo = e + direcao * rr * risco
        ultimo = min(n - 1, i + MAX_HOLD, fim[i] if fim is not None else n - 1)
        if ultimo <= i:
            continue
        hh, ll = h[i + 1:ultimo + 1], l[i + 1:ultimo + 1]
        if direcao == 1:
            bs, ba = np.flatnonzero(ll <= st), np.flatnonzero(hh >= alvo)
        else:
            bs, ba = np.flatnonzero(hh >= st), np.flatnonzero(ll <= alvo)
        js = bs[0] if len(bs) else 10 ** 9
        ja = ba[0] if len(ba) else 10 ** 9
        if js == ja == 10 ** 9:
            j, saida = ultimo, c[ultimo]
        elif js <= ja:
            j = i + 1 + js
            if j > i + 1:
                saida = min(o[j], st) if direcao == 1 else max(o[j], st)
            else:
                saida = st
        else:
            j, saida = i + 1 + ja, alvo
        res.append((idx[i + 1], idx[j], direcao * (saida - e) / risco, e / risco))
        livre = j + 1
    return res


# --------------------------------------------------------------- relatório
def tstat(r):
    r = np.asarray(r)
    return r.mean() / (r.std(ddof=1) / np.sqrt(len(r))) if len(r) > 2 else np.nan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--synthetic', action='store_true')
    ap.add_argument('--saida', default='relatorio_daytrade.md')
    a = ap.parse_args()

    brutos, fund = {}, {}
    for k, sim in enumerate(SIMBOLOS):
        if a.synthetic:
            df = sintetico(sim, k, freq='15min', sd=0.004, drift=0.0)
            f = funding_sintetico(df.index, k)
        else:
            df, f = carregar_15m(sim), carregar_funding(sim)
        if df is None or len(df) < 5000:
            print(f'{sim}: sem dados, ignorado', file=sys.stderr)
            continue
        brutos[sim], fund[sim] = df, f
        print(f'{sim}: {len(df)} candles 15m, funding {0 if f is None else len(f)}',
              file=sys.stderr)

    dia = reamostrar(brutos['BTC'], '1D')
    regime = (dia.close > ema(dia.close, 200)).shift(1)

    linhas = []
    for sim, df in brutos.items():
        d = preparar(df, fund[sim], regime)
        for fam, var, sinal, dr, stop, alvo, rr, fim in estrategias(d):
            for ent, sai, r, alav in simular(d, sinal, dr, stop, alvo, rr, fim):
                linhas.append((fam, var, dr, sim, ent, sai, r, alav))
        print(f'{sim}: simulado', file=sys.stderr)
    t = pd.DataFrame(linhas, columns=['familia', 'variante', 'dir', 'sim', 'entrada',
                                      'saida', 'R_bruto', 'e_sobre_risco'])
    t['oos'] = t.entrada >= pd.Timestamp(CORTE_OOS, tz='UTC')
    t['ano'] = t.entrada.dt.year
    t = t.sort_values('saida')

    L = ['# Backtest day trade cripto (candles de 15 min)', '',
         f'{len(brutos)} moedas. Parâmetros escolhidos só no período de ajuste '
         f'(até {CORTE_OOS}); **o que vale é a coluna fora da amostra (OOS)**.', '',
         'Formato: trades | acerto | média por trade | profit factor | total | '
         'drawdown máximo (em R).', '']
    grade = []
    escolhidos = []
    for cen, custo in CUSTOS.items():
        L += [f'## Cenário {cen} (custo ida e volta {custo:.2%})', '',
              '| Família | Parâmetro escolhido | Ajuste (IS) | Fora da amostra (OOS) '
              '| t OOS | moedas + OOS |', '|---|---|---|---|---|---|']
        for fam, g in t.groupby('familia'):
            if cen == 'spot_taker' and (g.dir == -1).any():
                continue  # venda só em futuros
            g = g.assign(R=g.R_bruto - custo * g.e_sobre_risco)
            melhor, melhor_exp = None, -np.inf
            for var, gv in g.groupby('variante'):
                mi, mo = metricas(gv[~gv.oos].R), metricas(gv[gv.oos].R)
                grade.append((cen, fam, var, mi['n'], mi['exp'], mo['n'], mo['exp']))
                if mi['n'] >= MIN_TRADES_IS and mi['exp'] > melhor_exp:
                    melhor, melhor_exp = var, mi['exp']
            if melhor is None:
                L.append(f'| {fam} | poucos trades | - | - | - | - |')
                continue
            gv = g[g.variante == melhor]
            mi, mo = metricas(gv[~gv.oos].R), metricas(gv[gv.oos].R)
            por_moeda = gv[gv.oos].groupby('sim').R.sum()
            pct = f'{(por_moeda > 0).mean():.0%}' if len(por_moeda) else '-'
            L.append(f'| {fam} | {melhor} | {fmt(mi)} | {fmt(mo)} | '
                     f'{tstat(gv[gv.oos].R):.1f} | {pct} |')
            escolhidos.append((cen, fam, melhor, gv))
        L.append('')

    L += ['## Ano a ano dos parâmetros escolhidos', '',
          '| Cenário | Família | Ano | trades | acerto | média | PF | total | DD |',
          '|---|---|---|---|---|---|---|---|---|']
    for cen, fam, var, gv in escolhidos:
        for ano, ga in gv.groupby('ano'):
            L.append(f'| {cen} | {fam} | {ano} | {fmt(metricas(ga.R))} |')
    L += ['', 'Aprovada = média OOS positiva, t OOS >= 2, maioria das moedas positiva '
          'e ajuste (IS) também positivo.', '']
    aprov = []
    for cen, fam, var, gv in escolhidos:
        mi, mo = metricas(gv[~gv.oos].R), metricas(gv[gv.oos].R)
        por_moeda = gv[gv.oos].groupby('sim').R.sum()
        if (mo['n'] >= 30 and mo['exp'] > 0 and mi['exp'] > 0
                and tstat(gv[gv.oos].R) >= 2 and (por_moeda > 0).mean() > 0.5):
            aprov.append(f'- **{fam}** ({cen}, {var}): OOS {fmt(mo)}')
    L += ['## Aprovadas', ''] + (aprov or ['- nenhuma passou em todos os critérios'])
    txt = '\n'.join(L)
    with open(a.saida, 'w') as f:
        f.write(txt + '\n')
    pd.DataFrame(grade, columns=['cenario', 'familia', 'variante', 'n_is', 'exp_is',
                                 'n_oos', 'exp_oos']).to_csv(
        os.path.splitext(a.saida)[0] + '_grade.csv', index=False)
    print(txt)


if __name__ == '__main__':
    main()
