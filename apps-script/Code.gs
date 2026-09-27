/**
 * SCANNER OURO V10.8 — Google Apps Script, arquivo único.
 * Somente alertas; não aposta. Probabilidades experimentais,
 * com recalibração automática somente após validação dos resultados.
 * Odds API-Football são BACK de casas listadas na API, nunca Lay da Bolsa.
 * Cole em Code.gs e execute instalarScannerOver() uma vez.
 *
 * Credenciais: NÃO ficam no código. Cadastre em
 * Configurações do projeto > Propriedades do script:
 *   OURO_API_KEY           chave da API-Football
 *   OURO_TELEGRAM_TOKEN    token do bot do Telegram
 *   OURO_TELEGRAM_CHAT_ID  chat que recebe os alertas
 */
function ouroCred(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
const OURO = {
  get API_KEY() { return ouroCred('OURO_API_KEY'); },
  get TELEGRAM_TOKEN() { return ouroCred('OURO_TELEGRAM_TOKEN'); },
  get TELEGRAM_CHAT_ID() { return ouroCred('OURO_TELEGRAM_CHAT_ID'); },
  BASE: 'https://v3.football.api-sports.io',
  TZ: 'America/Sao_Paulo',
  MODELO: 'SCANNER-OURO-V10.8',
  TETO_DIA: 6900, RESERVA_CONFERENCIA: 250,
  MAX_CHAMADAS: 48, MAX_SEGUNDOS: 125,
  LIVE_LOTE: 18, LIVE_STATS_EXTRA: 7, LIVE_ODDS: 7,
  PRE_LOTE: 10, PRE_ODDS: 6, MAX_SINAIS: 3,
  HIST_MIN: 6, HIST_LOCAL: 2,
  PROB_LIVE: 0.60, PROB_PRE: 0.66, EV_MIN: 0.03,
  COMISSAO: 0, ODD_LIVE_IDADE: 300, ODD_PRE_IDADE: 86400,
  MAX_REGISTROS: 180, AUDITORIA_RETRO_HORAS: 72,
  APREND_MIN: 60, APREND_JANELA: 80, APREND_VALIDACAO: 20,
  APREND_PRIOR: 120, APREND_MAX_AJUSTE: 0.04,
  APREND_GANHO_MIN: 0.002,
  OBS_MAX_POR_GRUPO: 90, OBS_CONSULTA: 20, OBS_MAX_DIAS: 14,
  PERIODO_HT_MIN: 7, PERIODO_HT_MAX: 35,
  PERIODO_2H_MIN: 47, PERIODO_2H_MAX: 75,
  PRESSAO_JANELA_MIN: 150000, PRESSAO_JANELA_MAX: 720000,
  PRESSAO_MINUTOS_MIN: 3, PRESSAO_MINUTOS_MAX: 11,
  SNAP_CACHE_TTL: 900,
  ERRO_ALERTA_LIMITE: 3,
  FECHO_RETENCAO_DIAS: 120,
  EV_MIN_AMOSTRA_BAIXA: 0.02, AMOSTRA_BAIXA_JOGOS: 10,
  ODD_OUTLIER_MULT: 1.25, ODD_OUTLIER_MIN_COTACOES: 3,
  HIST_PESO_OUTRA_COMPETICAO: 0.75,
  PRESSAO_CALIB_MIN: 80, PRESSAO_CALIB_JANELA: 150,
  PRESSAO_SENS_MIN: 0.6, PRESSAO_SENS_MAX: 1.4, PRESSAO_GANHO_MIN: 0.03
};
let ouroRun = null;

function ouroProps() { return PropertiesService.getScriptProperties(); }
function ouroGet(k, fallback) {
  const v = ouroProps().getProperty(k);
  if (v === null) return fallback;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
function ouroSet(k, v) { ouroProps().setProperty(k, JSON.stringify(v)); }
function ouroN(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(String(v).replace('%', '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function ouroPct(n) { return Number.isFinite(n) ? (100 * n).toFixed(1) + '%' : 'ND'; }
function ouroDate(date) {
  return Utilities.formatDate(date ? new Date(date) : new Date(), OURO.TZ, 'dd/MM HH:mm');
}
function ouroDay(offset) {
  const d = new Date(Date.now() + offset * 86400000);
  return Utilities.formatDate(d, OURO.TZ, 'yyyy-MM-dd');
}
function ouroUtcDay() { return new Date().toISOString().slice(0, 10); }
function ouroDiag(reason, j, extra) {
  if (!ouroRun) return;
  const d = ouroRun.d;
  d.motivos[reason] = (d.motivos[reason] || 0) + 1;
  if (d.amostras.length < 28) d.amostras.push({
    jogo: j && j.teams ? j.teams.home.name + ' x ' + j.teams.away.name : '',
    id: j && j.fixture ? j.fixture.id : null, motivo: reason, detalhe: extra || ''
  });
}
function ouroRodada(kind, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('Outra execução em andamento.'); return null; }
  try {
    let quota = ouroGet('OURO10_QUOTA', {day: ouroUtcDay(), used: 0});
    if (quota.day !== ouroUtcDay()) quota = {day: ouroUtcDay(), used: 0};
    const utc = new Date();
    const minutesLeft = 1440 - (utc.getUTCHours() * 60 + utc.getUTCMinutes());
    const roundsLeft = Math.max(1, Math.ceil(minutesLeft / 5));
    const budget = kind === 'scan' ?
      Math.min(OURO.MAX_CHAMADAS, Math.max(8, Math.floor(
        (OURO.TETO_DIA - OURO.RESERVA_CONFERENCIA - quota.used) / roundsLeft
      ))) : OURO.MAX_CHAMADAS;
    ouroRun = {kind, start: Date.now(), calls: 0, quota, routes: {}, budget, d: null};
    return fn();
  } finally {
    if (ouroRun) ouroSet('OURO10_QUOTA', ouroRun.quota);
    ouroRun = null;
    lock.releaseLock();
  }
}
function ouroPode(reserve) {
  if (!ouroRun) throw Error('CHAMADA_FORA_DA_RODADA');
  if (Date.now() - ouroRun.start > OURO.MAX_SEGUNDOS * 1000) throw Error('TEMPO_RODADA');
  if (ouroRun.calls >= ouroRun.budget - (reserve || 0)) throw Error('CHAMADAS_RODADA');
  const limite = Math.min(OURO.TETO_DIA, ouroRun.quota.provider || OURO.TETO_DIA)
    - (ouroRun.kind === 'scan' ? OURO.RESERVA_CONFERENCIA : 0);
  if (ouroRun.quota.used >= limite) throw Error('COTA_DIARIA');
}
function ouroApi(path, ttl, reserve, maxPages) {
  const cache = CacheService.getScriptCache(), key = 'ouro10:' + path;
  if (ttl) {
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  }
  let out = [], pages = 1, object = null;
  const cap = maxPages || 1;
  for (let page = 1; page <= pages && page <= cap; page++) {
    ouroPode(reserve);
    const route = path.split('?')[0];
    const url = OURO.BASE + path + (page === 1 ? '' :
      (path.includes('?') ? '&' : '?') + 'page=' + page);
    ouroRun.calls++;
    ouroRun.quota.used++;
    ouroRun.routes[route] = (ouroRun.routes[route] || 0) + 1;
    const res = UrlFetchApp.fetch(url, {
      headers: {'x-apisports-key': OURO.API_KEY}, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw Error('API_HTTP_' + res.getResponseCode() + ':' + route);
    const data = JSON.parse(res.getContentText());
    if (data.errors && Object.keys(data.errors).length) {
      throw Error('API_ERRO:' + JSON.stringify(data.errors).slice(0, 160));
    }
    const headers = res.getAllHeaders(), h = {};
    Object.keys(headers).forEach(k => { h[k.toLowerCase()] = headers[k]; });
    const left = ouroN(h['x-ratelimit-requests-remaining']);
    const total = ouroN(h['x-ratelimit-requests-limit']);
    if (left !== null && total !== null && total > 0) {
      ouroRun.quota.provider = total;
      ouroRun.quota.used = Math.max(ouroRun.quota.used, total - left);
    }
    if (!Array.isArray(data.response)) {
      if (path === '/status' && data.response && typeof data.response === 'object') {
        object = data.response; break;
      }
      throw Error('API_FORMATO:' + route);
    }
    out.push(...data.response);
    pages = Math.max(1, Number((data.paging || {}).total) || 1);
    if (page === cap && pages > cap) ouroDiag('ODDS_PAGINAS_PARCIAIS', null, path + ' ' + cap + '/' + pages);
  }
  const result = object || out;
  if (ttl) {
    const v = JSON.stringify(result);
    if (v.length < 65000) cache.put(key, v, Math.min(ttl, 21600));
  }
  return result;
}
function ouroTelegram(msg) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' +
    OURO.TELEGRAM_TOKEN + '/sendMessage', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({chat_id: OURO.TELEGRAM_CHAT_ID,
        text: String(msg).slice(0, 3900), disable_web_page_preview: true})
    });
  const data = JSON.parse(res.getContentText());
  if (!data.ok) throw Error('TELEGRAM_' + res.getResponseCode());
  return data.result && data.result.message_id;
}
function ouroPeriodo(j) {
  if (!j || !j.fixture || !j.fixture.status || !j.goals) return null;
  const m = ouroN(j.fixture.status.elapsed);
  if (m === null || ouroN(j.goals.home) === null || ouroN(j.goals.away) === null) return null;
  if (j.fixture.status.short === '1H' && m >= OURO.PERIODO_HT_MIN && m <= OURO.PERIODO_HT_MAX) return 'HT';
  if (j.fixture.status.short === '2H' && m >= OURO.PERIODO_2H_MIN && m <= OURO.PERIODO_2H_MAX) return '2H';
  return null;
}
function ouroStats(j) {
  const raw = Array.isArray(j.statistics) ? j.statistics : [];
  return [j.teams.home.id, j.teams.away.id].map(id => {
    const row = raw.find(x => x.team && Number(x.team.id) === Number(id));
    const stats = {};
    ((row || {}).statistics || []).forEach(x => {
      stats[String(x.type || '').toLowerCase().trim()] = ouroN(x.value);
    });
    return {shots: stats['total shots'], target: stats['shots on goal']};
  });
}
function ouroStatsOK(a) {
  return Array.isArray(a) && a.length === 2 && a.every(x =>
    Number.isFinite(x.shots) && Number.isFinite(x.target) &&
    x.shots >= 0 && x.target >= 0 && x.target <= x.shots);
}
function ouroVermelho(j) {
  return Array.isArray(j.events) && j.events.some(e =>
    /card/i.test(String(e.type || '')) && /red/i.test(String(e.detail || '')));
}
function ouroGolRecente(j) {
  return Array.isArray(j.events) && j.events.some(e =>
    /goal/i.test(String(e.type || '')) &&
    ouroN((e.time || {}).elapsed) !== null &&
    Number(j.fixture.status.elapsed) - Number(e.time.elapsed) < 4);
}
function ouroEventos(j, forcarConsulta) {
  if (!forcarConsulta && Array.isArray(j.events)) return true;
  try {
    const events = ouroApi('/fixtures/events?fixture=' + j.fixture.id, 0, 0, 1);
    if (!Array.isArray(events)) return false;
    j.events = events;
    return true;
  } catch (e) {
    ouroDiag('ERRO_EVENTOS', j, e.message);
    return false;
  }
}
function ouroHistorico(j, teamId, local, period) {
  const key = 'ouro10hist:' + j.fixture.id + ':' + teamId + ':' + Number(local) + ':' + period;
  const cache = CacheService.getScriptCache(), hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const games = ouroApi('/fixtures?team=' + teamId + '&last=60', 3600, 5, 1);
  const rows = games.filter(x => x.fixture && x.teams && x.score &&
      x.score.halftime && x.score.fulltime && x.fixture.status.short === 'FT' &&
      Number(x.fixture.timestamp) < Number(j.fixture.timestamp))
    .sort((a, b) => Number(b.fixture.timestamp) - Number(a.fixture.timestamp))
    .map(x => {
      const ht = x.score.halftime, ft = x.score.fulltime;
      if ([ht.home, ht.away, ft.home, ft.away].some(z => ouroN(z) === null)) return null;
      const h = Number(x.teams.home.id) === Number(teamId);
      const a = Number(x.teams.away.id) === Number(teamId);
      if (!h && !a) return null;
      const gh = period === 'HT' ? Number(ht.home) :
        period === '2H' ? Number(ft.home) - Number(ht.home) : Number(ft.home);
      const ga = period === 'HT' ? Number(ht.away) :
        period === '2H' ? Number(ft.away) - Number(ht.away) : Number(ft.away);
      if (gh < 0 || ga < 0) return null;
      return {gf: h ? gh : ga, ga: h ? ga : gh, local: h,
        season: Number(x.league.season) === Number(j.league.season),
        competicao: Number(x.league.id) === Number(j.league.id)};
    }).filter(Boolean).slice(0, 25);
  const localRows = rows.filter(x => x.local === local);
  if (rows.length < OURO.HIST_MIN || localRows.length < OURO.HIST_LOCAL)
    throw Error('HIST_INSUFICIENTE ' + rows.length + '/' + localRows.length);
  function mean(field) {
    let sum = 0, wsum = 0;
    rows.forEach((x, i) => {
      const w = (x.season ? 1 : 0.70) * (x.local === local ? 1.35 : 1) *
        (i < 8 ? 1.12 : 1) * (x.competicao ? 1 : OURO.HIST_PESO_OUTRA_COMPETICAO);
      sum += x[field] * w; wsum += w;
    });
    return sum / wsum;
  }
  const result = {gf: mean('gf'), ga: mean('ga'), n: rows.length};
  cache.put(key, JSON.stringify(result), 3600);
  return result;
}
function ouroModelo(j, period, pressureData) {
  const home = ouroHistorico(j, j.teams.home.id, true, period);
  const away = ouroHistorico(j, j.teams.away.id, false, period);
  const hg = Math.min(3.8, Math.max(0.08, (home.gf + away.ga) / 2));
  const ag = Math.min(3.8, Math.max(0.08, (away.gf + home.ga) / 2));
  const m = j.fixture.status.short === 'NS' ? 0 :
    Number(j.fixture.status.elapsed);
  const remain = period === 'HT' ? 45 - m : 90 - m;
  const duration = period === 'MATCH' ? 90 : 45;
  if (remain <= 0) return null;
  let pressure = 1, shots5 = null, target5 = null, sensibilidadePressao = null;
  if (pressureData) {
    const shots = pressureData.shots;
    const target = pressureData.target;
    if (shots < 2 || target < 1 || pressureData.minutes <= 0) return null;
    shots5 = shots * 5 / pressureData.minutes;
    target5 = target * 5 / pressureData.minutes;
    const basePressure = Math.max(0.85, Math.min(1.18, 0.92 + shots5 * 0.09 + target5 * 0.06));
    sensibilidadePressao = ouroSensibilidadePressao().sensibilidade;
    pressure = Math.max(0.85, Math.min(1.18,
      1 + (basePressure - 1) * sensibilidadePressao));
  }
  const lambda = (hg + ag) * remain / duration * pressure;
  const p0 = Math.exp(-lambda), p1 = p0 * lambda;
  return {lambda, p0, p1, p2: 1 - p0 - p1, p05: 1 - p0,
    shots5, target5, pressure, hg, ag,
    jogosCasa: home.n, jogosFora: away.n, sensibilidadePressao};
}
function ouroSnapLer(fixtureId) {
  const raw = CacheService.getScriptCache().get('ouro10snap:' + fixtureId);
  return raw ? JSON.parse(raw) : null;
}
function ouroSnapGravar(fixtureId, snap) {
  CacheService.getScriptCache().put('ouro10snap:' + fixtureId,
    JSON.stringify(snap), OURO.SNAP_CACHE_TTL);
}
function ouroPressao(j, stats, period) {
  const minute = Number(j.fixture.status.elapsed);
  const score = j.goals.home + '-' + j.goals.away;
  const shots = stats[0].shots + stats[1].shots;
  const target = stats[0].target + stats[1].target;
  if (period === 'HT') {
    return shots >= 3 && target >= 1 ?
      {shots, target, minutes: Math.max(minute, 7)} : null;
  }
  const previous = ouroSnapLer(j.fixture.id);
  const current = {score, minute, stats, at: Date.now()};
  ouroSnapGravar(j.fixture.id, current);
  if (!previous || previous.score !== score ||
      current.at - previous.at < OURO.PRESSAO_JANELA_MIN ||
      current.at - previous.at > OURO.PRESSAO_JANELA_MAX ||
      minute - previous.minute < OURO.PRESSAO_MINUTOS_MIN ||
      minute - previous.minute > OURO.PRESSAO_MINUTOS_MAX) return null;
  const shotsDelta = stats.reduce((n, x, i) => n + x.shots - previous.stats[i].shots, 0);
  const targetDelta = stats.reduce((n, x, i) => n + x.target - previous.stats[i].target, 0);
  return shotsDelta >= 2 && targetDelta >= 1 && targetDelta <= shotsDelta ?
    {shots: shotsDelta, target: targetDelta, minutes: minute - previous.minute} : null;
}
function ouroEV(odd, win, loss) {
  return win * (odd - 1) * (1 - OURO.COMISSAO) - loss;
}
function ouroMinOdd(win, loss, evMin) {
  const min = evMin === undefined || evMin === null ? OURO.EV_MIN : evMin;
  return Math.ceil((1 + (loss + min) /
    (win * (1 - OURO.COMISSAO))) * 100) / 100;
}
function ouroEvMinAjustado(model) {
  const jogos = Math.min(ouroN(model.jogosCasa), ouroN(model.jogosFora));
  return OURO.EV_MIN + (Number.isFinite(jogos) && jogos <= OURO.AMOSTRA_BAIXA_JOGOS ?
    OURO.EV_MIN_AMOSTRA_BAIXA : 0);
}
// Recalibração local: usa previsões feitas antes do jogo terminar e
// conferidas no FT. Cada mercado e modo tem até 80 resultados.
function ouroChaveAprendizado(mode, market) {
  const names = ['OVER_05_HT', 'OVER_05_2T', 'OVER_10_ASIAN_FT', 'OVER_15_FT'];
  return ['PRE', 'LIVE'].includes(mode) && names.includes(market) ?
    'OURO10_LRN_' + mode + '_' + market : null;
}
function ouroAjusteAmostra(rows, asian) {
  const n = rows.length;
  if (!n) return {win: 0, loss: 0};
  let win = 0, loss = 0;
  rows.forEach(x => {
    win += (x[3] === 'GREEN' ? 1 : 0) - x[1];
    loss += (x[3] === 'RED' ? 1 : 0) - x[2];
  });
  const shrink = n / (n + OURO.APREND_PRIOR);
  const clip = x => Math.max(-OURO.APREND_MAX_AJUSTE,
    Math.min(OURO.APREND_MAX_AJUSTE, x));
  const dw = clip(win / n * shrink);
  return {win: dw, loss: asian ? clip(loss / n * shrink) : -dw};
}
function ouroAplicarAjuste(win, loss, adjustment, asian) {
  const w = Math.max(0.001, Math.min(0.999, win + adjustment.win));
  const l = asian ? Math.max(0.001, Math.min(1 - w, loss + adjustment.loss)) : 1 - w;
  return {win: w, loss: l};
}
function ouroBrier(row, pred, asian) {
  const actualWin = row[3] === 'GREEN' ? 1 : 0;
  const actualLoss = row[3] === 'RED' ? 1 : 0;
  const actualPush = row[3] === 'DEVOLVIDA' ? 1 : 0;
  const push = Math.max(0, 1 - pred.win - pred.loss);
  const sq = x => x * x;
  return (sq(pred.win - actualWin) + sq(pred.loss - actualLoss) +
    (asian ? sq(push - actualPush) : 0)) / (asian ? 3 : 2);
}
function ouroResumoAprendizado(mode, market) {
  const key = ouroChaveAprendizado(mode, market);
  if (!key) return {status: 'NÃO APLICÁVEL', amostra: 0};
  const stored = ouroGet(key, []), rows = Array.isArray(stored) ? stored : [];
  const n = rows.length, asian = market === 'OVER_10_ASIAN_FT';
  const summary = {status: 'COLETANDO', amostra: n,
    jogosObservados: rows.filter(x => x[4] === 'O').length,
    sinais: rows.filter(x => x[4] !== 'O').length,
    minimo: OURO.APREND_MIN, modo: mode, mercado: market,
    ajusteWin: 0, ajusteLoss: 0, brierBase: null, brierAjustado: null};
  if (n < OURO.APREND_MIN) return summary;
  const training = rows.slice(0, -OURO.APREND_VALIDACAO);
  const validation = rows.slice(-OURO.APREND_VALIDACAO);
  const check = ouroAjusteAmostra(training, asian);
  let base = 0, adjusted = 0;
  validation.forEach(row => {
    base += ouroBrier(row, {win: row[1], loss: row[2]}, asian);
    adjusted += ouroBrier(row,
      ouroAplicarAjuste(row[1], row[2], check, asian), asian);
  });
  summary.brierBase = Number((base / validation.length).toFixed(4));
  summary.brierAjustado = Number((adjusted / validation.length).toFixed(4));
  const gain = (base - adjusted) / validation.length;
  if (gain < OURO.APREND_GANHO_MIN) {
    summary.status = 'EM OBSERVAÇÃO'; return summary;
  }
  const full = ouroAjusteAmostra(rows, asian);
  summary.status = 'ATIVO';
  summary.ajusteWin = Number(full.win.toFixed(4));
  summary.ajusteLoss = Number(full.loss.toFixed(4));
  return summary;
}
function ouroCalibrar(mode, market, win, loss) {
  const meta = ouroResumoAprendizado(mode, market);
  const asian = market === 'OVER_10_ASIAN_FT';
  const p = meta.status === 'ATIVO' ? ouroAplicarAjuste(win, loss,
    {win: meta.ajusteWin, loss: meta.ajusteLoss}, asian) : {win, loss};
  return {win: p.win, loss: p.loss, baseWin: win, baseLoss: loss, meta};
}
function ouroRegistrarAprendizado(r, source) {
  if (!r.enviado || !r.auditoriaFinal ||
      !['GREEN', 'RED', 'DEVOLVIDA'].includes(r.resultado) ||
      !/^SCANNER-OURO-V10\./.test(String(r.modelo || ''))) return;
  const key = ouroChaveAprendizado(r.mode, r.market);
  if (!key || (r.resultado === 'DEVOLVIDA' && r.market !== 'OVER_10_ASIAN_FT')) return;
  const win = ouroN(r.pWinBase === undefined ? r.pWin : r.pWinBase);
  const loss = ouroN(r.pLossBase === undefined ? r.pLoss : r.pLossBase);
  if (win === null || loss === null || win <= 0 || loss <= 0 ||
      win + loss > 1.001 ||
      (r.market !== 'OVER_10_ASIAN_FT' && win + loss < 0.999)) return;
  const stored = ouroGet(key, []), rows = Array.isArray(stored) ? stored : [];
  const id = String(r.fixtureId);
  const value = [id, win, loss, r.resultado, source === 'O' ? 'O' : 'S'];
  const index = rows.findIndex(x => String(x[0]) === id);
  if (index !== -1) {
    // A previsão do sinal entregue prevalece sobre observações sem alerta.
    if (source === 'O' && rows[index][4] !== 'O') return;
    if (JSON.stringify(rows[index]) === JSON.stringify(value)) return;
    rows[index] = value;
  } else rows.push(value);
  ouroSet(key, rows.slice(-OURO.APREND_JANELA));
}
// Calibração da sensibilidade do coeficiente de pressão: compara a taxa de
// acerto de sinais LIVE com pressão alta vs. baixa/neutra já auditados.
// Enquanto não há amostra suficiente, a sensibilidade fica em 1 (neutra).
function ouroChavePressaoCalib() { return 'OURO10_PRESS_SENS'; }
function ouroRegistrarPressao(r) {
  if (r.mode !== 'LIVE' || !r.enviado || !r.auditoriaFinal ||
      !['GREEN', 'RED', 'DEVOLVIDA'].includes(r.resultado) ||
      !/^SCANNER-OURO-V10\./.test(String(r.modelo || ''))) return;
  const pressao = r.entradaDados && ouroN(r.entradaDados.pressao);
  if (pressao === null) return;
  const key = ouroChavePressaoCalib();
  const stored = ouroGet(key, []), rows = Array.isArray(stored) ? stored : [];
  const id = r.fixtureId + '_' + r.market;
  const win = r.resultado === 'GREEN' ? 1 : 0;
  const value = [String(id), pressao, win];
  const index = rows.findIndex(x => x[0] === value[0]);
  if (index !== -1) rows[index] = value; else rows.push(value);
  ouroSet(key, rows.slice(-OURO.PRESSAO_CALIB_JANELA));
}
function ouroSensibilidadePressao() {
  const stored = ouroGet(ouroChavePressaoCalib(), []);
  const rows = Array.isArray(stored) ? stored : [];
  const n = rows.length;
  const summary = {status: 'COLETANDO', amostra: n,
    minimo: OURO.PRESSAO_CALIB_MIN, sensibilidade: 1};
  if (n < OURO.PRESSAO_CALIB_MIN) return summary;
  const alta = rows.filter(x => x[1] > 1.02);
  const baixa = rows.filter(x => x[1] <= 1.02);
  if (alta.length < 15 || baixa.length < 15) {
    summary.status = 'EM OBSERVAÇÃO'; return summary;
  }
  const taxaAlta = alta.reduce((s, x) => s + x[2], 0) / alta.length;
  const taxaBaixa = baixa.reduce((s, x) => s + x[2], 0) / baixa.length;
  const diff = taxaAlta - taxaBaixa;
  summary.taxaAlta = Number(taxaAlta.toFixed(4));
  summary.taxaBaixa = Number(taxaBaixa.toFixed(4));
  if (Math.abs(diff) < OURO.PRESSAO_GANHO_MIN) {
    summary.status = 'EM OBSERVAÇÃO'; return summary;
  }
  const shrink = n / (n + OURO.APREND_PRIOR);
  const raw = 1 + diff * 2 * shrink;
  summary.status = 'ATIVO';
  summary.sensibilidade = Number(Math.max(OURO.PRESSAO_SENS_MIN,
    Math.min(OURO.PRESSAO_SENS_MAX, raw)).toFixed(3));
  return summary;
}
function verSensibilidadePressao() {
  const r = ouroSensibilidadePressao();
  console.log(JSON.stringify(r, null, 2)); return r;
}
function verAprendizadoScanner() {
  const groups = [
    ['LIVE', 'OVER_05_HT'], ['LIVE', 'OVER_05_2T'],
    ['LIVE', 'OVER_10_ASIAN_FT'], ['PRE', 'OVER_10_ASIAN_FT'],
    ['PRE', 'OVER_15_FT']
  ];
  const result = groups.map(x => ouroResumoAprendizado(x[0], x[1]));
  console.log(JSON.stringify(result, null, 2)); return result;
}
// Previsões sem sinal também têm resultado verificável. São mantidas
// separadas dos alertas e não alteram a conferência diária do Telegram.
function ouroObservar(j, mode, market, win, loss) {
  const key = ouroChaveAprendizado(mode, market);
  const kickoff = Number(j.fixture && j.fixture.timestamp) * 1000;
  if (!key || !Number.isFinite(kickoff) || kickoff <= 0 ||
      !Number.isFinite(win) || !Number.isFinite(loss) ||
      win <= 0 || loss <= 0 || win + loss > 1.001) return false;
  const obsKey = key.replace('OURO10_LRN_', 'OURO10_OBS_');
  const stored = ouroGet(obsKey, []), rows = Array.isArray(stored) ? stored : [];
  if (rows.some(x => String(x[0]) === String(j.fixture.id)) ||
      rows.length >= OURO.OBS_MAX_POR_GRUPO) return false;
  rows.push([String(j.fixture.id), win, loss, Date.now(), kickoff + 105 * 60000]);
  ouroSet(obsKey, rows); return true;
}
function ouroConferirObservacoes() {
  const now = Date.now(), due = [], keys = [
    ['LIVE', 'OVER_05_HT'], ['LIVE', 'OVER_05_2T'],
    ['LIVE', 'OVER_10_ASIAN_FT'], ['PRE', 'OVER_10_ASIAN_FT'],
    ['PRE', 'OVER_15_FT']
  ];
  const pools = keys.map(pair => {
    const key = ouroChaveAprendizado(pair[0], pair[1])
      .replace('OURO10_LRN_', 'OURO10_OBS_');
    const stored = ouroGet(key, []);
    const rows = (Array.isArray(stored) ? stored : []).filter(x =>
      now - Number(x[3]) <= OURO.OBS_MAX_DIAS * 86400000);
    if (rows.length !== (Array.isArray(stored) ? stored.length : 0)) ouroSet(key, rows);
    rows.forEach(x => {
      if (Number(x[4]) <= now) due.push({key, pair, row: x});
    });
    return {key, rows};
  });
  due.sort((a, b) => Number(a.row[4]) - Number(b.row[4]));
  const ids = Array.from(new Set(due.map(x => String(x.row[0]))))
    .slice(0, OURO.OBS_CONSULTA);
  if (!ids.length) return {consultados: 0, auditados: 0};
  let fixtures;
  try { fixtures = ouroApi('/fixtures?ids=' + ids.join('-'), 0, 0, 1); }
  catch (e) { console.log('OBSERVACOES_API: ' + e.message);
    return {consultados: 0, auditados: 0, erro: e.message}; }
  const map = {}; fixtures.forEach(j => { map[String(j.fixture.id)] = j; });
  let auditados = 0;
  pools.forEach(pool => {
    let changed = false;
    pool.rows = pool.rows.filter(row => {
      const id = String(row[0]);
      if (!ids.includes(id) || Number(row[4]) > now) return true;
      const j = map[id];
      if (!j || !j.fixture || !j.fixture.status) {
        row[4] = now + 60 * 60000; changed = true; return true;
      }
      const status = j.fixture.status.short;
      if (['CANC', 'ABD', 'AWD', 'WO'].includes(status)) {
        changed = true; return false;
      }
      const parts = pool.key.replace('OURO10_OBS_', '').split('_');
      const mode = parts.shift(), market = parts.join('_');
      const result = ouroLiquidar({market}, j);
      if (['GREEN', 'RED', 'DEVOLVIDA'].includes(result) &&
          ['FT', 'AET', 'PEN'].includes(status)) {
        ouroRegistrarAprendizado({fixtureId: id, mode, market,
          modelo: OURO.MODELO, enviado: true, resultado: result,
          auditoriaFinal: ouroDadosConferencia(j),
          pWinBase: row[1], pLossBase: row[2]}, 'O');
        auditados++; changed = true; return false;
      }
      row[4] = now + (status === 'PST' ? 8 : 1) * 3600000;
      changed = true; return true;
    });
    if (changed) ouroSet(pool.key, pool.rows);
  });
  const out = {consultados: ids.length, auditados};
  console.log('OBSERVACOES: ' + JSON.stringify(out)); return out;
}
function ouroLine(v) {
  const h = ouroN(v.handicap);
  if (h !== null) return h;
  const m = String(v.value || '').match(/\b(?:over|under)\s*\(?\s*(\d+(?:[.,]\d+)?)\s*\)?/i);
  return m ? ouroN(m[1]) : null;
}
function ouroMarket(name, period, asian) {
  const s = String(name || '').toLowerCase().replace(/\s+/g, ' ');
  if (/corner|card|booking|player|penalt|handicap|both teams|correct|exact|odd\/even|extra time|result|home team|away team|team total|team goals/.test(s))
    return false;
  if (!/(over\s*\/\s*under|over\s+and\s+under|total goals|match goals|asian total|asian goals|goal line)/.test(s))
    return false;
  if (asian && !/asian|goal line/.test(s)) return false;
  const first = /first[ -]?half|1st[ -]?half|half[ -]?time|half[ -]?1\b|\b1h\b/.test(s);
  const second = /second[ -]?half|2nd[ -]?half|half[ -]?2\b|\b2h\b/.test(s);
  if (period === 'HT') return first && !second;
  if (period === '2H') return second && !first;
  return !first && !second && !/half|\b[12]h\b/.test(s);
}
function ouroOdd(j, period, line, live) {
  const path = (live ? '/odds/live?fixture=' : '/odds?fixture=') + j.fixture.id;
  const raw = ouroApi(path, live ? 0 : 900, 2, live ? 2 : 8);
  const found = [], names = [], reasons = {};
  const fail = k => { reasons[k] = (reasons[k] || 0) + 1; };
  raw.forEach(r => {
    if (!r.fixture || Number(r.fixture.id) !== Number(j.fixture.id)) { fail('ID'); return; }
    if (live) {
      const status = r.status || {};
      if (status.stopped === true || status.blocked === true || status.finished === true)
        { fail('SUSPENSO'); return; }
      const fx = r.fixture.status || {}, current = j.fixture.status || {};
      if (fx.short && fx.short !== current.short) { fail('PERIODO'); return; }
      if (ouroN(fx.elapsed) !== null && Math.abs(Number(fx.elapsed) -
          Number(current.elapsed)) > 4) { fail('MINUTO'); return; }
      const teams = r.teams || {};
      if (teams.home && teams.away && ouroN(teams.home.goals) !== null &&
          ouroN(teams.away.goals) !== null &&
          (Number(teams.home.goals) !== Number(j.goals.home) ||
           Number(teams.away.goals) !== Number(j.goals.away))) { fail('PLACAR'); return; }
    }
    const books = live ? [{name: 'API-Football LIVE', update: r.update,
      bets: r.odds || []}] : (r.bookmakers || []);
    books.forEach(book => {
      const update = book.update || r.update, age = (Date.now() - Date.parse(update)) / 1000;
      if (!Number.isFinite(age) || age < -60 ||
          age > (live ? OURO.ODD_LIVE_IDADE : OURO.ODD_PRE_IDADE))
        { fail('DATA_ODD'); return; }
      (book.bets || []).forEach(bet => {
        if (names.length < 15 && bet.name) names.push(bet.name);
        if (!ouroMarket(bet.name, period, line === 1)) { fail('MERCADO'); return; }
        const values = bet.values || [];
        const overs = values.filter(v => /^over\b/i.test(String(v.value || '')) &&
          ouroLine(v) === line && v.suspended !== true);
        if (!overs.length) { fail('LINHA'); return; }
        overs.forEach(v => {
          const odd = ouroN(v.odd);
          if (odd === null || odd <= 1 || odd > 25) { fail('ODD'); return; }
          found.push({odd, book: book.name, market: bet.name, updated: update});
        });
      });
    });
  });
  found.sort((a, b) => b.odd - a.odd);
  if (found.length >= OURO.ODD_OUTLIER_MIN_COTACOES) {
    const valores = found.map(x => x.odd).slice().sort((a, b) => a - b);
    const mid = Math.floor(valores.length / 2);
    const mediana = valores.length % 2 ? valores[mid] : (valores[mid - 1] + valores[mid]) / 2;
    while (found.length > 1 && found[0].odd > mediana * OURO.ODD_OUTLIER_MULT) {
      ouroDiag('ODD_OUTLIER_DESCARTADA', j,
        found[0].odd + ' vs mediana ' + mediana.toFixed(2));
      found.shift();
    }
  }
  if (!found.length) ouroDiag('SEM_ODD_' + (live ? 'LIVE' : 'PRE'), j,
    JSON.stringify({registros: raw.length, motivos: reasons, mercados: names.slice(0, 8)}));
  return found[0] || null;
}
function ouroRegistros() {
  return Object.keys(ouroProps().getProperties()).filter(k => /^OURO10_S_/.test(k));
}
function ouroTodosRegistros() {
  return Object.keys(ouroProps().getProperties()).filter(k =>
    /^(OURO10_S_|OV9_S_)/.test(k));
}
function ouroMercadoTexto(market) {
  const labels = {
    OVER_05_HT: 'Over 0,5 gol no 1º tempo',
    OVER_05_2T: 'Over 0,5 gol no 2º tempo',
    OVER_10_ASIAN_FT: 'Over 1,0 asiático FT',
    OVER_15_FT: 'Over 1,5 gols FT'
  };
  return labels[market] || market || 'Mercado não informado';
}
function ouroOddTexto(odd) {
  const value = ouroN(odd);
  return value === null ? 'ND' : value.toFixed(2).replace('.', ',');
}
function ouroTextoSinal(r) {
  const market = r.market || r.mercado;
  const entry = r.mode === 'PRE' ? 'Pré-jogo' :
    'Ao vivo ' + r.minuto + "' | " + r.score;
  return 'SCANNER OURO | SINAL SIMULADO #' + r.fixtureId + '\n' +
    r.casa + ' x ' + r.fora + '\n' + r.liga + ' | ' +
    ouroDate(r.inicio) + ' BRT\n' + entry + '\n' +
    ouroMercadoTexto(market) + ' | Odd BACK ' + ouroOddTexto(r.odd) + '\n' +
    'Fonte: ' + r.fonte + ' (API, ' + ouroDate(r.updated) + ' BRT)\n' +
    'Probabilidade experimental: ' + ouroPct(r.pWin) +
    ' | Odd mín.: ' + ouroOddTexto(ouroMinOdd(r.pWin, r.pLoss, r.evMinAplicado)) +
    ' | EV est.: ' + ouroPct(r.ev) + '\n' +
    'Calibração: ' + (r.aprendizado && r.aprendizado.status === 'ATIVO' ?
      'automática (' + r.aprendizado.amostra + ' jogos auditados)' : 'em observação') + '\n' +
    'Confira linha e preço atual. Não é odd Lay da Bolsa.';
}
function ouroSinal(j, mode, market, period, line, quote, win, loss, model) {
  const id = j.fixture.id + '_' + mode + '_' + market, key = 'OURO10_S_' + id;
  if (ouroProps().getProperty(key)) return false;
  if (ouroRegistros().length >= OURO.MAX_REGISTROS) {
    ouroDiag('REGISTROS_CHEIOS', j); return false;
  }
  const rec = {fixtureId: j.fixture.id, modelo: OURO.MODELO,
    mode, market, period, line,
    pWinBase: model.calibracao ? model.calibracao.baseWin : win,
    pLossBase: model.calibracao ? model.calibracao.baseLoss : loss,
    aprendizado: model.calibracao ? model.calibracao.meta : null,
    evMinAplicado: ouroN(model.evMinAplicado),
    odd: quote.odd, fonte: quote.book, updated: quote.updated,
    mercadoAPI: quote.market,
    inicio: j.fixture.date, liga: j.league.name, casa: j.teams.home.name,
    fora: j.teams.away.name, minuto: mode === 'LIVE' ? j.fixture.status.elapsed : 0,
    score: mode === 'PRE' ? 'ND (pré-jogo)' :
      j.goals.home + '-' + j.goals.away, pWin: win, pLoss: loss,
    ev: ouroEV(quote.odd, win, loss), criado: new Date().toISOString(),
    resultado: 'PENDENTE', enviado: false, notificado: false,
    auditoriaPendente: true,
    entradaDados: {
      ligaId: j.league.id, temporada: j.league.season,
      casaId: j.teams.home.id, foraId: j.teams.away.id,
      idadeOddMin: Math.round((Date.now() - Date.parse(quote.updated)) / 60000),
      golsNoSinal: mode === 'LIVE' ? ouroN(j.goals.home) + ouroN(j.goals.away) : null,
      lambda: ouroN(model.lambda), mediaCasa: ouroN(model.hg),
      mediaFora: ouroN(model.ag), jogosCasa: ouroN(model.jogosCasa),
      jogosFora: ouroN(model.jogosFora), pressao: ouroN(model.pressure),
      sensibilidadePressao: ouroN(model.sensibilidadePressao),
      chutesJanela: ouroN(model.shots), alvoJanela: ouroN(model.target),
      probZero: ouroN(model.p0), probUm: ouroN(model.p1),
      evMinAplicado: ouroN(model.evMinAplicado)
    }};
  ouroSet(key, rec);
  const msg = ouroTextoSinal(rec);
  try {
    rec.messageId = ouroTelegram(msg);
    rec.enviado = true;
    ouroSet(key, rec);
    return true;
  } catch (e) {
    ouroDiag('FALHA_TELEGRAM_ENTREGA_INCERTA', j, e.message);
    throw e;
  }
}
function ouroRecheck(j, live) {
  let row;
  try {
    row = ouroApi('/fixtures?id=' + j.fixture.id, 0, 0, 1)[0];
  } catch (e) {
    ouroDiag('ERRO_RECHECK', j, e.message);
    return false;
  }
  if (!row) return false;
  if (!live) return row.fixture.status.short === 'NS' &&
    Date.parse(row.fixture.date) - Date.now() >= 10 * 60000;
  const same = row.fixture.status.short === j.fixture.status.short &&
    Math.abs(Number(row.fixture.status.elapsed) - Number(j.fixture.status.elapsed)) <= 4 &&
    Number(row.goals.home) === Number(j.goals.home) &&
    Number(row.goals.away) === Number(j.goals.away);
  if (!same || !ouroEventos(row, false)) return false;
  return !ouroVermelho(row) && !ouroGolRecente(row);
}
function ouroLive(d) {
  const all = ouroApi('/fixtures?live=all', 0, 6, 1);
  d.live = all.length;
  const eligible = all.filter(ouroPeriodo);
  d.janelaLive = eligible.length;
  const rotation = ouroGet('OURO10_LROT', 0);
  const start = eligible.length ? rotation % eligible.length : 0;
  const rotated = eligible.slice(start).concat(eligible.slice(0, start));
  const ready = rotated.filter(j => {
    if (ouroPeriodo(j) !== '2H') return false;
    const snap = ouroSnapLer(j.fixture.id);
    return snap && snap.score === j.goals.home + '-' + j.goals.away &&
      Date.now() - snap.at >= OURO.PRESSAO_JANELA_MIN &&
      Date.now() - snap.at <= OURO.PRESSAO_JANELA_MAX &&
      Number(j.fixture.status.elapsed) - snap.minute >= OURO.PRESSAO_MINUTOS_MIN &&
      Number(j.fixture.status.elapsed) - snap.minute <= OURO.PRESSAO_MINUTOS_MAX;
  });
  const selected = ready.slice(0, OURO.LIVE_LOTE).concat(
    rotated.filter(j => !ready.some(r => r.fixture.id === j.fixture.id))
      .slice(0, Math.max(0, OURO.LIVE_LOTE - ready.length)));
  ouroSet('OURO10_LROT', rotation + OURO.LIVE_LOTE);
  d.liveSelecionados = selected.length;
  if (!selected.length) return;
  const details = ouroApi('/fixtures?ids=' +
    selected.map(x => x.fixture.id).join('-'), 0, 6, 1);
  const byId = {};
  details.forEach(j => { byId[j.fixture.id] = j; });
  let fallback = 0, oddCount = 0;
  for (const f of selected) {
    if (ouroRun.calls >= ouroRun.budget - 8 ||
        Date.now() - ouroRun.start > OURO.MAX_SEGUNDOS * 1000 - 15000 ||
        oddCount >= OURO.LIVE_ODDS || d.sinais >= OURO.MAX_SINAIS) break;
    const j = byId[f.fixture.id];
    if (!j) { ouroDiag('SEM_DETALHES', f); continue; }
    const period = ouroPeriodo(j);
    if (!period) continue;
    let stats = ouroStats(j);
    if (!ouroStatsOK(stats) && fallback < OURO.LIVE_STATS_EXTRA) {
      fallback++;
      try {
        const raw = ouroApi('/fixtures/statistics?fixture=' + j.fixture.id, 0, 6, 1);
        stats = ouroStats(Object.assign({}, j, {statistics: raw}));
      } catch (e) { ouroDiag('ERRO_STATS', j, e.message); }
    }
    if (!ouroStatsOK(stats)) { ouroDiag('STATS_INCOMPLETAS', j); continue; }
    const pressure = ouroPressao(j, stats, period);
    if (!pressure) {
      ouroDiag(period === '2H' ? 'JANELA_2T_NAO_FORMADA' : 'ATAQUE_INSUFICIENTE', j);
      continue;
    }
    if (!ouroEventos(j, false)) { ouroDiag('EVENTOS_INCOMPLETOS', j); continue; }
    if (ouroVermelho(j) || ouroGolRecente(j)) {
      ouroDiag('CARTAO_OU_GOL_RECENTE', j); continue;
    }
    const goals = Number(j.goals.home) + Number(j.goals.away);
    const ht = j.score && j.score.halftime;
    const halfGoals = period === 'HT' ? goals :
      ht && ouroN(ht.home) !== null && ouroN(ht.away) !== null ?
      goals - Number(ht.home) - Number(ht.away) : null;
    const targets = [];
    if (halfGoals === 0) targets.push({name: period === 'HT' ? 'OVER_05_HT' : 'OVER_05_2T',
      period, line: 0.5});
    if (goals === 0) targets.push({name: 'OVER_10_ASIAN_FT',
      period: 'MATCH', line: 1});
    if (!targets.length) { ouroDiag('LINHAS_JA_DECIDIDAS', j); continue; }
    for (const t of targets) {
      if (oddCount >= OURO.LIVE_ODDS || d.sinais >= OURO.MAX_SINAIS ||
          ouroRun.calls >= ouroRun.budget - 5) break;
      if (ouroProps().getProperty('OURO10_S_' + j.fixture.id + '_LIVE_' + t.name)) continue;
      let model;
      try { model = ouroModelo(j, t.period, pressure); }
      catch (e) { ouroDiag('HIST_LIVE', j, e.message); continue; }
      if (!model) { ouroDiag('SEM_MODELO', j); continue; }
      const rawWin = t.line === 1 ? model.p2 : model.p05;
      ouroObservar(j, 'LIVE', t.name, rawWin, model.p0);
      const calibration = ouroCalibrar('LIVE', t.name, rawWin, model.p0);
      const win = calibration.win, loss = calibration.loss;
      if (win < OURO.PROB_LIVE) { ouroDiag('PROB_LIVE_BAIXA', j, ouroPct(win)); continue; }
      const evMin = ouroEvMinAjustado(model);
      oddCount++;
      let quote;
      try { quote = ouroOdd(j, t.period, t.line, true); }
      catch (e) { ouroDiag('ERRO_ODD_LIVE', j, e.message); continue; }
      if (!quote) continue;
      if (ouroEV(quote.odd, win, loss) < evMin) {
        ouroDiag('ODD_LIVE_SEM_VALOR', j, quote.odd + ' < ' + ouroMinOdd(win, loss, evMin)); continue;
      }
      if (!ouroRecheck(j, true)) { ouroDiag('PLACAR_MUDOU', j); continue; }
      try {
        if (ouroSinal(j, 'LIVE', t.name, t.period, t.line, quote, win, loss,
            Object.assign({}, model, {shots: pressure.shots,
              target: pressure.target, calibracao: calibration,
              evMinAplicado: evMin}))) d.sinais++;
      } catch (e) { ouroDiag('ENVIO_FALHOU', j, e.message); }
    }
  }
  d.oddsLiveConsultadas = oddCount;
}
function ouroPre(d) {
  const now = Date.now();
  if (now - ouroGet('OURO10_PRE_LAST', 0) < 9 * 60000) return;
  let all = [];
  [ouroDay(0), ouroDay(1)].forEach(date => {
    try { all.push(...ouroApi('/fixtures?date=' + date +
      '&timezone=America%2FSao_Paulo', 900, 5, 1)); }
    catch (e) { ouroDiag('ERRO_AGENDA', null, e.message); }
  });
  const uniq = Array.from(new Map(all.map(j => [j.fixture.id, j])).values());
  d.agenda = uniq.length;
  const candidates = uniq.filter(j => j.fixture.status.short === 'NS' &&
    Date.parse(j.fixture.date) - now >= 20 * 60000 &&
    Date.parse(j.fixture.date) - now <= 18 * 3600000)
    .sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
  d.preElegiveis = candidates.length;
  // Jogos que começam em breve primeiro; rodízio entre os demais.
  const soon = candidates.filter(j => Date.parse(j.fixture.date) - now <= 3 * 3600000);
  const later = candidates.filter(j => Date.parse(j.fixture.date) - now > 3 * 3600000);
  const soonRotation = ouroGet('OURO10_SROT', 0);
  const soonStart = soon.length ? soonRotation % soon.length : 0;
  const soonRotated = soon.slice(soonStart).concat(soon.slice(0, soonStart));
  ouroSet('OURO10_SROT', soonRotation + OURO.PRE_LOTE - 2);
  const rotation = ouroGet('OURO10_PROT', 0);
  const start = later.length ? rotation % later.length : 0;
  const rotated = later.slice(start).concat(later.slice(0, start));
  ouroSet('OURO10_PROT', rotation + OURO.PRE_LOTE);
  const selected = soonRotated.slice(0, OURO.PRE_LOTE - 2).concat(
    rotated.slice(0, OURO.PRE_LOTE - Math.min(soon.length, OURO.PRE_LOTE - 2)));
  d.preSelecionados = selected.length;
  let oddsCount = 0;
  for (const j of selected) {
    if (ouroRun.calls >= ouroRun.budget - 6 ||
        Date.now() - ouroRun.start > OURO.MAX_SEGUNDOS * 1000 - 12000 ||
        oddsCount >= OURO.PRE_ODDS || d.sinais >= OURO.MAX_SINAIS) break;
    let model;
    try { model = ouroModelo(j, 'MATCH', null); }
    catch (e) { ouroDiag('HIST_PRE', j, e.message); continue; }
    if (!model) continue;
    d.preAnalisados++;
    ouroObservar(j, 'PRE', 'OVER_15_FT', model.p2, model.p0 + model.p1);
    ouroObservar(j, 'PRE', 'OVER_10_ASIAN_FT', model.p2, model.p0);
    const evMin = ouroEvMinAjustado(model);
    const targets = [
      {name: 'OVER_15_FT', line: 1.5, win: model.p2, loss: model.p0 + model.p1},
      {name: 'OVER_10_ASIAN_FT', line: 1, win: model.p2, loss: model.p0}
    ].map(t => Object.assign(t, {calibracao: ouroCalibrar('PRE', t.name,
      t.win, t.loss)})).filter(t => t.calibracao.win >= OURO.PROB_PRE &&
      !ouroProps().getProperty('OURO10_S_' + j.fixture.id + '_PRE_' + t.name));
    if (!targets.length) { ouroDiag('PROB_PRE_BAIXA_OU_REPETIDO', j); continue; }
    let oddQueried = false;
    for (const t of targets) {
      if (oddsCount >= OURO.PRE_ODDS || d.sinais >= OURO.MAX_SINAIS ||
          ouroRun.calls >= ouroRun.budget - 4) break;
      if (!oddQueried) { oddsCount++; oddQueried = true; }
      let quote;
      try { quote = ouroOdd(j, 'MATCH', t.line, false); }
      catch (e) { ouroDiag('ERRO_ODD_PRE', j, e.message); continue; }
      if (!quote) continue;
      if (ouroEV(quote.odd, t.calibracao.win, t.calibracao.loss) < evMin) {
        ouroDiag('ODD_PRE_SEM_VALOR', j, quote.odd + ' < ' +
          ouroMinOdd(t.calibracao.win, t.calibracao.loss, evMin)); continue;
      }
      if (!ouroRecheck(j, false)) { ouroDiag('JOGO_INICIOU', j); continue; }
      try {
        if (ouroSinal(j, 'PRE', t.name, 'MATCH', t.line, quote,
            t.calibracao.win, t.calibracao.loss,
            Object.assign({}, model, {calibracao: t.calibracao,
              evMinAplicado: evMin}))) d.sinais++;
      } catch (e) { ouroDiag('ENVIO_FALHOU', j, e.message); }
    }
  }
  d.oddsPreConsultadas = oddsCount;
  ouroSet('OURO10_PRE_LAST', Date.now());
}
function ouroChecarErrosConsecutivos(d) {
  const seq = ouroGet('OURO10_ERRSEQ', 0);
  if (d.erros.length) {
    const next = seq + 1;
    ouroSet('OURO10_ERRSEQ', next);
    if (next >= OURO.ERRO_ALERTA_LIMITE && next % OURO.ERRO_ALERTA_LIMITE === 0) {
      try {
        ouroTelegram('ALERTA SCANNER OURO\n' + next +
          ' rodadas seguidas com erro.\nÚltimo: ' + d.erros[d.erros.length - 1]);
      } catch (e) { console.log('ALERTA_TELEGRAM: ' + e.message); }
    }
  } else if (seq) {
    ouroSet('OURO10_ERRSEQ', 0);
  }
}
function rodarScannerOver() {
  return ouroRodada('scan', () => {
    const d = {at: ouroDate(), live: 0, janelaLive: 0, liveSelecionados: 0,
      oddsLiveConsultadas: 0, agenda: 0, preElegiveis: 0, preSelecionados: 0,
      preAnalisados: 0, oddsPreConsultadas: 0, sinais: 0,
      motivos: {}, amostras: [], erros: []};
    ouroRun.d = d;
    try { ouroLive(d); } catch (e) { d.erros.push('LIVE: ' + e.message); }
    try { ouroPre(d); } catch (e) { d.erros.push('PRE: ' + e.message); }
    d.calls = ouroRun.calls; d.budget = ouroRun.budget;
    d.quota = ouroRun.quota.used; d.routes = ouroRun.routes;
    ouroSet('OURO10_DIAG', d);
    console.log(JSON.stringify(d));
    ouroChecarErrosConsecutivos(d);
    ouroResumoAuto(d);
    return d;
  });
}
function ouroResumoAuto(d) {
  const a = ouroGet('OURO10_RESUMO', {last: 0, rounds: 0, signals: 0, reasons: {}});
  a.rounds++; a.signals += d.sinais;
  Object.keys(d.motivos).forEach(k => { a.reasons[k] =
    (a.reasons[k] || 0) + d.motivos[k]; });
  if (Date.now() - a.last < 60 * 60000) { ouroSet('OURO10_RESUMO', a); return; }
  const reasons = Object.keys(a.reasons)
    .sort((x, y) => a.reasons[y] - a.reasons[x]).slice(0, 6)
    .map(k => a.reasons[k] + ' ' + k).join('\n');
  ouroSet('OURO10_RESUMO', {last: Date.now(), rounds: 0, signals: 0, reasons: {}});
  try { ouroTelegram('RESUMO OURO V10.8 ' + ouroDate() + ' BRT\nRodadas: ' +
    a.rounds + ' | Sinais: ' + a.signals + '\nAo vivo: ' + d.live +
    ' | Na janela: ' + d.janelaLive + '\nPré elegíveis: ' + d.preElegiveis +
    '\nMotivos:\n' + (reasons || 'Nenhum') + '\nAPI: ' + d.quota +
    '/' + OURO.TETO_DIA); }
  catch (e) { console.log('RESUMO_TELEGRAM: ' + e.message); }
}
function ouroPlacarSeguro(score) {
  if (!score) return null;
  const home = ouroN(score.home), away = ouroN(score.away);
  if (home === null || away === null || !Number.isInteger(home) ||
      !Number.isInteger(away) || home < 0 || away < 0) return null;
  return {home, away, total: home + away};
}
function ouroDadosConferencia(j) {
  return {status: j.fixture.status.short, at: new Date().toISOString(),
    ht: ouroPlacarSeguro(j.score && j.score.halftime),
    ft: ouroPlacarSeguro(j.score && j.score.fulltime)};
}
function ouroLiquidar(rec, j) {
  const market = rec.market || rec.mercado;
  const data = ouroDadosConferencia(j), status = data.status;
  if (['PST', 'SUSP', 'INT'].includes(status)) return null;
  if (['CANC', 'ABD', 'AWD', 'WO'].includes(status)) return 'REVISAO';
  const halfReady = ['HT', '2H', 'FT', 'AET', 'PEN'].includes(status);
  const fullReady = ['FT', 'AET', 'PEN'].includes(status);
  const ht = data.ht, ft = data.ft;
  if (ht && ft && (ft.home < ht.home || ft.away < ht.away)) return null;
  if (market === 'OVER_05_HT') return halfReady && ht ?
    (ht.total >= 1 ? 'GREEN' : 'RED') : null;
  if (market === 'OVER_05_2T') return fullReady && ht && ft ?
    (ft.total - ht.total >= 1 ? 'GREEN' : 'RED') : null;
  if (!fullReady || !ft) return null;
  if (market === 'OVER_10_ASIAN_FT')
    return ft.total >= 2 ? 'GREEN' : ft.total === 1 ? 'DEVOLVIDA' : 'RED';
  if (market === 'OVER_15_FT') return ft.total >= 2 ? 'GREEN' : 'RED';
  return 'REVISAO';
}
function ouroPrecisaAuditoria(r) {
  if (!r || !r.enviado || r.auditoriaFinal) return false;
  if (r.auditoriaPendente) return true;
  const at = Date.parse(r.criado || r.criadoEm || '');
  const age = Date.now() - at;
  return Number.isFinite(age) && age >= 0 &&
    age <= OURO.AUDITORIA_RETRO_HORAS * 3600000;
}
function ouroAuditoriaFinal(j) {
  const d = ouroDadosConferencia(j);
  const final = ['FT', 'AET', 'PEN'].includes(d.status);
  const exceptional = ['CANC', 'ABD', 'AWD', 'WO'].includes(d.status);
  if ((!final && !exceptional) || (final && !d.ft)) return null;
  const out = {at: d.at, status: d.status, ht: d.ht, ft: d.ft,
    golsSegundoTempo: d.ht && d.ft ? d.ft.total - d.ht.total : null,
    eventos: 'ND', gols: [], vermelhos: [],
    estatisticas: {cobertura: 'ND'}};
  if (exceptional) return out;
  try {
    const events = ouroApi('/fixtures/events?fixture=' + j.fixture.id, 0, 0, 1);
    if (Array.isArray(events)) {
      out.eventos = events.length ? 'OK' : 'SEM_EVENTOS';
      events.forEach(e => {
        const minute = ouroN((e.time || {}).elapsed);
        if (minute === null || minute > 90) return;
        const extra = ouroN((e.time || {}).extra);
        const when = String(minute) + (extra > 0 ? '+' + extra : '') + "'";
        const team = (e.team || {}).name || 'Time ND';
        const type = String(e.type || ''), detail = String(e.detail || '');
        const item = {minuto: when, time: team, tipo: detail || type};
        if (/goal/i.test(type) && !/missed|cancel|disallow/i.test(detail))
          out.gols.push(item);
        if (/card/i.test(type) && /red/i.test(detail)) out.vermelhos.push(item);
      });
    }
  } catch (e) { console.log('AUDITORIA_EVENTOS_' + j.fixture.id + ': ' + e.message); }
  try {
    const raw = Array.isArray(j.statistics) && j.statistics.length ?
      j.statistics : ouroApi('/fixtures/statistics?fixture=' + j.fixture.id, 0, 0, 1);
    const stats = ouroStats(Object.assign({}, j, {statistics: raw}));
    if (ouroStatsOK(stats)) {
      function xg(id) {
        const row = raw.find(x => x.team && Number(x.team.id) === Number(id));
        const found = ((row || {}).statistics || [])
          .find(x => /^(expected goals|xg)$/i.test(String(x.type || '').trim()));
        return found ? ouroN(found.value) : null;
      }
      out.estatisticas = {cobertura: 'OK',
        chutes: [stats[0].shots, stats[1].shots],
        noAlvo: [stats[0].target, stats[1].target],
        xg: [xg(j.teams.home.id), xg(j.teams.away.id)]};
    }
  } catch (e) { console.log('AUDITORIA_STATS_' + j.fixture.id + ': ' + e.message); }
  return out;
}
function ouroTextoConferencia(r) {
  const d = r.conferencia, market = r.market || r.mercado;
  const title = (r.correcaoFinal ? 'RETIFICAÇÃO: ' : '') +
    ({GREEN: 'GREEN', RED: 'RED', DEVOLVIDA: 'DEVOLVIDA',
      REVISAO: 'REVISÃO MANUAL'}[r.resultado] || r.resultado);
  let score;
  if (market === 'OVER_05_HT' && d.ht) {
    score = 'Intervalo: ' + d.ht.home + '-' + d.ht.away +
      ' | Gols 1ºT: ' + d.ht.total;
  } else if (market === 'OVER_05_2T' && d.ht && d.ft) {
    score = 'Intervalo: ' + d.ht.home + '-' + d.ht.away +
      ' | FT (90 min): ' + d.ft.home + '-' + d.ft.away +
      ' | Gols 2ºT: ' + (d.ft.total - d.ht.total);
  } else if (d.ft) {
    score = 'FT (90 min): ' + d.ft.home + '-' + d.ft.away +
      ' | Total: ' + d.ft.total + ' gols';
  } else {
    score = 'Status: ' + d.status;
  }
  const reason = r.resultado === 'REVISAO' ?
    '\nJogo não concluído normalmente; confira a regra da casa.' :
    r.resultado === 'DEVOLVIDA' ?
      '\nOver 1,0 asiático: 1 gol devolve a stake.' : '';
  const entry = (r.mode || r.modo) === 'LIVE' ?
    '\nEntrada: ' + r.minuto + "' | " + (r.score || r.placarNoSinal || 'ND') : '';
  return 'SCANNER OURO | ' + title + ' (SIMULADO) #' + r.fixtureId + '\n' +
    r.casa + ' x ' + r.fora + '\n' +
    ouroMercadoTexto(market) + ' | Odd registrada: ' + ouroOddTexto(r.odd) +
    entry + '\n' + score + reason + '\n' +
    'Fonte: API-Football | ' + ouroDate(d.at) + ' BRT\n' +
    'Conferência do sinal; confirme a liquidação na casa.';
}
function ouroAvisarResultado(key, r) {
  if (!r.enviado || r.notificado || !r.conferencia) return false;
  try {
    const messageId = ouroTelegram(ouroTextoConferencia(r));
    r.notificado = true;
    r.messageIdResultado = messageId;
    ouroSet(key, r);
    return true;
  } catch (e) {
    r.ultimoErroAviso = String(e.message).slice(0, 150);
    ouroSet(key, r);
    console.log('CONFERENCIA_TELEGRAM: ' + e.message);
    return false;
  }
}
function conferirResultadosPendentes() {
  const out = ouroRodada('settle', () => {
    const eligible = ouroTodosRegistros().filter(k => {
      const r = ouroGet(k, null);
      return r && r.fixtureId && (r.resultado === 'PENDENTE' ||
        (r.enviado && !r.notificado) || ouroPrecisaAuditoria(r));
    });
    if (!eligible.length) return {pendentes: 0, concluidos: 0,
      auditorias: 0, avisos: 0, observacoes: ouroConferirObservacoes()};
    const cursor = ouroGet('OURO10_CONFCURSOR', 0) % eligible.length;
    const keys = eligible.slice(cursor).concat(eligible.slice(0, cursor)).slice(0, 50);
    ouroSet('OURO10_CONFCURSOR', (cursor + keys.length) % eligible.length);
    let done = 0, avisos = 0, auditorias = 0;
    // Resultados já conferidos são reenviados sem depender de nova consulta à API.
    keys.forEach(k => {
      const r = ouroGet(k, null);
      if (r.resultado !== 'PENDENTE' && r.conferencia &&
          ouroAvisarResultado(k, r)) avisos++;
    });
    const query = keys.filter(k => {
      const r = ouroGet(k, null);
      return r.resultado === 'PENDENTE' || !r.conferencia ||
        ouroPrecisaAuditoria(r);
    });
    const ids = Array.from(new Set(query.map(k => ouroGet(k, null).fixtureId)));
    const finalCache = {};
    for (let i = 0; i < ids.length; i += 20) {
      let rows;
      try { rows = ouroApi('/fixtures?ids=' + ids.slice(i, i + 20).join('-'), 0, 0, 1); }
      catch (e) { console.log('CONFERENCIA: ' + e.message); break; }
      const map = {}; rows.forEach(j => { map[j.fixture.id] = j; });
      query.forEach(k => {
        const r = ouroGet(k, null), j = r && map[r.fixtureId];
        if (!j) return;
        if (r.resultado === 'PENDENTE') {
          const result = ouroLiquidar(r, j);
          if (!result) return;
          r.resultado = result; r.fechado = new Date().toISOString();
          done++;
        } else if (!r.conferencia &&
            r.resultado !== ouroLiquidar(r, j) && r.resultado !== 'REVISAO') {
          return; // Um registro antigo sem placar precisa de revisão manual.
        }
        if (r.conferencia && (r.market || r.mercado) === 'OVER_05_HT' &&
            ['FT', 'AET', 'PEN'].includes(j.fixture.status.short)) {
          const official = ouroLiquidar(r, j);
          if (official && official !== r.resultado) {
            r.resultadoAnterior = r.resultado; r.resultado = official;
            r.correcaoFinal = true; r.notificado = false;
            r.conferencia = ouroDadosConferencia(j);
          }
        }
        if (!r.conferencia) r.conferencia = ouroDadosConferencia(j);
        if (ouroPrecisaAuditoria(r)) {
          if (!(j.fixture.id in finalCache))
            finalCache[j.fixture.id] = ouroAuditoriaFinal(j);
          if (finalCache[j.fixture.id]) {
            r.auditoriaFinal = finalCache[j.fixture.id];
            r.auditoriaPendente = false;
            auditorias++;
          }
        }
        ouroSet(k, r);
        ouroRegistrarAprendizado(r);
        ouroRegistrarPressao(r);
        if (ouroAvisarResultado(k, r)) avisos++;
      });
    }
    const result = {consultados: keys.length, concluidos: done, auditorias, avisos,
      pendentes: ouroTodosRegistros().filter(k => {
        const r = ouroGet(k, null); return r && r.resultado === 'PENDENTE';
      }).length};
    result.observacoes = ouroConferirObservacoes();
    console.log(JSON.stringify(result)); return result;
  });
  if (out && ouroRegistros().length >= 145) {
    try { arquivarResultadosConcluidos(); }
    catch (e) { console.log('ARQUIVO_AUTOMATICO: ' + e.message); }
  }
  return out;
}
function diagnosticoScanner() {
  const d = ouroGet('OURO10_DIAG', null);
  console.log(JSON.stringify(d || {erro: 'Ainda não há varredura V10.8'}, null, 2));
  return d;
}
function ouroDiaEnvio(r) {
  const date = new Date(r.criado || r.criadoEm || r.inicio || '');
  return Number.isNaN(date.getTime()) ? null :
    Utilities.formatDate(date, OURO.TZ, 'yyyy-MM-dd');
}
function ouroLerArquivo(id) {
  const rows = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString());
  if (!Array.isArray(rows)) throw Error('ARQUIVO_INVALIDO');
  return rows;
}
function ouroLerSinais() {
  const seen = {}, sinais = [], erros = [];
  function add(r, archived) {
    if (!r || !r.fixtureId) return;
    const key = r.id || [r.fixtureId, r.mode || r.modo,
      r.market || r.mercado].join('_');
    if (seen[key]) return;
    seen[key] = true;
    sinais.push(Object.assign({}, r, {arquivoHistorico: !!archived}));
  }
  ouroTodosRegistros().forEach(k => add(ouroGet(k, null), false));
  const archives = ouroGet('OURO10_ARQUIVOS', []);
  if (!Array.isArray(archives)) erros.push('INDICE_ARQUIVOS_INVALIDO');
  (Array.isArray(archives) ? archives : []).forEach(id => {
    try { ouroLerArquivo(id).forEach(r => add(r, true)); }
    catch (e) { erros.push(String(id) + ': ' + e.message); }
  });
  return {sinais, erros};
}
function ouroRelatorioDia(day, all) {
  const sinais = all.filter(r => r.enviado && ouroDiaEnvio(r) === day)
    .sort((a, b) => Date.parse(a.criado || a.criadoEm || '') -
      Date.parse(b.criado || b.criadoEm || ''));
  const count = {GREEN: 0, RED: 0, DEVOLVIDA: 0, REVISAO: 0, PENDENTE: 0};
  const mercados = {}, needsAudit = sinais.filter(r =>
    r.resultado !== 'PENDENTE' && !r.auditoriaFinal &&
    !r.arquivoHistorico && ouroPrecisaAuditoria(r)).length;
  let profit = 0, units = 0;
  sinais.forEach(r => {
    if (count[r.resultado] !== undefined) count[r.resultado]++;
    const market = r.market || r.mercado || 'ND';
    if (!mercados[market]) mercados[market] = {GREEN: 0, RED: 0,
      DEVOLVIDA: 0, REVISAO: 0, PENDENTE: 0};
    if (mercados[market][r.resultado] !== undefined)
      mercados[market][r.resultado]++;
    const odd = ouroN(r.odd);
    if (odd !== null && odd > 1 &&
        ['GREEN', 'RED', 'DEVOLVIDA'].includes(r.resultado)) {
      units++;
      profit += r.resultado === 'GREEN' ? odd - 1 :
        r.resultado === 'RED' ? -1 : 0;
    }
  });
  const groups = Array.from(new Set(sinais.map(r =>
    (r.mode || r.modo) + '|' + (r.market || r.mercado))));
  const aprendizado = groups.map(group => {
    const parts = group.split('|');
    return ouroResumoAprendizado(parts[0], parts[1]);
  });
  return {dia: day, total: sinais.length, count, mercados, aprendizado,
    auditoriasPendentes: needsAudit,
    taxaGreen: count.GREEN + count.RED ?
      ouroPct(count.GREEN / (count.GREEN + count.RED)) : 'ND',
    roiBackTeorico: units ? ouroPct(profit / units) : 'ND',
    unidadesBack: units, sinais};
}
function ouroLinhaDia(r) {
  const d = r.auditoriaFinal || r.conferencia || {};
  const format = p => p ? p.home + '-' + p.away : 'ND';
  const mode = r.mode || r.modo;
  const entry = mode === 'LIVE' ? r.minuto + "' " +
    (r.score || r.placarNoSinal || 'ND') : 'pré';
  const goals = d.eventos === 'OK' ?
    (d.gols.length ? d.gols.map(x => x.minuto).join(',') :
      d.ft && d.ft.total === 0 ? 'nenhum' : 'ND') : 'ND';
  const red = d.eventos === 'OK' ?
    (d.vermelhos.length ? d.vermelhos.map(x => x.minuto).join(',') : 'nenhum') : 'ND';
  return (r.resultado || 'PENDENTE') + ' | ' + r.casa + ' x ' + r.fora +
    ' | ' + ouroMercadoTexto(r.market || r.mercado) + ' @' +
    ouroOddTexto(r.odd) + ' P' + ouroPct(ouroN(r.pWin)) + '\n' +
    'Entrada ' + entry + ' | HT ' + format(d.ht) + ' | FT ' +
    format(d.ft) + ' | Gols ' + goals + ' | Vermelhos ' + red;
}
function ouroPaginasDia(report, partial) {
  const c = report.count;
  const title = 'SCANNER OURO | ' + (partial ? 'PARCIAL' : 'FECHAMENTO FINAL') +
    ' ' + report.dia + ' (SIMULADO)';
  const header = title + '\nSinais ' + report.total + ' | ' +
    c.GREEN + 'G ' + c.RED + 'R ' + c.DEVOLVIDA + 'D ' +
    c.REVISAO + ' revisão | ' + c.PENDENTE + ' pendentes\n' +
    'Taxa Green ' + report.taxaGreen + ' (sem devoluções) | ROI Back teórico ' +
    report.roiBackTeorico + ' (1u/sinal)\n' +
    'Auditorias ainda pendentes: ' + report.auditoriasPendentes + '\n' +
    'Calibração ativa: ' + report.aprendizado.filter(x => x.status === 'ATIVO').length +
    '/' + report.aprendizado.length + ' grupos (detalhes no relatório)';
  const marketLines = Object.keys(report.mercados).map(m => {
    const v = report.mercados[m];
    return ouroMercadoTexto(m) + ': ' + v.GREEN + 'G/' + v.RED +
      'R/' + v.DEVOLVIDA + 'D';
  }).join('\n');
  const prefix = header + '\n' + marketLines + '\n';
  let pages = [], body = '';
  report.sinais.forEach((r, index) => {
    const line = (index + 1) + '. ' + ouroLinhaDia(r) + '\n';
    if (body && prefix.length + body.length + line.length > 3400) {
      pages.push(body); body = '';
    }
    body += line;
  });
  if (body) pages.push(body);
  return pages.map((part, index) => prefix + 'Parte ' +
    (index + 1) + '/' + pages.length + '\n' + part +
    (index === pages.length - 1 ?
      'Detalhes completos salvos no relatório diário. ND = não informado.' : ''));
}
function verAuditoriaDoDia(day) {
  const date = day || ouroDay(0);
  const data = ouroLerSinais();
  if (data.erros.length) throw Error('ARQUIVOS_INDISPONIVEIS: ' + data.erros.join('; '));
  const report = ouroRelatorioDia(date, data.sinais);
  console.log(JSON.stringify(report, null, 2));
  return report;
}
function ouroLimparFechosAntigos() {
  const today = ouroDay(0);
  if (ouroGet('OURO10_FECHO_LIMPEZA', '') === today) return;
  const limit = Date.now() - OURO.FECHO_RETENCAO_DIAS * 86400000;
  const props = ouroProps();
  Object.keys(props.getProperties()).forEach(k => {
    const m = k.match(/^OURO10_FECHO_(\d{4}-\d{2}-\d{2})$/);
    if (m && Date.parse(m[1] + 'T00:00:00-03:00') < limit) props.deleteProperty(k);
  });
  ouroSet('OURO10_FECHO_LIMPEZA', today);
}
function conferenciaFinalDoDia() {
  return ouroRodada('daily', () => {
    ouroLimparFechosAntigos();
    const data = ouroLerSinais();
    if (data.erros.length) {
      console.log('FECHO_ARQUIVOS: ' + data.erros.join('; '));
      return {erro: 'ARQUIVOS_INDISPONIVEIS', detalhes: data.erros};
    }
    const today = ouroDay(0), start = ouroGet('OURO10_FECHO_INICIO', today);
    const hour = Number(Utilities.formatDate(new Date(), OURO.TZ, 'HH'));
    const days = Array.from(new Set(data.sinais
      .filter(r => r.enviado).map(ouroDiaEnvio)
      .filter(d => d && d >= start && d < today))).sort();
    const result = {dias: days.length, fechados: 0, parciais: 0};
    days.forEach(day => {
      const report = ouroRelatorioDia(day, data.sinais);
      if (!report.total) return;
      const pending = report.count.PENDENTE + report.auditoriasPendentes;
      const phase = pending ? 'parcial' : 'final';
      // O parcial espera até 02h BRT do dia seguinte para jogos que acabam tarde.
      if (phase === 'parcial' && day === ouroDay(-1) && hour < 2) return;
      const key = 'OURO10_FECHO_' + day, state = ouroGet(key, {});
      if (state[phase] && state[phase].done) return;
      if (phase === 'final' && !state.arquivoId) {
        try {
          const content = JSON.stringify(report);
          const file = DriveApp.createFile('scanner_ouro_auditoria_' + day +
            '.json', content, 'application/json');
          if (file.getBlob().getDataAsString() !== content)
            throw Error('ARQUIVO_NAO_CONFIRMADO');
          state.arquivoId = file.getId(); ouroSet(key, state);
        } catch (e) {
          console.log('FECHO_DRIVE_' + day + ': ' + e.message);
          return;
        }
      }
      const pages = ouroPaginasDia(report, phase === 'parcial');
      const progress = state[phase] || {next: 0, done: false};
      try {
        for (let i = progress.next; i < pages.length; i++) {
          ouroTelegram(pages[i]);
          progress.next = i + 1;
          state[phase] = progress;
          ouroSet(key, state);
        }
        progress.done = true; state[phase] = progress; ouroSet(key, state);
        result[phase === 'final' ? 'fechados' : 'parciais']++;
      } catch (e) { console.log('FECHO_TELEGRAM_' + day + ': ' + e.message); }
    });
    console.log(JSON.stringify(result)); return result;
  });
}
function resumoResultados() {
  const count = {GREEN: 0, RED: 0, DEVOLVIDA: 0, REVISAO: 0, PENDENTE: 0};
  const seen = {};
  function add(r) {
    if (!r || count[r.resultado] === undefined) return;
    const id = r.id || [r.fixtureId, r.mode || r.modo,
      r.market || r.mercado].join('_');
    if (seen[id]) return;
    seen[id] = true;
    count[r.resultado]++;
  }
  ouroTodosRegistros().forEach(k => {
    add(ouroGet(k, null));
  });
  let arquivosIndisponiveis = 0;
  ouroGet('OURO10_ARQUIVOS', []).forEach(id => {
    try { ouroLerArquivo(id).forEach(add); }
    catch (e) {
      arquivosIndisponiveis++;
      console.log('RESUMO_ARQUIVO_INDISPONIVEL: ' + id + ' ' + e.message);
    }
  });
  count.avaliados = count.GREEN + count.RED;
  count.taxaGreenSimulada = count.avaliados ?
    ouroPct(count.GREEN / count.avaliados) : 'ND';
  count.arquivosIndisponiveis = arquivosIndisponiveis;
  console.log(JSON.stringify(count)); return count;
}
function arquivarResultadosConcluidos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw Error('SCANNER_OCUPADO');
  try {
    const done = ouroRegistros().map(k => ({key: k, r: ouroGet(k, null)}))
      .filter(x => x.r && ['GREEN', 'RED', 'DEVOLVIDA', 'REVISAO']
        .includes(x.r.resultado) && x.r.enviado && x.r.notificado &&
        (x.r.auditoriaFinal || !ouroPrecisaAuditoria(x.r)));
    if (!done.length) { console.log('Nenhum resultado V10 para arquivar.'); return 0; }
    const content = JSON.stringify(done.map(x => x.r));
    const file = DriveApp.createFile('scanner_ouro_v10_' + Date.now() + '.json',
      content, 'application/json');
    if (file.getBlob().getDataAsString() !== content) throw Error('ARQUIVO_NAO_CONFIRMADO');
    const ids = ouroGet('OURO10_ARQUIVOS', []);
    ids.push(file.getId()); ouroSet('OURO10_ARQUIVOS', ids);
    done.forEach(x => ouroProps().deleteProperty(x.key));
    console.log('Arquivados: ' + done.length); return done.length;
  } finally { lock.releaseLock(); }
}
function testarConexoes() {
  return ouroRodada('test', () => {
    const status = ouroApi('/status', 0, 0, 1);
    ouroTelegram('SCANNER OURO V10.8\nAPI: OK\nTelegram: OK\nConsumo: ' +
      JSON.stringify(status.requests || 'ND'));
    return {api: 'OK', telegram: 'OK', requests: status.requests || null};
  });
}
function auditarProbabilidadesEOdds() {
  return diagnosticoScanner(); // Diagnóstico da última rodada: motivos e exemplos reais.
}
function pararScanner() {
  const names = ['rodarScannerOver', 'rodarScanner12G', 'rodarScannerGratis',
    'rodarScannerPro', 'monitorarJogosAoVivo', 'conferirResultadosPendentes',
    'conferenciaFinalDoDia'];
  ScriptApp.getProjectTriggers().forEach(t => {
    if (names.includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
  console.log('Acionadores antigos do scanner removidos.');
}
function instalarScannerOver() {
  if (!OURO.API_KEY || !OURO.TELEGRAM_TOKEN || !OURO.TELEGRAM_CHAT_ID)
    throw Error('CREDENCIAIS_AUSENTES: cadastre OURO_API_KEY, OURO_TELEGRAM_TOKEN ' +
      'e OURO_TELEGRAM_CHAT_ID nas Propriedades do script');
  if (!ouroGet('OURO10_FECHO_INICIO', null))
    ouroSet('OURO10_FECHO_INICIO', ouroDay(0));
  pararScanner();
  ScriptApp.newTrigger('rodarScannerOver').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('conferirResultadosPendentes').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('conferenciaFinalDoDia').timeBased().everyHours(1).create();
  ouroTelegram('SCANNER OURO V10.8 INSTALADO\nVarredura: ~5 min; resultado: ~10 min.' +
    '\nFechamento diário: ~1 h após o dia terminar e os sinais concluírem.' +
    '\nAlertas simulados; não aposta automaticamente.');
  console.log('SCANNER OURO V10.8 INSTALADO');
}
function rodarScanner12G() { return rodarScannerOver(); }
function instalarScanner12G() { return instalarScannerOver(); }
