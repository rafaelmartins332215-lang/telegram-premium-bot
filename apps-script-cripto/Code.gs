/**
 * SCANNER CRIPTO V1 — Google Apps Script, arquivo único.
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
  MODELO: 'SCANNER-CRIPTO-V1',
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
  HOSTS: ['https://data-api.binance.vision', 'https://api.binance.com',
    'https://api1.binance.com', 'https://api2.binance.com', 'https://api3.binance.com'],
  // Propriedades do script aceitam no máximo 9 KB por valor: guardamos só as
  // últimas operações; os totais ficam em st.stats.
  LOTE: 20, HISTORICO_MAX: 25, ERRO_ALERTA: 3, HORA_RESUMO: 21, ATRASO_MAX_MS: 3600 * 1000,
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
  return criptoGet('CRIPTO_ESTADO', null) || {
    banca: CRIPTO.BANCA_INICIAL, abertas: [], fechadas: [], ultimoCandle: 0,
    stats: {n: 0, ganhos: 0, somaR: 0, lucro: 0},
    regime: null, erros: 0, inicio: Date.now()
  };
}
function criptoSalvar(st) {
  if (st.fechadas.length > CRIPTO.HISTORICO_MAX) {
    st.fechadas = st.fechadas.slice(-CRIPTO.HISTORICO_MAX);
  }
  criptoSet('CRIPTO_ESTADO', st);
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

// ------------------------------------------------------------ Binance (dados públicos)
function criptoHosts() {
  const bom = criptoGet('CRIPTO_HOST', null);
  return bom ? [bom].concat(CRIPTO.HOSTS.filter(h => h !== bom)) : CRIPTO.HOSTS.slice();
}

/** Busca vários caminhos da API em paralelo; tenta outro servidor se um falhar. */
function criptoApiVarios(caminhos) {
  const saida = new Array(caminhos.length).fill(null);
  let faltam = caminhos.map((_, i) => i);
  for (const host of criptoHosts()) {
    if (!faltam.length) break;
    const pedidos = faltam.map(i => ({url: host + caminhos[i], muteHttpExceptions: true}));
    let resps;
    try { resps = UrlFetchApp.fetchAll(pedidos); } catch (e) { continue; }
    const aindaFaltam = [];
    let algumOk = false;
    resps.forEach((r, k) => {
      const i = faltam[k];
      const code = r.getResponseCode();
      if (code === 200) {
        saida[i] = JSON.parse(r.getContentText());
        algumOk = true;
      } else if (code === 400) {
        saida[i] = {erro: 'moeda inválida'};  // par não existe: não adianta outro host
      } else {
        aindaFaltam.push(i);
      }
    });
    if (algumOk) criptoSet('CRIPTO_HOST', host);
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
  const caminhos = ['/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=400']
    .concat(pares.map(p => '/api/v3/klines?symbol=' + p + '&interval=' + CRIPTO.TF +
      '&limit=' + CRIPTO.CANDLES));
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
  criptoTelegram('🚀 SINAL DE COMPRA (SIMULADO)\n' + par + ' | rompimento 4h com volume\n' +
    '\nEntrada: ' + criptoPreco(entrada) +
    '\nStop: ' + criptoPreco(stop) + ' (' + criptoPct(stop / entrada - 1) + ')' +
    '\nAlvo: ' + criptoPreco(alvo) + ' (' + criptoPct(alvo / entrada - 1) + ')' +
    '\nPrazo máximo: 8 dias' +
    '\n\nTamanho: ' + criptoPreco(qtd) + ' ' + par.replace('USDT', '') + ' ≈ ' + criptoUsd(valor) +
    '\nMargem (' + CRIPTO.ALAVANCAGEM + 'x, isolada): ' + criptoUsd(valor / CRIPTO.ALAVANCAGEM) +
    '\nRisco: ' + criptoUsd(riscoUsd) + ' (' + (100 * CRIPTO.RISCO) + '% da banca)' +
    '\nVolume ' + (s.volume / s.volMedia).toFixed(1) + 'x a média' +
    '\nPosições abertas: ' + st.abertas.length + '/' + CRIPTO.MAX_POSICOES);
  return '';
}

// ------------------------------------------------------------ conferência
function criptoConferir(st, agora) {
  if (!st.abertas.length) return;
  const caminhos = st.abertas.map(p => '/api/v3/klines?symbol=' + p.par +
    '&interval=15m&limit=1000&startTime=' + p.abertura);
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
  st.fechadas.push({par: p.par, fim: r.quando, tipo: r.tipo, R: Number(R.toFixed(3)),
    lucro: Number(lucro.toFixed(4))});
  st.stats.n++;
  if (lucro > 0) st.stats.ganhos++;
  st.stats.somaR += R;
  st.stats.lucro += lucro;
  const icone = {ALVO: '✅', STOP: '❌', PRAZO: '⏱'}[r.tipo];
  criptoTelegram(icone + ' ' + r.tipo + ' (SIMULADO) ' + p.par +
    '\nEntrada ' + criptoPreco(p.entrada) + ' → saída ' + criptoPreco(r.preco) +
    ' (' + criptoPct(r.preco / p.entrada - 1) + ')' +
    '\nResultado: ' + (R >= 0 ? '+' : '') + R.toFixed(2) + 'R = ' + criptoUsd(lucro) +
    ' (já com taxas)' +
    '\nBanca simulada: ' + criptoUsd(st.banca) +
    '\nAberta em ' + criptoData(p.abertura) + ', fechada em ' + criptoData(r.quando));
}

// ------------------------------------------------------------ relatórios
function criptoTextoResumo(st) {
  const s = st.stats;
  return 'RESUMO SCANNER CRIPTO (SIMULADO)' +
    '\nBanca: ' + criptoUsd(st.banca) + ' (início ' + criptoUsd(CRIPTO.BANCA_INICIAL) + ', ' +
    criptoPct(st.banca / CRIPTO.BANCA_INICIAL - 1) + ')' +
    '\nOperações fechadas: ' + s.n + (s.n ? ' | acerto ' +
      (100 * s.ganhos / s.n).toFixed(0) + '% | média ' + (s.somaR / s.n).toFixed(2) + 'R' : '') +
    '\nResultado total: ' + criptoUsd(s.lucro) +
    '\nFiltro BTC: ' + (st.regime === null ? 'ainda não lido' : st.regime ? 'ligado 🟢' : 'em espera 🔴') +
    '\nAbertas (' + st.abertas.length + '): ' +
    (st.abertas.map(p => p.par + ' @ ' + criptoPreco(p.entrada)).join(', ') || 'nenhuma');
}
function resumoDiarioCripto() { criptoTelegram(criptoTextoResumo(criptoEstado())); }
function resumoCripto() {
  const txt = criptoTextoResumo(criptoEstado());
  console.log(txt);
  criptoTelegram(txt);
}
function diagnosticoCripto() {
  console.log(JSON.stringify(criptoGet('CRIPTO_DIAG', {}), null, 2));
}

// ------------------------------------------------------------ instalação
function testarConexoesCripto() {
  const r = criptoApiVarios(['/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=2']);
  const binanceOk = Array.isArray(r[0]);
  console.log('Binance: ' + (binanceOk ? 'OK via ' + criptoGet('CRIPTO_HOST', '?') : 'FALHOU'));
  const tgOk = criptoTelegram('Teste de conexão do SCANNER CRIPTO: OK. Binance ' +
    (binanceOk ? 'OK.' : 'FALHOU.'));
  console.log('Telegram: ' + (tgOk ? 'OK' : 'FALHOU (confira token e chat id)'));
  return binanceOk && tgOk;
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
  criptoTelegram('SCANNER CRIPTO V1 INSTALADO (MODO SIMULADO)\n' +
    'Estratégia: rompimento 4h com volume + filtro BTC\n' +
    CRIPTO.MOEDAS.length + ' moedas | risco ' + (100 * CRIPTO.RISCO) + '% por trade | máx. ' +
    CRIPTO.MAX_POSICOES + ' posições\nBanca simulada: ' + criptoUsd(st.banca) +
    '\nVarre a cada 15 min; sinais só no fechamento dos candles de 4h ' +
    '(21h, 1h, 5h, 9h, 13h e 17h de Brasília).\nNão envia ordens para a corretora.');
  rodarScannerCripto();
}

function zerarSimulacaoCripto() {
  criptoProps().deleteProperty('CRIPTO_ESTADO');
  criptoProps().deleteProperty('CRIPTO_DIAG');
  console.log('Simulação zerada. Banca volta para ' + criptoUsd(CRIPTO.BANCA_INICIAL));
}
