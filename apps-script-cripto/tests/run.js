// Testes do Scanner Cripto sem Google Apps Script: serviços do GAS, Binance e
// Telegram simulados em memória. Rode com: node apps-script-cripto/tests/run.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const H4 = 4 * 3600 * 1000;
const DIA = 24 * 3600 * 1000;
const M15 = 15 * 60 * 1000;

function carregar(opts) {
  const props = Object.assign({CRIPTO_TELEGRAM_TOKEN: 't', CRIPTO_TELEGRAM_CHAT_ID: '1'},
    opts.props || {});
  const enviados = [];
  const gatilhos = (opts.gatilhos || []).map(n => ({getHandlerFunction: () => n}));
  const agora = opts.agora;
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(agora); }
    static now() { return agora; }
  }
  function resp(code, body) {
    return {getResponseCode: () => code, getContentText: () => JSON.stringify(body)};
  }
  const ctx = {
    console: {log: () => {}}, Date: FakeDate, JSON, Math, Number, String, Array, Object,
    Infinity, Error,
    PropertiesService: {getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => {
        assert.ok(String(v).length <= 9000, 'propriedade ' + k + ' passou de 9 KB');
        props[k] = String(v);
      },
      deleteProperty: k => { delete props[k]; }
    })},
    LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})},
    Utilities: {sleep: () => {}, formatDate: d => new Date(d).toISOString()},
    ScriptApp: {
      getProjectTriggers: () => gatilhos.slice(),
      deleteTrigger: t => { gatilhos.splice(gatilhos.indexOf(t), 1); },
      newTrigger: n => {
        const b = {timeBased: () => b, everyMinutes: () => b, everyDays: () => b,
          atHour: () => b, create: () => gatilhos.push({getHandlerFunction: () => n})};
        return b;
      }
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        if (url.includes('api.telegram.org')) {
          enviados.push(o.payload.text);
          return resp(200, {ok: true});
        }
        const u = new URL(url);
        return opts.binance(u.origin, u.searchParams);
      },
      fetchAll: reqs => reqs.map(r => {
        const u = new URL(r.url);
        return opts.binance(u.origin, u.searchParams);
      })
    }
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return {ctx, props, enviados, gatilhos,
    estado: () => JSON.parse(props.CRIPTO_ESTADO || 'null')};
}

// ---------- geradores de candles
function kline(t, o, h, l, c, v, dur) { return [t, o, h, l, c, v, t + dur - 1]; }

/** 4h: tendência de alta suave; último candle fechado rompe com volume 4x. */
function velas4h(candleAtual, rompe) {
  const out = [];
  const n = 1000;
  let p = 100;
  for (let i = 0; i < n; i++) {
    const t = candleAtual - (n - i) * H4;
    const o = p;
    const ultimo = i === n - 1;
    p = ultimo && rompe ? p * 1.1 : p * (i % 2 ? 1.03 : 0.975);
    const h = Math.max(o, p) * 1.002;
    const l = Math.min(o, p) * 0.998;
    out.push(kline(t, o, h, l, p, ultimo && rompe ? 4000 : 1000, H4));
  }
  out.push(kline(candleAtual, p, p * 1.001, p * 0.999, p * 1.0005, 50, H4));  // em curso
  return out;
}
function velasDia(agora, alta) {
  const hoje = Math.floor(agora / DIA) * DIA;
  const out = [];
  let p = 20000;
  for (let i = 400; i >= 1; i--) {
    const o = p;
    p = p * (alta ? 1.003 : 0.997);
    out.push(kline(hoje - i * DIA, o, Math.max(o, p), Math.min(o, p), p, 1, DIA));
  }
  out.push(kline(hoje, p, p, p, p, 1, DIA));
  return out;
}

function cenario(o) {
  const candleAtual = Math.floor(Date.UTC(2026, 8, 28, 12) / H4) * H4;
  const agora = candleAtual + (o.minutos || 10) * 60000;
  const quinze = o.quinze || (() => []);
  const bloqueados = o.bloqueados || [];
  return carregar({
    agora, props: o.props, gatilhos: o.gatilhos,
    binance: (origin, q) => {
      if (bloqueados.indexOf(origin) >= 0) return {getResponseCode: () => 451, getContentText: () => ''};
      const kucoin = origin === 'https://api.kucoin.com';
      const sym = kucoin ? q.get('symbol').replace('-', '') : q.get('symbol');
      const tf = kucoin ? {'15min': '15m', '4hour': '4h', '1day': '1d'}[q.get('type')] : q.get('interval');
      const ini = kucoin ? Number(q.get('startAt')) * 1000 : Number(q.get('startTime'));
      let body;
      if (tf === '1d') body = velasDia(agora, o.alta !== false);
      else if (tf === '15m') body = quinze(sym, ini);
      else body = velas4h(candleAtual, (o.rompem || []).indexOf(sym) >= 0);
      if (kucoin) {  // KuCoin: segundos, mais novo primeiro, [t, abre, fecha, max, min, vol]
        body = {code: '200000', data: body.slice().reverse().map(k =>
          [String(k[0] / 1000), String(k[1]), String(k[4]), String(k[2]), String(k[3]), String(k[5])])};
      }
      return {getResponseCode: () => 200, getContentText: () => JSON.stringify(body)};
    }
  });
}

const testes = [];
function teste(nome, fn) { testes.push([nome, fn]); }

teste('abre operação simulada quando rompe com volume e filtro ligado', () => {
  const b = cenario({rompem: ['SOLUSDT']});
  b.ctx.rodarScannerCripto();
  const st = b.estado();
  assert.strictEqual(st.abertas.length, 1);
  const p = st.abertas[0];
  assert.strictEqual(p.par, 'SOLUSDT');
  assert.ok(p.stop < p.entrada && p.alvo > p.entrada);
  assert.ok(Math.abs((p.alvo - p.entrada) - 2 * (p.entrada - p.stop)) < 1e-9);
  assert.ok(Math.abs(p.riscoUsd - 0.5) < 1e-9, 'risco 1% de 50');
  assert.ok(b.enviados.some(m => m.includes('SINAL DE COMPRA') && m.includes('SOLUSDT')));
});

teste('não repete sinal no mesmo candle', () => {
  const b = cenario({rompem: ['SOLUSDT']});
  b.ctx.rodarScannerCripto();
  b.ctx.rodarScannerCripto();
  assert.strictEqual(b.enviados.filter(m => m.includes('SINAL DE COMPRA')).length, 1);
});

teste('filtro BTC desligado: nenhuma compra', () => {
  const b = cenario({rompem: ['SOLUSDT'], alta: false});
  b.ctx.rodarScannerCripto();
  assert.strictEqual(b.estado().abertas.length, 0);
});

teste('avisa quando o filtro muda', () => {
  const b = cenario({alta: false, props: {CRIPTO_ESTADO: JSON.stringify({banca: 50, abertas: [],
    fechadas: [], ultimoCandle: 0, regime: true, erros: 0,
    stats: {n: 0, ganhos: 0, somaR: 0, lucro: 0}})}});
  b.ctx.rodarScannerCripto();
  assert.ok(b.enviados.some(m => m.includes('FILTRO DESLIGADO')));
});

teste('candle fechado há mais de 1h: não entra atrasado', () => {
  const b = cenario({rompem: ['SOLUSDT'], minutos: 90});
  b.ctx.rodarScannerCripto();
  assert.strictEqual(b.estado().abertas.length, 0);
  assert.ok(JSON.parse(b.props.CRIPTO_DIAG).atrasado);
});

teste('respeita limite de 6 posições', () => {
  const b = cenario({rompem: ['SOLUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT',
    'LINKUSDT', 'DOTUSDT', 'LTCUSDT']});
  b.ctx.rodarScannerCripto();
  assert.strictEqual(b.estado().abertas.length, 6);
  assert.ok(JSON.parse(b.props.CRIPTO_DIAG).ignorados.some(x => x.includes('limite')));
});

teste('ordem abaixo do mínimo é ignorada', () => {
  const b = cenario({rompem: ['SOLUSDT'], props: {CRIPTO_BANCA: '2'}});
  b.ctx.rodarScannerCripto();
  assert.strictEqual(b.estado().abertas.length, 0);
});

teste('bate o alvo: fecha com +2R menos taxa e atualiza a banca', () => {
  const b = cenario({rompem: ['SOLUSDT']});
  b.ctx.rodarScannerCripto();
  const p = b.estado().abertas[0];
  const b2 = cenario({props: {CRIPTO_ESTADO: b.props.CRIPTO_ESTADO},
    quinze: (sym, ini) => [kline(Math.floor(ini / M15) * M15 + M15, p.entrada, p.alvo * 1.001,
      p.entrada * 0.999, p.alvo, 1, M15)]});
  b2.ctx.rodarScannerCripto();
  const st = b2.estado();
  assert.strictEqual(st.abertas.length, 0);
  assert.strictEqual(st.fechadas[0].tipo, 'ALVO');
  assert.ok(Math.abs(st.fechadas[0].R - 2) < 1e-6);
  assert.ok(Math.abs(st.banca - (50 + 1 - 0.0012 * p.valor)) < 1e-6);
  assert.ok(b2.enviados.some(m => m.includes('ALVO')));
});

teste('stop e alvo no mesmo candle: conta stop', () => {
  const b = cenario({rompem: ['SOLUSDT']});
  b.ctx.rodarScannerCripto();
  const p = b.estado().abertas[0];
  const b2 = cenario({props: {CRIPTO_ESTADO: b.props.CRIPTO_ESTADO},
    quinze: (sym, ini) => [kline(Math.floor(ini / M15) * M15 + M15, p.entrada, p.alvo * 1.01,
      p.stop * 0.99, p.entrada, 1, M15)]});
  b2.ctx.rodarScannerCripto();
  assert.strictEqual(b2.estado().fechadas[0].tipo, 'STOP');
  assert.ok(b2.estado().banca < 50);
});

const BINANCE = ['https://data-api.binance.vision', 'https://api.binance.com',
  'https://api1.binance.com', 'https://api2.binance.com'];

teste('usa o próximo servidor se um estiver bloqueado', () => {
  const b = cenario({rompem: ['SOLUSDT'], bloqueados: [BINANCE[0]]});
  b.ctx.rodarScannerCripto();
  assert.strictEqual(b.estado().abertas.length, 1);
  assert.strictEqual(JSON.parse(b.props.CRIPTO_FONTE), 'binance');
});

teste('Binance toda bloqueada: usa a MEXC', () => {
  const b = cenario({rompem: ['SOLUSDT'], bloqueados: BINANCE});
  b.ctx.rodarScannerCripto();
  assert.strictEqual(b.estado().abertas.length, 1);
  assert.strictEqual(JSON.parse(b.props.CRIPTO_FONTE), 'mexc');
});

teste('Binance e MEXC bloqueadas: usa a KuCoin com o mesmo sinal', () => {
  const b = cenario({rompem: ['SOLUSDT'], bloqueados: BINANCE.concat(['https://api.mexc.com'])});
  b.ctx.rodarScannerCripto();
  const st = b.estado();
  assert.strictEqual(st.abertas.length, 1);
  assert.strictEqual(JSON.parse(b.props.CRIPTO_FONTE), 'kucoin');
  const ref = cenario({rompem: ['SOLUSDT']});
  ref.ctx.rodarScannerCripto();
  const a = st.abertas[0], r = ref.estado().abertas[0];
  assert.ok(Math.abs(a.stop - r.stop) < 1e-9 && Math.abs(a.alvo - r.alvo) < 1e-9);
});

teste('teste de conexão lista as fontes e escolhe uma que funciona', () => {
  const b = cenario({bloqueados: BINANCE});
  assert.strictEqual(b.ctx.testarConexoesCripto(), true);
  assert.strictEqual(JSON.parse(b.props.CRIPTO_FONTE), 'mexc');
  const msg = b.enviados.find(m => m.includes('Fontes de preço'));
  assert.ok(msg.includes('binance-vision: falhou (HTTP 451)') && msg.includes('mexc: OK'));
});

teste('instalar não mexe nos acionadores do Scanner Ouro', () => {
  const b = cenario({gatilhos: ['rodarScannerOver', 'conferirResultadosPendentes',
    'rodarScannerCripto']});
  b.ctx.instalarScannerCripto();
  const nomes = b.gatilhos.map(g => g.getHandlerFunction()).sort();
  assert.deepStrictEqual(nomes, ['conferirResultadosPendentes', 'resumoDiarioCripto',
    'rodarScannerCripto', 'rodarScannerOver']);
  b.ctx.pararScannerCripto();
  assert.deepStrictEqual(b.gatilhos.map(g => g.getHandlerFunction()).sort(),
    ['conferirResultadosPendentes', 'rodarScannerOver']);
});

teste('estado continua abaixo de 9 KB depois de muitas operações', () => {
  const b = cenario({});
  const st = b.ctx.criptoEstado();
  for (let i = 0; i < 200; i++) {
    b.ctx.criptoFechar(st, {par: 'PEPEUSDT', entrada: 0.00001234, stop: 0.0000118,
      valor: 10, riscoUsd: 0.5, abertura: 1}, {tipo: 'STOP', preco: 0.0000118, quando: 2}, 3);
  }
  b.ctx.criptoSalvar(st);
  assert.strictEqual(b.estado().stats.n, 200);
});

teste('indicadores: EMA e ATR iguais ao pandas (adjust=False / Wilder)', () => {
  const b = cenario({});
  const ema = b.ctx.criptoEma([1, 2, 3, 4], 3);
  assert.deepStrictEqual(ema.map(x => +x.toFixed(6)), [1, 1.5, 2.25, 3.125]);
  const atr = b.ctx.criptoAtr([{h: 2, l: 1, c: 1.5}, {h: 3, l: 1.5, c: 2}], 2);
  assert.deepStrictEqual(atr, [1, 1.25]);
});

let falhas = 0;
for (const [nome, fn] of testes) {
  try { fn(); console.log('ok   ' + nome); } catch (e) {
    falhas++;
    console.log('FALHOU ' + nome + '\n  ' + (e && e.stack || e));
  }
}
console.log(`\n${testes.length - falhas}/${testes.length} testes passaram`);
process.exit(falhas ? 1 : 0);
