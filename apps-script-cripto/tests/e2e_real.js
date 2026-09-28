// Teste de ponta a ponta com dados REAIS (MEXC/KuCoin), imitando o Google:
// Binance bloqueada, Telegram só capturado (nada é enviado de verdade).
// Roda o Code.gs inteiro: instalação, varredura, operações abertas e fechadas
// com candles reais, relatórios diário/semanal/mensal/completo.
// Uso: node apps-script-cripto/tests/e2e_real.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const {execFileSync} = require('child_process');

const BLOQUEADOS = ['data-api.binance.vision', 'api.binance.com', 'api1.binance.com',
  'api2.binance.com'];
let chamadas = 0;
function http(url) {
  chamadas++;
  if (BLOQUEADOS.some(h => url.includes('//' + h))) return {code: 451, body: ''};
  try {
    const out = execFileSync('curl', ['-s', '-m', '25', '-w', '\n%{http_code}', url],
      {maxBuffer: 50 * 1024 * 1024}).toString();
    const i = out.lastIndexOf('\n');
    return {code: Number(out.slice(i + 1)), body: out.slice(0, i)};
  } catch (e) { return {code: 0, body: ''}; }
}
function resp(r) { return {getResponseCode: () => r.code, getContentText: () => r.body}; }

const props = {CRIPTO_TELEGRAM_TOKEN: 'teste', CRIPTO_TELEGRAM_CHAT_ID: '1'};  // Telegram só capturado
const enviados = [];
const gatilhos = [];
const ctx = {
  console: {log: () => {}}, JSON, Math, Number, String, Array, Object, Infinity, Error, Date,
  PropertiesService: {getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null),
    setProperty: (k, v) => {
      assert.ok(String(v).length <= 9000, 'propriedade ' + k + ' passou de 9 KB');
      props[k] = String(v);
    },
    deleteProperty: k => { delete props[k]; }
  })},
  LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})},
  Utilities: {
    sleep: () => {},
    formatDate: (d, tz, fmt) => {  // equivalente ao Java SimpleDateFormat em America/Sao_Paulo
      const x = new Date(d.getTime() - 3 * 3600000);
      const p = n => String(n).padStart(2, '0');
      return fmt.replace('yyyy', x.getUTCFullYear()).replace('MM', p(x.getUTCMonth() + 1))
        .replace('dd', p(x.getUTCDate())).replace('HH', p(x.getUTCHours()))
        .replace('mm', p(x.getUTCMinutes())).replace(/^u$/, String(x.getUTCDay() || 7))
        .replace(/^d$/, String(x.getUTCDate()));
    }
  },
  ScriptApp: {
    getProjectTriggers: () => gatilhos.slice(),
    deleteTrigger: t => gatilhos.splice(gatilhos.indexOf(t), 1),
    newTrigger: n => {
      const b = {timeBased: () => b, everyMinutes: () => b, everyDays: () => b, atHour: () => b,
        create: () => gatilhos.push({getHandlerFunction: () => n})};
      return b;
    }
  },
  UrlFetchApp: {
    fetch: (url, o) => {
      if (url.includes('api.telegram.org')) {
        const txt = o.payload.text;
        assert.ok(txt.length <= 4096, 'mensagem maior que o limite do Telegram');
        enviados.push(txt);
        return resp({code: 200, body: '{"ok":true}'});
      }
      return resp(http(url));
    },
    fetchAll: reqs => reqs.map(q => resp(http(q.url)))
  }
};
vm.createContext(ctx);
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
vm.runInContext(CODE + '\n;this.__CRIPTO = CRIPTO;', ctx);
const run = src => vm.runInContext(src, ctx);

const etapas = [];
function etapa(nome, fn) { etapas.push([nome, fn]); }
function semLixo(msgs) {
  msgs.forEach(m => {
    assert.ok(!/NaN|undefined|null|\[object/.test(m), 'texto quebrado na mensagem:\n' + m);
  });
}
function novas(desde) { return enviados.slice(desde); }

// ------------------------------------------------------------------ etapas
etapa('teste de conexão (Binance bloqueada como no Google)', () => {
  const ok = run('testarConexoesCripto()');
  assert.strictEqual(ok, true);
  assert.ok(['mexc', 'kucoin'].includes(JSON.parse(props.CRIPTO_FONTE)));
  const m = enviados[enviados.length - 1];
  assert.ok(m.includes('binance: falhou (HTTP 451)') && m.includes('mexc: OK'));
  console.log(m);
});

etapa('instalação cria só os 2 acionadores e faz a primeira varredura', () => {
  const n0 = enviados.length;
  run('instalarScannerCripto()');
  assert.deepStrictEqual(gatilhos.map(g => g.getHandlerFunction()).sort(),
    ['resumoDiarioCripto', 'rodarScannerCripto']);
  const diag = JSON.parse(props.CRIPTO_DIAG);
  console.log('diagnóstico: ' + JSON.stringify({regime: diag.regime, atrasado: diag.atrasado,
    avaliadas: diag.avaliadas, sinais: diag.sinais, falhas: diag.falhas}));
  if (!diag.atrasado && diag.regime) {
    assert.ok(diag.avaliadas >= 38, 'poucas moedas avaliadas: ' + diag.avaliadas);
  }
  semLixo(novas(n0));
});

etapa('varredura de um candle recente avalia as 40 moedas', () => {
  // força reavaliar o último candle fechado, como se fosse logo após o fechamento
  const agoraReal = Date.now();
  const H4 = 4 * 3600000;
  const fechado = Math.floor(agoraReal / H4) * H4 - H4;
  const st = run('criptoEstado()');
  ctx.__st = st;
  ctx.__agora = fechado + H4 + 5 * 60000;  // 5 min depois do fechamento
  ctx.__fechado = fechado;
  // candles reais, com "agora" 5 min após o fechamento para não ser tratado como atrasado
  run('criptoVarrer(__st, __agora, __fechado)');
  const diag = JSON.parse(props.CRIPTO_DIAG);
  console.log('varredura: regime ' + diag.regime + ', avaliadas ' + diag.avaliadas +
    ', sinais ' + JSON.stringify(diag.sinais) + ', falhas ' + JSON.stringify(diag.falhas));
  if (diag.regime) assert.ok(diag.avaliadas >= 38, 'avaliadas ' + diag.avaliadas);
});

etapa('operações com candles reais: alvo, stop e ainda aberta', () => {
  const agora = Date.now();
  const ini = Math.floor((agora - 3 * 86400000) / 900000) * 900000;
  const pares = ['SOLUSDT', 'ETHUSDT', 'PEPEUSDT'];
  ctx.__ped = pares.map(p => ({par: p, tf: '15m', limite: 1000, inicio: ini}));
  const dados = run('criptoApiVarios(__ped)');
  dados.forEach((d, i) => assert.ok(Array.isArray(d) && d.length > 200, 'sem candles de ' + pares[i]));
  const entradaDe = d => Number(d.find(k => Number(k[0]) >= ini)[1]);
  const st = run('criptoEstado()');
  st.abertas = [];
  // SOL: faixa estreita (1%) -> deve fechar em alvo ou stop com os candles reais
  const e0 = entradaDe(dados[0]);
  st.abertas.push({par: 'SOLUSDT', entrada: e0, stop: e0 * 0.99, alvo: e0 * 1.02, qtd: 10 / e0,
    valor: 10, riscoUsd: 0.5, abertura: ini, candle: ini - 14400000});
  // ETH: faixa larga -> deve continuar aberta
  const e1 = entradaDe(dados[1]);
  st.abertas.push({par: 'ETHUSDT', entrada: e1, stop: e1 * 0.5, alvo: e1 * 2, qtd: 10 / e1,
    valor: 10, riscoUsd: 0.5, abertura: ini, candle: ini - 14400000});
  // PEPE (preço minúsculo): faixa estreita
  const e2 = entradaDe(dados[2]);
  st.abertas.push({par: 'PEPEUSDT', entrada: e2, stop: e2 * 0.985, alvo: e2 * 1.03, qtd: 10 / e2,
    valor: 10, riscoUsd: 0.5, abertura: ini, candle: ini - 14400000});
  run('criptoSalvar')(st);

  // resultado esperado calculado de forma independente, com os mesmos candles
  function esperado(d, p) {
    for (const k of d) {
      const t = Number(k[0]);
      if (t < ini + 900000) continue;
      if (Number(k[3]) <= p.stop) return 'STOP';
      if (Number(k[2]) >= p.alvo) return 'ALVO';
    }
    return null;
  }
  const esp = {SOLUSDT: esperado(dados[0], st.abertas[0]), PEPEUSDT: esperado(dados[2], st.abertas[2])};
  const n0 = enviados.length;
  const st2 = run('criptoEstado()');
  run('criptoConferir')(st2, Date.now());
  run('criptoSalvar')(st2);
  const hist = run('criptoHist()');
  console.log('esperado: ' + JSON.stringify(esp) + ' | fechadas: ' +
    JSON.stringify(hist.map(o => [o.par, o.tipo, o.R.toFixed(2)])));
  for (const par of ['SOLUSDT', 'PEPEUSDT']) {
    const h = hist.find(o => o.par === par.replace('USDT', ''));
    if (esp[par]) assert.ok(h && h.tipo === esp[par], par + ': esperado ' + esp[par]);
    else assert.ok(!h, par + ' não deveria ter fechado');
  }
  assert.ok(st2.abertas.some(p => p.par === 'ETHUSDT'), 'ETH deveria continuar aberta');
  novas(n0).forEach(m => console.log('\n' + m));
  semLixo(novas(n0));
});

etapa('relatório diário com preço ao vivo das abertas', () => {
  const n0 = enviados.length;
  run('relatorioDiarioCripto()');
  const m = enviados[enviados.length - 1];
  console.log('\n' + m);
  assert.ok(m.includes('RELATÓRIO DIÁRIO') && m.includes('ETHUSDT'));
  assert.ok(!m.includes('preço indisponível'), 'não conseguiu o preço atual');
  semLixo(novas(n0));
});

etapa('relatórios semanal, mensal e completo', () => {
  const n0 = enviados.length;
  run('resumoCripto()');
  const st = run('criptoEstado()');
  ctx.__st = st;
  enviados.push(run('criptoTextoPeriodo("📈 RELATÓRIO SEMANAL — teste", Date.now() - 7 * 86400000, __st, Date.now())'));
  enviados.push(run('criptoTextoPeriodo("🗓 RELATÓRIO MENSAL — teste", Date.now() - 30 * 86400000, __st, Date.now())'));
  novas(n0).forEach(m => {
    assert.ok(m.length <= 4096, 'relatório maior que o limite do Telegram');
    console.log('\n' + m);
  });
  semLixo(novas(n0));
});

etapa('acionador diário de domingo e de dia 1 não quebra', () => {
  const n0 = enviados.length;
  run('resumoDiarioCripto()');
  // domingo e dia 1: chama as mesmas funções que o acionador chama nesses dias
  const st = run('criptoEstado()');
  ctx.__st = st;
  run('criptoTextoPeriodo("x", 0, __st, Date.now())');
  semLixo(novas(n0));
});

etapa('rodada normal do acionador de 15 min', () => {
  const n0 = enviados.length;
  run('rodarScannerCripto()');
  const st = run('criptoEstado()');
  assert.strictEqual(st.erros, 0, 'a rodada registrou erro');
  semLixo(novas(n0));
});

etapa('zerar simulação limpa tudo', () => {
  run('zerarSimulacaoCripto()');
  assert.ok(!Object.keys(props).some(k => k.startsWith('CRIPTO_HIST') || k === 'CRIPTO_ESTADO'));
  assert.strictEqual(run('criptoHist()').length, 0);
});

let falhas = 0;
for (const [nome, fn] of etapas) {
  try { fn(); console.log('\nok   ' + nome + '\n'); } catch (e) {
    falhas++;
    console.log('\nFALHOU ' + nome + '\n  ' + (e && e.stack || e) + '\n');
  }
}
const tam = Object.keys(props).reduce((a, k) => a + k.length + props[k].length, 0);
console.log(`${etapas.length - falhas}/${etapas.length} etapas passaram | chamadas HTTP: ${chamadas} | ` +
  `mensagens: ${enviados.length}`);
process.exit(falhas ? 1 : 0);
