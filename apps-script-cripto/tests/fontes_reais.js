// Roda o Code.gs de verdade contra as APIs públicas (sem Telegram) e mostra,
// fonte por fonte, se responde e se os 40 pares são lidos. Uso no GitHub
// Actions (servidores nos EUA, como os do Google): node tests/fontes_reais.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {execFileSync} = require('child_process');

function http(url) {
  try {
    const out = execFileSync('curl', ['-s', '-m', '20', '-w', '\n%{http_code}', url],
      {maxBuffer: 50 * 1024 * 1024}).toString();
    const i = out.lastIndexOf('\n');
    return {code: Number(out.slice(i + 1)), body: out.slice(0, i)};
  } catch (e) { return {code: 0, body: ''}; }
}
const props = {};
const ctx = {
  console, JSON, Math, Number, String, Array, Object, Infinity, Error, Date,
  PropertiesService: {getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: k => { delete props[k]; }
  })},
  LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})},
  Utilities: {sleep: () => {}, formatDate: d => new Date(d).toISOString()},
  UrlFetchApp: {
    fetch: url => { const r = http(url); return {getResponseCode: () => r.code, getContentText: () => r.body}; },
    fetchAll: reqs => reqs.map(q => ctx.UrlFetchApp.fetch(q.url))
  }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
const todas = vm.runInContext('CRIPTO_FONTES.slice()', ctx);
const agora = Date.now();
for (const f of todas) {
  ctx.__f = f;
  vm.runInContext('CRIPTO_FONTES.splice(0, CRIPTO_FONTES.length, __f)', ctx);
  delete props.CRIPTO_FONTE;
  const pedidos = vm.runInContext(
    '[criptoPedido("BTCUSDT", "1d", 400)].concat(CRIPTO.MOEDAS.map(m => criptoPedido(m + "USDT", "4h", 1000)))', ctx);
  ctx.__p = pedidos;
  const dados = vm.runInContext('criptoApiVarios(__p)', ctx);
  let ok = 0;
  const falhas = [];
  let sol = null;
  dados.slice(1).forEach((d, i) => {
    const par = pedidos[i + 1].par;
    if (!d) { falhas.push(par); return; }
    ctx.__d = d;
    const s = vm.runInContext('criptoAvaliar(criptoCandles(__d), ' + agora + ')', ctx);
    if (s) ok++; else falhas.push(par + '(poucos candles)');
    if (par === 'SOLUSDT' && s) sol = s;
  });
  ctx.__d = dados[0];
  const reg = dados[0] ? vm.runInContext('criptoRegime(criptoCandles(__d), ' + agora + ')', ctx) : null;
  console.log(`\n== ${f.nome}: ${ok}/40 pares lidos` +
    (reg ? ` | BTC ${reg.close.toFixed(0)} vs EMA200 ${reg.ema.toFixed(0)} -> filtro ${reg.ok ? 'LIGADO' : 'DESLIGADO'}` : ' | BTC diário: falhou'));
  if (sol) console.log(`   SOL último 4h fechado: close ${sol.close} atr ${sol.atr.toFixed(4)} ema200 ${sol.ema.toFixed(3)} sinal ${sol.ok}`);
  if (falhas.length) console.log('   falhas: ' + falhas.join(', '));
}
