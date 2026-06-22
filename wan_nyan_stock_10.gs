// ============================================================
// ワンニャン株式予報  v10
//   ハチ（柴犬）  : マクロ・地合い分析 / 順張り
//   ミケ（三毛猫）: テクニカル分析 / 逆張り・リスク管理
//
//   現在値・前日比  → GOOGLEFINANCE（最大20分遅延）
//   過去日足        → Yahoo Finance 非公式API
//
//   v10変更点：
//     ・pool を52銘柄→34銘柄に削減（実行時間短縮）
//     ・analyzeTechnical に rciShortPrev（前日RCI）を追加
//       → detectWBottomPattern_ での二重計算を廃止（対策B）
//     ・runDailyAnalysis からカピバラ・ピヨトンを分離
//       → 17:00 ハチ＋ミケ、17:30 カピバラ、18:00 ピヨ＋トン
//       → setupTriggers() で3本まとめて設定（対策A）
// ============================================================

var GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY';
var GEMINI_URL     = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';
var SHEET_NAME        = 'industry';
var REPORT_SHEET      = 'AI_report';
var WEEKLY_SHEET      = 'weekly_report';
var WATCH_SHEET       = 'watchlist';
var WATCH_REPORT_SHEET= 'watch_report';
var POOL_SHEET        = 'pool';
var SCREEN_TOP_N      = 8;

// スクリーニング戦略プリセット
var PRESETS = {
  gyaku:   {label: '逆張り（売られすぎ）',      hint: '下げすぎの反発を拾う'},
  jun:     {label: '順張り（トレンドフォロー）',  hint: '上昇トレンドに乗る'},
  brk:     {label: 'ブレイクアウト',            hint: '高値圏の勢いを追う'},
  oshime:  {label: '押し目買い',                hint: '上昇中の一時的な下げを狙う'},
  kanetsu: {label: '過熱検出（利確目安）',       hint: '買われすぎ銘柄を見つける'},
  wbottom: {label: '底打ち感検出',              hint: 'Wボトム＋陽線回復の底打ち候補'}
};

function getPresetId_() {
  var id = '';
  try { id = PropertiesService.getScriptProperties().getProperty('SCREEN_PRESET') || ''; } catch (e) {}
  return PRESETS[id] ? id : 'gyaku';
}
function setPresetFromApp(id) {
  if (!PRESETS[id]) { return {ok: false, msg: '不明なプリセットです'}; }
  PropertiesService.getScriptProperties().setProperty('SCREEN_PRESET', id);
  return {ok: true, label: PRESETS[id].label};
}

var HORIZONS  = {short: '短期（〜2週間）', mid: '中期（2週間〜1か月）', long: '長期（1か月〜）'};
var SIZES     = {all: '指定なし', large: '大型中心', small: '中小型中心'};
var PRICECAPS = {0: '指定なし', 500: '500円以下', 1000: '1,000円以下', 3000: '3,000円以下'};

function getOpt_(key, def) {
  var v = '';
  try { v = PropertiesService.getScriptProperties().getProperty(key) || ''; } catch (e) {}
  return v || def;
}
function getHorizon_()  { var v = getOpt_('SCREEN_HORIZON',  'mid'); return HORIZONS[v]              ? v : 'mid'; }
function getSize_()     { var v = getOpt_('SCREEN_SIZE',     'all'); return SIZES[v]                 ? v : 'all'; }
function getPriceCap_() { var v = parseInt(getOpt_('SCREEN_PRICECAP', '0'), 10); return PRICECAPS[v] !== undefined ? v : 0; }

function setScreenOptionsFromApp(horizon, size, cap) {
  var props = PropertiesService.getScriptProperties();
  if (HORIZONS[horizon])                          { props.setProperty('SCREEN_HORIZON',  horizon); }
  if (SIZES[size])                                { props.setProperty('SCREEN_SIZE',     size); }
  if (PRICECAPS[parseInt(cap, 10)] !== undefined) { props.setProperty('SCREEN_PRICECAP', String(cap)); }
  return {ok: true, msg: '設定を保存しました。次回の抽出から反映されます'};
}

var WEEKLY_NAME  = 'ソラ';
var WEEKLY_EMOJI = '🐕';
var WATCH_NAME   = 'カピバラ';
var WATCH_EMOJI  = '🦫';
var BIRD_NAME    = 'ピヨ';
var BIRD_EMOJI   = '🐦';
var PIG_NAME     = 'トン';
var PIG_EMOJI    = '🐷';
var MY_SHEET        = 'my_stocks';
var MY_REPORT_SHEET = 'mystock_report';

var INDICES = [
  {name: '日経平均',       symbol: '^N225'},
  {name: 'TOPIX(ETF1306)', symbol: '1306.T'},
  {name: 'NYダウ',         symbol: '^DJI'},
  {name: 'S&P500',         symbol: '^GSPC'},
  {name: 'NASDAQ',         symbol: '^IXIC'},
  {name: 'ドル円',         symbol: 'JPY=X'}
];

var MA_LINES    = [5, 25, 75];
var SMA_SHORT   = 5;
var SMA_LONG    = 25;
var RCI_SHORT   = 9;
var RCI_LONG    = 26;
var MACD_FAST   = 12;
var MACD_SLOW   = 26;
var MACD_SIGNAL = 9;
var BB_PERIOD   = 20;
var BB_K        = 2;
var YAHOO_RANGE = '6mo';

var SECTORS = [
  {name: 'Food',         code: '1617'},
  {name: 'Energy',       code: '1618'},
  {name: 'Materials',    code: '1619'},
  {name: 'Construction', code: '1620'},
  {name: 'Machinery',    code: '1621'},
  {name: 'Electronics',  code: '1622'},
  {name: 'Automotive',   code: '1623'},
  {name: 'Steel',        code: '1624'},
  {name: 'Transport',    code: '1625'},
  {name: 'Trading Co.',  code: '1626'},
  {name: 'Retail',       code: '1627'},
  {name: 'Banking',      code: '1628'},
  {name: 'Finance',      code: '1629'},
  {name: 'Real Estate',  code: '1630'},
  {name: 'IT/Telecom',   code: '1631'},
  {name: 'Pharma',       code: '1632'},
  {name: 'Utilities',    code: '1633'}
];

var SECTOR_JP = [
  '食品', 'エネルギー資源', '主要素材', '建設・資材', '機械',
  '電気・精密', '自動車・輸送機器', '鉄鋼・非鉄', '運輸・物流',
  '商社・卸売', '小売', '銀行', '金融（除く銀行）', '不動産',
  '情報・通信・サービス他', '医薬品', '電力・ガス'
];

// ★ pool を34銘柄に削減（重複・流動性低め銘柄を除外）
var POOL = [
  // 半導体・電子部品
  ['8035', '東京エレクトロン'], ['6857', 'アドバンテスト'], ['6920', 'レーザーテック'],
  ['6146', 'ディスコ'],         ['6723', 'ルネサスエレクトロニクス'],
  ['6762', 'TDK'],              ['6981', '村田製作所'], ['5803', 'フジクラ'],
  // 機械・重工
  ['7011', '三菱重工業'], ['7012', '川崎重工業'], ['7013', 'IHI'],
  ['6367', 'ダイキン工業'], ['6594', 'ニデック'],
  // IT・ネット
  ['9984', 'ソフトバンクグループ'], ['6758', 'ソニーグループ'],
  ['6098', 'リクルートホールディングス'],
  ['4385', 'メルカリ'], ['3994', 'マネーフォワード'], ['4478', 'freee'],
  // 自動車・輸送
  ['7203', 'トヨタ自動車'], ['7267', 'ホンダ'], ['6902', 'デンソー'], ['7270', 'SUBARU'],
  // 金融
  ['8306', '三菱UFJフィナンシャル・グループ'],
  ['8316', '三井住友フィナンシャルグループ'],
  ['8766', '東京海上ホールディングス'],
  // 製薬
  ['4519', '中外製薬'], ['4568', '第一三共'],
  // その他
  ['4661', 'オリエンタルランド'], ['4063', '信越化学工業'],
  ['5802', '住友電気工業'],
  ['9983', 'ファーストリテイリング'], ['7974', '任天堂'],
  ['4751', 'サイバーエージェント']
];

var SMALLCAP_CODES = ['4385', '3994', '4478', '4751'];

// ============================================================
// 1. メニュー
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('株式予報アプリ')
    .addItem('Gemini APIキーを設定', 'setGeminiKey')
    .addItem('Gemini接続テスト', 'testGemini')
    .addSeparator()
    .addItem('① 初期セットアップ', 'setupSheet')
    .addSeparator()
    .addItem('② Yahoo 取得テスト', 'testYahoo')
    .addSeparator()
    .addItem('③ 今すぐ分析実行（ハチ＋ミケ）', 'runDailyAnalysis')
    .addItem('④ 週次レポートを実行（ソラ）', 'runWeeklyReport')
    .addItem('⑤ 売られすぎ銘柄を自動抽出（カピバラ）', 'runWatchlist')
    .addItem('⑥ 保有・監視銘柄を分析（ピヨ＆トン）', 'runMyStocks')
    .addSeparator()
    .addItem('トリガーを一括設定（17:00/17:30/18:00）', 'setupTriggers')
    .addItem('週次トリガーを設定（毎週月曜10:00）', 'setWeeklyTrigger')
    .addItem('Web App URL を表示', 'showWebAppUrl')
    .addToUi();
}

// ============================================================
// 2. 初期セットアップ
// ============================================================
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { sheet = ss.insertSheet(SHEET_NAME); }
  sheet.clearContents();
  sheet.clearFormats();

  var headers = ['業界名', '銘柄コード', '株価（円）', '前日比（%）', 'MA配列', 'RCI(9)', 'MACD', 'ボリンジャー', '判定'];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');

  for (var i = 0; i < SECTORS.length; i++) {
    var row = i + 2;
    sheet.getRange(row, 1).setValue(SECTOR_JP[i]);
    sheet.getRange(row, 2).setValue(SECTORS[i].code);
    sheet.getRange(row, 3).setFormula('=IFERROR(GOOGLEFINANCE("TYO:"&B' + row + ',"price"),"-")');
    sheet.getRange(row, 4).setFormula('=IFERROR(GOOGLEFINANCE("TYO:"&B' + row + ',"changepct")/100,"-")');
    for (var c = 5; c <= 9; c++) { sheet.getRange(row, c).setValue('(分析待ち)'); }
  }
  sheet.getRange(2, 4, SECTORS.length, 1).setNumberFormat('0.00%');
  sheet.setColumnWidth(1, 200); sheet.setColumnWidth(2, 90);
  sheet.setColumnWidth(3, 110); sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 110); sheet.setColumnWidth(6, 110);
  sheet.setColumnWidth(7, 70);  sheet.setColumnWidth(8, 110); sheet.setColumnWidth(9, 140);
  sheet.setFrozenRows(1);

  var rSheet = ss.getSheetByName(REPORT_SHEET);
  if (!rSheet) { rSheet = ss.insertSheet(REPORT_SHEET); }
  rSheet.clearContents();
  rSheet.getRange(1, 1, 1, 3)
    .setValues([['日付', 'ハチ レポート（マクロ）', 'ミケ レポート（テクニカル）']])
    .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');
  rSheet.setColumnWidth(1, 140); rSheet.setColumnWidth(2, 450); rSheet.setColumnWidth(3, 450);
  rSheet.setFrozenRows(1);

  var poolSheet = ss.getSheetByName(POOL_SHEET);
  if (!poolSheet) { poolSheet = ss.insertSheet(POOL_SHEET); }
  if (poolSheet.getRange(1, 1).getValue() === '') {
    poolSheet.getRange(1, 1, 1, 3)
      .setValues([['銘柄コード', '銘柄名', 'サイズ']])
      .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');
    var poolRows = [];
    for (var pi = 0; pi < POOL.length; pi++) {
      poolRows.push([POOL[pi][0], POOL[pi][1], (SMALLCAP_CODES.indexOf(POOL[pi][0]) >= 0) ? '中小型' : '大型']);
    }
    poolSheet.getRange(2, 1, poolRows.length, 3).setValues(poolRows);
    poolSheet.getRange(1, 1).setNote('スクリーニング対象の銘柄群です。自由に追加・削除できます。');
    poolSheet.setColumnWidth(1, 90); poolSheet.setColumnWidth(2, 200);
    poolSheet.setFrozenRows(1);
  }

  var wlSheet = ss.getSheetByName(WATCH_SHEET);
  if (!wlSheet) { wlSheet = ss.insertSheet(WATCH_SHEET); }
  if (wlSheet.getRange(1, 1).getValue() === '') {
    wlSheet.getRange(1, 1, 1, 9)
      .setValues([['銘柄コード', '銘柄名', '株価（円）', '前日比（%）', 'MA配列', 'RCI(9)', 'MACD', 'ボリンジャー', '判定']])
      .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');
    wlSheet.getRange(1, 1).setNote('「⑤ 売られすぎ銘柄を自動抽出」で自動で並びます。手入力不要です。');
    wlSheet.setColumnWidth(1, 90);  wlSheet.setColumnWidth(2, 160);
    wlSheet.setColumnWidth(3, 110); wlSheet.setColumnWidth(4, 100);
    wlSheet.setColumnWidth(5, 110); wlSheet.setColumnWidth(6, 110);
    wlSheet.setColumnWidth(7, 70);  wlSheet.setColumnWidth(8, 110); wlSheet.setColumnWidth(9, 140);
    wlSheet.setFrozenRows(1);
  }

  var mySheet = ss.getSheetByName(MY_SHEET);
  if (!mySheet) { mySheet = ss.insertSheet(MY_SHEET); }
  if (mySheet.getRange(1, 1).getValue() === '') {
    mySheet.getRange(1, 1, 1, 3)
      .setValues([['銘柄コード', '銘柄名（任意）', '区分（保有/監視 任意）']])
      .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');
    mySheet.getRange(1, 1).setNote('保有中、または見ておきたい銘柄のコードをA列に入力してください。');
    mySheet.setColumnWidth(1, 90); mySheet.setColumnWidth(2, 180); mySheet.setColumnWidth(3, 160);
    mySheet.setFrozenRows(1);
  }

  SpreadsheetApp.getUi().alert(
    'セットアップ完了！\n\n' +
    '次の手順：\n' +
    '1. メニュー「Gemini APIキーを設定」でAPIキーを登録\n' +
    '2. 「② Yahoo 取得テスト」で取得状況を確認\n' +
    '3. 「③ 今すぐ分析実行」でハチ＋ミケを実行\n' +
    '4. 「⑤ 売られすぎ銘柄を自動抽出」でカピバラを実行\n' +
    '5. 保有・監視銘柄があれば my_stocks シートに入力して「⑥」を実行\n' +
    '6. 「トリガーを一括設定」で毎日の自動実行を登録'
  );
}

// ============================================================
// 3. Yahoo Finance 非公式API — 日足取得
//    open・volume も同時取得（底打ち検出で使用）
// ============================================================
function fetchYahooDaily(code, range) {
  var symbol = String(code);
  if (!/[\^=.]/.test(symbol)) { symbol += '.T'; }
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
            encodeURIComponent(symbol) + '?range=' + (range || YAHOO_RANGE) + '&interval=1d';
  try {
    var res = UrlFetchApp.fetch(url, {method: 'get', headers: {'User-Agent': 'Mozilla/5.0'}, muteHttpExceptions: true});
    if (res.getResponseCode() !== 200) { return []; }
    var json = JSON.parse(res.getContentText());
    var r    = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.timestamp || !r.indicators || !r.indicators.quote) { return []; }
    var ts       = r.timestamp;
    var closeArr = r.indicators.quote[0].close;
    var openArr  = r.indicators.quote[0].open   || [];
    var volArr   = r.indicators.quote[0].volume || [];
    var bars = [];
    for (var k = 0; k < ts.length; k++) {
      var c = closeArr[k];
      if (typeof c !== 'number') { continue; }
      bars.push({
        date:   Utilities.formatDate(new Date(ts[k] * 1000), 'Asia/Tokyo', 'yyyy-MM-dd'),
        close:  c,
        open:   (typeof openArr[k] === 'number') ? openArr[k] : c,
        volume: (typeof volArr[k]  === 'number') ? volArr[k]  : 0
      });
    }
    bars.sort(function(a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    return bars;
  } catch (e) { return []; }
}

function fetchYahooBatch() {
  var result = [];
  for (var i = 0; i < SECTORS.length; i++) {
    result.push(fetchYahooDaily(SECTORS[i].code));
    Utilities.sleep(150);
  }
  return result;
}

// ============================================================
// 4. テクニカル指標の計算
// ============================================================
function smaEndingAt(closes, period, endExclusive) {
  if (endExclusive < period) { return null; }
  var sum = 0;
  for (var i = endExclusive - period; i < endExclusive; i++) { sum += closes[i]; }
  return sum / period;
}

function stdevEndingAt(closes, period, endExclusive) {
  if (endExclusive < period) { return null; }
  var mean = smaEndingAt(closes, period, endExclusive);
  var sq   = 0;
  for (var i = endExclusive - period; i < endExclusive; i++) {
    sq += (closes[i] - mean) * (closes[i] - mean);
  }
  return Math.sqrt(sq / period);
}

function emaSeries(values, period) {
  if (values.length < period) { return []; }
  var k   = 2 / (period + 1);
  var out = [];
  var seed = 0;
  for (var i = 0; i < period; i++) { seed += values[i]; }
  var ema = seed / period;
  out[period - 1] = ema;
  for (var j = period; j < values.length; j++) {
    ema    = values[j] * k + ema * (1 - k);
    out[j] = ema;
  }
  return out;
}

function calcRCI(closes, period) {
  var n = closes.length;
  if (n < period) { return null; }
  var window = closes.slice(n - period);
  var priceSorted = window
    .map(function(v, idx) { return {v: v, idx: idx}; })
    .sort(function(a, b) { return b.v - a.v; });
  var priceRank = [];
  for (var p = 0; p < priceSorted.length; p++) { priceRank[priceSorted[p].idx] = p + 1; }
  var sumD2 = 0;
  for (var i = 0; i < period; i++) {
    var d = (period - i) - priceRank[i];
    sumD2 += d * d;
  }
  return (1 - (6 * sumD2) / (period * (period * period - 1))) * 100;
}

// ★ 対策B：rciShortPrev（前日のRCI9）を追加して detectWBottomPattern_ の二重計算を廃止
function analyzeTechnical(closes) {
  var n    = closes.length;
  var last = closes[n - 1];

  // 移動平均線配列
  var ma   = {};
  for (var m = 0; m < MA_LINES.length; m++) { ma[MA_LINES[m]] = smaEndingAt(closes, MA_LINES[m], n); }
  var sma5 = ma[5], sma25 = ma[25], sma75 = ma[75];

  var perfectOrder = '';
  if (sma5 !== null && sma25 !== null && sma75 !== null) {
    if      (sma5 > sma25 && sma25 > sma75) { perfectOrder = 'パーフェクトオーダー(上昇)'; }
    else if (sma5 < sma25 && sma25 < sma75) { perfectOrder = 'パーフェクトオーダー(下降)'; }
  }
  var trend = '中立';
  if (sma25 !== null) {
    if      (last > sma25 && (sma5 === null || sma5 >= sma25)) { trend = '上昇'; }
    else if (last < sma25 && (sma5 === null || sma5 <= sma25)) { trend = '下落'; }
  }

  var maCross   = '';
  var sma5Prev  = smaEndingAt(closes, SMA_SHORT, n - 1);
  var sma25Prev = smaEndingAt(closes, SMA_LONG,  n - 1);
  if (sma5 !== null && sma25 !== null && sma5Prev !== null && sma25Prev !== null) {
    if      (sma5Prev <= sma25Prev && sma5 > sma25) { maCross = 'ゴールデンクロス'; }
    else if (sma5Prev >= sma25Prev && sma5 < sma25) { maCross = 'デッドクロス'; }
  }

  // RCI（当日＋前日をまとめて計算 → detectWBottomPattern_ で使い回す）
  var rciShort     = calcRCI(closes, RCI_SHORT);
  var rciLong      = calcRCI(closes, RCI_LONG);
  // ★ 前日RCI：closes の末尾を1本除いた配列で計算
  var rciShortPrev = (n >= RCI_SHORT + 1) ? calcRCI(closes.slice(0, n - 1), RCI_SHORT) : null;
  var rciState     = '中立';
  if (rciShort !== null) {
    if      (rciShort >= 80)  { rciState = '買われすぎ'; }
    else if (rciShort <= -80) { rciState = '売られすぎ'; }
  }

  // MACD
  var macd = null, macdSignal = null, macdHist = null, macdCross = '';
  var emaFast = emaSeries(closes, MACD_FAST);
  var emaSlow = emaSeries(closes, MACD_SLOW);
  if (emaFast.length && emaSlow.length) {
    var macdLine = [];
    for (var t = 0; t < closes.length; t++) {
      if (emaFast[t] !== undefined && emaSlow[t] !== undefined) { macdLine[t] = emaFast[t] - emaSlow[t]; }
    }
    var compact = macdLine.filter(function(v) { return v !== undefined; });
    var sig     = emaSeries(compact, MACD_SIGNAL);
    if (sig.length >= 2) {
      var li       = compact.length - 1;
      macd         = compact[li];
      macdSignal   = sig[li];
      macdHist     = macd - macdSignal;
      var prevMacd = compact[li - 1];
      var prevSig  = sig[li - 1];
      if (prevSig !== undefined) {
        if      (prevMacd <= prevSig && macd > macdSignal) { macdCross = 'ゴールデンクロス'; }
        else if (prevMacd >= prevSig && macd < macdSignal) { macdCross = 'デッドクロス'; }
      }
    }
  }

  // ボリンジャーバンド
  var bbMid = smaEndingAt(closes, BB_PERIOD, n);
  var bbStd = stdevEndingAt(closes, BB_PERIOD, n);
  var bbPos = '－', bbUpper2 = null, bbLower2 = null;
  if (bbMid !== null && bbStd !== null) {
    var u1 = bbMid + bbStd,      u2 = bbMid + BB_K * bbStd;
    var l1 = bbMid - bbStd,      l2 = bbMid - BB_K * bbStd;
    bbUpper2 = u2; bbLower2 = l2;
    if      (last >= u2) { bbPos = '+2σ超え'; }
    else if (last >= u1) { bbPos = '+1σ〜+2σ'; }
    else if (last <= l2) { bbPos = '-2σ割れ'; }
    else if (last <= l1) { bbPos = '-1σ〜-2σ'; }
    else                 { bbPos = '±1σ内'; }
  }

  return {
    last: last,
    sma5: sma5, sma25: sma25, sma75: sma75,
    perfectOrder: perfectOrder, trend: trend, maCross: maCross,
    rciShort: rciShort, rciShortPrev: rciShortPrev,  // ★ 前日RCI追加
    rciLong: rciLong, rciState: rciState,
    macd: macd, macdSignal: macdSignal, macdHist: macdHist, macdCross: macdCross,
    bbMid: bbMid, bbUpper2: bbUpper2, bbLower2: bbLower2, bbPos: bbPos
  };
}

// ============================================================
// 4b. 底打ちパターン検出（Wボトム＋陽線回復）
//
//   スコア内訳（合計最大115点）：
//     条件A Wボトム形状（-2σタッチ2回＋安値1%以上切り上がり）: 35点
//     条件B 直近7日で陽線4本以上（緩め設定）                 : 25点
//     条件C RCI9が-80以下から-60以上に回復                   : 20点  ★tech.rciShortPrev を使用
//     条件D 直近20日安値から7%以上回復                       : 15点
//     条件E 2回目の安値付近で出来高増加（20日比1.1倍以上）   : 20点
//   75点以上でシグナル発火（厳しめ）
// ============================================================
function detectWBottomPattern_(bars, closes, tech) {
  var score   = 0;
  var reasons = [];
  var n       = closes.length;

  // 条件A：Wボトム形状チェック（直近20日で-2σタッチが2回、安値1%以上切り上がり）
  var bbLower2 = tech.bbLower2;
  if (bbLower2 !== null) {
    var lookback  = Math.min(20, bars.length);
    var touchDays = [];
    for (var i = bars.length - lookback; i < bars.length; i++) {
      if (bars[i].close <= bbLower2 * 1.05) { touchDays.push({idx: i, price: bars[i].close}); }
    }
    if (touchDays.length >= 2) {
      var firstLow  = touchDays[0].price;
      var secondLow = touchDays[touchDays.length - 1].price;
      if (secondLow > firstLow * 1.01) {
        score += 35;
        reasons.push('Wボトム形成（安値切り上がり ' + ((secondLow / firstLow - 1) * 100).toFixed(1) + '%）');
      }
    }
  }

  // 条件B：直近7日で陽線4本以上（終値>始値を陽線とカウント）
  var recentBars  = bars.slice(Math.max(0, bars.length - 7));
  var yosenCount  = 0;
  for (var j = 0; j < recentBars.length; j++) {
    if (recentBars[j].close > recentBars[j].open) { yosenCount++; }
  }
  if (yosenCount >= 4) {
    score += 25;
    reasons.push('直近7日で陽線' + yosenCount + '本');
  }

  // 条件C：RCI9が-80以下から-60以上に回復
  // ★ tech.rciShortPrev を使い回すことで二重計算を廃止（対策B）
  var rciNow  = tech.rciShort;
  var rciPrev = tech.rciShortPrev;
  if (rciPrev !== null && rciNow !== null && rciPrev <= -80 && rciNow >= -60) {
    score += 20;
    reasons.push('RCI9が売られすぎゾーン(' + Math.round(rciPrev) + ')から回復(' + Math.round(rciNow) + ')');
  }

  // 条件D：直近20日安値から7%以上回復
  var recentCloses = closes.slice(Math.max(0, n - 20));
  var recentLow    = recentCloses[0];
  for (var k = 1; k < recentCloses.length; k++) { if (recentCloses[k] < recentLow) { recentLow = recentCloses[k]; } }
  var recoveryPct  = (closes[n - 1] - recentLow) / recentLow * 100;
  if (recoveryPct >= 7) {
    score += 15;
    reasons.push('直近安値から' + recoveryPct.toFixed(1) + '%回復');
  }

  // 条件E：直近5日の出来高が20日平均の1.1倍以上
  if (bars.length >= 20) {
    var vol5sum = 0, vol20sum = 0;
    var recent5  = bars.slice(bars.length - 5);
    var recent20 = bars.slice(bars.length - 20);
    for (var v5  = 0; v5  < recent5.length;  v5++)  { vol5sum  += recent5[v5].volume; }
    for (var v20 = 0; v20 < recent20.length; v20++)  { vol20sum += recent20[v20].volume; }
    var avgVol5  = vol5sum  / recent5.length;
    var avgVol20 = vol20sum / recent20.length;
    if (avgVol5 > avgVol20 * 1.1) {
      score += 20;
      reasons.push('出来高増加（直近5日平均が20日平均の' + (avgVol5 / avgVol20).toFixed(1) + '倍）');
    }
  }

  return {isWBottom: score >= 75, score: score, reasons: reasons};
}

// ============================================================
// 5. セクターデータ読み込み（現在値 + テクニカル）
// ============================================================
function readSectorData() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { throw new Error('シートが見つかりません。先に「① 初期セットアップ」を実行してください。'); }

  var todayStr  = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var dow       = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'u');
  var isWeekday = (dow !== '6' && dow !== '7');
  var allBars   = fetchYahooBatch();
  var result    = [];

  for (var i = 0; i < SECTORS.length; i++) {
    var row       = i + 2;
    var name      = SECTOR_JP[i];
    var code      = SECTORS[i].code;
    var price     = sheet.getRange(row, 3).getValue();
    var changePct = sheet.getRange(row, 4).getValue();
    var pct       = (typeof changePct === 'number') ? changePct : 0;
    var curPrice  = (typeof price === 'number')     ? price     : null;

    var bars   = allBars[i];
    var closes = [];
    for (var b = 0; b < bars.length; b++) { closes.push(bars[b].close); }
    if (isWeekday && curPrice && bars.length > 0 && bars[bars.length - 1].date < todayStr) { closes.push(curPrice); }

    var tech = (closes.length >= SMA_LONG) ? analyzeTechnical(closes) : null;

    var judgment, bgColor;
    if (tech) {
      var up   = (tech.perfectOrder.indexOf('上昇') >= 0) || tech.trend === '上昇';
      var down = (tech.perfectOrder.indexOf('下降') >= 0) || tech.trend === '下落';
      var hot  = (tech.rciState === '買われすぎ' || tech.bbPos === '+2σ超え');
      var cold = (tech.rciState === '売られすぎ' || tech.bbPos === '-2σ割れ');
      if      (up && hot)    { judgment = '上昇・過熱';      bgColor = '#fff4d6'; }
      else if (up)           { judgment = '上昇トレンド';    bgColor = '#e8f8e5'; }
      else if (down && cold) { judgment = '下落・売られすぎ'; bgColor = '#e6f0ff'; }
      else if (down)         { judgment = '下落トレンド';    bgColor = '#fce8e8'; }
      else                   { judgment = '中立';            bgColor = '#ffffff'; }
    } else {
      if      (pct >= 0.005)  { judgment = '上昇（騰落率のみ）'; bgColor = '#e8f8e5'; }
      else if (pct <= -0.005) { judgment = '下落（騰落率のみ）'; bgColor = '#fce8e8'; }
      else                    { judgment = '中立（騰落率のみ）'; bgColor = '#ffffff'; }
    }

    var maText = '-', rciText = '-', macdText = '-';
    if (tech) {
      maText = tech.perfectOrder ? (tech.perfectOrder.indexOf('上昇') >= 0 ? 'PO↑' : 'PO↓') : tech.trend;
      if (tech.maCross) { maText += '／' + (tech.maCross === 'ゴールデンクロス' ? 'GC' : 'DC'); }
      if (tech.rciShort !== null) {
        rciText = Math.round(tech.rciShort);
        if (tech.rciState !== '中立') { rciText += '(' + tech.rciState + ')'; }
      }
      if (tech.macdCross)              { macdText = (tech.macdCross === 'ゴールデンクロス' ? 'GC' : 'DC'); }
      else if (tech.macdHist !== null) { macdText = (tech.macdHist >= 0 ? '陽' : '陰'); }
    }

    sheet.getRange(row, 5).setValue(maText);
    sheet.getRange(row, 6).setValue(rciText);
    sheet.getRange(row, 7).setValue(macdText);
    sheet.getRange(row, 8).setValue(tech ? tech.bbPos : '-');
    sheet.getRange(row, 9).setValue(judgment);
    sheet.getRange(row, 1, 1, 9).setBackground(bgColor);

    var aboveMA = (tech && tech.sma25 && closes.length) ? (closes[closes.length - 1] > tech.sma25) : null;
    result.push({
      name: name, price: curPrice || 0, changePct: (pct * 100).toFixed(2),
      sma25: tech && tech.sma25 ? Math.round(tech.sma25) : null,
      perfectOrder: tech ? tech.perfectOrder : '', trend: tech ? tech.trend : null,
      maCross: tech ? tech.maCross : '',
      rciShort: tech && tech.rciShort !== null ? Math.round(tech.rciShort) : null,
      rciState: tech ? tech.rciState : null,
      macdCross: tech ? tech.macdCross : '', macdHist: tech ? tech.macdHist : null,
      bbPos: tech ? tech.bbPos : null, aboveMA: aboveMA, judgment: judgment, hasTech: !!tech
    });
  }
  return result;
}

// ============================================================
// 6. Gemini API
// ============================================================
function setGeminiKey() {
  var ui      = SpreadsheetApp.getUi();
  var current = getGeminiKey_();
  var hint    = current ? '（現在：設定済み）' : '（現在：未設定）';
  var res     = ui.prompt('Gemini APIキーを設定',
    'Google AI Studio で取得したAPIキーを貼り付けてください。' + hint, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) { return; }
  var key = (res.getResponseText() || '').replace(/^[\s"']+|[\s"']+$/g, '');
  if (!key) { ui.alert('キーが空でした。設定を中止します。'); return; }
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  ui.alert('保存しました。文字数: ' + key.length + '　末尾: ...' + key.slice(-4));
}

function testGemini() {
  var ui  = SpreadsheetApp.getUi();
  var key = getGeminiKey_();
  if (!key) { ui.alert('キーが未設定です。メニュー「Gemini APIキーを設定」で登録してください。'); return; }
  var options = {
    method: 'post', contentType: 'application/json',
    headers: {'x-goog-api-key': key},
    payload: JSON.stringify({contents: [{parts: [{text: 'ping'}]}]}),
    muteHttpExceptions: true
  };
  try {
    var res  = UrlFetchApp.fetch(GEMINI_URL + '?key=' + encodeURIComponent(key), options);
    var code = res.getResponseCode();
    ui.alert(code === 200 ? 'API応答: HTTP 200 OK ✅ キーは正常です。' : 'API応答: HTTP ' + code + ' ❌\n' + res.getContentText().substring(0, 300));
  } catch (e) { ui.alert('通信エラー: ' + e.message); }
}

function getGeminiKey_() {
  var fromProps = '';
  try { fromProps = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || ''; } catch (e) {}
  var key = (fromProps || GEMINI_API_KEY || '').toString().trim();
  return (key === 'YOUR_GEMINI_API_KEY') ? '' : key;
}

function callGeminiAPI(prompt) {
  var apiKey = getGeminiKey_();
  if (!apiKey) { return 'Gemini APIキーが未設定です。メニュー「Gemini APIキーを設定」から登録してください。'; }
  var url     = GEMINI_URL + '?key=' + encodeURIComponent(apiKey);
  var payload = {contents: [{parts: [{text: prompt}]}], generationConfig: {temperature: 0.8, maxOutputTokens: 450}};
  var options = {method: 'post', contentType: 'application/json', headers: {'x-goog-api-key': apiKey}, payload: JSON.stringify(payload), muteHttpExceptions: true};
  var lastInfo = '';
  for (var attempt = 1; attempt <= 4; attempt++) {
    try {
      var res  = UrlFetchApp.fetch(url, options);
      var code = res.getResponseCode();
      var json = JSON.parse(res.getContentText());
      if (code === 200 && json.candidates && json.candidates[0]) { return json.candidates[0].content.parts[0].text.trim(); }
      lastInfo = 'HTTP ' + code + ' ' + JSON.stringify(json);
      if (code === 429 && lastInfo.indexOf('PerDay') >= 0) { return '本日のGemini無料枠を使い切りました。翌日リセット後に再実行してください。'; }
      if (code === 503 || code === 429 || code === 500) { Utilities.sleep(2000 * attempt); continue; }
      return 'APIエラー: ' + lastInfo;
    } catch (e) { lastInfo = e.message; Utilities.sleep(2000 * attempt); }
  }
  return 'APIエラー（リトライ上限）: ' + lastInfo;
}

// ============================================================
// 主要指数の取得
// ============================================================
function fetchIndicesData_() {
  var result = [];
  for (var i = 0; i < INDICES.length; i++) {
    var idx  = INDICES[i];
    var bars = fetchYahooDaily(idx.symbol, '1y');
    Utilities.sleep(120);
    if (!bars || bars.length < 2) { continue; }
    var last         = bars[bars.length - 1].close;
    var prev         = bars[bars.length - 2].close;
    var pct          = (last - prev) / prev * 100;
    var hi52         = bars[0].close;
    for (var k = 1; k < bars.length; k++) { if (bars[k].close > hi52) { hi52 = bars[k].close; } }
    result.push({name: idx.name, symbol: idx.symbol, value: last, pct: pct, hi52: hi52, distFromHigh: (last - hi52) / hi52 * 100});
  }
  return result;
}

// ============================================================
// 7. ハチ（柴犬）レポート
// ============================================================
function generateDogReport(sectorData, indicesData) {
  var sorted = sectorData.slice().sort(function(a, b) { return parseFloat(b.changePct) - parseFloat(a.changePct); });
  var up = 0, down = 0, aboveMA = 0, maCount = 0;
  for (var i = 0; i < sectorData.length; i++) {
    var p = parseFloat(sectorData[i].changePct);
    if (p > 0) { up++; } else if (p < 0) { down++; }
    if (sectorData[i].aboveMA !== null) { maCount++; if (sectorData[i].aboveMA) { aboveMA++; } }
  }
  var lines = [];
  for (var j = 0; j < sorted.length; j++) {
    var s = sorted[j];
    lines.push(s.name + ': ' + (parseFloat(s.changePct) >= 0 ? '+' : '') + s.changePct + '%' + (s.trend ? '／' + s.trend : ''));
  }
  var breadth = '上昇業界 ' + up + ' ／ 下落業界 ' + down + (maCount ? '、25日線より上 ' + aboveMA + '/' + maCount + '業界' : '');
  var indexLines = [];
  if (indicesData && indicesData.length) {
    for (var k = 0; k < indicesData.length; k++) {
      var ix  = indicesData[k];
      var val = (ix.symbol === 'JPY=X') ? ix.value.toFixed(2) : Math.round(ix.value).toLocaleString();
      var hiNote = '';
      if (typeof ix.distFromHigh === 'number') {
        if      (ix.distFromHigh >= -0.5) { hiNote = '（52週高値圏・ほぼ最高値水準）'; }
        else if (ix.distFromHigh >= -3)   { hiNote = '（52週高値から ' + ix.distFromHigh.toFixed(1) + '%）'; }
      }
      indexLines.push(ix.name + ' ' + val + ' / 前日比 ' + (ix.pct >= 0 ? '+' : '') + ix.pct.toFixed(2) + '%' + hiNote);
    }
  }
  var maRatioNote = '';
  if (maCount) {
    var ratio = aboveMA / maCount;
    if      (ratio >= 0.8) { maRatioNote = '※ 25日線より上の業種が ' + Math.round(ratio * 100) + '% で中期地合いは強い状態です。\n'; }
    else if (ratio <= 0.2) { maRatioNote = '※ 25日線より上の業種が ' + Math.round(ratio * 100) + '% で中期地合いは弱い状態です。\n'; }
  }
  var prompt =
    'あなたは明るく元気な柴犬のキャラクター「ハチ」です。語尾は必ず「〜ワン！」「〜だワン！」「〜ですワン！」。\n' +
    'スイングトレード（数日〜数週間）の観点で順張り・市場全体の地合いが得意です。\n' +
    '【重要】データに記載が無いことは絶対に推測・創作しないでください。\n\n' +
    (indexLines.length ? '【本日の主要指数】\n' + indexLines.join('\n') + '\n\n' : '') +
    '【セクターのブレッドス】' + breadth + '\n' + maRatioNote + '\n' +
    '1. 今日の市場全体の地合いの評価\n2. 順張りで狙える業界\n3. 今後1週間の注目ポイント\n' +
    'を180〜250文字で簡潔に報告してください。テクニカル詳細・個別銘柄には触れず地合いに絞ってください。\n\n' +
    '【本日のセクター別データ】\n' + lines.join('\n');
  return callGeminiAPI(prompt);
}

// ============================================================
// 8. ミケ（三毛猫）レポート
// ============================================================
function generateCatReport(sectorData) {
  var rciHigh = [], rciLow = [], macdGolden = [], macdDead = [], poUp = [], poDown = [], bbUpper = [], bbLower = [];
  for (var i = 0; i < sectorData.length; i++) {
    var s = sectorData[i];
    if (!s.hasTech) { continue; }
    if (s.rciState === '買われすぎ')         { rciHigh.push(s.name + '(RCI' + s.rciShort + ')'); }
    if (s.rciState === '売られすぎ')         { rciLow.push(s.name + '(RCI' + s.rciShort + ')'); }
    if (s.macdCross === 'ゴールデンクロス')  { macdGolden.push(s.name); }
    if (s.macdCross === 'デッドクロス')      { macdDead.push(s.name); }
    if (s.perfectOrder.indexOf('上昇') >= 0) { poUp.push(s.name); }
    if (s.perfectOrder.indexOf('下降') >= 0) { poDown.push(s.name); }
    if (s.bbPos === '+2σ超え')               { bbUpper.push(s.name); }
    if (s.bbPos === '-2σ割れ')               { bbLower.push(s.name); }
  }
  var dataText =
    'RCI買われすぎ: '  + (rciHigh.length   ? rciHigh.join('、')    : 'なし') + '\n' +
    'RCI売られすぎ: '  + (rciLow.length    ? rciLow.join('、')     : 'なし') + '\n' +
    'MACDゴールデンクロス: ' + (macdGolden.length ? macdGolden.join('、') : 'なし') + '\n' +
    'MACDデッドクロス: '     + (macdDead.length   ? macdDead.join('、')   : 'なし') + '\n' +
    'パーフェクトオーダー(上昇): ' + (poUp.length    ? poUp.join('、')    : 'なし') + '\n' +
    'パーフェクトオーダー(下降): ' + (poDown.length  ? poDown.join('、')  : 'なし') + '\n' +
    'ボリンジャー+2σ: ' + (bbUpper.length  ? bbUpper.join('、')   : 'なし') + '\n' +
    'ボリンジャー-2σ: ' + (bbLower.length  ? bbLower.join('、')   : 'なし');
  var prompt =
    'あなたは冷静沈着な三毛猫のキャラクター「ミケ」です。語尾は必ず「〜にゃ」「〜だにゃ」「〜ですにゃ」。\n' +
    'スイングトレードのテクニカル分析・逆張り・リスク管理が得意です。\n\n' +
    dataText + '\n\n' +
    '1. RCI買われすぎ・+2σの反落リスク\n2. RCI売られすぎ・-2σの逆張りチャンスと注意点\n3. MACDクロス・パーフェクトオーダーから見るトレンド転換リスク\n' +
    'を180〜250文字で報告してください。地合い総評（ハチ担当）には触れないでください。';
  return callGeminiAPI(prompt);
}

// ============================================================
// 9. メイン分析（ハチ＋ミケのみ）
// ★ 対策A：カピバラ・ピヨトンは別トリガーに分離
// ============================================================
function runDailyAnalysis() {
  Logger.log('ハチ＋ミケ 分析開始...');
  var sectorData;
  try { sectorData = readSectorData(); } catch (e) { notify_('エラー: ' + e.message); return; }
  if (sectorData.length === 0) { notify_('データがありません。市場が閉まっている可能性があります。'); return; }

  var indicesData = [];
  try { indicesData = fetchIndicesData_(); } catch (eIdx) { Logger.log('主要指数の取得に失敗（続行）: ' + eIdx.message); }

  var dogReport = generateDogReport(sectorData, indicesData);
  var catReport = generateCatReport(sectorData);
  saveReports(dogReport, catReport);

  notify_('ハチ＋ミケの分析完了！\n「AI_report」シートにレポートが保存されました。\n（カピバラは17:30、ピヨ＆トンは18:00に自動実行されます）');
}

function notify_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

// ============================================================
// 10. レポート保存
// ============================================================
function saveReports(dogReport, catReport) {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var rSheet = ss.getSheetByName(REPORT_SHEET);
  if (!rSheet) { rSheet = ss.insertSheet(REPORT_SHEET); }
  if (rSheet.getRange(1, 1).getValue() === '') {
    rSheet.getRange(1, 1, 1, 3)
      .setValues([['日付', 'ハチ レポート（マクロ）', 'ミケ レポート（テクニカル）']])
      .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');
    rSheet.setFrozenRows(1);
  }
  rSheet.insertRowBefore(2);
  var dateStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  rSheet.getRange(2, 1).setValue(dateStr);
  rSheet.getRange(2, 2).setValue(dogReport);
  rSheet.getRange(2, 3).setValue(catReport);
  rSheet.getRange(2, 1, 1, 3).setWrap(true).setVerticalAlignment('top');
  rSheet.setRowHeight(2, 150);
}

// ============================================================
// 10b. 週次レポート（ソラ）
// ============================================================
function runWeeklyReport() {
  Logger.log('週次レポート開始...');
  var allBars  = fetchYahooBatch();
  var weekData = [];
  for (var i = 0; i < SECTORS.length; i++) {
    var bars = allBars[i];
    if (bars.length < 6) { continue; }
    var lastClose = bars[bars.length - 1].close;
    var prevClose = bars[bars.length - 6].close;
    if (!prevClose) { continue; }
    weekData.push({name: SECTOR_JP[i], weekPct: ((lastClose - prevClose) / prevClose * 100).toFixed(2)});
  }
  if (weekData.length === 0) { notify_('週次データが取得できませんでした。'); return; }
  saveWeeklyReport(generateWeeklyReport(weekData));
  notify_(WEEKLY_NAME + 'の週次レポートを保存しました。');
}

function generateWeeklyReport(weekData) {
  var sorted = weekData.slice().sort(function(a, b) { return parseFloat(b.weekPct) - parseFloat(a.weekPct); });
  var up = 0, down = 0, lines = [];
  for (var i = 0; i < sorted.length; i++) {
    var v = parseFloat(sorted[i].weekPct);
    if (v > 0) { up++; } else if (v < 0) { down++; }
    lines.push(sorted[i].name + ': ' + (v >= 0 ? '+' : '') + sorted[i].weekPct + '%');
  }
  var top3 = sorted.slice(0, 3).map(function(s) { return s.name + '(' + (parseFloat(s.weekPct) >= 0 ? '+' : '') + s.weekPct + '%)'; });
  var bot3 = sorted.slice(-3).reverse().map(function(s) { return s.name + '(' + s.weekPct + '%)'; });
  var prompt =
    'あなたは落ち着いて頼れる犬のキャラクター「' + WEEKLY_NAME + '」です。穏やかで丁寧な口調で話します。\n' +
    '上昇セクター数 ' + up + ' ／ 下落セクター数 ' + down + '\n' +
    '上昇トップ3: ' + top3.join('、') + '\n下落ワースト3: ' + bot3.join('、') + '\n\n' +
    '1. 先週の市場全体の振り返り\n2. 強かった・弱かったセクターの傾向\n3. 今週に向けた注目点\n' +
    'を300〜400文字でまとめてください。振り返りは「先週は〜」、見通しは「今週は〜」と表現してください。\n\n' +
    '【先週の騰落率】\n' + lines.join('\n');
  return callGeminiAPI(prompt);
}

function saveWeeklyReport(report) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(WEEKLY_SHEET);
  if (!sh) { sh = ss.insertSheet(WEEKLY_SHEET); }
  if (sh.getRange(1, 1).getValue() === '') {
    sh.getRange(1, 1, 1, 2).setValues([['週', WEEKLY_NAME + ' レポート（週次）']])
      .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');
    sh.setColumnWidth(1, 140); sh.setColumnWidth(2, 600); sh.setFrozenRows(1);
  }
  sh.insertRowBefore(2);
  sh.getRange(2, 1).setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  sh.getRange(2, 2).setValue(report);
  sh.getRange(2, 1, 1, 2).setWrap(true).setVerticalAlignment('top');
  sh.setRowHeight(2, 150);
}

// ============================================================
// 10c. カピバラ（スクリーニング）
// ============================================================
function runWatchlist() {
  var n = runWatchlistCore_();
  if      (n < 0)  { notify_('「' + POOL_SHEET + '」シートが見つかりません。先に「① 初期セットアップ」を実行してください。'); }
  else if (n === 0) { notify_('スクリーニング対象がありません。「' + POOL_SHEET + '」シートを確認してください。'); }
  else              { notify_(WATCH_NAME + 'が上位' + n + '銘柄を自動抽出しました。'); }
}

function computeOversoldScore_(tech) {
  var score = 0;
  if (tech.rciShort !== null) { score += (-tech.rciShort); }
  if      (tech.bbPos === '-2σ割れ')    { score += 40; }
  else if (tech.bbPos === '-1σ〜-2σ')  { score += 20; }
  if (tech.sma25 && tech.last < tech.sma25) { score += Math.min((tech.sma25 - tech.last) / tech.sma25 * 100, 30); }
  return score;
}

// ★ 引数に bars を追加（wbottom で出来高・始値を参照）
function computePresetScore_(presetId, tech, closes, bars) {
  var last = closes[closes.length - 1];
  var hi = -Infinity, lo = Infinity;
  for (var i = Math.max(0, closes.length - 120); i < closes.length; i++) {
    if (closes[i] > hi) { hi = closes[i]; }
    if (closes[i] < lo) { lo = closes[i]; }
  }
  var posRange = (hi > lo) ? (last - lo) / (hi - lo) * 100 : 50;
  var up       = (tech.perfectOrder.indexOf('上昇') >= 0) || tech.trend === '上昇';
  var score    = 0;
  switch (presetId) {
    case 'jun':
      if (tech.perfectOrder.indexOf('上昇') >= 0)          { score += 50; }
      else if (tech.trend === '上昇')                       { score += 25; }
      if (tech.macdCross === 'ゴールデンクロス')             { score += 30; }
      else if (tech.macdHist !== null && tech.macdHist > 0) { score += 15; }
      if (tech.rciShort !== null && tech.rciShort > 0 && tech.rciShort < 80) { score += tech.rciShort * 0.2; }
      break;
    case 'brk':
      score += posRange * 0.5;
      if      (tech.bbPos === '+2σ超え')   { score += 30; }
      else if (tech.bbPos === '+1σ〜+2σ') { score += 15; }
      if (tech.macdHist !== null && tech.macdHist > 0) { score += 15; }
      break;
    case 'oshime':
      if (up) {
        score += 40;
        if (tech.rciShort !== null && tech.rciShort < 0) { score += (-tech.rciShort) * 0.5; }
        if (tech.bbPos === '-1σ〜-2σ' || tech.bbPos === '-2σ割れ') { score += 20; }
      }
      break;
    case 'kanetsu':
      if (tech.rciShort !== null) { score += tech.rciShort; }
      if      (tech.bbPos === '+2σ超え')   { score += 40; }
      else if (tech.bbPos === '+1σ〜+2σ') { score += 20; }
      break;
    case 'wbottom':
      // ★ detectWBottomPattern_ のスコアをそのまま使用（tech に rciShortPrev が入っているので二重計算なし）
      score = detectWBottomPattern_(bars, closes, tech).score;
      break;
    default:
      score = computeOversoldScore_(tech);
  }
  return score;
}

function runWatchlistCore_() {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var poolSheet = ss.getSheetByName(POOL_SHEET);
  if (!poolSheet) { return -1; }
  var lastRow = poolSheet.getLastRow();
  if (lastRow < 2) { return 0; }

  var rows       = poolSheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var candidates = [];
  var sizeOpt    = getSize_();
  var priceCap   = getPriceCap_();
  var presetId   = getPresetId_();

  for (var i = 0; i < rows.length; i++) {
    var code = rows[i][0];
    if (code === '' || code === null) { continue; }
    code     = String(code).trim();
    var name    = rows[i][1] ? String(rows[i][1]) : code;
    var sizeTag = rows[i][2] ? String(rows[i][2]) : '';
    if (sizeOpt === 'large' && sizeTag === '中小型') { continue; }
    if (sizeOpt === 'small' && sizeTag === '大型')   { continue; }

    var bars = fetchYahooDaily(code);
    Utilities.sleep(150);
    var closes = [];
    for (var b = 0; b < bars.length; b++) { closes.push(bars[b].close); }
    if (closes.length < SMA_LONG) { continue; }

    var tech  = analyzeTechnical(closes);
    var price = closes[closes.length - 1];
    if (priceCap > 0 && price > priceCap) { continue; }
    var pct   = (closes.length >= 2) ? ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100) : null;

    var score = computePresetScore_(presetId, tech, closes, bars);
    // wbottom はシグナル未達（75点未満）の銘柄をスコア0に
    if (presetId === 'wbottom' && !detectWBottomPattern_(bars, closes, tech).isWBottom) { score = 0; }

    candidates.push({name: name, code: code, price: price, pct: pct, tech: tech, score: score, bars: bars, closes: closes});
  }

  if (candidates.length === 0) { return 0; }
  candidates.sort(function(a, b) { return b.score - a.score; });
  var top       = candidates.slice(0, SCREEN_TOP_N);
  var watchData = writeWatchlist_(top);
  saveWatchReport(generateWatchReport(watchData));
  return watchData.length;
}

function writeWatchlist_(top) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(WATCH_SHEET);
  if (!sh) { sh = ss.insertSheet(WATCH_SHEET); }
  if (sh.getLastRow() >= 2) { sh.getRange(2, 1, sh.getLastRow() - 1, 9).clearContent(); }

  var watchData = [];
  var presetId  = getPresetId_();
  for (var i = 0; i < top.length; i++) {
    var c    = top[i];
    var tech = c.tech;
    var row  = i + 2;

    var up   = (tech.perfectOrder.indexOf('上昇') >= 0) || tech.trend === '上昇';
    var down = (tech.perfectOrder.indexOf('下降') >= 0) || tech.trend === '下落';
    var hot  = (tech.rciState === '買われすぎ' || tech.bbPos === '+2σ超え');
    var cold = (tech.rciState === '売られすぎ' || tech.bbPos === '-2σ割れ');
    var judgment;
    if      (up && hot)    { judgment = '上昇・過熱'; }
    else if (up)           { judgment = '上昇トレンド'; }
    else if (down && cold) { judgment = '下落・売られすぎ'; }
    else if (down)         { judgment = '下落トレンド'; }
    else if (cold)         { judgment = '売られすぎ'; }
    else                   { judgment = '中立'; }

    if (presetId === 'wbottom' && c.bars) {
      var wb = detectWBottomPattern_(c.bars, c.closes, tech);
      if (wb.isWBottom) { judgment = '底打ち候補（' + wb.score + '点）'; }
    }

    var maText = tech.perfectOrder ? (tech.perfectOrder.indexOf('上昇') >= 0 ? 'PO↑' : 'PO↓') : tech.trend;
    if (tech.maCross) { maText += '／' + (tech.maCross === 'ゴールデンクロス' ? 'GC' : 'DC'); }
    var rciText = '-';
    if (tech.rciShort !== null) {
      rciText = Math.round(tech.rciShort);
      if (tech.rciState !== '中立') { rciText += '(' + tech.rciState + ')'; }
    }
    var macdText = '-';
    if (tech.macdCross)              { macdText = (tech.macdCross === 'ゴールデンクロス' ? 'GC' : 'DC'); }
    else if (tech.macdHist !== null) { macdText = (tech.macdHist >= 0 ? '陽' : '陰'); }

    sh.getRange(row, 1).setValue(c.code);
    sh.getRange(row, 2).setValue(c.name);
    sh.getRange(row, 3).setValue(c.price !== null ? Math.round(c.price) : '-');
    if (c.pct !== null) { sh.getRange(row, 4).setValue(c.pct / 100).setNumberFormat('+0.00%;-0.00%'); }
    else                { sh.getRange(row, 4).setValue('-'); }
    sh.getRange(row, 5).setValue(maText);
    sh.getRange(row, 6).setValue(rciText);
    sh.getRange(row, 7).setValue(macdText);
    sh.getRange(row, 8).setValue(tech.bbPos);
    sh.getRange(row, 9).setValue(judgment);

    watchData.push({
      name: c.name, code: c.code, price: c.price, pct: c.pct,
      perfectOrder: tech.perfectOrder, rciShort: tech.rciShort !== null ? Math.round(tech.rciShort) : null,
      rciState: tech.rciState, macdCross: tech.macdCross, bbPos: tech.bbPos, judgment: judgment, hasTech: true
    });
  }
  return watchData;
}

function generateWatchReport(watchData) {
  var lines = [];
  for (var i = 0; i < watchData.length; i++) {
    var s   = watchData[i];
    var sig = [];
    if (s.rciState === '売られすぎ')  { sig.push('RCI売られすぎ(' + s.rciShort + ')'); }
    if (s.rciState === '買われすぎ')  { sig.push('RCI買われすぎ(' + s.rciShort + ')'); }
    if (s.bbPos === '-2σ割れ')        { sig.push('BB-2σ割れ'); }
    if (s.bbPos === '+2σ超え')        { sig.push('BB+2σ超え'); }
    if (s.macdCross)                  { sig.push('MACD' + s.macdCross); }
    if (s.perfectOrder)               { sig.push(s.perfectOrder); }
    lines.push(s.name + '(' + s.code + '): ' +
      (s.price !== null ? Math.round(s.price) + '円' : '-') + ' ' +
      (s.pct !== null ? (s.pct >= 0 ? '+' : '') + s.pct.toFixed(2) + '%' : '-') +
      ' / 判定:' + s.judgment + (sig.length ? ' / ' + sig.join('、') : ''));
  }
  var pid    = getPresetId_();
  var pLabel = PRESETS[pid].label;
  var focus;
  if      (pid === 'jun')     { focus = '1. 順張りで乗れそうな注目候補\n2. 過熱気味で注意の銘柄\n3. トレンド持続性を見るポイント'; }
  else if (pid === 'brk')     { focus = '1. ブレイクが続きそうな注目候補\n2. 急騰直後で反落に注意の銘柄\n3. ブレイクの本物/ダマシの見分け方'; }
  else if (pid === 'oshime')  { focus = '1. 良い押し目になっていそうな注目候補\n2. トレンド転換の恐れがある銘柄\n3. 押し目買いエントリーで確認すべきこと'; }
  else if (pid === 'kanetsu') { focus = '1. 特に過熱感が強く利確を検討してもよい銘柄\n2. 過熱だが勢いが続く可能性もある銘柄\n3. 高値圏での注意点'; }
  else if (pid === 'wbottom') { focus = '1. Wボトム・陽線回復・出来高増加がそろった注目候補（下げ止まり確認が大事と添える）\n2. スコアは高いがまだ様子見が必要な銘柄\n3. 底打ち候補エントリー前に確認したいリスク'; }
  else                        { focus = '1. 反発を待てそうな注目候補（下げ止まり確認が大事と添える）\n2. まだ下落が続き慎重にすべき銘柄\n3. リスト内の比較感'; }

  var prompt =
    'あなたはのんびり屋で優しいカピバラのキャラクター「' + WATCH_NAME + '」です。穏やかでマイペースな口調（焦らせない、癒し系）。\n' +
    'ユーザーはスイングトレードを行っており、戦略「' + pLabel + '」・保有期間「' + HORIZONS[getHorizon_()] + '」' +
    (getSize_() !== 'all' ? '・対象「' + SIZES[getSize_()] + '」' : '') +
    (getPriceCap_() > 0 ? '・価格帯「' + PRICECAPS[getPriceCap_()] + '」' : '') + ' の設定です。\n\n' +
    '以下が本日自動抽出された候補です（スコア順）。\n' + lines.join('\n') + '\n\n' +
    '次の点を200〜300文字でのんびり報告してください。\n' + focus + '\n' +
    '注目の2〜3銘柄だけ具体名を挙げ、あとは一言でまとめてください。\n' +
    '「自動抽出候補であり売買の推奨ではない」ことと、リスク管理を大切にするトーンで締めてください。';
  return callGeminiAPI(prompt);
}

function saveWatchReport(report) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(WATCH_REPORT_SHEET);
  if (!sh) { sh = ss.insertSheet(WATCH_REPORT_SHEET); }
  if (sh.getRange(1, 1).getValue() === '') {
    sh.getRange(1, 1, 1, 2).setValues([['日付', WATCH_NAME + ' レポート（ウォッチリスト）']])
      .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');
    sh.setColumnWidth(1, 140); sh.setColumnWidth(2, 600); sh.setFrozenRows(1);
  }
  sh.insertRowBefore(2);
  sh.getRange(2, 1).setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  sh.getRange(2, 2).setValue(report);
  sh.getRange(2, 1, 1, 2).setWrap(true).setVerticalAlignment('top');
  sh.setRowHeight(2, 150);
}

// ============================================================
// 10d. ピヨ＆トン（保有・監視銘柄）
// ============================================================
function lookupStockName_(code) {
  var symbol = String(code);
  if (!/[\^=.]/.test(symbol)) { symbol += '.T'; }
  try {
    var res = UrlFetchApp.fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=1d',
      {method: 'get', headers: {'User-Agent': 'Mozilla/5.0'}, muteHttpExceptions: true}
    );
    if (res.getResponseCode() !== 200) { return ''; }
    var meta = JSON.parse(res.getContentText()).chart.result[0].meta;
    return meta.shortName || meta.longName || '';
  } catch (e) { return ''; }
}

function addMyStockFromApp(code) {
  code = String(code || '').trim();
  if (!/^[0-9]{4}[0-9A-Z]?$/.test(code)) { return {ok: false, msg: '銘柄コードは4桁の数字で入力してください（例: 7203）'}; }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MY_SHEET);
  if (!sh) { return {ok: false, msg: 'my_stocksシートがありません。①初期セットアップを実行してください'}; }
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var codes = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < codes.length; i++) {
      if (String(codes[i][0]).trim() === code) { return {ok: false, msg: code + ' は登録済みです'}; }
    }
  }
  var name = lookupStockName_(code);
  if (!name) { return {ok: false, msg: code + ' のデータが見つかりません。コードをご確認ください'}; }
  sh.getRange(lastRow + 1, 1, 1, 3).setValues([[code, name, '監視']]);
  return {ok: true, name: name, msg: name + '（' + code + '）を登録しました。次回の分析から反映されます'};
}

function removeMyStockFromApp(code) {
  code = String(code || '').trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MY_SHEET);
  if (!sh || sh.getLastRow() < 2) { return {ok: false, msg: '登録銘柄がありません'}; }
  var codes = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < codes.length; i++) {
    if (String(codes[i][0]).trim() === code) { sh.deleteRow(i + 2); return {ok: true, msg: code + ' を削除しました'}; }
  }
  return {ok: false, msg: code + ' は見つかりませんでした'};
}

function runMyStocks() {
  var n = runMyStocksCore_();
  if      (n < 0)   { notify_(MY_SHEET + 'シートが見つかりません。①初期セットアップを実行してください。'); }
  else if (n === 0)  { notify_('銘柄が登録されていません。my_stocks シートのA列に銘柄コードを入力してください。'); }
  else               { notify_(BIRD_NAME + 'と' + PIG_NAME + 'が' + n + '銘柄を分析しました。'); }
}

function analyzeLongView_(closes) {
  var last = closes[closes.length - 1];
  var out  = {ma75Trend: '-', pos52w: null, hi52: null, lo52: null};
  if (closes.length >= 75 + 20) {
    var ma75now  = smaEndingAt(closes, closes.length - 1, 75);
    var ma75prev = smaEndingAt(closes, closes.length - 21, 75);
    if (ma75now !== null && ma75prev !== null) {
      out.ma75Trend = ma75now > ma75prev ? '上向き' : (ma75now < ma75prev ? '下向き' : '横ばい');
    }
  }
  var lookback = Math.min(closes.length, 250);
  var hi = -Infinity, lo = Infinity;
  for (var i = closes.length - lookback; i < closes.length; i++) {
    if (closes[i] > hi) { hi = closes[i]; }
    if (closes[i] < lo) { lo = closes[i]; }
  }
  if (hi > lo) {
    out.hi52 = hi; out.lo52 = lo;
    out.pos52w = Math.round((last - lo) / (hi - lo) * 100);
  }
  return out;
}

function runMyStocksCore_() {
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var sh      = ss.getSheetByName(MY_SHEET);
  if (!sh) { return -1; }
  var lastRow = sh.getLastRow();
  if (lastRow < 2) { return 0; }

  var rows = sh.getRange(2, 1, lastRow - 1, 3).getValues();
  var data = [];

  for (var i = 0; i < rows.length; i++) {
    var code = rows[i][0];
    if (code === '' || code === null) { continue; }
    code     = String(code).trim();
    var name = rows[i][1] ? String(rows[i][1]) : '';
    if (!name) {
      name = lookupStockName_(code);
      if (name) { sh.getRange(i + 2, 2).setValue(name); }
      else       { name = code; }
    }
    var kind     = rows[i][2] ? String(rows[i][2]) : '';
    var sheetRow = i + 2;

    var bars   = fetchYahooDaily(code, '2y');
    Utilities.sleep(150);
    var closes = [];
    for (var b = 0; b < bars.length; b++) { closes.push(bars[b].close); }
    if (closes.length < SMA_LONG) { sh.getRange(sheetRow, 4).setValue('取得不可'); continue; }

    var tech  = analyzeTechnical(closes);
    var lv    = analyzeLongView_(closes);
    var price = closes[closes.length - 1];
    var pct   = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100);

    var shortSig = '中立';
    if (tech.rciState === '売られすぎ' || tech.bbPos === '-2σ割れ')  { shortSig = '売られすぎ（反発待ち）'; }
    else if (tech.rciState === '買われすぎ' || tech.bbPos === '+2σ超え') { shortSig = '買われすぎ（過熱）'; }
    var midSig = tech.perfectOrder ? tech.perfectOrder : (tech.trend || '中立');
    if (tech.macdCross) { midSig += '・MACD' + (tech.macdCross === 'ゴールデンクロス' ? 'GC' : 'DC'); }
    var longSig = '75日線' + lv.ma75Trend + (lv.pos52w !== null ? '・52週位置' + lv.pos52w + '%' : '');

    var timing = '様子見';
    if ((tech.rciState === '売られすぎ' || tech.bbPos === '-2σ割れ') && tech.macdHist !== null && tech.macdHist >= 0) {
      timing = '買いシグナル点灯（売られすぎ＋MACD好転）';
    } else if (tech.rciState === '売られすぎ' || tech.bbPos === '-2σ割れ') {
      timing = '買いシグナル接近（下げ止まり確認待ち）';
    } else if (tech.rciState === '買われすぎ' || tech.bbPos === '+2σ超え') {
      timing = '売りシグナル接近（過熱・利確検討ゾーン）';
    } else if (tech.macdCross === 'ゴールデンクロス') {
      timing = '買い方向の初動（MACD GC）';
    } else if (tech.macdCross === 'デッドクロス') {
      timing = '売り方向の初動（MACD DC）';
    }

    sh.getRange(sheetRow, 4).setValue(Math.round(price));
    sh.getRange(sheetRow, 5).setValue(pct / 100).setNumberFormat('+0.00%;-0.00%');
    sh.getRange(sheetRow, 6).setValue(shortSig);
    sh.getRange(sheetRow, 7).setValue(midSig);
    sh.getRange(sheetRow, 8).setValue(longSig);
    sh.getRange(sheetRow, 9).setValue(timing);

    data.push({name: name, code: code, kind: kind, price: price, pct: pct,
      shortSig: shortSig, midSig: midSig, longSig: longSig, timing: timing,
      rci: tech.rciShort !== null ? Math.round(tech.rciShort) : null,
      bbPos: tech.bbPos, pos52w: lv.pos52w});
  }

  if (data.length === 0) { return 0; }
  sh.getRange(1, 4, 1, 6).setValues([['株価（円）', '前日比（%）', '短期', '中期', '長期', '売買シグナル']])
    .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');

  saveMyStockReports(generateBirdReport(data), generatePigReport(data));
  return data.length;
}

function myStockLines_(data) {
  return data.map(function(s) {
    return s.name + '(' + s.code + ')' + (s.kind ? '[' + s.kind + ']' : '') + ': ' +
      Math.round(s.price) + '円 ' + (s.pct >= 0 ? '+' : '') + s.pct.toFixed(2) + '% / ' +
      '短期:' + s.shortSig + ' / 中期:' + s.midSig + ' / 長期:' + s.longSig +
      (s.rci !== null ? ' / RCI:' + s.rci : '') +
      (s.pos52w !== null ? ' / 52週位置:' + s.pos52w + '%' : '') +
      ' / シグナル:' + s.timing;
  }).join('\n');
}

function generateBirdReport(data) {
  return callGeminiAPI(
    'あなたは小鳥のキャラクター「' + BIRD_NAME + '」です。語尾は「〜ピヨ」「〜だピヨ」。明るく軽やか、空から相場を見渡すのが得意です。\n' +
    '保有・監視銘柄の「短期・中期・長期」の見通しを整理して伝える役割です。\n\n' +
    '【本日のデータ】\n' + myStockLines_(data) + '\n\n' +
    '各銘柄の短期・中期・長期を250〜350文字で軽やかに報告してください（1銘柄2〜3文まで）。\n' +
    '売買タイミングの話はしないでください（トンの担当）。\n' +
    '見通しはテクニカル上の整理であり断定・予言はしないでください。\n' +
    '最後に「参考情報であり投資判断はご自身で」と添えてください。'
  );
}

function generatePigReport(data) {
  return callGeminiAPI(
    'あなたは子豚のキャラクター「' + PIG_NAME + '」です。語尾は「〜ブー」「〜だブー」。おいしいタイミングを探すのが得意です。\n' +
    '保有・監視銘柄の売買シグナル（買い時・売り時の目安）を伝える役割です。\n\n' +
    '【本日のデータ（シグナルは機械判定済み）】\n' + myStockLines_(data) + '\n\n' +
    '「シグナル:」欄をもとに買い接近／売り接近／様子見をグループ分けして200〜300文字で報告してください。\n' +
    '見通し解説はしないでください（ピヨの担当）。\n' +
    'シグナルはテクニカル上の目安であり売買の推奨ではないことを明言してください。\n' +
    '損切りライン（-2σを割ったら撤退など）のリスク管理も一言添えてください。'
  );
}

function saveMyStockReports(birdReport, pigReport) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MY_REPORT_SHEET);
  if (!sh) { sh = ss.insertSheet(MY_REPORT_SHEET); }
  if (sh.getRange(1, 1).getValue() === '') {
    sh.getRange(1, 1, 1, 3)
      .setValues([['日付', BIRD_NAME + ' レポート（見通し）', PIG_NAME + ' レポート（売買シグナル）']])
      .setBackground('#1a252f').setFontColor('#ffffff').setFontWeight('bold');
    sh.setColumnWidth(1, 140); sh.setColumnWidth(2, 450); sh.setColumnWidth(3, 450);
    sh.setFrozenRows(1);
  }
  sh.insertRowBefore(2);
  sh.getRange(2, 1).setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  sh.getRange(2, 2).setValue(birdReport);
  sh.getRange(2, 3).setValue(pigReport);
  sh.getRange(2, 1, 1, 3).setWrap(true).setVerticalAlignment('top');
  sh.setRowHeight(2, 150);
}

// ============================================================
// 11. Web App（doGet）
// ============================================================
function doGet() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var rSheet = ss.getSheetByName(REPORT_SHEET);
  var sSheet = ss.getSheetByName(SHEET_NAME);

  var dogReport  = '（レポートはまだありません。メニューから分析を実行してください）';
  var catReport  = dogReport;
  var reportDate = '';
  if (rSheet && rSheet.getLastRow() >= 2) {
    reportDate = rSheet.getRange(2, 1).getDisplayValue();
    dogReport  = rSheet.getRange(2, 2).getValue() || dogReport;
    catReport  = rSheet.getRange(2, 3).getValue() || catReport;
  }

  var weeklyReport = '';
  var wSheet = ss.getSheetByName(WEEKLY_SHEET);
  if (wSheet && wSheet.getLastRow() >= 2) { weeklyReport = wSheet.getRange(2, 2).getValue() || ''; }

  var watchReport = '';
  var wrSheet = ss.getSheetByName(WATCH_REPORT_SHEET);
  if (wrSheet && wrSheet.getLastRow() >= 2) { watchReport = wrSheet.getRange(2, 2).getValue() || ''; }

  var watchRows = '';
  var wlSheet   = ss.getSheetByName(WATCH_SHEET);
  if (wlSheet && wlSheet.getLastRow() >= 2) {
    var wlData = wlSheet.getRange(2, 1, wlSheet.getLastRow() - 1, 9).getValues();
    for (var w = 0; w < wlData.length; w++) {
      var wcode = wlData[w][0];
      if (!wcode) { continue; }
      var wname  = wlData[w][1] || wcode;
      var wprice = wlData[w][2];
      var wpct   = wlData[w][3];
      var wrci   = wlData[w][5];
      var wbb    = wlData[w][7];
      var wjudg  = wlData[w][8];
      var wpriceDisp = (typeof wprice === 'number') ? wprice.toLocaleString() + '円' : (wprice || '-');
      var wpctStr    = (typeof wpct === 'number') ? ((wpct >= 0 ? '+' : '') + (wpct * 100).toFixed(2) + '%') : String(wpct || '-');
      var wpctColor  = wpctStr.indexOf('-') >= 0 ? '#c0392b' : (wpctStr.indexOf('+') >= 0 ? '#27ae60' : '#555');
      var wrciStr    = String(wrci || '-');
      var wrciColor  = wrciStr.indexOf('売られ') >= 0 ? '#2980b9' : (wrciStr.indexOf('買われ') >= 0 ? '#c0392b' : '#555');
      var wbbStr     = String(wbb || '-');
      var wbbColor   = wbbStr.indexOf('-2σ') >= 0 ? '#2980b9' : (wbbStr.indexOf('+2σ') >= 0 ? '#c0392b' : '#555');
      watchRows += '<tr>' +
        '<td>' + wname + '<span style="color:#999;font-size:11px"> (' + wcode + ')</span></td>' +
        '<td style="text-align:right">' + wpriceDisp + '</td>' +
        '<td style="text-align:right;color:' + wpctColor + ';font-weight:bold">' + wpctStr + '</td>' +
        '<td style="text-align:center;font-size:12px;color:' + wrciColor + '">' + wrciStr + '</td>' +
        '<td style="text-align:center;font-size:12px;color:' + wbbColor + '">' + wbbStr + '</td>' +
        '<td style="text-align:center">' + (wjudg || '-') + '</td>' +
        '</tr>';
    }
  }

  var indicesHtml = '';
  try {
    var cache = CacheService.getScriptCache();
    indicesHtml = cache.get('indicesHtml') || '';
    if (!indicesHtml) {
      for (var ix = 0; ix < INDICES.length; ix++) {
        var idx   = INDICES[ix];
        var ibars = fetchYahooDaily(idx.symbol, '5d');
        Utilities.sleep(100);
        if (ibars.length < 2) { continue; }
        var iLast  = ibars[ibars.length - 1].close;
        var iPrev  = ibars[ibars.length - 2].close;
        var iPct   = (iLast - iPrev) / iPrev * 100;
        var iColor = iPct >= 0 ? '#2ecc71' : '#e74c3c';
        var iVal   = (idx.symbol === 'JPY=X') ? iLast.toFixed(2) : iLast.toLocaleString(undefined, {maximumFractionDigits: 0});
        indicesHtml += '<div class="idx"><div class="idx-name">' + idx.name + '</div>' +
          '<div class="idx-val">' + iVal + '</div>' +
          '<div class="idx-chg" style="color:' + iColor + '">' + (iPct >= 0 ? '▲ +' : '▼ ') + iPct.toFixed(2) + '%</div></div>';
      }
      if (indicesHtml) { cache.put('indicesHtml', indicesHtml, 600); }
    }
  } catch (eIdx) { indicesHtml = ''; }

  var birdReport = '', pigReport = '';
  var mrSheet = ss.getSheetByName(MY_REPORT_SHEET);
  if (mrSheet && mrSheet.getLastRow() >= 2) {
    birdReport = mrSheet.getRange(2, 2).getValue() || '';
    pigReport  = mrSheet.getRange(2, 3).getValue() || '';
  }

  var myRows = '', myChips = '';
  var mySheet2 = ss.getSheetByName(MY_SHEET);
  if (mySheet2 && mySheet2.getLastRow() >= 2) {
    var myData = mySheet2.getRange(2, 1, mySheet2.getLastRow() - 1, 9).getValues();
    for (var m = 0; m < myData.length; m++) {
      var mcode = myData[m][0];
      if (!mcode) { continue; }
      var mname  = myData[m][1] || mcode;
      var mkind  = myData[m][2] || '';
      var mprice = myData[m][3];
      var mpctRaw= myData[m][4];
      var mpct   = (typeof mpctRaw === 'number') ? ((mpctRaw >= 0 ? '+' : '') + (mpctRaw * 100).toFixed(2) + '%') : String(mpctRaw || '-');
      var mshort = myData[m][5] || '-'; var mmid = myData[m][6] || '-'; var mlong = myData[m][7] || '-';
      var mtiming= String(myData[m][8] || '-');
      var mpriceDisp = (typeof mprice === 'number') ? mprice.toLocaleString() + '円' : (mprice || '-');
      var mpctColor  = mpct.indexOf('-') >= 0 ? '#c0392b' : (mpct.indexOf('+') >= 0 ? '#27ae60' : '#555');
      var mtColor    = mtiming.indexOf('買い') >= 0 ? '#2980b9' : (mtiming.indexOf('売り') >= 0 ? '#c0392b' : '#555');
      myRows += '<tr>' +
        '<td>' + mname + '<span style="color:#999;font-size:11px"> (' + mcode + ')' + (mkind ? ' ' + mkind : '') + '</span></td>' +
        '<td style="text-align:right">' + mpriceDisp + '</td>' +
        '<td style="text-align:right;color:' + mpctColor + ';font-weight:bold">' + mpct + '</td>' +
        '<td style="text-align:center;font-size:12px">' + mshort + '</td>' +
        '<td style="text-align:center;font-size:12px">' + mmid + '</td>' +
        '<td style="text-align:center;font-size:12px">' + mlong + '</td>' +
        '<td style="text-align:center;font-size:12px;color:' + mtColor + ';font-weight:bold">' + mtiming + '</td>' +
        '</tr>';
      myChips += '<span class="chip">' + mname + ' (' + mcode + ')' +
        '<button class="chip-x" onclick="delStock(\'' + mcode + '\')">×</button></span>';
    }
  }

  var tableRows = '';
  if (sSheet && sSheet.getLastRow() >= 2) {
    for (var si = 0; si < SECTORS.length; si++) {
      var srow  = si + 2;
      var sname = sSheet.getRange(srow, 1).getValue();
      if (!sname) { continue; }
      var sprice     = sSheet.getRange(srow, 3).getValue();
      var schangePct = sSheet.getRange(srow, 4).getValue();
      var smaText    = sSheet.getRange(srow, 5).getValue();
      var srciText   = sSheet.getRange(srow, 6).getValue();
      var smacdText  = sSheet.getRange(srow, 7).getValue();
      var sbbPos     = sSheet.getRange(srow, 8).getValue();
      var sjudgment  = sSheet.getRange(srow, 9).getValue();
      var spct       = (typeof schangePct === 'number') ? schangePct : 0;
      var spctDisp   = (spct * 100).toFixed(2);
      var spctColor  = spct >= 0 ? '#27ae60' : '#c0392b';
      var sbgColor   = spct >= 0.005 ? '#eafbea' : (spct <= -0.005 ? '#fdecea' : '#fafafa');
      var smaStr     = String(smaText   || '-');
      var srciStr    = String(srciText  || '-');
      var smacdStr   = String(smacdText || '-');
      var sbbStr     = String(sbbPos    || '-');
      tableRows += '<tr style="background:' + sbgColor + '">' +
        '<td>' + sname + '</td>' +
        '<td style="text-align:right">' + ((typeof sprice === 'number') ? sprice.toLocaleString() + '円' : '-') + '</td>' +
        '<td style="text-align:right;color:' + spctColor + ';font-weight:bold">' + (spct >= 0 ? '+' : '') + spctDisp + '%</td>' +
        '<td style="text-align:center;font-size:12px;color:' + (smaStr.indexOf('↑') >= 0 ? '#27ae60' : (smaStr.indexOf('↓') >= 0 ? '#c0392b' : '#555')) + '">' + smaStr + '</td>' +
        '<td style="text-align:center;font-size:12px;color:' + (srciStr.indexOf('買われ') >= 0 ? '#c0392b' : (srciStr.indexOf('売られ') >= 0 ? '#2980b9' : '#555')) + '">' + srciStr + '</td>' +
        '<td style="text-align:center;font-size:12px;color:' + (smacdStr.indexOf('GC') >= 0 || smacdStr === '陽' ? '#27ae60' : (smacdStr.indexOf('DC') >= 0 || smacdStr === '陰' ? '#c0392b' : '#555')) + '">' + smacdStr + '</td>' +
        '<td style="text-align:center;font-size:12px;color:' + (sbbStr.indexOf('+2σ') >= 0 ? '#c0392b' : (sbbStr.indexOf('-2σ') >= 0 ? '#2980b9' : '#555')) + '">' + sbbStr + '</td>' +
        '<td style="text-align:center">' + (sjudgment || '-') + '</td></tr>';
    }
  }
  if (!tableRows) { tableRows = '<tr><td colspan="8" style="text-align:center;color:#999;padding:20px">データがありません。</td></tr>'; }

  var esc = function(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  var presetId      = getPresetId_();
  var presetLabel   = PRESETS[presetId].label;
  var presetOptions = '';
  for (var pk in PRESETS) {
    presetOptions += '<option value="' + pk + '"' + (pk === presetId ? ' selected' : '') + '>' +
      PRESETS[pk].label + '（' + PRESETS[pk].hint + '）</option>';
  }
  var curH = getHorizon_(), curS = getSize_(), curC = getPriceCap_();
  var horizonOptions = '', sizeOptions = '', capOptions = '';
  for (var hk in HORIZONS) { horizonOptions += '<option value="' + hk + '"' + (hk === curH ? ' selected' : '') + '>保有: ' + HORIZONS[hk] + '</option>'; }
  for (var sk in SIZES)    { sizeOptions    += '<option value="' + sk + '"' + (sk === curS ? ' selected' : '') + '>サイズ: ' + SIZES[sk]    + '</option>'; }
  for (var ck in PRICECAPS){ capOptions     += '<option value="' + ck + '"' + (String(ck) === String(curC) ? ' selected' : '') + '>価格帯: ' + PRICECAPS[ck] + '</option>'; }

  var css =
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:"Helvetica Neue",Arial,sans-serif;background:linear-gradient(135deg,#1a252f,#34495e);min-height:100vh;padding:24px 16px;color:#333}' +
    '.wrap{max-width:900px;margin:0 auto}' +
    '.hero{text-align:center;margin-bottom:28px}' +
    '.hero h1{font-size:26px;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.5);margin-bottom:6px}' +
    '.hero .sub{color:rgba(255,255,255,.7);font-size:13px}' +
    '.badge{display:inline-block;background:rgba(255,255,255,.15);color:#fff;border-radius:999px;padding:4px 14px;font-size:13px;margin-top:10px}' +
    '.card{background:#fff;border-radius:18px;padding:24px;margin-bottom:20px;box-shadow:0 10px 40px rgba(0,0,0,.2)}' +
    '.row{display:flex;align-items:flex-start;gap:18px}' +
    '.icon{font-size:72px;line-height:1;flex-shrink:0}.body{flex:1}' +
    '.cname{font-size:19px;font-weight:700;margin-bottom:2px}' +
    '.role{display:inline-block;font-size:11px;color:#666;background:#f0f0f0;border-radius:999px;padding:2px 10px;margin-bottom:12px}' +
    '.bubble{border-radius:12px;padding:16px 18px;line-height:1.9;white-space:pre-wrap;font-size:14.5px;border-left:5px solid #ccc}' +
    '.dog{border-left-color:#e67e22;background:#fffaf5}.cat{border-left-color:#8e44ad;background:#fdf8ff}' +
    '.stitle{font-size:16px;font-weight:700;border-bottom:2px solid #2c3e50;padding-bottom:8px;margin-bottom:16px;color:#2c3e50}' +
    'table{width:100%;border-collapse:collapse;font-size:14px}' +
    'th{background:#2c3e50;color:#fff;padding:10px 14px;text-align:left;font-weight:600}' +
    'td{padding:9px 14px;border-bottom:1px solid #eee}' +
    '.idxbar{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:22px}' +
    '.idx{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:10px 16px;min-width:120px;text-align:center}' +
    '.idx-name{color:rgba(255,255,255,.75);font-size:11px;margin-bottom:2px}' +
    '.idx-val{color:#fff;font-size:18px;font-weight:700;letter-spacing:.5px}' +
    '.idx-chg{font-size:12px;font-weight:600;margin-top:2px}' +
    '.chip{display:inline-flex;align-items:center;gap:6px;background:#f0f3f6;border:1px solid #dde3e9;border-radius:999px;padding:4px 6px 4px 12px;font-size:13px;margin:3px}' +
    '.chip-x{border:none;background:#cfd8e0;color:#fff;border-radius:50%;width:18px;height:18px;line-height:18px;font-size:12px;cursor:pointer;padding:0}' +
    '.chip-x:hover{background:#e74c3c}' +
    '.ctl-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}' +
    '.ctl-row select,.ctl-row input{padding:8px 10px;border:1px solid #ccd5dc;border-radius:8px;font-size:14px}' +
    '.btn{background:#2c3e50;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}' +
    '.btn:hover{background:#3d566e}' +
    '.ctl-msg{font-size:13px;color:#2980b9;min-height:18px;margin-top:4px}' +
    '.foot{text-align:center;color:rgba(255,255,255,.45);font-size:11px;margin-top:24px;padding-bottom:16px;line-height:1.8}' +
    '@media(max-width:600px){.row{flex-direction:column;align-items:center}.icon{font-size:56px}.body{width:100%}}';

  var bbl = function(color, bg, content) {
    return '<div class="bubble" style="border-left:5px solid ' + color + ';background:' + bg + '">' + content + '</div>';
  };

  var body =
    '<body><div class="wrap">' +
    '<div class="hero"><h1>🐾 ワンニャン株式予報</h1>' +
    '<p class="sub">日本株を毎日自動分析。地合い・テクニカル・個別銘柄をお届けします。</p>' +
    '<span class="badge">📅 ' + (reportDate ? reportDate + ' JST' : 'レポートなし') + '</span></div>' +
    (indicesHtml ? '<div class="idxbar">' + indicesHtml + '</div>' : '') +
    '<div class="card"><div class="row"><div class="icon">🐶</div><div class="body">' +
    '<div class="cname">ハチ（柴犬）</div><span class="role">マクロ分析 / 地合い・順張り担当</span>' +
    '<div class="bubble dog">' + esc(dogReport) + '</div></div></div></div>' +
    '<div class="card"><div class="row"><div class="icon">🐱</div><div class="body">' +
    '<div class="cname">ミケ（三毛猫）</div><span class="role">テクニカル分析 / 逆張り・リスク管理担当</span>' +
    '<div class="bubble cat">' + esc(catReport) + '</div></div></div></div>' +
    (weeklyReport ? '<div class="card"><div class="row"><div class="icon">' + WEEKLY_EMOJI + '</div><div class="body">' +
    '<div class="cname">' + WEEKLY_NAME + '（週次総括）</div><span class="role">週次パフォーマンス担当</span>' +
    bbl('#16a085', '#f3fbf9', esc(weeklyReport)) + '</div></div></div>' : '') +
    (watchReport ? '<div class="card"><div class="row"><div class="icon">' + WATCH_EMOJI + '</div><div class="body">' +
    '<div class="cname">' + WATCH_NAME + '（自動スクリーニング）</div><span class="role">候補を毎日自動抽出して見守る担当</span>' +
    bbl('#b8860b', '#fefcf3', esc(watchReport)) + '</div></div></div>' : '') +
    (watchRows ? '<div class="card"><div class="stitle">⭐ 本日の候補：' + presetLabel + '（上位' + SCREEN_TOP_N + '）</div>' +
    '<table><thead><tr><th>銘柄</th><th style="text-align:right">株価</th><th style="text-align:right">前日比</th>' +
    '<th style="text-align:center">RCI</th><th style="text-align:center">ボリンジャー</th><th style="text-align:center">判定</th>' +
    '</tr></thead><tbody>' + watchRows + '</tbody></table></div>' : '') +
    (birdReport ? '<div class="card"><div class="row"><div class="icon">' + BIRD_EMOJI + '</div><div class="body">' +
    '<div class="cname">' + BIRD_NAME + '（小鳥・見通し）</div><span class="role">保有・監視銘柄の短期/中期/長期見通し担当</span>' +
    bbl('#3498db', '#f3f9fe', esc(birdReport)) + '</div></div></div>' : '') +
    (pigReport ? '<div class="card"><div class="row"><div class="icon">' + PIG_EMOJI + '</div><div class="body">' +
    '<div class="cname">' + PIG_NAME + '（子豚・売買シグナル）</div><span class="role">保有・監視銘柄の買い時・売り時シグナル担当</span>' +
    bbl('#e84393', '#fef5f9', esc(pigReport)) + '</div></div></div>' : '') +
    (myRows ? '<div class="card"><div class="stitle">💼 保有・監視銘柄</div>' +
    '<table><thead><tr><th>銘柄</th><th style="text-align:right">株価</th><th style="text-align:right">前日比</th>' +
    '<th style="text-align:center">短期</th><th style="text-align:center">中期</th><th style="text-align:center">長期</th>' +
    '<th style="text-align:center">売買シグナル</th></tr></thead><tbody>' + myRows + '</tbody></table></div>' : '') +
    '<div class="card"><div class="stitle">📊 本日のセクター別テクニカル</div>' +
    '<table><thead><tr><th>業界</th><th style="text-align:right">株価</th><th style="text-align:right">前日比</th>' +
    '<th style="text-align:center">MA配列</th><th style="text-align:center">RCI</th><th style="text-align:center">MACD</th>' +
    '<th style="text-align:center">ボリンジャー</th><th style="text-align:center">判定</th>' +
    '</tr></thead><tbody>' + tableRows + '</tbody></table></div>' +
    '<div class="card"><div class="stitle">⚙️ 設定</div>' +
    '<div style="font-weight:600;font-size:14px;margin-bottom:6px">スクリーニング戦略（カピバラの抽出条件）</div>' +
    '<div class="ctl-row"><select id="presetSel">' + presetOptions + '</select>' +
    '<button class="btn" onclick="applyPreset()">適用</button>' +
    '<span style="font-size:12px;color:#888">現在: ' + presetLabel + '（次回の抽出から反映）</span></div>' +
    '<div style="font-weight:600;font-size:14px;margin:14px 0 6px">抽出オプション</div>' +
    '<div class="ctl-row"><select id="horizonSel">' + horizonOptions + '</select>' +
    '<select id="sizeSel">' + sizeOptions + '</select>' +
    '<select id="capSel">' + capOptions + '</select>' +
    '<button class="btn" onclick="applyOptions()">適用</button></div>' +
    '<div style="font-weight:600;font-size:14px;margin:14px 0 6px">保有・監視銘柄の登録</div>' +
    '<div class="ctl-row"><input id="stockCode" type="text" placeholder="例: 7203" maxlength="5" style="width:110px">' +
    '<button class="btn" onclick="addStock()">追加</button></div>' +
    '<div>' + (myChips || '<span style="color:#999;font-size:13px">登録銘柄はまだありません</span>') + '</div>' +
    '<div class="ctl-msg" id="ctlMsg"></div></div>' +
    '<div class="foot">⚠️ このレポートは情報提供を目的としており、特定の投資を勧誘・推奨するものではありません。<br>投資はご自身の判断と責任において行ってください。</div>' +
    '<script>' +
    'function msg(t,ok){var el=document.getElementById("ctlMsg");el.textContent=t;el.style.color=ok?"#27ae60":"#c0392b";}' +
    'function applyPreset(){var id=document.getElementById("presetSel").value;msg("保存中...",true);' +
    'google.script.run.withSuccessHandler(function(r){msg(r.ok?"戦略を「"+r.label+"」に変更しました。次回の抽出から反映されます":r.msg,r.ok);})' +
    '.withFailureHandler(function(e){msg("エラー: "+e.message,false);}).setPresetFromApp(id);}' +
    'function applyOptions(){msg("保存中...",true);' +
    'google.script.run.withSuccessHandler(function(r){msg(r.msg,r.ok);})' +
    '.withFailureHandler(function(e){msg("エラー: "+e.message,false);})' +
    '.setScreenOptionsFromApp(document.getElementById("horizonSel").value,document.getElementById("sizeSel").value,document.getElementById("capSel").value);}' +
    'function addStock(){var code=document.getElementById("stockCode").value;if(!code){msg("銘柄コードを入力してください",false);return;}' +
    'msg("社名を確認中...",true);google.script.run.withSuccessHandler(function(r){msg(r.msg,r.ok);if(r.ok){setTimeout(function(){location.reload();},1800);}})' +
    '.withFailureHandler(function(e){msg("エラー: "+e.message,false);}).addMyStockFromApp(code);}' +
    'function delStock(code){if(!confirm(code+" を削除しますか？")){return;}' +
    'google.script.run.withSuccessHandler(function(r){msg(r.msg,r.ok);if(r.ok){setTimeout(function(){location.reload();},1200);}})' +
    '.withFailureHandler(function(e){msg("エラー: "+e.message,false);}).removeMyStockFromApp(code);}' +
    '</scr'+'ipt></div></body></html>';

  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<title>ワンニャン株式予報</title><style>' + css + '</style></head>' + body)
    .setTitle('ワンニャン株式予報')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ============================================================
// 12. トリガー設定
// ★ 対策A：3つの処理を別々のトリガーに分離
//    17:00 runDailyAnalysis   ハチ＋ミケ（セクター分析・Gemini×2）
//    17:30 runWatchlist       カピバラ（pool全件スクリーニング・Gemini×1）
//    18:00 runMyStocks        ピヨ＋トン（my_stocks分析・Gemini×2）
// ============================================================
function setupTriggers() {
  // 既存トリガーをすべて削除（重複防止）
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'runDailyAnalysis' || fn === 'runWatchlist' || fn === 'runMyStocks') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('runDailyAnalysis')
    .timeBased().everyDays(1).atHour(17).inTimezone('Asia/Tokyo').create();
  ScriptApp.newTrigger('runWatchlist')
    .timeBased().everyDays(1).atHour(17).nearMinute(30).inTimezone('Asia/Tokyo').create();
  ScriptApp.newTrigger('runMyStocks')
    .timeBased().everyDays(1).atHour(18).inTimezone('Asia/Tokyo').create();

  SpreadsheetApp.getUi().alert(
    'トリガーを3本設定しました！\n\n' +
    '17:00  ハチ＋ミケ（セクター分析）\n' +
    '17:30  カピバラ（スクリーニング）\n' +
    '18:00  ピヨ＋トン（保有・監視銘柄）\n\n' +
    '各処理が独立して動くため、タイムアウトのリスクが大幅に減ります。'
  );
}

// 後方互換用（旧メニューから呼んでも動くようにエイリアスを残す）
function setDailyTrigger() { setupTriggers(); }

function setWeeklyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runWeeklyReport') { ScriptApp.deleteTrigger(triggers[i]); }
  }
  ScriptApp.newTrigger('runWeeklyReport')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(10).inTimezone('Asia/Tokyo').create();
  SpreadsheetApp.getUi().alert(WEEKLY_NAME + 'の週次レポートを毎週月曜10:00（JST）に自動実行します。');
}

// ============================================================
// 13. Web App URL を表示
// ============================================================
function showWebAppUrl() {
  var url = ScriptApp.getService().getUrl();
  if (url) { SpreadsheetApp.getUi().alert('Web App URL:\n\n' + url + '\n\nブックマークしておくといつでも確認できます。'); }
  else {
    SpreadsheetApp.getUi().alert('まだデプロイされていません。\n\n手順:\n1.「デプロイ」>「新しいデプロイ」\n2. 種類:「ウェブアプリ」、アクセス:「全員」\n3. デプロイしてURLをコピー');
  }
}

// ============================================================
// 14. Yahoo Finance 取得テスト
// ============================================================
function testYahoo() {
  var msg = 'Yahoo Finance 取得テスト結果\n\n';
  var ok  = 0;
  var allBars = fetchYahooBatch();
  for (var i = 0; i < SECTORS.length; i++) {
    var bars = allBars[i];
    if (bars.length > 0) { ok++; msg += '○ ' + SECTORS[i].code + ' ' + SECTOR_JP[i] + ': ' + bars.length + '件（最新 ' + bars[bars.length - 1].date + '）\n'; }
    else                 {       msg += '× ' + SECTORS[i].code + ' ' + SECTOR_JP[i] + ': 取得不可\n'; }
  }
  msg += '\n取得できたコード: ' + ok + ' / ' + SECTORS.length;
  if (ok === 0) { msg += '\n\n全滅の場合、Yahooがクラウドからのアクセスを制限（429）している可能性があります。'; }
  SpreadsheetApp.getUi().alert(msg);
}
