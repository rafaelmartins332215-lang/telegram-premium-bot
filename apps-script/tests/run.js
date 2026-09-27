// Testes do Code.gs sem Google Apps Script: os serviços do GAS, a API-Football
// e o Telegram são simulados em memória. Rode com: node apps-script/tests/run.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function carregar(opts) {
  opts = opts || {};
  const props = Object.assign({
    OURO_API_KEY: 'k', OURO_TELEGRAM_TOKEN: 't', OURO_TELEGRAM_CHAT_ID: '1'
  }, opts.props || {});
  const cache = {};
  const enviados = [];
  const chamadas = [];
  const telegram = opts.telegram || (() => ({code: 200,
    body: {ok: true, result: {message_id: enviados.length}}}));
  const api = opts.api || (() => []);
  function resposta(code, body, headers) {
    return {getResponseCode: () => code, getContentText: () => JSON.stringify(body),
      getAllHeaders: () => headers || {}};
  }
  const ctx = {
    console: {log: () => {}},
    PropertiesService: {getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; },
      getProperties: () => Object.assign({}, props)
    })},
    CacheService: {getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null),
      put: (k, v) => { cache[k] = v; }
    })},
    LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})},
    Utilities: {
      sleep: () => {},
      formatDate: (d, tz, fmt) => {
        const p = {};
        new Intl.DateTimeFormat('en-GB', {timeZone: tz, year: 'numeric', month: '2-digit',
          day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
          .formatToParts(d).forEach(x => { p[x.type] = x.value; });
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
          .replace('HH', p.hour).replace('mm', p.minute);
      }
    },
    UrlFetchApp: {fetch: (url, o) => {
      if (url.includes('api.telegram.org')) {
        const msg = JSON.parse(o.payload).text;
        const r = telegram(msg, enviados);
        if (r.throw) throw Error(r.throw);
        if (r.body && r.body.ok) enviados.push(msg);
        return resposta(r.code, r.body);
      }
      chamadas.push(url);
      return resposta(200, {errors: [], response: api(url), paging: {total: 1}});
    }},
    DriveApp: {createFile: (n, c) => ({getBlob: () => ({getDataAsString: () => c}),
      getId: () => 'f' + n})},
    ScriptApp: {}
  };
  vm.createContext(ctx);
  vm.runInContext(CODE + '\nthis.OURO = OURO;', ctx);
  return {g: ctx, props, enviados, chamadas};
}

const testes = [];
function teste(nome, fn) { testes.push({nome, fn}); }

function jogo(id, status, ht, ft, extra) {
  return Object.assign({
    fixture: {id, status: {short: status, elapsed: 90}, date: new Date().toISOString(),
      timestamp: Math.floor(Date.now() / 1000) - 7200},
    league: {id: 1, season: 2026, name: 'Liga'},
    teams: {home: {id: 10, name: 'Casa'}, away: {id: 20, name: 'Fora'}},
    goals: {home: ft[0], away: ft[1]},
    score: {halftime: {home: ht[0], away: ht[1]}, fulltime: {home: ft[0], away: ft[1]}}
  }, extra || {});
}

teste('credenciais vêm das Propriedades do script', () => {
  const {g} = carregar();
  assert.strictEqual(g.OURO.API_KEY, 'k');
  assert.strictEqual(g.OURO.TELEGRAM_TOKEN, 't');
  assert.ok(!/99f011|8626147047/.test(CODE), 'credencial antiga no código');
});

teste('liquidação dos mercados', () => {
  const {g} = carregar();
  const L = (m, st, ht, ft) => g.ouroLiquidar({market: m}, jogo(1, st, ht, ft));
  assert.strictEqual(L('OVER_05_HT', 'HT', [1, 0], [1, 0]), 'GREEN');
  assert.strictEqual(L('OVER_05_HT', 'HT', [0, 0], [0, 0]), 'RED');
  assert.strictEqual(L('OVER_05_2T', '2H', [0, 0], [1, 0]), null);
  assert.strictEqual(L('OVER_05_2T', 'FT', [1, 0], [1, 0]), 'RED');
  assert.strictEqual(L('OVER_05_2T', 'FT', [1, 0], [2, 0]), 'GREEN');
  assert.strictEqual(L('OVER_10_ASIAN_FT', 'FT', [0, 0], [1, 0]), 'DEVOLVIDA');
  assert.strictEqual(L('OVER_10_ASIAN_FT', 'FT', [0, 0], [1, 1]), 'GREEN');
  assert.strictEqual(L('OVER_10_ASIAN_FT', 'FT', [0, 0], [0, 0]), 'RED');
  assert.strictEqual(L('OVER_15_FT', 'FT', [0, 0], [1, 0]), 'RED');
  assert.strictEqual(L('OVER_15_FT', 'CANC', [0, 0], [0, 0]), 'REVISAO');
  assert.strictEqual(L('OVER_15_FT', 'PST', [0, 0], [0, 0]), null);
});

teste('reconhecimento de mercado e linha', () => {
  const {g} = carregar();
  assert.ok(g.ouroMarket('Goals Over/Under', 'MATCH', false));
  assert.ok(g.ouroMarket('Goals Over/Under First Half', 'HT', false));
  assert.ok(!g.ouroMarket('Goals Over/Under First Half', 'MATCH', false));
  assert.ok(g.ouroMarket('Goals Over/Under - Second Half', '2H', false));
  assert.ok(g.ouroMarket('Asian Total', 'MATCH', true));
  assert.ok(!g.ouroMarket('Goals Over/Under', 'MATCH', true));
  assert.ok(!g.ouroMarket('Corners Over Under', 'MATCH', false));
  assert.strictEqual(g.ouroLine({value: 'Over 1.5'}), 1.5);
  assert.strictEqual(g.ouroLine({value: 'Over', handicap: '1'}), 1);
});

teste('perfil de tempo: fração restante e acréscimos', () => {
  const {g} = carregar();
  const F = g.ouroFracaoRestante;
  assert.ok(Math.abs(F('MATCH', 0) - 1) < 1e-9);
  assert.ok(Math.abs(F('HT', 0) - 1) < 1e-9);
  assert.strictEqual(F('HT', 47), 0);
  assert.strictEqual(F('2H', 94), 0);
  assert.ok(F('HT', 45) > 0, 'acréscimo do 1º tempo precisa contar');
  // Minuto 60 do 2º tempo: sobra mais que 30/45 por causa do fim de jogo mais aberto.
  assert.ok(F('2H', 60) > 30 / 45);
  const perfil = g.ouroPerfilGols();
  assert.ok(Math.abs(perfil.reduce((s, b) => s + b[2], 0) - 1) < 1e-9);
});

teste('escolha da odd: mediana, maior e filtro de casas', () => {
  const {g} = carregar();
  const q = [{odd: 1.9, book: 'A'}, {odd: 2.0, book: 'B'}, {odd: 1.8, book: 'C'},
    {odd: 1.85, book: 'D'}];
  const m = g.ouroEscolherOdd(q);
  assert.strictEqual(m.odd, 1.85);
  assert.strictEqual(m.maior, 2.0);
  assert.strictEqual(m.cotacoes, 4);
  g.OURO.ODD_ESCOLHA = 'MAIOR';
  assert.strictEqual(g.ouroEscolherOdd(q).odd, 2.0);
  assert.strictEqual(g.ouroEscolherOdd([]), null);
  g.OURO.CASAS = ['bet365'];
  assert.ok(g.ouroCasaAceita('Bet365', false));
  assert.ok(!g.ouroCasaAceita('Betano', false));
  assert.ok(g.ouroCasaAceita('API-Football LIVE', true));
});

teste('Telegram: 429 espera e tenta de novo; 4xx vira RECUSADO', () => {
  let n = 0;
  const {g, enviados} = carregar({telegram: () => (++n === 1 ?
    {code: 429, body: {ok: false, parameters: {retry_after: 3}}} :
    {code: 200, body: {ok: true, result: {message_id: 7}}})});
  assert.strictEqual(g.ouroTelegram('oi'), 7);
  assert.strictEqual(enviados.length, 1);
  const b = carregar({telegram: () => ({code: 400, body: {ok: false, description: 'x'}})});
  assert.throws(() => b.g.ouroTelegram('oi'), /TELEGRAM_RECUSADO_400/);
  const c = carregar({telegram: () => ({code: 502, body: {ok: false}})});
  assert.throws(() => c.g.ouroTelegram('oi'), /TELEGRAM_INCERTO_502/);
});

function sinal(g) {
  const j = jogo(55, 'NS', [0, 0], [0, 0]);
  j.fixture.date = new Date(Date.now() + 3600000).toISOString();
  return g.ouroSinal(j, 'PRE', 'OVER_15_FT', 'MATCH', 1.5,
    {odd: 1.9, book: 'A', market: 'Goals Over/Under', updated: new Date().toISOString(),
      maior: 2.0, casaMaior: 'B', cotacoes: 4},
    0.7, 0.3, {lambda: 2.8, hg: 1.4, ag: 1.4, jogosCasa: 20, jogosFora: 20,
      p0: 0.06, p1: 0.17, evMinAplicado: 0.03,
      calibracao: {baseWin: 0.7, baseLoss: 0.3, meta: {status: 'COLETANDO', amostra: 3,
        brierBase: null}}});
}

teste('sinal recusado pelo Telegram é apagado para poder repetir', () => {
  const {g, props} = carregar({telegram: () => ({code: 400, body: {ok: false}})});
  assert.throws(() => sinal(g), /RECUSADO/);
  assert.ok(!('OURO10_S_55_PRE_OVER_15_FT' in props));
});

teste('sinal com entrega incerta fica marcado e é limpo depois de 24 h', () => {
  const {g, props} = carregar({telegram: () => ({throw: 'Timeout'})});
  assert.throws(() => sinal(g), /Timeout/);
  const key = 'OURO10_S_55_PRE_OVER_15_FT';
  const r = JSON.parse(props[key]);
  assert.strictEqual(r.entregaIncerta, true);
  assert.strictEqual(g.ouroLimparNaoEnviados(), 0);
  r.criado = new Date(Date.now() - 25 * 3600000).toISOString();
  props[key] = JSON.stringify(r);
  assert.strictEqual(g.ouroLimparNaoEnviados(), 1);
  assert.ok(!(key in props));
});

teste('sinal enviado grava registro enxuto com maior odd', () => {
  const {g, props, enviados} = carregar();
  assert.strictEqual(sinal(g), true);
  const r = JSON.parse(props.OURO10_S_55_PRE_OVER_15_FT);
  assert.strictEqual(r.enviado, true);
  assert.deepStrictEqual(Object.keys(r.aprendizado), ['status', 'amostra']);
  assert.strictEqual(r.oddMaior, 2.0);
  assert.ok(/Maior odd vista: 2,00 \(B\)/.test(enviados[0]));
  assert.strictEqual(sinal(g), false, 'não repete o mesmo sinal');
});

teste('conferência: liquida, audita, avisa e alimenta o aprendizado', () => {
  const ft = jogo(55, 'FT', [1, 0], [2, 1]);
  const {g, props, enviados} = carregar({api: url => {
    if (url.includes('/fixtures?ids=')) return [ft];
    if (url.includes('/fixtures/events')) return [
      {time: {elapsed: 10}, team: {name: 'Casa'}, type: 'Goal', detail: 'Normal Goal'}];
    if (url.includes('/fixtures/statistics')) return [];
    return [];
  }});
  sinal(g);
  const out = g.conferirResultadosPendentes();
  assert.strictEqual(out.concluidos, 1);
  assert.strictEqual(out.auditorias, 1);
  assert.strictEqual(out.avisos, 1);
  const r = JSON.parse(props.OURO10_S_55_PRE_OVER_15_FT);
  assert.strictEqual(r.resultado, 'GREEN');
  assert.strictEqual(r.notificado, true);
  assert.ok(/GREEN \(SIMULADO\)/.test(enviados[1]));
  const lrn = JSON.parse(props.OURO10_LRN_PRE_OVER_15_FT);
  assert.deepStrictEqual(lrn, [['55', 0.7, 0.3, 'GREEN', 'S']]);
});

teste('aprendizado cabe no limite de 9 KB por propriedade', () => {
  const {g, props} = carregar();
  for (let i = 0; i < 200; i++) {
    g.ouroRegistrarAprendizado({fixtureId: 1000000 + i, mode: 'LIVE',
      market: 'OVER_10_ASIAN_FT', modelo: 'SCANNER-OURO-V10.9', enviado: true,
      auditoriaFinal: {}, resultado: i % 3 ? 'GREEN' : 'RED',
      pWinBase: 0.612345678901, pLossBase: 0.211234567891}, 'S');
  }
  const v = props.OURO10_LRN_LIVE_OVER_10_ASIAN_FT;
  assert.strictEqual(JSON.parse(v).length, g.OURO.APREND_JANELA);
  assert.ok(v.length < 9000, 'tamanho ' + v.length);
  const resumo = g.ouroResumoAprendizado('LIVE', 'OVER_10_ASIAN_FT');
  assert.ok(['ATIVO', 'EM OBSERVAÇÃO'].includes(resumo.status));
});

teste('sensibilidade da pressão usa o erro de previsão', () => {
  const {g, props} = carregar();
  const rows = [];
  // Pressão alta: modelo subestima (erro +0,2). Baixa: calibrado (erro 0).
  for (let i = 0; i < 50; i++) rows.push(['a' + i, 1.1, 0.2]);
  for (let i = 0; i < 50; i++) rows.push(['b' + i, 1.0, 0]);
  props.OURO10_PRESS_SENS2 = JSON.stringify(rows);
  const s = g.ouroSensibilidadePressao();
  assert.strictEqual(s.status, 'ATIVO');
  assert.ok(s.sensibilidade > 1, 'deveria aumentar: ' + s.sensibilidade);
  // DEVOLVIDA não entra.
  g.ouroRegistrarPressao({mode: 'LIVE', enviado: true, auditoriaFinal: {},
    resultado: 'DEVOLVIDA', modelo: 'SCANNER-OURO-V10.9', fixtureId: 9,
    market: 'OVER_10_ASIAN_FT', pWinBase: 0.6, entradaDados: {pressao: 1.1}});
  assert.strictEqual(JSON.parse(props.OURO10_PRESS_SENS2).length, 100);
});

teste('CLV registra a odd de fechamento da mesma casa', () => {
  const agora = Date.now();
  const {g, props} = carregar({api: url => {
    if (!url.includes('/odds?fixture=55')) return [];
    return [{fixture: {id: 55}, bookmakers: ['A', 'B', 'C'].map((b, i) => ({
      name: b, update: new Date().toISOString(),
      bets: [{name: 'Goals Over/Under', values: [
        {value: 'Over 1.5', odd: String([1.7, 1.8, 1.75][i])}]}]}))}];
  }});
  sinal(g);
  const key = 'OURO10_S_55_PRE_OVER_15_FT';
  const r = JSON.parse(props[key]);
  r.inicio = new Date(agora + 10 * 60000).toISOString();
  props[key] = JSON.stringify(r);
  const d = g.rodarScannerOver();
  assert.strictEqual(d.erros.length, 0, JSON.stringify(d.erros));
  const depois = JSON.parse(props[key]);
  assert.strictEqual(d.clvRegistrados, 1);
  assert.strictEqual(depois.oddFechamento, 1.7);
  assert.strictEqual(depois.fonteFechamento, 'A');
  assert.strictEqual(depois.clv, Number((1.9 / 1.7 - 1).toFixed(4)));
});

teste('modelo gera probabilidades válidas a partir do histórico', () => {
  const base = Math.floor(Date.now() / 1000) - 86400 * 30;
  const {g} = carregar({api: url => {
    const m = url.match(/team=(\d+)/);
    if (!m) return [];
    const id = Number(m[1]);
    return Array.from({length: 12}, (_, i) => ({
      fixture: {id: 900 + i, timestamp: base + i * 86400, status: {short: 'FT'}},
      league: {id: 1, season: 2026},
      teams: i % 2 ? {home: {id}, away: {id: 99}} : {home: {id: 99}, away: {id}},
      score: {halftime: {home: 1, away: 0}, fulltime: {home: 2, away: 1}}
    }));
  }});
  const j = jogo(77, 'NS', [0, 0], [0, 0]);
  j.fixture.timestamp = Math.floor(Date.now() / 1000) + 3600;
  let pre, live;
  g.ouroRodada('test', () => {
    pre = g.ouroModelo(j, 'MATCH', null);
    const j2 = JSON.parse(JSON.stringify(j));
    j2.fixture.status = {short: '2H', elapsed: 60};
    live = g.ouroModelo(j2, '2H', {shots: 4, target: 2, minutes: 5});
  });
  [pre, live].forEach(m => {
    assert.ok(m && m.lambda > 0 && m.p0 > 0 && m.p2 > 0 && m.p2 < 1, JSON.stringify(m));
    assert.ok(Math.abs(m.p0 + m.p1 + m.p2 - 1) < 1e-9);
  });
  assert.ok(live.lambda < pre.lambda, 'faltando 30 min deve esperar menos gols');
  assert.strictEqual(live.sensibilidadePressao, 1);
});

teste('arquivamento inclui registros legados OV9', () => {
  const {g, props} = carregar();
  props.OV9_S_1 = JSON.stringify({fixtureId: 1, resultado: 'GREEN'});
  props.OV9_S_2 = JSON.stringify({fixtureId: 2, resultado: 'PENDENTE'});
  assert.strictEqual(g.arquivarResultadosConcluidos(30), 0, 'lote mínimo');
  assert.strictEqual(g.arquivarResultadosConcluidos(), 1);
  assert.ok(!('OV9_S_1' in props));
  assert.ok('OV9_S_2' in props);
});

let falhas = 0;
testes.forEach(t => {
  try { t.fn(); console.log('ok   ' + t.nome); }
  catch (e) { falhas++; console.log('FALHA ' + t.nome + '\n      ' + e.stack.split('\n').slice(0, 3).join('\n      ')); }
});
console.log('\n' + (testes.length - falhas) + '/' + testes.length + ' testes passaram');
process.exit(falhas ? 1 : 0);
