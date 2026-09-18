const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const JSON_ROOT = path.join(ROOT, 'data-json');
const CHECK = process.argv.includes('--check');
const SCHEMA_VERSION = 1;
const MAP_KEYS = [
  'summaries', 'records', 'itemCountDaily', 'lineHumanDaily',
  'lineAvgFromSheets', 'stoplineDaily', 'changeoverDaily', 'changeoverCountDaily'
];

const slash = p => p.split(path.sep).join('/');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value));
};

function scanFiles(dir, re, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return scanFiles(full, re, base);
    return re.test(entry.name) ? [slash(path.relative(base, full))] : [];
  }).sort((a, b) => a.localeCompare(b, 'zh-Hant', {numeric: true}));
}

function reportSpan(rel) {
  const name = path.posix.basename(rel).normalize('NFKC');
  const m = name.match(/(?:^|[^0-9])(\d{3})[.\-_/](\d{1,2})[.\-_/](\d{1,2})\s*[-~～至]\s*(\d{1,2})/);
  if (!m) return null;
  return {monthKey: `${Number(m[1]) + 1911}-${String(Number(m[2])).padStart(2, '0')}`, start: Number(m[3]), end: Number(m[4])};
}

function chooseSourceFiles(all) {
  const excluded = new Set();
  const byMonthAndStart = new Map();
  for (const rel of all) {
    const span = reportSpan(rel);
    if (!span) continue;
    const key = `${span.monthKey}|${span.start}`;
    const prior = byMonthAndStart.get(key);
    if (!prior || span.end > prior.span.end || (span.end === prior.span.end && rel > prior.rel)) {
      if (prior) excluded.add(prior.rel);
      byMonthAndStart.set(key, {rel, span});
    } else excluded.add(rel);
  }
  return {files: all.filter(rel => !excluded.has(rel)), excluded: [...excluded]};
}

function loadWebsiteParser() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const full = blocks.find(s => s.includes('async function parseWorkbookArrayBuffer'));
  if (!full) throw new Error('index.html 找不到人時性解析函式');
  const source = full.split('(async function init(){')[0];

  const stub = new Proxy(function(){}, {
    get: (_t, key) => {
      if (key === 'style' || key === 'dataset') return {};
      if (key === 'options') return [];
      if (key === 'classList') return {add(){}, remove(){}, toggle(){}, contains(){return false;}};
      return stub;
    },
    apply: () => stub
  });
  const document = {
    getElementById() { return stub; }, querySelector() { return stub; }, querySelectorAll() { return []; },
    createElement() { return stub; }, addEventListener() {}, head: stub, body: stub, documentElement: stub
  };
  const sandbox = {
    XLSX, console, document, navigator: {}, location: {host:'', href:'http://localhost/', pathname:'/', protocol:'http:', search:''},
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, DOMException, URL, URLSearchParams,
    Blob, Map, Set, Date, Math, Intl, requestAnimationFrame(){}, requestIdleCallback(fn){ fn(); },
    localStorage: {getItem(){return null;}, setItem(){}, removeItem(){}},
    fetch: async () => { throw new Error('converter 不執行網路請求'); },
    alert(){}, confirm(){return false;}
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, {filename: 'index.html', timeout: 20000});
  vm.runInContext(`globalThis.__dashboardParser = {
    async parse(buf, filename){
      for (const key of ${JSON.stringify(MAP_KEYS)}) state[key] = new Map();
      state.recordList = [];
      state.firstSeenProd = new Map();
      state.loadedFiles = [];
      await parseWorkbookArrayBuffer(buf, filename);
      const payload = {recordList: state.recordList};
      for (const key of ${JSON.stringify(MAP_KEYS)}) payload[key] = Array.from(state[key].entries());
      return payload;
    }
  }`, sandbox);
  return {api: sandbox.__dashboardParser, parserHash: hash(`${SCHEMA_VERSION}\n${source}`), sandbox};
}

function validatePayload(payload, rel) {
  if (!payload || !Array.isArray(payload.recordList)) throw new Error(`${rel}: JSON 缺少 recordList`);
  for (const key of MAP_KEYS) if (!Array.isArray(payload[key])) throw new Error(`${rel}: JSON 缺少 ${key}`);
}

async function main() {
  const {api, parserHash, sandbox} = loadWebsiteParser();
  const allExcel = scanFiles(DATA, /\.xlsx$/i);
  const {files, excluded} = chooseSourceFiles(allExcel);
  if (excluded.length) console.log(`略過 ${excluded.length} 份已有較完整版本的舊檔：${excluded.join('、')}`);

  const oldManifest = readJson(path.join(DATA, 'json-manifest.json')) || {};
  const entries = {};
  let converted = 0, reused = 0;

  for (const rel of files) {
    const sourceFile = path.join(DATA, ...rel.split('/'));
    const sourceSha256 = hash(fs.readFileSync(sourceFile));
    const jsonRel = slash(path.join('data-json', rel.replace(/\.xlsx$/i, '.json')));
    const jsonFile = path.join(ROOT, ...jsonRel.split('/'));
    const old = oldManifest.files && oldManifest.files[rel];
    if (old && old.sourceSha256 === sourceSha256 && old.parserHash === parserHash && old.json === jsonRel && fs.existsSync(jsonFile)) {
      validatePayload(readJson(jsonFile), rel);
      entries[rel] = {...old, jsonBytes: fs.statSync(jsonFile).size};
      reused++;
      continue;
    }
    if (CHECK) throw new Error(`${rel}: JSON 尚未更新，請執行 npm run convert:data`);

    sandbox.__input = new Uint8Array(fs.readFileSync(sourceFile));
    const payload = await api.parse(sandbox.__input, rel);
    delete sandbox.__input;
    payload.schemaVersion = SCHEMA_VERSION;
    payload.source = rel;
    payload.sourceSha256 = sourceSha256;
    payload.parserHash = parserHash;
    validatePayload(payload, rel);
    writeJson(jsonFile, payload);
    entries[rel] = {json: jsonRel, sourceSha256, parserHash, jsonBytes: fs.statSync(jsonFile).size};
    converted++;
    console.log(`轉換 ${rel}`);
  }

  const expectedJson = new Set(Object.values(entries).map(e => e.json.replace(/^data-json\//, '')));
  const orphanJson = scanFiles(JSON_ROOT, /\.json$/i).filter(rel => !expectedJson.has(rel));
  const staleJson = Object.keys(oldManifest.files || {})
    .filter(rel => !entries[rel])
    .map(rel => oldManifest.files[rel] && oldManifest.files[rel].json)
    .filter(rel => typeof rel === 'string' && rel.startsWith('data-json/'))
    .map(rel => rel.replace(/^data-json\//, ''));
  const cleanupJson = [...new Set([...orphanJson, ...staleJson])];
  const fileList = {files};
  if (CHECK) {
    const current = readJson(path.join(DATA, 'manifest.json'));
    if (JSON.stringify(current) !== JSON.stringify(fileList)) throw new Error('data/manifest.json 與資料夾內容不同步');
    if (JSON.stringify(oldManifest.files || {}) !== JSON.stringify(entries)) throw new Error('data/json-manifest.json 與 JSON 檔不同步');
    if (cleanupJson.length) throw new Error(`data-json 含 ${cleanupJson.length} 份無來源的舊 JSON`);
  } else {
    writeJson(path.join(DATA, 'manifest.json'), fileList);
    writeJson(path.join(DATA, 'json-manifest.json'), {
      schemaVersion: SCHEMA_VERSION, parserHash, generatedAt: new Date().toISOString(), files: entries
    });
    if (cleanupJson.length) console.log(`清理 ${cleanupJson.length} 份無來源 JSON`);
    for (const rel of cleanupJson) {
      const target = path.join(JSON_ROOT, ...rel.split('/'));
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    // 某些同步資料夾的目錄索引更新較慢，稍後再核對一次，確保一次執行就清乾淨。
    await new Promise(resolve => setTimeout(resolve, 100));
    const remaining = scanFiles(JSON_ROOT, /\.json$/i).filter(rel => !expectedJson.has(rel));
    for (const rel of remaining) {
      const target = path.join(JSON_ROOT, ...rel.split('/'));
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    const stillRemaining = scanFiles(JSON_ROOT, /\.json$/i).filter(rel => !expectedJson.has(rel));
    if (stillRemaining.length) throw new Error(`無法清理 ${stillRemaining.length} 份舊 JSON`);
  }
  console.log(`${CHECK ? '檢查完成' : '轉換完成'}：${files.length} 份（新轉 ${converted}、沿用 ${reused}）`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
