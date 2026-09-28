/**
 * SCANNER CRIPTO V1.1 — Google Apps Script, arquivo único.
 * Estratégia validada no backtest (backtest/): rompimento com volume em 4h,
 * só compra, com filtro do BTC acima da EMA200 diária.
 *
 * MODO SIMULADO: manda os sinais no Telegram e acompanha o resultado com
 * uma banca simulada. NÃO envia ordens para a corretora.
 *
 * Projeto separado do Scanner Ouro: nomes de funções, propriedades e
 * acionadores têm prefixo "cripto" e não mexem nos do Ouro.
 *
 * Credenciais em Configurações do projeto > Propriedades do script:
 *   CRIPTO_TELEGRAM_TOKEN    token do bot do Telegram
 *   CRIPTO_TELEGRAM_CHAT_ID  chat que recebe os alertas
 *   CRIPTO_BANCA             (opcional) banca inicial em dólares, padrão 50
 */
function criptoCred(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
const CRIPTO = {
  get TELEGRAM_TOKEN() { return criptoCred('CRIPTO_TELEGRAM_TOKEN'); },
  get TELEGRAM_CHAT_ID() { return criptoCred('CRIPTO_TELEGRAM_CHAT_ID'); },
  get BANCA_INICIAL() { return Number(criptoCred('CRIPTO_BANCA')) || 50; },
  MODELO: 'SCANNER-CRIPTO-V1.1',
  MOEDAS: ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
    'LTC', 'TRX', 'NEAR', 'SUI', 'APT', 'ATOM', 'UNI', 'AAVE', 'FIL', 'INJ',
    'OP', 'ARB', 'SHIB', 'PEPE', 'WIF', 'TIA', 'SEI', 'RUNE', 'FET', 'STX',
    'IMX', 'HBAR', 'ETC', 'BCH', 'XLM', 'ALGO', 'SAND', 'GALA', 'LDO', 'CRV'],
  // Regras da estratégia (iguais ao backtest; não mude sem testar de novo)
  TF: '4h', TF_MS: 4 * 3600 * 1000, CANDLES: 1000,
  JANELA_MAX: 20, VOL_MULT: 2, EMA_TEND: 200, EMA_BTC: 200,
  STOP_ATR: 1.5, RR: 2, MAX_CANDLES: 48,
  // Gestão para banca pequena
  RISCO: 0.01, MAX_POSICOES: 6, ORDEM_MIN: 5, ALAVANCAGEM: 2,
  CUSTO_IDA_VOLTA: 0.0012,
  LOTE: 20, ERRO_ALERTA: 3, HORA_RESUMO: 21, ATRASO_MAX_MS: 3600 * 1000,
  // Histórico em blocos: cada propriedade aceita no máximo 9 KB.
  HIST_BLOCO: 8000,
  // Referência do backtest (4h, volume 2x, alvo 2R, futuros, 40 moedas)
  REF_ACERTO: 0.42, REF_MEDIA_R: 0.22, AMOSTRA_MIN: 30,
  GATILHOS: ['rodarScannerCripto', 'resumoDiarioCripto']
};

// ------------------------------------------------------------ estado
function criptoProps() { return PropertiesService.getScriptProperties(); }
function criptoGet(k, padrao) {
  const v = criptoProps().getProperty(k);
  if (v === null || v === undefined) return padrao;
  try { return JSON.parse(v); } catch (e) { return padrao; }
}
function criptoSet(k, v) { criptoProps().setProperty(k, JSON.stringify(v)); }
function criptoEstado() {
  const st = criptoGet('CRIPTO_ESTADO', null) || {
    banca: CRIPTO.BANCA_INICIAL, abertas: [], ultimoCandle: 0, regime: null, erros: 0,
    inicio: Date.now()
  };
  const s = st.stats = Object.assign({n: 0, ganhos: 0, somaR: 0, lucro: 0, pico: st.banca,
    ddMax: 0, seqPerda: 0, maxSeqPerda: 0, sinais: 0, ignorados: 0}, st.stats || {});
  if (!s.pico) s.pico = st.banca;
  if (Array.isArray(st.fechadas)) {  // versão 1.0 guardava as últimas operações no estado
    st.fechadas.forEach(f => criptoHistAdd({par: f.par, ab: f.abertura || f.fim,
      fe: f.fechamento || f.fim, tipo: f.tipo, R: f.R, lucro: f.lucro}));
    delete st.fechadas;
    criptoSalvar(st);
  }
  return st;
}
function criptoSalvar(st) { criptoSet('CRIPTO_ESTADO', st); }

// ------------------------------------------------------------ histórico completo
// Cada operação: [par, abertura, fechamento, tipo, R, lucro, entrada, saída, valor]
function criptoHistAdd(o) {
  const n = criptoGet('CRIPTO_HIST_N', 0);
  const k = Math.max(n - 1, 0);
  const bloco = n ? criptoGet('CRIPTO_HIST_' + k, []) : [];
  const linha = [o.par.replace(/USDT$/, ''), o.ab, o.fe, String(o.tipo || '?')[0],
    Number((o.R || 0).toFixed(3)), Number((o.lucro || 0).toFixed(4)),
    o.ent || 0, o.sai || 0, Number((o.valor || 0).toFixed(2))];
  bloco.push(linha);
  if (JSON.stringify(bloco).length > CRIPTO.HIST_BLOCO && bloco.length > 1) {
    criptoSet('CRIPTO_HIST_' + k, bloco.slice(0, -1));
    criptoSet('CRIPTO_HIST_' + (k + 1), [linha]);
    criptoSet('CRIPTO_HIST_N', k + 2);
  } else {
    criptoSet('CRIPTO_HIST_' + k, bloco);
    criptoSet('CRIPTO_HIST_N', k + 1);
  }
}
function criptoHist() {
  const n = criptoGet('CRIPTO_HIST_N', 0);
  const tipos = {A: 'ALVO', S: 'STOP', P: 'PRAZO'};
  let out = [];
  for (let k = 0; k < n; k++) {
    out = out.concat(criptoGet('CRIPTO_HIST_' + k, []).map(x => ({
      par: x[0], ab: x[1], fe: x[2], tipo: tipos[x[3]] || x[3], R: x[4], lucro: x[5],
      ent: x[6], sai: x[7], valor: x[8]})));
  }
  return out;
}

// ------------------------------------------------------------ utilidades
function criptoPreco(x) {
  if (!Number.isFinite(x)) return 'ND';
  return x >= 1 ? x.toFixed(x >= 100 ? 2 : 4) : Number(x.toPrecision(5)).toString();
}
function criptoUsd(x) { return (x < 0 ? '-' : '') + 'US$ ' + Math.abs(x).toFixed(2); }
function criptoPct(x) { return (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%'; }
function criptoData(ms) {
  return Utilities.formatDate(new Date(ms), 'America/Sao_Paulo', 'dd/MM HH:mm');
}

function criptoTelegram(msg) {
  if (!CRIPTO.TELEGRAM_TOKEN || !CRIPTO.TELEGRAM_CHAT_ID) {
    console.log('Telegram não configurado: ' + msg);
    return false;
  }
  for (let t = 0; t < 2; t++) {
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + CRIPTO.TELEGRAM_TOKEN +
      '/sendMessage', {
      method: 'post', muteHttpExceptions: true,
      payload: {chat_id: CRIPTO.TELEGRAM_CHAT_ID, text: '₿ ' + msg,
        disable_web_page_preview: 'true'}
    });
    if (res.getResponseCode() === 200) return true;
    Utilities.sleep(1500);
  }
  return false;
}

// ------------------------------------------------------------ dados de preço (públicos)
// Os servidores do Google ficam nos EUA e a Binance pode recusar a conexão.
// Por isso há fontes reserva: MEXC (mesmo formato da Binance) e KuCoin.
// A estratégia usa preço e volume relativos da própria moeda; o preço é o
// mesmo em todas as corretoras grandes por causa da arbitragem.
const CRIPTO_FONTES = [
  {nome: 'binance-vision', tipo: 'binance', host: 'https://data-api.binance.vision'},
  {nome: 'binance', tipo: 'binance', host: 'https://api.binance.com'},
  {nome: 'binance-api1', tipo: 'binance', host: 'https://api1.binance.com'},
  {nome: 'binance-api2', tipo: 'binance', host: 'https://api2.binance.com'},
  {nome: 'mexc', tipo: 'binance', host: 'https://api.mexc.com'},
  {nome: 'kucoin', tipo: 'kucoin', host: 'https://api.kucoin.com'}
];
const CRIPTO_KUCOIN_TF = {'15m': '15min', '4h': '4hour', '1d': '1day'};
const CRIPTO_TF_MS = {'15m': 900000, '4h': 4 * 3600000, '1d': 86400000};

function criptoPedido(par, tf, limite, inicio) {
  return {par: par, tf: tf, limite: limite, inicio: inicio || 0};
}

function criptoUrl(f, p) {
  if (f.tipo === 'binance') {
    return f.host + '/api/v3/klines?symbol=' + p.par + '&interval=' + p.tf + '&limit=' +
      p.limite + (p.inicio ? '&startTime=' + p.inicio : '');
  }
  const fim = Math.floor(Date.now() / 1000);
  const ini = p.inicio ? Math.floor(p.inicio / 1000) :
    fim - Math.floor(p.limite * CRIPTO_TF_MS[p.tf] / 1000);
  return f.host + '/api/v1/market/candles?type=' + CRIPTO_KUCOIN_TF[p.tf] + '&symbol=' +
    p.par.replace(/USDT$/, '-USDT') + '&startAt=' + ini + '&endAt=' + fim;
}

/** Converte a resposta para o formato da Binance: [abre, o, h, l, c, v, fecha]. */
function criptoLer(f, p, texto) {
  let j;
  try { j = JSON.parse(texto); } catch (e) { return null; }
  if (f.tipo === 'binance') return Array.isArray(j) && j.length ? j : null;
  if (!j || j.code !== '200000' || !Array.isArray(j.data) || !j.data.length) return null;
  const dur = CRIPTO_TF_MS[p.tf];
  return j.data.map(k => [Number(k[0]) * 1000, k[1], k[3], k[4], k[2], k[5],
    Number(k[0]) * 1000 + dur - 1]).sort((a, b) => a[0] - b[0]);
}

function criptoFontes() {
  const boa = criptoGet('CRIPTO_FONTE', null);
  const i = CRIPTO_FONTES.findIndex(f => f.nome === boa);
  return i < 0 ? CRIPTO_FONTES.slice() :
    [CRIPTO_FONTES[i]].concat(CRIPTO_FONTES.filter((_, k) => k !== i));
}

/** Busca vários pedidos em paralelo; o que falhar tenta a próxima fonte. */
function criptoApiVarios(pedidos) {
  const saida = new Array(pedidos.length).fill(null);
  let faltam = pedidos.map((_, i) => i);
  for (const f of criptoFontes()) {
    if (!faltam.length) break;
    let resps;
    try {
      resps = UrlFetchApp.fetchAll(faltam.map(i => ({url: criptoUrl(f, pedidos[i]),
        muteHttpExceptions: true})));
    } catch (e) { continue; }
    const aindaFaltam = [];
    let algumOk = false;
    resps.forEach((r, k) => {
      const i = faltam[k];
      const dados = r.getResponseCode() === 200 ? criptoLer(f, pedidos[i], r.getContentText()) : null;
      if (dados) { saida[i] = dados; algumOk = true; } else aindaFaltam.push(i);
    });
    if (algumOk) criptoSet('CRIPTO_FONTE', f.nome);
    faltam = aindaFaltam;
  }
  return saida;
}

function criptoCandles(bruto) {
  return (bruto || []).map(k => ({
    t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]),
    c: Number(k[4]), v: Number(k[5]), fim: Number(k[6])
  }));
}

// ------------------------------------------------------------ indicadores
function criptoEma(xs, n) {
  const a = 2 / (n + 1);
  const out = new Array(xs.length);
  xs.forEach((x, i) => { out[i] = i === 0 ? x : a * x + (1 - a) * out[i - 1]; });
  return out;
}
function criptoAtr(cs, n) {
  const out = new Array(cs.length);
  cs.forEach((k, i) => {
    const tr = i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - cs[i - 1].c),
      Math.abs(k.l - cs[i - 1].c));
    out[i] = i === 0 ? tr : out[i - 1] + (tr - out[i - 1]) / n;
  });
  return out;
}

/** BTC fechou o último dia completo acima da EMA200 diária? */
function criptoRegime(diarios, agora) {
  const fechados = diarios.filter(k => k.fim < agora);
  if (fechados.length < CRIPTO.EMA_BTC) return null;
  const ema = criptoEma(fechados.map(k => k.c), CRIPTO.EMA_BTC);
  const u = fechados.length - 1;
  return {ok: fechados[u].c > ema[u], close: fechados[u].c, ema: ema[u]};
}

/** Avalia o último candle de 4h fechado. Retorna o sinal ou null. */
function criptoAvaliar(cs, agora) {
  const fechados = cs.filter(k => k.fim < agora);
  const n = fechados.length;
  if (n < CRIPTO.EMA_TEND + CRIPTO.JANELA_MAX + 1) return null;
  const i = n - 1;
  const k = fechados[i];
  const ema = criptoEma(fechados.map(x => x.c), CRIPTO.EMA_TEND);
  const atr = criptoAtr(fechados, 14);
  let max = -Infinity;
  for (let j = i - CRIPTO.JANELA_MAX; j < i; j++) max = Math.max(max, fechados[j].h);
  let vol = 0;
  for (let j = i - 19; j <= i; j++) vol += fechados[j].v;
  vol /= 20;
  const ok = k.c > max && k.v > CRIPTO.VOL_MULT * vol && k.c > ema[i] && atr[i] > 0;
  return {candle: k.t, ok: ok, close: k.c, maxima: max, volume: k.v, volMedia: vol,
    ema: ema[i], atr: atr[i]};
}

// ------------------------------------------------------------ varredura
function rodarScannerCripto() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  const st = criptoEstado();
  try {
    const agora = Date.now();
    criptoConferir(st, agora);
    const candleAtual = Math.floor(agora / CRIPTO.TF_MS) * CRIPTO.TF_MS;
    const ultimoFechado = candleAtual - CRIPTO.TF_MS;
    if (st.ultimoCandle < ultimoFechado) {
      criptoVarrer(st, agora, ultimoFechado);
      st.ultimoCandle = ultimoFechado;
    }
    st.erros = 0;
  } catch (e) {
    st.erros = (st.erros || 0) + 1;
    console.log('Erro: ' + (e && e.stack || e));
    if (st.erros === CRIPTO.ERRO_ALERTA) {
      criptoTelegram('⚠️ SCANNER CRIPTO com erro ' + st.erros + 'x seguidas: ' +
        String(e && e.message || e).slice(0, 300));
    }
  } finally {
    criptoSalvar(st);
    lock.releaseLock();
  }
}

function criptoVarrer(st, agora, ultimoFechado) {
  const pares = CRIPTO.MOEDAS.map(m => m + 'USDT');
  const caminhos = [criptoPedido('BTCUSDT', '1d', 400)]
    .concat(pares.map(p => criptoPedido(p, CRIPTO.TF, CRIPTO.CANDLES)));
  let dados = [];
  for (let i = 0; i < caminhos.length; i += CRIPTO.LOTE) {
    dados = dados.concat(criptoApiVarios(caminhos.slice(i, i + CRIPTO.LOTE)));
  }
  if (!Array.isArray(dados[0])) throw new Error('sem candles diários do BTC');
  const regime = criptoRegime(criptoCandles(dados[0]), agora);
  if (!regime) throw new Error('histórico diário do BTC insuficiente');
  if (st.regime !== null && st.regime !== regime.ok) {
    criptoTelegram(regime.ok
      ? '🟢 FILTRO LIGADO: BTC fechou acima da EMA200 diária (' + criptoPreco(regime.close) +
        ' > ' + criptoPreco(regime.ema) + '). Robô volta a procurar compras.'
      : '🔴 FILTRO DESLIGADO: BTC fechou abaixo da EMA200 diária (' + criptoPreco(regime.close) +
        ' < ' + criptoPreco(regime.ema) + '). Robô em espera, sem novas compras.');
  }
  st.regime = regime.ok;
  const diag = {candle: ultimoFechado, regime: regime.ok, avaliadas: 0, sinais: [],
    ignorados: [], falhas: []};
  // Candle fechado há muito tempo (ex.: primeira execução): não entra atrasado.
  const atrasado = agora - (ultimoFechado + CRIPTO.TF_MS) > CRIPTO.ATRASO_MAX_MS;
  if (!regime.ok || atrasado) {
    diag.atrasado = atrasado;
    criptoSet('CRIPTO_DIAG', diag);
    return;
  }

  pares.forEach((par, k) => {
    const bruto = dados[k + 1];
    if (!Array.isArray(bruto)) { diag.falhas.push(par); return; }
    const cs = criptoCandles(bruto);
    const s = criptoAvaliar(cs, agora);
    if (!s || s.candle !== ultimoFechado) { diag.falhas.push(par); return; }
    diag.avaliadas++;
    if (!s.ok) return;
    const motivo = criptoAbrir(st, par, s, cs[cs.length - 1], agora);
    (motivo ? diag.ignorados : diag.sinais).push(par + (motivo ? ': ' + motivo : ''));
    if (motivo && motivo !== 'já posicionado') st.stats.ignorados++;
  });
  criptoSet('CRIPTO_DIAG', diag);
}

/** Registra a operação simulada. Retorna o motivo se não abrir. */
function criptoAbrir(st, par, s, candleEmCurso, agora) {
  if (st.abertas.some(p => p.par === par)) return 'já posicionado';
  if (st.abertas.length >= CRIPTO.MAX_POSICOES) return 'limite de posições';
  const entrada = candleEmCurso && candleEmCurso.t > s.candle ? candleEmCurso.c : s.close;
  const riscoPreco = CRIPTO.STOP_ATR * s.atr;
  const stop = entrada - riscoPreco;
  const alvo = entrada + CRIPTO.RR * riscoPreco;
  const riscoUsd = st.banca * CRIPTO.RISCO;
  const qtd = riscoUsd / riscoPreco;
  const valor = qtd * entrada;
  if (valor < CRIPTO.ORDEM_MIN) return 'ordem abaixo do mínimo (' + criptoUsd(valor) + ')';
  const margemUsada = st.abertas.reduce((a, p) => a + p.valor / CRIPTO.ALAVANCAGEM, 0);
  if (margemUsada + valor / CRIPTO.ALAVANCAGEM > st.banca) return 'sem margem livre';
  const pos = {par: par, entrada: entrada, stop: stop, alvo: alvo, qtd: qtd, valor: valor,
    riscoUsd: riscoUsd, abertura: agora, candle: s.candle};
  st.abertas.push(pos);
  st.stats.sinais++;
  criptoTelegram('🚀 SINAL DE COMPRA (SIMULADO)\n' + par + ' | rompimento 4h com volume\n' +
    '\nEntrada: ' + criptoPreco(entrada) +
    '\nStop: ' + criptoPreco(stop) + ' (' + criptoPct(stop / entrada - 1) + ')' +
    '\nAlvo: ' + criptoPreco(alvo) + ' (' + criptoPct(alvo / entrada - 1) + ')' +
    '\nPrazo máximo: 8 dias' +
    '\n\nTamanho: ' + criptoPreco(qtd) + ' ' + par.replace('USDT', '') + ' ≈ ' + criptoUsd(valor) +
    '\nMargem (' + CRIPTO.ALAVANCAGEM + 'x, isolada): ' + criptoUsd(valor / CRIPTO.ALAVANCAGEM) +
    '\nRisco: ' + criptoUsd(riscoUsd) + ' (' + (100 * CRIPTO.RISCO) + '% da banca)' +
    '\nVolume ' + (s.volume / s.volMedia).toFixed(1) + 'x a média' +
    '\nPosições abertas: ' + st.abertas.length + '/' + CRIPTO.MAX_POSICOES +
    '\n\nGráfico: https://www.tradingview.com/chart/?symbol=MEXC:' + par);
  return '';
}

// ------------------------------------------------------------ conferência
function criptoConferir(st, agora) {
  if (!st.abertas.length) return;
  const caminhos = st.abertas.map(p => criptoPedido(p.par, '15m', 1000, p.abertura));
  const dados = criptoApiVarios(caminhos);
  const ficam = [];
  st.abertas.forEach((p, k) => {
    const cs = criptoCandles(Array.isArray(dados[k]) ? dados[k] : []);
    const r = criptoDesfecho(p, cs, agora);
    if (r) criptoFechar(st, p, r, agora);
    else ficam.push(p);
  });
  st.abertas = ficam;
}

/** Stop antes do alvo no mesmo candle (conservador, igual ao backtest). */
function criptoDesfecho(p, cs, agora) {
  const inicio = Math.floor(p.abertura / 900000) * 900000 + 900000;
  const prazo = p.abertura + CRIPTO.MAX_CANDLES * CRIPTO.TF_MS;
  let ultimo = null;
  for (const k of cs) {
    if (k.t < inicio) continue;
    if (k.t >= prazo) break;
    if (k.l <= p.stop) return {tipo: 'STOP', preco: Math.min(k.o, p.stop), quando: k.t};
    if (k.h >= p.alvo) return {tipo: 'ALVO', preco: p.alvo, quando: k.t};
    ultimo = k;
  }
  if (agora >= prazo && ultimo) return {tipo: 'PRAZO', preco: ultimo.c, quando: prazo};
  return null;
}

function criptoFechar(st, p, r, agora) {
  const R = (r.preco - p.entrada) / (p.entrada - p.stop);
  const custo = CRIPTO.CUSTO_IDA_VOLTA * p.valor;
  const lucro = R * p.riscoUsd - custo;
  st.banca += lucro;
  criptoHistAdd({par: p.par, ab: p.abertura, fe: r.quando, tipo: r.tipo, R: R, lucro: lucro,
    ent: p.entrada, sai: r.preco, valor: p.valor});
  const s = st.stats;
  s.n++;
  if (lucro > 0) { s.ganhos++; s.seqPerda = 0; } else {
    s.seqPerda++;
    s.maxSeqPerda = Math.max(s.maxSeqPerda, s.seqPerda);
  }
  s.somaR += R;
  s.lucro += lucro;
  s.pico = Math.max(s.pico, st.banca);
  s.ddMax = Math.max(s.ddMax, 1 - st.banca / s.pico);
  const icone = {ALVO: '✅', STOP: '❌', PRAZO: '⏱'}[r.tipo];
  criptoTelegram(icone + ' ' + r.tipo + ' (SIMULADO) ' + p.par +
    '\nEntrada ' + criptoPreco(p.entrada) + ' → saída ' + criptoPreco(r.preco) +
    ' (' + criptoPct(r.preco / p.entrada - 1) + ')' +
    '\nResultado: ' + (R >= 0 ? '+' : '') + R.toFixed(2) + 'R = ' + criptoUsd(lucro) +
    ' (já com taxas)' +
    '\nBanca simulada: ' + criptoUsd(st.banca) + ' (' +
    criptoPct(st.banca / CRIPTO.BANCA_INICIAL - 1) + ' desde o início)' +
    '\nDuração: ' + criptoDuracao(r.quando - p.abertura) +
    ' | aberta ' + criptoData(p.abertura) + ', fechada ' + criptoData(r.quando) +
    '\nPlacar: ' + s.ganhos + ' ganhos / ' + (s.n - s.ganhos) + ' perdas (' +
    (100 * s.ganhos / s.n).toFixed(0) + '%)');
}

// ------------------------------------------------------------ relatórios
function criptoDuracao(ms) {
  const h = ms / 3600000;
  return h < 48 ? h.toFixed(0) + 'h' : (h / 24).toFixed(1) + ' dias';
}
function criptoDia(ms, fmt) {
  return Utilities.formatDate(new Date(ms), 'America/Sao_Paulo', fmt || 'yyyy-MM-dd');
}

/** Métricas profissionais de uma lista de operações fechadas. */
function criptoMetricas(lista) {
  const n = lista.length;
  const m = {n: n, ganhos: 0, lucro: 0, somaR: 0, bruto: 0, perdaBruta: 0, dur: 0,
    tipos: {ALVO: 0, STOP: 0, PRAZO: 0}, moedas: {}, melhor: null, pior: null, ddUsd: 0};
  let acum = 0, pico = 0;
  lista.slice().sort((x, y) => x.fe - y.fe).forEach(o => {
    if (o.lucro > 0) { m.ganhos++; m.bruto += o.lucro; } else m.perdaBruta -= o.lucro;
    m.lucro += o.lucro;
    m.somaR += o.R;
    m.dur += (o.fe - o.ab);
    m.tipos[o.tipo] = (m.tipos[o.tipo] || 0) + 1;
    const c = m.moedas[o.par] = m.moedas[o.par] || {n: 0, lucro: 0};
    c.n++;
    c.lucro += o.lucro;
    if (!m.melhor || o.R > m.melhor.R) m.melhor = o;
    if (!m.pior || o.R < m.pior.R) m.pior = o;
    acum += o.lucro;
    pico = Math.max(pico, acum);
    m.ddUsd = Math.max(m.ddUsd, pico - acum);
  });
  m.acerto = n ? m.ganhos / n : 0;
  m.mediaR = n ? m.somaR / n : 0;
  const varR = n > 1 ? lista.reduce((a, o) => a + (o.R - m.mediaR) * (o.R - m.mediaR), 0) / (n - 1) : 0;
  m.erroR = n > 1 ? Math.sqrt(varR / n) : 0;
  m.pf = m.perdaBruta > 0 ? m.bruto / m.perdaBruta : (m.bruto > 0 ? Infinity : 0);
  m.durMedia = n ? m.dur / n : 0;
  return m;
}

function criptoVeredito(m) {
  if (m.n < CRIPTO.AMOSTRA_MIN) {
    return '⏳ Amostra pequena (' + m.n + ' de ' + CRIPTO.AMOSTRA_MIN +
      ' operações). Ainda não dá para concluir; continue no simulado.';
  }
  const z = m.erroR > 0 ? (m.mediaR - CRIPTO.REF_MEDIA_R) / m.erroR : 0;
  if (m.mediaR > 0 && z > -2) return '✅ Dentro do esperado pelo backtest.';
  if (z < -2 && m.mediaR <= 0) {
    return '❌ Abaixo do backtest com significância estatística. Não passar para dinheiro real.';
  }
  return '⚠️ Inconclusivo: resultado abaixo da referência, mas dentro da margem de erro. Acompanhar.';
}

function criptoBlocoMetricas(m) {
  if (!m.n) return 'Nenhuma operação fechada no período.';
  const ord = Object.keys(m.moedas).map(k => [k, m.moedas[k]]).sort((a, b) => b[1].lucro - a[1].lucro);
  const fmtM = x => x[0] + ' ' + criptoUsd(x[1].lucro) + ' (' + x[1].n + ')';
  return 'Operações: ' + m.n + ' | acerto ' + (100 * m.acerto).toFixed(0) + '%' +
    '\nResultado: ' + criptoUsd(m.lucro) +
    '\nMédia por operação: ' + (m.mediaR >= 0 ? '+' : '') + m.mediaR.toFixed(2) + 'R' +
    (m.n > 1 ? ' (± ' + m.erroR.toFixed(2) + ')' : '') +
    '\nProfit factor: ' + (Number.isFinite(m.pf) ? m.pf.toFixed(2) : '∞') +
    '\nMelhor: ' + m.melhor.par + ' ' + (m.melhor.R >= 0 ? '+' : '') + m.melhor.R.toFixed(2) + 'R' +
    ' | pior: ' + m.pior.par + ' ' + m.pior.R.toFixed(2) + 'R' +
    '\nSaídas: ✅ alvo ' + (m.tipos.ALVO || 0) + ' | ❌ stop ' + (m.tipos.STOP || 0) +
    ' | ⏱ prazo ' + (m.tipos.PRAZO || 0) +
    '\nDuração média: ' + criptoDuracao(m.durMedia) +
    '\nQueda máxima: ' + criptoUsd(m.ddUsd) +
    '\nMelhores moedas: ' + ord.slice(0, 3).map(fmtM).join(', ') +
    (ord.length > 3 ? '\nPiores moedas: ' +
      ord.slice(Math.max(3, ord.length - 3)).reverse().map(fmtM).join(', ') : '');
}

/** Preço atual das posições abertas (último candle de 15 min). */
function criptoPrecosAtuais(st) {
  if (!st.abertas.length) return [];
  const d = criptoApiVarios(st.abertas.map(p => criptoPedido(p.par, '15m', 2)));
  return d.map(x => (Array.isArray(x) && x.length ? Number(x[x.length - 1][4]) : NaN));
}

function criptoBlocoAbertas(st) {
  if (!st.abertas.length) return 'Posições abertas: nenhuma';
  const precos = criptoPrecosAtuais(st);
  let total = 0, exp = 0;
  const linhas = st.abertas.map((p, i) => {
    const px = precos[i];
    const R = (px - p.entrada) / (p.entrada - p.stop);
    const usd = Number.isFinite(R) ? R * p.riscoUsd : 0;
    total += usd;
    exp += p.valor;
    const atual = Number.isFinite(R) ? criptoPreco(px) + ' (' + criptoPct(px / p.entrada - 1) +
      ') ' + (R >= 0 ? '+' : '') + R.toFixed(2) + 'R ' + criptoUsd(usd) : 'preço indisponível';
    return '• ' + p.par + ': ' + criptoPreco(p.entrada) + ' → ' + atual +
      '\n   stop ' + criptoPreco(p.stop) + ' | alvo ' + criptoPreco(p.alvo) +
      ' | há ' + criptoDuracao(Date.now() - p.abertura);
  });
  return 'Posições abertas (' + st.abertas.length + '/' + CRIPTO.MAX_POSICOES + '):\n' +
    linhas.join('\n') + '\nNão realizado: ' + criptoUsd(total) + ' | exposição ' + criptoUsd(exp) +
    ' | margem ' + criptoUsd(exp / CRIPTO.ALAVANCAGEM);
}

function criptoCabecalho(st) {
  return 'Banca: ' + criptoUsd(st.banca) + ' (início ' + criptoUsd(CRIPTO.BANCA_INICIAL) + ', ' +
    criptoPct(st.banca / CRIPTO.BANCA_INICIAL - 1) + ')' +
    '\nFiltro BTC: ' + (st.regime === null ? 'ainda não lido' :
      st.regime ? 'ligado 🟢 (procurando compras)' : 'em espera 🔴 (sem novas compras)');
}

function criptoTextoDiario(st, agora) {
  const hoje = criptoDia(agora);
  const hist = criptoHist();
  const doDia = hist.filter(o => criptoDia(o.fe) === hoje);
  const abertasHoje = hist.filter(o => criptoDia(o.ab) === hoje).length +
    st.abertas.filter(p => criptoDia(p.abertura) === hoje).length;
  const lucroDia = doDia.reduce((a, o) => a + o.lucro, 0);
  return '📊 RELATÓRIO DIÁRIO — ' + criptoDia(agora, 'dd/MM/yyyy') + ' (SIMULADO)\n' +
    '\n' + criptoCabecalho(st) +
    '\nResultado do dia: ' + criptoUsd(lucroDia) + ' | sinais hoje: ' + abertasHoje +
    '\n\nFechadas hoje (' + doDia.length + '):' +
    (doDia.length ? '\n' + doDia.map(o => '• ' + o.par + ' ' + o.tipo + ' ' +
      (o.R >= 0 ? '+' : '') + o.R.toFixed(2) + 'R ' + criptoUsd(o.lucro)).join('\n') : ' nenhuma') +
    '\n\n' + criptoBlocoAbertas(st);
}

function criptoTextoPeriodo(titulo, desde, st, agora) {
  const hist = criptoHist();
  const per = hist.filter(o => o.fe >= desde);
  const mp = criptoMetricas(per);
  const mt = criptoMetricas(hist);
  const s = st.stats;
  const dias = Math.max(1, (agora - st.inicio) / 86400000);
  return titulo + ' (SIMULADO)\n\n' + criptoCabecalho(st) +
    '\n\n— NO PERÍODO —\n' + criptoBlocoMetricas(mp) +
    '\n\n— DESDE O INÍCIO (' + dias.toFixed(0) + (dias < 1.5 ? ' dia' : ' dias') + ') —\n' + criptoBlocoMetricas(mt) +
    '\n\n— RISCO —' +
    '\nQueda máxima da banca: ' + (100 * s.ddMax).toFixed(1) + '%' +
    '\nSequência de perdas: atual ' + s.seqPerda + ' | máxima ' + s.maxSeqPerda +
    '\n\n— COMPARAÇÃO COM O BACKTEST —' +
    '\nAcerto: ' + (100 * mt.acerto).toFixed(0) + '% (backtest ~' + (100 * CRIPTO.REF_ACERTO).toFixed(0) + '%)' +
    '\nMédia: ' + (mt.mediaR >= 0 ? '+' : '') + mt.mediaR.toFixed(2) + 'R (backtest ~+' +
    CRIPTO.REF_MEDIA_R.toFixed(2) + 'R)' +
    '\n' + criptoVeredito(mt) +
    '\n\n— OPERACIONAL —' +
    '\nSinais abertos: ' + s.sinais + ' | ignorados por limite/margem: ' + s.ignorados +
    '\nFonte de preços: ' + criptoGet('CRIPTO_FONTE', '?') +
    '\n\n' + criptoBlocoAbertas(st);
}

/** Acionador diário (21h): relatório do dia; aos domingos o semanal; dia 1 o mensal. */
function resumoDiarioCripto() {
  const st = criptoEstado();
  const agora = Date.now();
  criptoTelegram(criptoTextoDiario(st, agora));
  if (criptoDia(agora, 'u') === '7') {
    criptoTelegram(criptoTextoPeriodo('📈 RELATÓRIO SEMANAL — ' + criptoDia(agora, 'dd/MM/yyyy'),
      agora - 7 * 86400000, st, agora));
  }
  if (criptoDia(agora, 'd') === '1') {
    const d = new Date(agora - 86400000);
    const inicioMes = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    criptoTelegram(criptoTextoPeriodo('🗓 RELATÓRIO MENSAL — ' + criptoDia(agora - 86400000, 'MM/yyyy'),
      inicioMes, st, agora));
  }
}
/** Relatório completo na hora (rode pelo editor). */
function resumoCripto() {
  const st = criptoEstado();
  const txt = criptoTextoPeriodo('📋 RELATÓRIO COMPLETO', st.inicio, st, Date.now());
  console.log(txt);
  criptoTelegram(txt);
}
function relatorioDiarioCripto() { criptoTelegram(criptoTextoDiario(criptoEstado(), Date.now())); }
function diagnosticoCripto() {
  console.log(JSON.stringify(criptoGet('CRIPTO_DIAG', {}), null, 2));
}

// ------------------------------------------------------------ instalação
function testarConexoesCripto() {
  const p = criptoPedido('BTCUSDT', '4h', 5);
  const linhas = [];
  let primeira = null;
  CRIPTO_FONTES.forEach(f => {
    let txt;
    try {
      const r = UrlFetchApp.fetch(criptoUrl(f, p), {muteHttpExceptions: true});
      const ok = r.getResponseCode() === 200 && criptoLer(f, p, r.getContentText());
      txt = ok ? 'OK' : 'falhou (HTTP ' + r.getResponseCode() + ')';
      if (ok && !primeira) primeira = f.nome;
    } catch (e) { txt = 'falhou (' + String(e.message || e).slice(0, 60) + ')'; }
    linhas.push(f.nome + ': ' + txt);
  });
  if (primeira) criptoSet('CRIPTO_FONTE', primeira);
  console.log('Fontes de preço:\n' + linhas.join('\n'));
  const tgOk = criptoTelegram('Teste de conexão do SCANNER CRIPTO\nTelegram: OK\n' +
    'Fontes de preço:\n' + linhas.join('\n') +
    (primeira ? '\nUsando: ' + primeira : '\nNENHUMA fonte de preço respondeu.'));
  console.log('Telegram: ' + (tgOk ? 'OK' : 'FALHOU (confira token e chat id)'));
  return !!primeira && tgOk;
}

function pararScannerCripto() {
  ScriptApp.getProjectTriggers()
    .filter(t => CRIPTO.GATILHOS.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function instalarScannerCripto() {
  if (!testarConexoesCripto()) {
    throw new Error('Conexão falhou. Rode testarConexoesCripto() e veja o registro.');
  }
  pararScannerCripto();  // remove só os acionadores deste robô
  ScriptApp.newTrigger('rodarScannerCripto').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('resumoDiarioCripto').timeBased().everyDays(1)
    .atHour(CRIPTO.HORA_RESUMO).create();
  const st = criptoEstado();
  criptoSalvar(st);
  criptoTelegram('SCANNER CRIPTO V1.1 INSTALADO (MODO SIMULADO)\n' +
    'Estratégia: rompimento 4h com volume + filtro BTC\n' +
    CRIPTO.MOEDAS.length + ' moedas | risco ' + (100 * CRIPTO.RISCO) + '% por trade | máx. ' +
    CRIPTO.MAX_POSICOES + ' posições\nBanca simulada: ' + criptoUsd(st.banca) +
    '\nVarre a cada 15 min; sinais só no fechamento dos candles de 4h ' +
    '(21h, 1h, 5h, 9h, 13h e 17h de Brasília).\nRelatórios: diário às 21h, semanal no domingo, ' +
    'mensal no dia 1.\nNão envia ordens para a corretora.');
  rodarScannerCripto();
}

function zerarSimulacaoCripto() {
  const n = criptoGet('CRIPTO_HIST_N', 0);
  for (let k = 0; k < n; k++) criptoProps().deleteProperty('CRIPTO_HIST_' + k);
  criptoProps().deleteProperty('CRIPTO_HIST_N');
  criptoProps().deleteProperty('CRIPTO_ESTADO');
  criptoProps().deleteProperty('CRIPTO_DIAG');
  criptoProps().deleteProperty('CRIPTO_FONTE');
  console.log('Simulação zerada. Banca volta para ' + criptoUsd(CRIPTO.BANCA_INICIAL));
}
