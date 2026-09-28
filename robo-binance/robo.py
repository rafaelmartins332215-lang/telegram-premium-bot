"""Robô Binance Futuros (USDⓈ-M) — estratégia validada no backtest.

Rompimento com volume em 4h, só compra, filtro do BTC acima da EMA200 diária.
Stop (1,5 ATR) e alvo (2R) ficam REGISTRADOS NA BINANCE logo após a entrada:
se o robô cair, a proteção continua valendo.

Modos (variável ROBO_MODO):
  testnet  (padrão) dinheiro de mentira em testnet.binancefuture.com
  real     dinheiro de verdade; exige também ROBO_CONFIRMO_REAL=SIM

Configuração por variáveis de ambiente (ou arquivo .env na mesma pasta):
  BINANCE_API_KEY, BINANCE_API_SECRET   chave SÓ com permissão de futuros, SEM saque
  TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
  ROBO_MODO, ROBO_CONFIRMO_REAL
Uso: python robo.py            (fica rodando)
     python robo.py --teste    (só confere conexões e saldo, não opera)
"""
import argparse
import hashlib
import hmac
import json
import math
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import requests

PASTA = os.path.dirname(os.path.abspath(__file__))
BRT = timezone(timedelta(hours=-3))

CONFIG = {
    'moedas': ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
               'LTC', 'TRX', 'NEAR', 'SUI', 'APT', 'ATOM', 'UNI', 'AAVE', 'FIL', 'INJ',
               'OP', 'ARB', 'SHIB', 'PEPE', 'WIF', 'TIA', 'SEI', 'RUNE', 'FET', 'STX',
               'IMX', 'HBAR', 'ETC', 'BCH', 'XLM', 'ALGO', 'SAND', 'GALA', 'LDO', 'CRV'],
    # regras da estratégia (iguais ao backtest; não mude sem testar de novo)
    'tf': '4h', 'tf_ms': 4 * 3600 * 1000, 'candles': 1000, 'janela_max': 20,
    'vol_mult': 2.0, 'ema_tend': 200, 'ema_btc': 200, 'stop_atr': 1.5, 'rr': 2.0,
    'max_candles': 48,
    # gestão
    'risco': 0.01, 'max_posicoes': 6, 'alavancagem': 2,
    'atraso_max_ms': 3600 * 1000,       # não entra se o candle fechou há mais de 1h
    'pausa_queda': 0.30,                # pausa novas entradas se a banca cair 30% do pico
    'intervalo_s': 30, 'hora_resumo': 21,
}
URLS = {'real': 'https://fapi.binance.com', 'testnet': 'https://testnet.binancefuture.com'}


def carregar_env():
    arq = os.path.join(PASTA, '.env')
    if os.path.exists(arq):
        for linha in open(arq, encoding='utf-8'):
            linha = linha.strip()
            if linha and not linha.startswith('#') and '=' in linha:
                k, v = linha.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


class ErroBinance(Exception):
    def __init__(self, code, msg):
        super().__init__(f'{code}: {msg}')
        self.code = code


# ------------------------------------------------------------------ Binance
class Binance:
    def __init__(self, base, key, secret, sessao=None):
        self.base, self.key, self.secret = base, key, secret
        self.s = sessao or requests.Session()
        self.offset = 0

    def sincronizar_relogio(self):
        t = self.publico('/fapi/v1/time')['serverTime']
        self.offset = t - int(time.time() * 1000)

    def publico(self, caminho, **params):
        r = self.s.get(self.base + caminho, params=params, timeout=20)
        return self._resposta(r)

    def assinado(self, metodo, caminho, **params):
        params['timestamp'] = int(time.time() * 1000) + self.offset
        params['recvWindow'] = 10000
        q = urlencode(params)
        sig = hmac.new(self.secret.encode(), q.encode(), hashlib.sha256).hexdigest()
        r = self.s.request(metodo, f'{self.base}{caminho}?{q}&signature={sig}',
                           headers={'X-MBX-APIKEY': self.key}, timeout=20)
        return self._resposta(r)

    @staticmethod
    def _resposta(r):
        try:
            j = r.json()
        except ValueError:
            raise ErroBinance(r.status_code, r.text[:200])
        if isinstance(j, dict) and 'code' in j and j.get('code') not in (0, 200) and 'msg' in j:
            raise ErroBinance(j['code'], j['msg'])
        if r.status_code >= 400:
            raise ErroBinance(r.status_code, str(j)[:200])
        return j


# ------------------------------------------------------------------ indicadores
def ema(xs, n):
    a, out = 2 / (n + 1), []
    for i, x in enumerate(xs):
        out.append(x if i == 0 else a * x + (1 - a) * out[-1])
    return out


def atr(cs, n=14):
    out = []
    for i, k in enumerate(cs):
        tr = k['h'] - k['l'] if i == 0 else max(k['h'] - k['l'], abs(k['h'] - cs[i - 1]['c']),
                                                abs(k['l'] - cs[i - 1]['c']))
        out.append(tr if i == 0 else out[-1] + (tr - out[-1]) / n)
    return out


def candles(bruto):
    return [{'t': int(k[0]), 'o': float(k[1]), 'h': float(k[2]), 'l': float(k[3]),
             'c': float(k[4]), 'v': float(k[5]), 'fim': int(k[6])} for k in bruto]


def regime_btc(diarios, agora):
    f = [k for k in diarios if k['fim'] < agora]
    if len(f) < CONFIG['ema_btc']:
        return None
    e = ema([k['c'] for k in f], CONFIG['ema_btc'])
    return {'ok': f[-1]['c'] > e[-1], 'close': f[-1]['c'], 'ema': e[-1]}


def avaliar(cs, agora):
    """Último candle de 4h fechado: rompe a máxima de 20 com volume 2x e acima da EMA200."""
    f = [k for k in cs if k['fim'] < agora]
    n = len(f)
    if n < CONFIG['ema_tend'] + CONFIG['janela_max'] + 1:
        return None
    i = n - 1
    k = f[i]
    e = ema([x['c'] for x in f], CONFIG['ema_tend'])
    a = atr(f)
    mx = max(x['h'] for x in f[i - CONFIG['janela_max']:i])
    vol = sum(x['v'] for x in f[i - 19:i + 1]) / 20
    ok = k['c'] > mx and k['v'] > CONFIG['vol_mult'] * vol and k['c'] > e[i] and a[i] > 0
    return {'candle': k['t'], 'ok': ok, 'close': k['c'], 'atr': a[i], 'volume': k['v'],
            'vol_media': vol}


def arred_baixo(x, passo):
    casas = max(0, -int(math.floor(math.log10(passo)))) if passo < 1 else 0
    return round(math.floor(x / passo + 1e-9) * passo, casas)


def arred(x, passo):
    casas = max(0, -int(math.floor(math.log10(passo)))) if passo < 1 else 0
    return round(round(x / passo) * passo, casas)


# ------------------------------------------------------------------ robô
class Robo:
    def __init__(self, api, telegram, modo, arquivo_estado=None, agora=None):
        self.api, self.tg, self.modo = api, telegram, modo
        self.arq = arquivo_estado or os.path.join(PASTA, f'estado_{modo}.json')
        self.agora = agora or (lambda: int(time.time() * 1000))
        self.estado = self._ler()
        self.regras = {}

    # ---------------- estado
    def _ler(self):
        if os.path.exists(self.arq):
            with open(self.arq, encoding='utf-8') as f:
                return json.load(f)
        return {'posicoes': {}, 'historico': [], 'ultimo_candle': 0, 'regime': None,
                'pico': None, 'pausado': False, 'ultimo_resumo': ''}

    def salvar(self):
        tmp = self.arq + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(self.estado, f, indent=1)
        os.replace(tmp, self.arq)

    def msg(self, texto):
        prefixo = '🤖 BINANCE ' + ('REAL' if self.modo == 'real' else 'TESTNET')
        self.tg(prefixo + '\n' + texto)

    # ---------------- regras da corretora
    def carregar_regras(self):
        info = self.api.publico('/fapi/v1/exchangeInfo')
        existentes = {}
        for s in info['symbols']:
            if s.get('contractType') != 'PERPETUAL' or s.get('quoteAsset') != 'USDT' \
                    or s.get('status') != 'TRADING':
                continue
            flt = {f['filterType']: f for f in s['filters']}
            existentes[s['symbol']] = {
                'passo': float(flt['MARKET_LOT_SIZE']['stepSize'] if 'MARKET_LOT_SIZE' in flt
                               else flt['LOT_SIZE']['stepSize']),
                'qtd_min': float(flt['LOT_SIZE']['minQty']),
                'tick': float(flt['PRICE_FILTER']['tickSize']),
                'nocional_min': float(flt.get('MIN_NOTIONAL', {}).get('notional', 5)),
            }
        self.regras = {}
        for m in CONFIG['moedas']:
            for par in (m + 'USDT', '1000' + m + 'USDT'):  # SHIB e PEPE são 1000SHIB, 1000PEPE
                if par in existentes:
                    self.regras[par] = existentes[par]
                    break
        return self.regras

    def conta(self):
        c = self.api.assinado('GET', '/fapi/v2/account')
        return float(c['totalWalletBalance']), float(c['availableBalance'])

    def posicoes_corretora(self):
        return {p['symbol']: p for p in self.api.assinado('GET', '/fapi/v2/positionRisk')
                if float(p['positionAmt']) != 0}

    # ---------------- ciclo
    def ciclo(self):
        agora = self.agora()
        self.acompanhar(agora)
        fechado = (agora // CONFIG['tf_ms']) * CONFIG['tf_ms'] - CONFIG['tf_ms']
        if self.estado['ultimo_candle'] < fechado:
            self.varrer(agora, fechado)
            self.estado['ultimo_candle'] = fechado
        self.resumo_se_hora(agora)
        self.salvar()

    def klines(self, par, tf, limite):
        return candles(self.api.publico('/fapi/v1/klines', symbol=par, interval=tf, limit=limite))

    def varrer(self, agora, fechado):
        reg = regime_btc(self.klines('BTCUSDT', '1d', 400), agora)
        if reg is None:
            raise RuntimeError('histórico diário do BTC insuficiente')
        if self.estado['regime'] is not None and self.estado['regime'] != reg['ok']:
            self.msg(('🟢 FILTRO LIGADO: BTC acima da EMA200 diária. Procurando compras.'
                      if reg['ok'] else
                      '🔴 FILTRO DESLIGADO: BTC abaixo da EMA200 diária. Sem novas compras.') +
                     f"\nBTC {reg['close']:.0f} | EMA200 {reg['ema']:.0f}")
        self.estado['regime'] = reg['ok']
        if not reg['ok'] or agora - (fechado + CONFIG['tf_ms']) > CONFIG['atraso_max_ms']:
            return
        if self.estado.get('pausado'):
            return
        if not self.regras:
            self.carregar_regras()
        for par in self.regras:
            try:
                cs = self.klines(par, CONFIG['tf'], CONFIG['candles'])
                s = avaliar(cs, agora)
                if s and s['candle'] == fechado and s['ok']:
                    motivo = self.abrir(par, s)
                    if motivo:
                        print(f'{par}: sinal ignorado ({motivo})')
            except Exception as e:  # uma moeda com problema não para as outras
                print(f'{par}: erro na varredura: {e}')

    # ---------------- entrada
    def abrir(self, par, s):
        if par in self.estado['posicoes']:
            return 'já posicionado'
        if len(self.estado['posicoes']) >= CONFIG['max_posicoes']:
            return 'limite de posições'
        r = self.regras[par]
        banca, livre = self.conta()
        risco_usd = banca * CONFIG['risco']
        dist = CONFIG['stop_atr'] * s['atr']
        preco_ref = s['close']
        qtd = arred_baixo(risco_usd / dist, r['passo'])
        if qtd < r['qtd_min'] or qtd * preco_ref < r['nocional_min']:
            return f"abaixo do mínimo da corretora ({qtd * preco_ref:.2f} < {r['nocional_min']})"
        margem = qtd * preco_ref / CONFIG['alavancagem']
        if margem * 1.1 > livre:
            return 'sem margem livre'
        try:
            self.api.assinado('POST', '/fapi/v1/marginType', symbol=par, marginType='ISOLATED')
        except ErroBinance as e:
            if e.code != -4046:  # -4046 = já está isolada
                raise
        self.api.assinado('POST', '/fapi/v1/leverage', symbol=par, leverage=CONFIG['alavancagem'])
        ordem = self.api.assinado('POST', '/fapi/v1/order', symbol=par, side='BUY',
                                  type='MARKET', quantity=qtd, newOrderRespType='RESULT')
        entrada = float(ordem.get('avgPrice') or preco_ref)
        qtd_exec = float(ordem.get('executedQty') or qtd)
        stop = arred(entrada - dist, r['tick'])
        alvo = arred(entrada + CONFIG['rr'] * dist, r['tick'])
        pos = {'entrada': entrada, 'qtd': qtd_exec, 'stop': stop, 'alvo': alvo,
               'abertura': self.agora(), 'risco_usd': risco_usd, 'ordens': {}}
        self.estado['posicoes'][par] = pos
        self.salvar()
        try:
            pos['ordens']['stop'] = self.protecao(par, 'STOP_MARKET', stop)
            pos['ordens']['alvo'] = self.protecao(par, 'TAKE_PROFIT_MARKET', alvo)
        except Exception as e:
            # sem proteção na corretora não fica posição aberta: fecha na hora
            self.fechar_mercado(par, qtd_exec)
            self.cancelar_tudo(par)
            del self.estado['posicoes'][par]
            self.salvar()
            self.msg(f'⚠️ {par}: não consegui registrar stop/alvo na Binance ({e}). '
                     'Posição fechada na hora por segurança.')
            return 'falha ao registrar proteção'
        self.salvar()
        self.msg(f'🚀 COMPRA EXECUTADA {par}\n'
                 f'Entrada: {entrada:g} | quantidade {qtd_exec:g} (≈ US$ {qtd_exec * entrada:.2f})\n'
                 f'Stop na Binance: {stop:g} ({(stop / entrada - 1) * 100:+.1f}%)\n'
                 f'Alvo na Binance: {alvo:g} ({(alvo / entrada - 1) * 100:+.1f}%)\n'
                 f'Risco: US$ {risco_usd:.2f} ({CONFIG["risco"] * 100:.0f}% da banca) | '
                 f'{CONFIG["alavancagem"]}x isolada | volume {s["volume"] / s["vol_media"]:.1f}x\n'
                 f'Posições: {len(self.estado["posicoes"])}/{CONFIG["max_posicoes"]}')
        return ''

    def protecao(self, par, tipo, preco):
        """Registra stop ou alvo na Binance. Tenta a ordem comum e, se a Binance exigir,
        a API de ordens condicionais (Algo)."""
        try:
            o = self.api.assinado('POST', '/fapi/v1/order', symbol=par, side='SELL', type=tipo,
                                  stopPrice=preco, closePosition='true', workingType='MARK_PRICE')
            return {'api': 'order', 'id': o['orderId']}
        except ErroBinance as e:
            if e.code not in (-4120, -1116, -4046):
                raise
        o = self.api.assinado('POST', '/fapi/v1/algoOrder', algoType='CONDITIONAL', symbol=par,
                              side='SELL', type=tipo, triggerPrice=preco, closePosition='true',
                              workingType='MARK_PRICE')
        return {'api': 'algo', 'id': o['algoId']}

    def fechar_mercado(self, par, qtd):
        return self.api.assinado('POST', '/fapi/v1/order', symbol=par, side='SELL', type='MARKET',
                                 quantity=qtd, reduceOnly='true', newOrderRespType='RESULT')

    def cancelar_tudo(self, par):
        for metodo, caminho in (('DELETE', '/fapi/v1/allOpenOrders'),
                                ('DELETE', '/fapi/v1/algoOpenOrders')):
            try:
                self.api.assinado(metodo, caminho, symbol=par)
            except ErroBinance:
                pass

    # ---------------- acompanhamento
    def acompanhar(self, agora):
        if not self.estado['posicoes']:
            return
        abertas = self.posicoes_corretora()
        for par in list(self.estado['posicoes']):
            pos = self.estado['posicoes'][par]
            if par not in abertas:
                self.registrar_fechamento(par, pos)
            elif agora - pos['abertura'] >= CONFIG['max_candles'] * CONFIG['tf_ms']:
                qtd = abs(float(abertas[par]['positionAmt']))
                self.cancelar_tudo(par)
                self.fechar_mercado(par, qtd)
                self.registrar_fechamento(par, pos, tipo='PRAZO')

    def registrar_fechamento(self, par, pos, tipo=None):
        self.cancelar_tudo(par)  # cancela a proteção que sobrou (stop ou alvo)
        trades = self.api.assinado('GET', '/fapi/v1/userTrades', symbol=par,
                                   startTime=int(pos['abertura']) - 60000)
        lucro = sum(float(t.get('realizedPnl', 0)) for t in trades) - \
            sum(float(t.get('commission', 0)) for t in trades)
        vendas = [t for t in trades if t.get('side') == 'SELL']
        saida = float(vendas[-1]['price']) if vendas else pos['entrada']
        if tipo is None:
            tipo = 'ALVO' if saida >= pos['alvo'] * 0.997 else \
                'STOP' if saida <= pos['stop'] * 1.003 else 'MANUAL'
        R = lucro / pos['risco_usd'] if pos['risco_usd'] else 0
        self.estado['historico'].append({'par': par, 'ab': pos['abertura'], 'fe': self.agora(),
                                         'tipo': tipo, 'entrada': pos['entrada'], 'saida': saida,
                                         'lucro': round(lucro, 4), 'R': round(R, 3)})
        del self.estado['posicoes'][par]
        banca, _ = self.conta()
        pico = max(self.estado.get('pico') or banca, banca)
        self.estado['pico'] = pico
        if banca < pico * (1 - CONFIG['pausa_queda']) and not self.estado.get('pausado'):
            self.estado['pausado'] = True
            self.msg(f'⛔ PAUSA: banca caiu {100 * (1 - banca / pico):.0f}% do pico. '
                     'Novas entradas suspensas. Para retomar: python robo.py --retomar')
        h = self.estado['historico']
        ganhos = sum(1 for x in h if x['lucro'] > 0)
        icone = {'ALVO': '✅', 'STOP': '❌', 'PRAZO': '⏱'}.get(tipo, 'ℹ️')
        self.msg(f'{icone} {tipo} {par}\nEntrada {pos["entrada"]:g} → saída {saida:g} '
                 f'({(saida / pos["entrada"] - 1) * 100:+.1f}%)\n'
                 f'Resultado real: US$ {lucro:+.2f} ({R:+.2f}R, já com taxas)\n'
                 f'Banca: US$ {banca:.2f}\nPlacar: {ganhos} ganhos / {len(h) - ganhos} perdas')
        self.salvar()

    # ---------------- relatórios
    def resumo_se_hora(self, agora):
        d = datetime.fromtimestamp(agora / 1000, BRT)
        chave = d.strftime('%Y-%m-%d')
        if d.hour == CONFIG['hora_resumo'] and self.estado.get('ultimo_resumo') != chave:
            self.estado['ultimo_resumo'] = chave
            self.msg(self.texto_resumo(agora))

    def texto_resumo(self, agora):
        banca, livre = self.conta()
        h = self.estado['historico']
        n = len(h)
        ganhos = sum(1 for x in h if x['lucro'] > 0)
        lucro = sum(x['lucro'] for x in h)
        media = sum(x['R'] for x in h) / n if n else 0
        linhas = []
        abertas = self.posicoes_corretora() if self.estado['posicoes'] else {}
        for par, p in self.estado['posicoes'].items():
            pr = abertas.get(par, {})
            linhas.append(f"• {par}: entrada {p['entrada']:g} → {float(pr.get('markPrice', 0)):g} | "
                          f"US$ {float(pr.get('unRealizedProfit', 0)):+.2f} | stop {p['stop']:g} | "
                          f"alvo {p['alvo']:g}")
        return (f'📊 RESUMO {datetime.fromtimestamp(agora / 1000, BRT):%d/%m/%Y}\n'
                f'Banca: US$ {banca:.2f} | livre US$ {livre:.2f}\n'
                f'Operações fechadas: {n}' + (f' | acerto {100 * ganhos / n:.0f}% | média {media:+.2f}R'
                                              if n else '') +
                f'\nResultado realizado: US$ {lucro:+.2f}\n'
                f"Filtro BTC: {'ligado 🟢' if self.estado['regime'] else 'em espera 🔴'}"
                + (' | ⛔ PAUSADO' if self.estado.get('pausado') else '') +
                f"\nAbertas ({len(self.estado['posicoes'])}/{CONFIG['max_posicoes']}):\n" +
                ('\n'.join(linhas) if linhas else 'nenhuma'))

    # ---------------- início
    def conferir_inicio(self):
        """Confere modo de posição e posições que o robô não conhece."""
        dual = self.api.assinado('GET', '/fapi/v1/positionSide/dual')
        if dual.get('dualSidePosition'):
            raise RuntimeError('A conta está em modo Hedge. Mude para "One-way" nas preferências '
                               'de Futuros da Binance antes de rodar o robô.')
        estranhas = [p for p in self.posicoes_corretora() if p not in self.estado['posicoes']]
        if estranhas:
            self.msg('ℹ️ Posições abertas que o robô não abriu (não vou mexer nelas): ' +
                     ', '.join(estranhas))


# ------------------------------------------------------------------ execução
def telegram_envio(token, chat):
    def enviar(texto):
        if not token or not chat:
            print(texto)
            return
        for _ in range(2):
            try:
                r = requests.post(f'https://api.telegram.org/bot{token}/sendMessage',
                                  data={'chat_id': chat, 'text': texto}, timeout=20)
                if r.status_code == 200:
                    return
            except requests.RequestException:
                pass
            time.sleep(2)
        print('Falha no Telegram:', texto)
    return enviar


def montar():
    carregar_env()
    modo = os.environ.get('ROBO_MODO', 'testnet').lower()
    if modo not in URLS:
        sys.exit('ROBO_MODO deve ser testnet ou real')
    if modo == 'real' and os.environ.get('ROBO_CONFIRMO_REAL') != 'SIM':
        sys.exit('Modo REAL exige ROBO_CONFIRMO_REAL=SIM no .env (proteção contra engano).')
    key, sec = os.environ.get('BINANCE_API_KEY', ''), os.environ.get('BINANCE_API_SECRET', '')
    if not key or not sec:
        sys.exit('Faltam BINANCE_API_KEY e BINANCE_API_SECRET no .env')
    api = Binance(URLS[modo], key, sec)
    tg = telegram_envio(os.environ.get('TELEGRAM_TOKEN'), os.environ.get('TELEGRAM_CHAT_ID'))
    return Robo(api, tg, modo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--teste', action='store_true', help='só confere conexões e saldo')
    ap.add_argument('--retomar', action='store_true', help='retira a pausa por queda da banca')
    a = ap.parse_args()
    robo = montar()
    robo.api.sincronizar_relogio()
    if a.retomar:
        robo.estado['pausado'] = False
        robo.estado['pico'] = None
        robo.salvar()
        print('Pausa retirada.')
        return
    regras = robo.carregar_regras()
    banca, livre = robo.conta()
    robo.conferir_inicio()
    info = (f'Conexão OK ({robo.modo}). Banca US$ {banca:.2f}, livre US$ {livre:.2f}. '
            f'{len(regras)} de {len(CONFIG["moedas"])} moedas disponíveis em futuros.')
    print(info)
    if a.teste:
        robo.msg('✅ ' + info + '\nTeste concluído; nenhuma ordem enviada.')
        return
    robo.msg('▶️ ROBÔ INICIADO\n' + info + f'\nRisco {CONFIG["risco"] * 100:.0f}% por operação, '
             f'máx. {CONFIG["max_posicoes"]} posições, {CONFIG["alavancagem"]}x isolada.')
    erros = 0
    while True:
        try:
            robo.ciclo()
            erros = 0
        except Exception as e:
            erros += 1
            traceback.print_exc()
            if erros == 3:
                robo.msg(f'⚠️ Erro 3x seguidas: {str(e)[:300]}')
            if erros % 20 == 0:
                try:
                    robo.api.sincronizar_relogio()
                except Exception:
                    pass
        time.sleep(CONFIG['intervalo_s'])


if __name__ == '__main__':
    main()
