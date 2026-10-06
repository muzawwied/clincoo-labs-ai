// clincoo-labs-ai v2 — gateway orkestra balapan + belajar latar Clincoo Labs
//
// Upgrade 6 Okt 2026 (permintaan owner: "agar AI belajar, jawab lebih cepat,
// belajar di layar belakang via OpenRouter, pakai model Astra kalau ada,
// utamakan kecepatan dan kecerdasan"):
//
//   1. BALAPAN PARALEL (kecepatan): kandidat start BERSAMAAN — OpenRouter
//      GLM 5.3 Flash + OpenRouter GPT-6 ASTRA (model astra ada!) + Gemini
//      3.6 Flash (+ Ollama pribadi bila ready). Token pertama yang mengalir
//      jadi pemenang dan langsung tampil ke user; kandidat lain diabort
//      begitu pemenang sudah menghasilkan ~120 karakter (hemat kuota).
//   2. MODEL ASTRA: openai/gpt-6-astra kandidat tetap (murah, cepat, pintar).
//   3. BELAJAR LATAR (kecerdasan, via OpenRouter, ctx.waitUntil — TIDAK
//      menunda jawaban sama sekali):
//      - labs_dataset  : setiap tanya-jawab direkam (pertanyaan, jawaban,
//                        model pemenang, latensi, skor juri 1-10).
//      - labs_model_stats: statistik menang/latensi/skor per model ->
//                        urutan kandidat ADAPTIF (model dengan skor & win
//                        terbaik start duluan di balapan berikutnya).
//      - labs_insights : tiap 6 pesan, riwayat diperpendek model flash
//                        menjadi "insight" <=700 char tentang user & gaya
//                        menjawab terbaik, disuntik ke system prompt.
//      - Juri latar    : jawaban pemenang dinilai 1-10 oleh model flash
//                        (OpenRouter) untuk memberi makan statistik.
//   4. Label model JUJUR: respons kini menyebut nama model pemenang asli.
//   5. Fallback tetap berlapis: Clouvia -> Workers AI -> Gemini -> ramah.
//      Header X-Labs-Force: fallback = tanpa Ollama.
//      Header X-Labs-Race: off = mode lama (sekuensial, tanpa balapan).
//   Endpoint: POST /api/chat | GET /health | GET /api/stats

var OLLAMA_MODEL = 'gemma3:latest';
var OLLAMA_TIMEOUT_MS = 75e3;
var OLLAMA_FIRST_MS = 10e3;
var OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
var OR_MODELS = ['z-ai/glm-5.3-flash', 'cohere/north-mini-code:free', 'google/gemma-4-31b-it:free', 'openai/gpt-6-astra']; // [6 Okt 2026] gemma-4-31b:free masuk — model free terbesar di katalog, jawaban rapi, ~3.6s, cadangan gratis saat cohere 429 [6 Okt 2026] cohere north-mini-code :free ikut balapan — spesialis koding, ~4s, gratis (50 req/hari/kunci; limit habis -> 429 gagal cepat, tidak menahan balapan)
var JUDGE_MODEL = 'z-ai/glm-5.3-flash';
var CLOUVIA_MODELS = ['glm5.3-flash', 'free-model'];
var WORKERS_AI_MODELS = ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
var GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];
var WINNER_ABORT_CHARS = 120; // pemenang sejauh ini -> abort kandidat lain
var DATASET_MAX_ROWS = 4000;
var INSIGHT_EVERY_N = 6; // kondensasi insight tiap N pesan
var INSIGHT_MAX_CHARS = 700;

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Labs-Force,X-Labs-Race',
  'Access-Control-Max-Age': '86400'
};

var urlCache = { url: '', at: 0 };
var psCache = new Map();
var tablesReady = false;
var statsCache = { at: 0, map: null };
var insightsCache = { at: 0, text: '' };

// ===== kunci dari env + D1 =====
async function d1Pairs(env, opts) {
  var out = [];
  try {
    if (opts.names && opts.names.length) {
      var ph = opts.names.map(function () { return '?'; }).join(',');
      var stmt = env.DB.prepare('SELECT key, value FROM env_vars WHERE key IN (' + ph + ')');
      var rows = await stmt.bind(...opts.names).all();
      out = out.concat(rows.results || []);
    }
    if (opts.like) {
      var rows2 = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key LIKE '" + opts.like + "' ORDER BY key").all();
      out = out.concat(rows2.results || []);
    }
  } catch (e) {
    console.log('[D1] env_vars err: ' + String(e && e.message || e));
  }
  return out;
}

function uniqValues(pairs, extra) {
  var seen = new Set();
  var vals = [];
  var add = function (v) {
    v = String(v || '').trim();
    if (v && !seen.has(v)) { seen.add(v); vals.push(v); }
  };
  for (var i = 0; i < extra.length; i++) add(extra[i]);
  for (var k = 0; k < pairs.length; k++) add(pairs[k].value);
  return vals;
}

async function getOllamaUrl(env) {
  if (urlCache.url && Date.now() - urlCache.at < 3e4) return urlCache.url;
  var url = (env.OLLAMA_URL || '').trim();
  try {
    var r = await env.DB.prepare("SELECT value FROM env_vars WHERE key='LABS_OLLAMA_URL' ORDER BY id DESC LIMIT 1").first();
    if (r && r.value && /^https?:\/\//.test(r.value.trim())) url = r.value.trim();
  } catch (e) {}
  urlCache = { url: url, at: Date.now() };
  return url;
}
async function getOpenRouterKeys(env) {
  var pairs = await d1Pairs(env, { like: 'OPENROUTER_API_KEY%' });
  return uniqValues(pairs, [env.OPENROUTER_API_KEY]);
}
async function getClouviaKeys(env) {
  var pairs = await d1Pairs(env, { names: ['CLOUVIA_API_KEY', 'CLOUVIA_API_KEY_2'] });
  return uniqValues(pairs, [env.CLOUVIA_API_KEY]);
}
async function getGeminiKeys(env) {
  var pairs = await d1Pairs(env, { like: 'GEMINI_API_KEY%' });
  return uniqValues(pairs, [env.GEMINI_API_KEY]);
}

// ===== pesan & memori =====
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && m.content !== undefined; })
    .map(function (m) { return { role: m.role, content: String(m.content || '') }; });
}

function memBlock(rows) {
  if (!rows || !rows.length) return '';
  var parts = rows.map(function (r, i) {
    return '[' + (i + 1) + '] User: ' + (r.user_msg || '(tanpa teks)') + '\n    AI: ' + (r.ai_reply || '');
  }).join('\n');
  return '\n\nINGATAN JANGKA PANJANG Clincoo (riwayat interaksi sebelumnya dengan user, lintas sesi \u2014 gunakan untuk personalisasi, konteks, dan preferensi user; jangan diulang mentah kecuali relevan):\n' + parts;
}

async function loadMemories(env, sessionId) {
  try {
    var r = await env.DB.prepare('SELECT user_msg, ai_reply FROM agent_memory WHERE session_id != ? ORDER BY id DESC LIMIT 12').bind(sessionId).all();
    return (r.results || []).slice().reverse();
  } catch (e) { return []; }
}

async function saveMemory(env, sessionId, userMsg, aiReply) {
  try {
    var u = String(userMsg || '').slice(0, 300);
    var a = String(aiReply || '').slice(0, 500);
    if (!u.trim() && !a.trim()) return;
    await env.DB.prepare('INSERT INTO agent_memory (session_id, user_msg, ai_reply, created_at) VALUES (?, ?, ?, ?)').bind(sessionId, u, a, Date.now()).run();
    await env.DB.prepare('DELETE FROM agent_memory WHERE id < (SELECT COALESCE(MAX(id),0) - 600 FROM agent_memory)').run();
  } catch (e) {}
}

function stripToolCalls(s) {
  s = s.replace(/\[\[\s*(TOOL_CALL|TOOLS_CALL|BUKA_HALAMAN|INFO_SISTEM|WRITE_FILE)[^\]]*\]?\]\]?/gi, '');
  return s.replace(/\[\[[A-Z_]+:[^\]]*\]\]/g, '');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ===== tabel belajar-latar (dibuat sekali, idempoten) =====
async function ensureTables(env) {
  if (tablesReady) return;
  try {
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS labs_dataset (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, user_msg TEXT, ai_reply TEXT, winner_model TEXT, models_tried TEXT, latency_ms INTEGER, judge_score REAL, judge_note TEXT, created_at INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS labs_model_stats (model TEXT PRIMARY KEY, wins INTEGER DEFAULT 0, fails INTEGER DEFAULT 0, total_latency_ms INTEGER DEFAULT 0, score_sum REAL DEFAULT 0, score_n INTEGER DEFAULT 0, updated_at INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS labs_insights (id INTEGER PRIMARY KEY CHECK (id = 1), insights TEXT, updated_at INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS labs_meta (k TEXT PRIMARY KEY, v TEXT)')
    ]);
    tablesReady = true;
  } catch (e) {
    console.log('[D1] ensureTables err: ' + String(e && e.message || e));
  }
}

// ===== statistik model -> urutan kandidat adaptif =====
async function loadStatsMap(env) {
  if (statsCache.map && Date.now() - statsCache.at < 6e4) return statsCache.map;
  var map = new Map();
  try {
    var r = await env.DB.prepare('SELECT model, wins, fails, total_latency_ms, score_sum, score_n FROM labs_model_stats').all();
    (r.results || []).forEach(function (row) {
      var n = Math.max(1, row.score_n || 0);
      map.set(row.model, {
        wins: row.wins || 0, fails: row.fails || 0,
        avgLat: (row.total_latency_ms || 0) / Math.max(1, (row.wins || 0) + (row.fails || 0)),
        avgScore: (row.score_sum || 0) / n
      });
    });
  } catch (e) {}
  statsCache = { at: Date.now(), map: map };
  return map;
}

function modelRank(m) {
  // mungkin tak ada statistik -> netral (0). Skor tinggi & win-rate baik duluan.
  var s = statsCache.map && statsCache.map.get(m);
  if (!s) return 0;
  return (s.avgScore || 0) + (s.wins - s.fails) * 0.4 - (s.avgLat || 0) / 10000;
}

async function orderedOrModels(env) {
  await loadStatsMap(env);
  return OR_MODELS.slice().sort(function (a, b) { return modelRank(b) - modelRank(a); });
}

// ===== insight belajar =====
async function loadInsights(env) {
  if (insightsCache.text && Date.now() - insightsCache.at < 3e4) return insightsCache.text;
  var txt = '';
  try {
    var r = await env.DB.prepare('SELECT insights FROM labs_insights WHERE id = 1').first();
    txt = (r && r.insights) || '';
  } catch (e) {}
  insightsCache = { at: Date.now(), text: txt };
  return txt;
}

// [6 Okt 2026, arahan owner: "tingkatin kualitas labs"] Standar jawaban yang
// disuntik ke system prompt untuk semua kandidat — kualitas dijaga di sisi
// server, jadi gak tergantung frontend atau model mana yang menang balapan.
var QUALITY_BLOCK = 'STANDAR JAWABAN (pegang selalu):\n'
  + '1. Akurasi dulu: kalau tidak yakin, bilang tidak yakin. Jangan pernah mengarang fakta, angka, nama API, atau referensi.\n'
  + '2. Ikuti bahasa user. Padat tapi lengkap; langsung ke inti, tanpa bertele-tele dan tanpa basa-basi pembuka/penutup.\n'
  + '3. Kode: berikan blok kode LENGKAP yang bisa langsung dijalankan, best practice, tanpa placeholder TODO — jelaskan singkat hanya bagian kritis.\n'
  + '4. Chat ringan: jawab 1-3 kalimat tanpa heading atau daftar. Pertanyaan teknis: struktur rapi dengan blok kode.\n'
  + '5. Kamu AI chat Labs Clincoo: tidak bisa membuka file, klik, mengisi formulir, atau menjalankan aksi apa pun — jangan pernah berpura-pura melakukannya.\n'
  + '6. Beri rekomendasi tegas seperti penasihat terbaik, bukan sekadar daftar opsi; kalau user keliru, koreksi dengan sopan.\n'
  + '7. Perintah instalasi (npm/pnpm/yarn/bun/pip/cargo/gem/go/composer): gunakan HANYA nama paket yang benar-benar ada di registry resmi beserta flag yang valid — sistem memverifikasi nama paket ke registry secara otomatis dan salah ejaan akan dikoreksi.\n';

// ===== [6 Okt 2026, arahan owner: "install yang lebih luas, ga boleh ada salah command"] =====
// VERIFIKASI PERINTAH INSTALASI: ekstrak nama paket dari perintah npm/pnpm/yarn/bun/
// pip/pipx/uv/cargo/gem/go/composer di jawaban AI, cek NYATA ke registry resmi
// (npmjs, PyPI, crates.io, rubygems, proxy.golang.org, packagist) secara paralel.
// Paket yang tidak ada -> minta koreksi ke model kualitas -> verifikasi ulang.
// Hasil tetap jelek -> peringatan deterministik. Nol overhead bila jawaban
// tidak berisi perintah instalasi.
function extractInstallPkgs(text) {
  var out = [], seen = {};
  function add(eco, name) {
    name = String(name || '').trim();
    if (!name || name.length > 100) return;
    var k = eco + ':' + name;
    if (seen[k]) return;
    seen[k] = 1;
    out.push({ eco: eco, name: name });
  }
  var lines = String(text || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var toks, t, tk, nm, ix;
    var mN = ln.match(/(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|uninstall)\s+([^#`]+)/);
    if (mN) {
      toks = mN[1].trim().split(/\s+/);
      for (t = 0; t < toks.length; t++) {
        tk = toks[t]; if (!tk) continue;
        if (tk[0] === '-' || tk.indexOf('://') !== -1) continue;
        nm = tk;
        if (nm[0] === '@') { ix = nm.indexOf('@', 1); if (ix > 0) nm = nm.slice(0, ix); }
        else { ix = nm.indexOf('@'); if (ix > 0) nm = nm.slice(0, ix); }
        if (nm[0] !== '@' && nm.indexOf('/') !== -1) continue;
        if (!/^[A-Za-z@_][A-Za-z0-9._@\/-]*$/.test(nm)) continue;
        add('npm', nm);
      }
    }
    var mP = ln.match(/(?:pip3?|pipx|uv)\s+(?:pip\s+)?install\s+([^#`]+)/);
    if (mP) {
      toks = mP[1].trim().split(/\s+/);
      for (t = 0; t < toks.length; t++) {
        tk = toks[t]; if (!tk) continue;
        if (tk[0] === '-' || tk === 'from' || tk.indexOf('://') !== -1 || tk.indexOf('git+') !== -1) continue;
        nm = tk.split('[')[0].split(/(==|>=|<=|~=|!=|>|<)/)[0];
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nm)) continue;
        add('pip', nm);
      }
    }
    var mC = ln.match(/cargo\s+(?:add|install)\s+([A-Za-z0-9][\w-]*)/);
    if (mC) add('cargo', mC[1]);
    var mG = ln.match(/(?:^|\s)gem\s+install\s+([A-Za-z0-9][\w-]*)/);
    if (mG) add('gem', mG[1]);
    var mGo = ln.match(/go\s+get\s+([^#`]+)/);
    if (mGo) {
      toks = mGo[1].trim().split(/\s+/);
      for (t = 0; t < toks.length; t++) {
        tk = toks[t]; if (!tk || tk[0] === '-') continue;
        if (tk.indexOf('.') === -1 && tk.indexOf('/') === -1) continue;
        add('go', tk.replace(/\/+$/, ''));
      }
    }
    var mCo = ln.match(/composer\s+require\s+([A-Za-z0-9][\w\/-]*)/);
    if (mCo) add('composer', mCo[1]);
  }
  return out.slice(0, 15);
}

async function verifyInstallPkgs(pkgs) {
  if (!pkgs || !pkgs.length) return [];
  var REG = {
    npm: function (nm) { return ['https://registry.npmjs.org/' + nm, null]; },
    pip: function (nm) { return ['https://pypi.org/pypi/' + nm + '/json', null]; },
    cargo: function (nm) { return ['https://crates.io/api/v1/crates/' + nm, 'Clincoo-Labs/1.0']; },
    gem: function (nm) { return ['https://rubygems.org/api/v1/gems/' + nm + '.json', null]; },
    go: function (nm) { return ['https://proxy.golang.org/' + nm + '/@latest', null]; },
    composer: function (nm) { return ['https://packagist.org/packages/' + nm + '.json', null]; }
  };
  var checks = pkgs.map(function (p) {
    var mk = REG[p.eco];
    if (!mk) return Promise.resolve(null);
    var pr = mk(p.name);
    var ac = new AbortController();
    var to = setTimeout(function () { try { ac.abort(); } catch (e) {} }, 4500);
    var hd = pr[1] ? { 'User-Agent': pr[1] } : {};
    return fetch(pr[0], { signal: ac.signal, headers: hd })
      .then(function (r) { clearTimeout(to); return { p: p, ok: r.status >= 200 && r.status < 300, known: r.status !== 404 && r.status !== 410 }; })
      .catch(function () { clearTimeout(to); return null; });
  });
  var rs = await Promise.all(checks);
  var bad = [];
  rs.forEach(function (r) { if (r && r.known && !r.ok) bad.push(r.p.eco + ':' + r.p.name); });
  return bad;
}

async function verifyAndFixInstall(env, messages, finalText, pushBlock) {
  try {
    var pkgs = extractInstallPkgs(finalText);
    if (!pkgs.length) return finalText;
    var bad = await verifyInstallPkgs(pkgs);
    if (!bad.length) return finalText;
    var head = '\n\n⚠️ *Koreksi otomatis* — verifikasi registry menemukan nama paket yang tidak ada: ' + bad.join(', ') + '.\n';
    var fixMsgs = messages.concat([
      { role: 'assistant', content: finalText },
      { role: 'user', content: 'KOREKSI SISTEM (verifikasi registry otomatis): nama paket berikut TIDAK ditemukan di registry resmi: ' + bad.join(', ') + '. Tulis ULANG hanya perintah instalasi yang benar dengan nama paket yang BENAR-BENAR ADA di registry, maksimal 8 baris dalam blok kode, tanpa penjelasan panjang. Jangan ulangi nama paket yang salah. Jika tidak yakin nama yang benar, sarankan cara mencarinya di registry resmi.' }
    ]);
    var fix = null;
    try { fix = await callGeminiModel(env, GEMINI_MODELS[0], fixMsgs, 25e3, null); } catch (e) {}
    if (!fix || !fix.text || !fix.text.trim()) {
      try { fix = await callCfRest(env, fixMsgs, 25e3, null, null); } catch (e2) {}
    }
    var body = '';
    if (fix && fix.text && fix.text.trim()) {
      var fixBad = await verifyInstallPkgs(extractInstallPkgs(fix.text));
      if (!fixBad.length) body = fix.text.trim();
    }
    if (!body) body = 'Jangan jalankan perintah di atas mentah-mentah: cek dulu nama paket resminya di registry (npmjs.com, pypi.org, crates.io, rubygems.org, pkg.go.dev).';
    if (pushBlock) { try { pushBlock(head + body); } catch (e3) {} }
    return finalText + head + body;
  } catch (e) { return finalText; }
}

function insightBlock(txt) {
  if (!txt || !txt.trim()) return '';
  return '\n\nINSIGHT TERPELAJARI (hasil belajar latar AI ini tentang user, topik langganan, dan gaya menjawab yang terbukti bagus \u2014 gunakan secara alami, JANGAN disebut atau diulang mentah-mentah):\n' + String(txt).trim();
}

// panggilan OpenRouter generik (non-stream) untuk juri & kondensasi insight
async function orSidecall(env, sysPrompt, userPrompt, maxTokens) {
  var keys = await getOpenRouterKeys(env);
  if (!keys.length) return null;
  // rotasi kunci: kunci pertama bisa saja mati (402 kredit habis) — coba semua.
  for (var k = 0; k < keys.length; k++) {
    var ac = new AbortController();
    var t = setTimeout(function () { ac.abort(); }, 25e3);
    try {
      var res = await fetch(OR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[k], 'HTTP-Referer': 'https://labs.clinqoo.biz.id', 'X-Title': 'Clincoo Labs' },
        body: JSON.stringify({
          model: JUDGE_MODEL, max_tokens: maxTokens || 300,
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPrompt }
          ]
        }),
        signal: ac.signal
      });
      clearTimeout(t);
      if (!res.ok) continue;
      var d = await res.json().catch(function () { return {}; });
      var txt = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '';
      if (txt.trim()) return txt;
    } catch (e) {
      clearTimeout(t);
    }
  }
  return null;
}

// juri latar: nilai jawaban 1-10
async function judgeAnswer(env, userMsg, answer) {
  var out = await orSidecall(env,
    'Kamu juri kualitas jawaban AI. Nilai jawaban berikut untuk pertanyaan user: 1-10 (10 = sangat tepat, akurat, memenuhi permintaan). Balas HANYA JSON valid: {"score": <angka>, "note": "<catatan singkat maks 120 karakter, bahasa Indonesia>"}',
    'PERTANYAAN USER:\n' + String(userMsg || '').slice(0, 600) + '\n\nJAWABAN AI:\n' + String(answer || '').slice(0, 2000), 600);
  if (!out) return null;
  // model kadang memotong JSON (reasoning memakan budget) — parsing toleran:
  // coba JSON utuh dulu, lalu ambil field score via regex.
  var j = null;
  try { var m = out.match(/\{[\s\S]*\}/); if (m) j = JSON.parse(m[0]); } catch (e) {}
  var sc = j ? Number(j.score) : NaN;
  if (!(sc >= 1 && sc <= 10)) {
    var m2 = out.match(/"score"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (m2) sc = Number(m2[1]);
  }
  if (!(sc >= 1 && sc <= 10)) return null;
  var note = '';
  try { var m3 = out.match(/"note"\s*:\s*"([^"]*)/); if (m3) note = m3[1]; } catch (e) {}
  if (!note && j) note = String(j.note || '');
  return { score: sc, note: String(note).slice(0, 120) };
}

// rekam hasil + statistik + (tiap N pesan) kondensasi insight — semua di latar.
// Dua cabang diparalelkan (juri & insight) agar total wall-time muat dalam
// budget waitUntil; versi sekuensial lama kehabisan waktu sebelum insight jalan.
async function learnInBackground(env, sessionId, userMsg, answer, winnerModel, modelsTried, latencyMs) {
  try {
    await ensureTables(env);

    // cabang A: juri -> dataset -> statistik
    var pA = (async function () {
      try {
        var verdict = await judgeAnswer(env, userMsg, answer);
        await env.DB.prepare('INSERT INTO labs_dataset (session_id, user_msg, ai_reply, winner_model, models_tried, latency_ms, judge_score, judge_note, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(sessionId, String(userMsg || '').slice(0, 400), String(answer || '').slice(0, 1500), winnerModel, modelsTried.join(','), latencyMs || 0, verdict ? verdict.score : null, verdict ? verdict.note : null, Date.now()).run();
        await env.DB.prepare('DELETE FROM labs_dataset WHERE id < (SELECT COALESCE(MAX(id),0) - ? FROM labs_dataset)').bind(DATASET_MAX_ROWS).run();
        await env.DB.prepare('INSERT INTO labs_model_stats (model, wins, fails, total_latency_ms, score_sum, score_n, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(model) DO UPDATE SET wins = wins + 1, total_latency_ms = total_latency_ms + excluded.total_latency_ms, score_sum = score_sum + COALESCE(excluded.score_sum,0), score_n = score_n + COALESCE(excluded.score_n,0), updated_at = excluded.updated_at')
          .bind(winnerModel, 1, 0, latencyMs || 0, verdict ? verdict.score : 0, verdict ? 1 : 0, Date.now()).run();
        for (var i = 0; i < modelsTried.length; i++) {
          if (modelsTried[i] === winnerModel) continue;
          await env.DB.prepare('INSERT INTO labs_model_stats (model, wins, fails, total_latency_ms, score_sum, score_n, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(model) DO UPDATE SET fails = fails + 1, updated_at = excluded.updated_at')
            .bind(modelsTried[i], 0, 1, 0, 0, 0, Date.now()).run();
        }
        statsCache = { at: 0, map: null }; // paksa baca ulang urutan adaptif
      } catch (e) {
        console.log('[BELAJAR-A] err: ' + String(e && e.message || e));
      }
    })();

    // cabang B: counter pesan -> (tiap N) kondensasi insight
    var pB = (async function () {
      try {
        var mkey = 'insight_msgs_' + sessionId;
        var prev = await env.DB.prepare('SELECT v FROM labs_meta WHERE k = ?').bind(mkey).first();
        var n = (Number(prev && prev.v) || 0) + 1;
        if (n < INSIGHT_EVERY_N) {
          await env.DB.prepare('INSERT INTO labs_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(mkey, String(n)).run();
          return;
        }
        await env.DB.prepare('INSERT INTO labs_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(mkey, '0').run();
        var rows = await env.DB.prepare('SELECT user_msg, ai_reply FROM agent_memory ORDER BY id DESC LIMIT 12').all();
        var hist = (rows.results || []).map(function (r, i) { return '[' + (i + 1) + '] U: ' + (r.user_msg || '') + ' | A: ' + (r.ai_reply || ''); }).join('\n').slice(0, 3500);
        var oldIns = await loadInsights(env);
        var fresh = await orSidecall(env,
          'Kamu mesin belajar latar untuk asisten AI Clincoo. Dari riwayat tanya-jawab berikut, perbarui "insight": fakta penting tentang user, preferensi, gaya menjawab yang disukai, topik berulang, dan pelajaran kualitas (apa yang membuat jawaban bagus/buruk). Balas HANYA isi insight final dalam Bahasa Indonesia, maksimal ' + INSIGHT_MAX_CHARS + ' karakter, padat, tanpa pembuka/penutup.',
          'INSIGHT LAMA:\n' + (oldIns || '(belum ada)') + '\n\nRIWAYAT TERBARU:\n' + hist, 900);
        if (fresh) {
          await env.DB.prepare('INSERT INTO labs_insights (id, insights, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET insights = excluded.insights, updated_at = excluded.updated_at').bind(String(fresh).slice(0, INSIGHT_MAX_CHARS * 2), Date.now()).run();
          insightsCache = { at: 0, text: '' };
        } else {
          console.log('[BELAJAR-B] kondensasi kosong — coba lagi di pesan berikut');
        }
      } catch (e) {
        console.log('[BELAJAR-B] err: ' + String(e && e.message || e));
      }
    })();

    await Promise.all([pA, pB]);
  } catch (e) {
    console.log('[BELAJAR] err: ' + String(e && e.message || e));
  }
}

// ===== L2: OpenRouter per-model — streaming + retry 429 antar kunci =====
async function callOpenRouterModel(env, model, messages, timeoutMs, onDelta, acExt) {
  var keys = await getOpenRouterKeys(env);
  if (!keys.length) return null;
  var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
  var chatMsgs = messages.filter(function (m) { return m.role !== 'system'; });
  var payloadMsgs = sys ? [{ role: 'system', content: sys }, ...chatMsgs] : chatMsgs;
  var t0 = Date.now();

  for (var i = 0; i < keys.length; i++) {
    var ac = acExt || new AbortController();
    var t = acExt ? null : setTimeout(function () { ac.abort(); }, timeoutMs || 6e4);
    try {
      var body = { model: model, messages: payloadMsgs, max_tokens: 16384 };
      if (onDelta) body.stream = true;
      var res = await fetch(OR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[i], 'HTTP-Referer': 'https://labs.clinqoo.biz.id', 'X-Title': 'Clincoo Labs' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      if (t) clearTimeout(t);

      if (res.status === 429) {
        console.log('[L2:' + model + '] kunci#' + (i + 1) + ' rate limit');
        if (i + 1 < keys.length) await new Promise(function (r) { setTimeout(r, 700); });
        continue;
      }
      if (!res.ok) {
        console.log('[L2:' + model + '] kunci#' + (i + 1) + ' HTTP ' + res.status);
        continue;
      }

      if (onDelta && res.body) {
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '', acc = '', firstMs = 0, finReason = '';
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop() || '';
          for (var li = 0; li < lines.length; li++) {
            var ln = lines[li].trim();
            if (ln.indexOf('data:') !== 0) continue;
            var data = ln.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              var j = JSON.parse(data);
              var d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
              var piece = d && typeof d.content === 'string' ? d.content : '';
              if (piece) {
                if (!firstMs) firstMs = Date.now() - t0;
                acc += piece; onDelta(piece);
              }
              var frS = j.choices && j.choices[0] && j.choices[0].finish_reason;
              if (frS) finReason = frS;
            } catch (e) {}
          }
        }
        if (acc.trim()) {
          console.log('[L2:' + model + '] stream OK ' + acc.length + ' char, first ' + firstMs + 'ms, total ' + (Date.now() - t0) + 'ms');
          return { text: acc, model: model, first_ms: firstMs, total_ms: Date.now() - t0, finish: finReason };
        }
        console.log('[L2:' + model + '] stream kosong — lanjut');
        continue;
      }

      var data2 = await res.json().catch(function () { return {}; });
      var text = data2 && data2.choices && data2.choices[0] && data2.choices[0].message && data2.choices[0].message.content || '';
      if (typeof text === 'string' && text.trim()) {
        var fin2 = data2.choices[0].finish_reason || '';
        console.log('[L2:' + model + '] OK ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
        return { text: text, model: model, first_ms: Date.now() - t0, total_ms: Date.now() - t0, finish: fin2 };
      }
    } catch (e) {
      if (t) clearTimeout(t);
      console.log('[L2:' + model + '] err: ' + String(e && e.message || e));
    }
  }
  return null;
}

// ===== L2b: Workers AI via REST — akun C (pool kuota gratis kedua, token cfut_) =====
// [6 Okt 2026, arahan owner: "manfaatin ai gratisnya"] Terpisah dari kuota Workers AI
// akun utama. Respon format OpenAI penuh (streaming SSE + finish_reason).
var CF_REST_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/zai-org/glm-4.7-flash']; // 70B utama (TTFB ~1.1s); glm-4.7-flash di akun baru lambat/sering kosong

async function getCfAiCreds(env) {
  var token = String(env.CF_AI_TOKEN || '').trim();
  var accountId = String(env.CF_AI_ACCOUNT_ID || '').trim();
  if (env.DB) {
    try {
      var rows = await env.DB.prepare('SELECT key, value FROM env_vars WHERE key IN (?,?)').bind('CF_AI_TOKEN', 'CF_AI_ACCOUNT_ID').all();
      (rows.results || []).forEach(function (r) {
        var v = String(r.value || '').trim();
        if (!v) return;
        if (r.key === 'CF_AI_TOKEN' && !token) token = v;
        if (r.key === 'CF_AI_ACCOUNT_ID' && !accountId) accountId = v;
      });
    } catch (e) {}
  }
  return (token && accountId) ? { token: token, accountId: accountId } : null;
}

async function callCfRest(env, messages, timeoutMs, onDelta, acExternal) {
  var creds = await getCfAiCreds(env);
  if (!creds) return null;
  var t0 = Date.now();
  for (var mi = 0; mi < CF_REST_MODELS.length; mi++) {
    var model = CF_REST_MODELS[mi];
    var label = 'cfrest:' + model.split('/').pop();
    var ac = acExternal || new AbortController();
    var t = acExternal ? null : setTimeout(function () { ac.abort(); }, timeoutMs || 4e4);
    try {
      var body = { messages: messages, max_tokens: 8192 };
      if (onDelta) body.stream = true;
      var res = await fetch('https://api.cloudflare.com/client/v4/accounts/' + creds.accountId + '/ai/run/' + model, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + creds.token },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      if (t) clearTimeout(t);
      if (!res.ok) { console.log('[L2b] HTTP ' + res.status); continue; }
      if (onDelta && res.body) {
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '', acc = '', firstMs = 0, finReason = '';
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop() || '';
          for (var li = 0; li < lines.length; li++) {
            var ln = lines[li].trim();
            if (ln.indexOf('data:') !== 0) continue;
            var data = ln.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              var j = JSON.parse(data);
              var d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
              var piece = d && typeof d.content === 'string' ? d.content : '';
              if (piece) {
                if (!firstMs) firstMs = Date.now() - t0;
                acc += piece; onDelta(piece);
              }
              var frS = j.choices && j.choices[0] && j.choices[0].finish_reason;
              if (frS) finReason = frS;
            } catch (e) {}
          }
        }
        if (acc.trim()) {
          console.log('[L2b] stream OK ' + acc.length + ' char, first ' + firstMs + 'ms');
          return { text: acc, model: label, first_ms: firstMs, total_ms: Date.now() - t0, finish: finReason };
        }
        continue;
      }
      var j2 = await res.json().catch(function () { return {}; });
      var rr = (j2 && j2.result) || {};
      var text = (rr.choices && rr.choices[0] && rr.choices[0].message && rr.choices[0].message.content) || rr.response || (typeof rr === 'string' ? rr : '') || '';
      if (typeof text === 'string' && text.trim()) {
        console.log('[L2b] OK ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
        return { text: text, model: label, first_ms: Date.now() - t0, total_ms: Date.now() - t0, finish: (rr.choices && rr.choices[0] && rr.choices[0].finish_reason) || '' };
      }
    } catch (e) {
      if (t) clearTimeout(t);
      console.log('[L2b] err: ' + String(e && e.message || e));
    }
  }
  return null;
}

// ===== L1: Ollama (non-stream) =====
async function callOllama(env, messages, ollamaUrl, acExternal) {
  var t0 = Date.now();
  var oBase = ollamaUrl.replace(/\/+$/, '');
  try {
    var r = await fetch(oBase + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages: messages, stream: false, think: false, keep_alive: '24h', options: { num_ctx: 16384, num_predict: -1 } }),
      signal: acExternal ? acExternal.signal : undefined
    });
    if (r.ok) {
      var jj = await r.json().catch(function () { return null; });
      var c = jj && jj.message && typeof jj.message.content === 'string' ? jj.message.content : '';
      if (c && c.trim()) {
        console.log('[L1] OK ' + c.length + ' char, ' + (Date.now() - t0) + 'ms');
        return { text: c, model: OLLAMA_MODEL, first_ms: Date.now() - t0, total_ms: Date.now() - t0 };
      }
    }
  } catch (e) {
    console.log('[L1] err: ' + String(e && e.message || e));
  }
  return null;
}

// ===== L5: Gemini (non-stream) =====
async function callGeminiModel(env, model, messages, timeoutMs, acExternal) {
  var keys = await getGeminiKeys(env);
  if (!keys.length) return null;
  var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
  var contents = messages.filter(function (m) { return m.role !== 'system'; }).map(function (m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });
  var t0 = Date.now();
  for (var k = 0; k < keys.length; k++) {
    var ac = acExternal || new AbortController();
    var own = !acExternal;
    var t = own ? setTimeout(function () { ac.abort(); }, timeoutMs || 45e3) : null;
    try {
      var gbody = { contents: contents };
      if (sys) gbody.systemInstruction = { parts: [{ text: sys }] };
      var res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[k] },
        body: JSON.stringify(gbody),
        signal: ac.signal
      });
      if (own) clearTimeout(t);
      if (!res.ok) { console.log('[L5:' + model + '] HTTP ' + res.status); continue; }
      var d = await res.json().catch(function () { return {}; });
      var parts = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || [];
      var text = parts.map(function (p) { return p.text || ''; }).join('');
      var fin5 = (d && d.candidates && d.candidates[0] && d.candidates[0].finishReason) || '';
      if (text.trim()) {
        console.log('[L5:' + model + '] OK ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
        return { text: text, model: model, first_ms: Date.now() - t0, total_ms: Date.now() - t0, finish: fin5 };
      }
    } catch (e) {
      if (own) clearTimeout(t);
      console.log('[L5:' + model + '] err: ' + String(e && e.message || e));
    }
  }
  return null;
}

// ===== L3: Clouvia =====
async function callClouvia(env, messages, timeoutMs) {
  var keys = await getClouviaKeys(env);
  if (!keys.length) { console.log('[L3] skip: tidak ada kunci'); return null; }
  var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
  var chatMsgs = messages.filter(function (m) { return m.role !== 'system'; }).map(function (m) { return { role: m.role, content: m.content }; });
  if (sys) {
    var iu = -1;
    for (var x = 0; x < chatMsgs.length; x++) if (chatMsgs[x].role === 'user') { iu = x; break; }
    if (iu !== -1) chatMsgs[iu] = { role: 'user', content: sys + '\n\n' + chatMsgs[iu].content };
    else chatMsgs.unshift({ role: 'user', content: sys });
  }
  var t0 = Date.now();
  for (var k = 0; k < keys.length; k++) {
    for (var mi = 0; mi < CLOUVIA_MODELS.length; mi++) {
      var model = CLOUVIA_MODELS[mi];
      var ac = new AbortController();
      var t = setTimeout(function () { ac.abort(); }, timeoutMs || 45e3);
      try {
        var res = await fetch('https://router.clouvia.id/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[k] },
          body: JSON.stringify({ model: model, messages: chatMsgs, max_tokens: 16384 }),
          signal: ac.signal
        });
        clearTimeout(t);
        if (!res.ok) { console.log('[L3] ' + model + ' HTTP ' + res.status); continue; }
        var data = await res.json().catch(function () { return {}; });
        var text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
        var fin3 = (data && data.choices && data.choices[0] && data.choices[0].finish_reason) || '';
        if (typeof text === 'string' && text.trim()) {
          console.log('[L3] OK ' + model + ' ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
          return { text: text, model: model, first_ms: Date.now() - t0, total_ms: Date.now() - t0, finish: fin3 };
        }
      } catch (e) {
        clearTimeout(t);
        console.log('[L3] ' + model + ' err: ' + String(e && e.message || e));
      }
    }
  }
  return null;
}

// ===== L4: Workers AI =====
async function callFallback(env, messages, timeoutMs) {
  if (!env.AI) return null;
  var t0 = Date.now();
  for (var i = 0; i < WORKERS_AI_MODELS.length; i++) {
    var model = WORKERS_AI_MODELS[i];
    var ac = new AbortController();
    var t = setTimeout(function () { ac.abort(); }, timeoutMs || 6e4);
    try {
      var out = await env.AI.run(model, { messages: messages, max_tokens: 8192 }, { signal: ac.signal });
      clearTimeout(t);
      var text = out && (out.response || out.text) || '';
      var fin4 = (out && out.finish_reason) || '';
      if (typeof text === 'string' && text.trim()) {
        console.log('[L4] OK ' + model + ' ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
        return { text: text, model: model.split('/').pop(), first_ms: Date.now() - t0, total_ms: Date.now() - t0, finish: fin4 };
      }
    } catch (e) {
      clearTimeout(t);
      console.log('[L4] ' + model + ' err: ' + String(e && e.message || e));
    }
  }
  return null;
}

// ===== AUTO-CONTINUE (finish_reason "length"): output mencapai batas token ->
// response terpotong -> SISTEM (bukan user) otomatis mengirim "lanjutkan" +
// state terakhir (teks parsial menempel sebagai pesan assistant di percakapan,
// tanpa sesi baru) -> model langsung menyambung dari titik henti seolah tak
// pernah terputus. Maksimal 4 sambungan per jawaban; delta sambungan ikut
// ter-stream bila push tersedia.
var FIN_IS_LENGTH = function (f) { return f === 'length' || f === 'LENGTH' || f === 'MAX_TOKENS'; };
async function continueIfNeeded(env, messages, res, opts) {
  if (!res || !res.text || !FIN_IS_LENGTH(res.finish)) return res;
  opts = opts || {};
  var push = opts.push || null;
  var kind = opts.kind || 'or';
  var contMsgs = messages.slice();
  var seg = res.text;
  var full = res.text;
  for (var ac = 0; ac < 4 && FIN_IS_LENGTH(res.finish); ac++) {
    contMsgs.push({ role: 'assistant', content: seg });
    contMsgs.push({ role: 'user', content: 'lanjutkan persis dari titik terakhirmu — jangan ulang dari awal, jangan bertanya, langsung sambung teksnya' });
    var rc = null;
    try {
      if (kind === 'or') rc = await callOpenRouterModel(env, res.model, contMsgs, 6e4, (push && opts.wantsStream) ? function (piece) { push({ t: 'delta', text: piece }); } : null, null);
      else if (kind === 'gemini') rc = await callGeminiModel(env, res.model, contMsgs, 45e3, null);
      else if (kind === 'ollama') rc = await callOllama(env, contMsgs, opts.ollamaUrl, null);
      else if (kind === 'clouvia') rc = await callClouvia(env, contMsgs, 45e3);
      else if (kind === 'cfrest') rc = await callCfRest(env, contMsgs, 45e3, (push && opts.wantsStream) ? function (piece) { push({ t: 'delta', text: piece }); } : null, null);
      else rc = await callFallback(env, contMsgs, 6e4);
    } catch (e) { break; }
    if (!rc || !rc.text) break;
    seg = rc.text; full += rc.text;
    res.finish = rc.finish || '';
    if (push && !((kind === 'or' || kind === 'cfrest') && opts.wantsStream)) push({ t: 'delta', text: rc.text });
    console.log('[CONT] sambungan #' + (ac + 1) + ' via ' + kind + ': +' + rc.text.length + ' char');
  }
  res.text = full;
  res.continued = true;
  return res;
}

// ===== BALAPAN: kandidat jalan bersamaan, tercepat & terpintar menang =====
// opts: {wantsStream, push, ollamaUrl, glmReady}
async function raceChat(env, messages, opts) {
  var t0 = Date.now();
  var push = opts.push || null;
  var winnerName = null;      // kandidat yang menguasai layar
  var winnerChars = 0;
  var winnerResult = null;   // hasil final kandidat pemenang
  var anyResult = null;      // hasil non-stream pertama yang selesai (cadangan)
  var abortMap = new Map(); // abort fn per kandidat

  function declareWinner(name) {
    if (winnerName === null) winnerName = name;
  }
  function abortLosers() {
    if (winnerName !== null && winnerChars >= WINNER_ABORT_CHARS) {
      abortMap.forEach(function (fn, nm) {
        if (nm !== winnerName) { try { fn(); } catch (e) {} }
      });
    }
  }

  var orModels = await orderedOrModels(env);
  var promises = [];
  var names = [];

  function addCand(name, start) {
    var idx = names.length;
    names.push(name);
    promises.push((async function () {
      var r = await start();
      if (!r) return null;
      r.name = name;
      if (winnerName === null) {
        // non-stream selesai duluan tanpa ada delta (mode non-stream, atau
        // kandidat non-stream menang sebelum stream mana pun mengeluarkan token)
        winnerName = name;
        if (push) push({ t: 'delta', text: r.text });
        winnerChars += r.text.length;
      }
      if (name === winnerName) winnerResult = r;
      if (!anyResult) anyResult = r;
      abortLosers();
      return r;
    })().catch(function () { return null; }));
  }

  // kandidat OpenRouter (streaming bila diminta) — urutan adaptif dari statistik
  for (var oi = 0; oi < orModels.length; oi++) {
    (function (m) {
      var ac = new AbortController();
      abortMap.set('or:' + m, function () { try { ac.abort(); } catch (e) {} });
      addCand('or:' + m, function () {
        return callOpenRouterModel(env, m, messages, 6e4, opts.wantsStream ? function (piece) {
          declareWinner('or:' + m);
          if (winnerName === 'or:' + m) {
            winnerChars += piece.length;
            if (push) push({ t: 'delta', text: piece });
            abortLosers();
          }
        } : null, ac);
      });
    })(orModels[oi]);
  }

  // kandidat Gemini (non-stream)
  (function () {
    var acG = new AbortController();
    abortMap.set('gemini:' + GEMINI_MODELS[0], function () { try { acG.abort(); } catch (e) {} });
    addCand('gemini:' + GEMINI_MODELS[0], function () {
      return callGeminiModel(env, GEMINI_MODELS[0], messages, 45e3, acG);
    });
  })();

  // kandidat Workers AI REST akun C (pool kuota gratis kedua; streaming bila diminta)
  (function () {
    var acR = new AbortController();
    var cfName = 'cfrest:llama-3.3-70b';
    abortMap.set(cfName, function () { try { acR.abort(); } catch (e) {} });
    addCand(cfName, function () {
      return callCfRest(env, messages, 4e4, opts.wantsStream ? function (piece) {
        declareWinner(cfName);
        if (winnerName === cfName) {
          winnerChars += piece.length;
          if (push) push({ t: 'delta', text: piece });
          abortLosers();
        }
      } : null, acR);
    });
  })();

  // kandidat Ollama bila ready (ikut balapan, gratis)
  if (opts.ollamaUrl && opts.glmReady) {
    (function () {
      var acO = new AbortController();
      abortMap.set('ollama:' + OLLAMA_MODEL, function () { try { acO.abort(); } catch (e) {} });
      addCand('ollama:' + OLLAMA_MODEL, function () {
        return callOllama(env, messages, opts.ollamaUrl, acO);
      });
    })();
  }

  await Promise.all(promises);

  var res = winnerResult || anyResult || null;
  if (!res) return null;
  // AUTO-CONTINUE: jawaban pemenang terpotong batas token -> sambung otomatis
  var wkind = res.name && res.name.indexOf('gemini:') === 0 ? 'gemini' : (res.name && res.name.indexOf('ollama:') === 0 ? 'ollama' : (res.name && res.name.indexOf('cfrest:') === 0 ? 'cfrest' : 'or'));
  res = await continueIfNeeded(env, messages, res, { kind: wkind, push: push, wantsStream: opts.wantsStream, ollamaUrl: opts.ollamaUrl });
  var modelsTried = names.slice();
  var lat = res.first_ms || (Date.now() - t0);
  console.log('[RACE] menang ' + res.name + ' | first=' + lat + 'ms | total=' + (Date.now() - t0) + 'ms | kandidat=' + modelsTried.join(' + '));
  return { text: res.text, model: res.name, latency_ms: lat, models_tried: modelsTried };
}

// ===== handler utama =====
async function handleChat(req, env, ctx) {
  var body;
  try { body = await req.json(); } catch (e) { body = {}; }

  if (body.action === 'delete_session') {
    var sid = body.session_id;
    if (sid) {
      try { ctx.waitUntil(env.DB.prepare('DELETE FROM agent_memory WHERE session_id = ?').bind(sid).run()); } catch (e) {}
    }
    return json({ success: true });
  }

  await ensureTables(env);

  var messages = sanitizeMessages(body.messages);
  if (messages.length > 13) {
    var sysKeep = messages[0].role === 'system' ? [messages[0]] : [];
    var rest = messages[0].role === 'system' ? messages.slice(1) : messages;
    messages.length = 0;
    messages.push.apply(messages, sysKeep.concat(rest.slice(-12)));
  }
  if (messages.length && messages[0].role === 'system') {
    messages[0] = {
      ...messages[0],
      content: messages[0].content + "\n\nATURAN TERTINGGI: Untuk pertanyaan atau obrolan biasa, jawab HANYA dengan teks biasa yang singkat dan langsung. JANGAN PERNAH menyertakan format [[...]], [[TOOL_CALL]], [[BUKA_HALAMAN]], [[INFO_SISTEM]], atau perintah alat/JSON apa pun, KECUALI user secara eksplisit meminta aksi tersebut."
    };
  }
  if (messages.length === 0) return json({ error: 'messages kosong' }, 400);

  var session_id = body.session_id || 'ls_' + Date.now();
  var memRows = await loadMemories(env, session_id);
  var mBlock = memBlock(memRows);
  var insBlock = insightBlock(await loadInsights(env));
  var extraBlocks = QUALITY_BLOCK + (mBlock || '') + (insBlock || '');
  if (extraBlocks) {
    if (messages.length && messages[0].role === 'system') {
      messages[0] = { ...messages[0], content: messages[0].content + extraBlocks };
    } else {
      messages.unshift({ role: 'system', content: extraBlocks.trim() });
    }
  }

  var lastUser = null;
  for (var i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUser = messages[i]; break; }
  var wantsStream = body.stream === true;
  var forceFallback = req.headers.get('X-Labs-Force') === 'fallback';
  var raceOff = req.headers.get('X-Labs-Race') === 'off';
  var ollamaUrl = forceFallback ? '' : await getOllamaUrl(env);

  // cek Ollama ready (cache 60 detik) — dipakai balapan sebagai kandidat
  var glmReady = false;
  if (ollamaUrl) {
    try {
      var cached = psCache.get(ollamaUrl);
      if (cached === undefined) {
        var acP = new AbortController();
        var tP = setTimeout(function () { acP.abort(); }, 3.5e3);
        var ps = await fetch(ollamaUrl.replace(/\/+$/, '') + '/api/ps', { signal: acP.signal });
        clearTimeout(tP);
        var j = await ps.json().catch(function () { return null; });
        glmReady = !!(j && Array.isArray(j.models) && j.models.some(function (m) { return (m.model || m.name || '').startsWith(OLLAMA_MODEL.split(':')[0]); }));
        psCache.set(ollamaUrl, glmReady);
        setTimeout(function () { psCache.delete(ollamaUrl); }, 6e4);
      } else {
        glmReady = cached;
      }
    } catch (e) {
      glmReady = false;
      try { psCache.set(ollamaUrl, false); setTimeout(function () { psCache.delete(ollamaUrl); }, 6e4); } catch (e2) {}
    }
  }

  function learnLater(res) {
    var finalText = stripToolCalls(res.text);
    try {
      ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, finalText));
      ctx.waitUntil(learnInBackground(env, session_id, lastUser && lastUser.content, finalText, res.model, res.models_tried || [res.model], res.latency_ms || 0));
    } catch (e) {}
    return finalText;
  }

  // [6 Okt 2026] FORCE cfrest: uji langsung kandidat REST akun C (non-stream)
  if (req.headers.get('X-Labs-Force') === 'cfrest') {
    var fr = await callCfRest(env, messages, 45e3, null, null);
    if (fr) fr = await continueIfNeeded(env, messages, fr, { kind: 'cfrest' });
    if (fr) fr.text = await verifyAndFixInstall(env, messages, fr.text, null);
    if (fr) return json({ text: learnLater(fr), model: fr.model, latency_ms: fr.first_ms || 0, models_tried: [fr.model] });
    return json({ error: 'cfrest gagal' });
  }

  // ---- MODE BALAPAN (default) ----
  if (!raceOff) {
    if (!wantsStream) {
      var rr = await raceChat(env, messages, { wantsStream: false, ollamaUrl: ollamaUrl, glmReady: glmReady });
      if (!rr) { rr = await callClouvia(env, messages, 45e3); if (rr) rr = await continueIfNeeded(env, messages, rr, { kind: 'clouvia' }); }
      if (!rr) { rr = await callFallback(env, messages, 6e4); if (rr) rr = await continueIfNeeded(env, messages, rr, { kind: 'wai' }); }
      if (!rr) { rr = await callGeminiModel(env, GEMINI_MODELS[1] || GEMINI_MODELS[0], messages, 45e3, null); if (rr) rr = await continueIfNeeded(env, messages, rr, { kind: 'gemini' }); }
      if (rr) {
        rr.text = await verifyAndFixInstall(env, messages, rr.text, null);
        var ft = learnLater(rr);
        return json({ text: ft, model: rr.model, session_id: session_id });
      }
      return json({ error: 'Semua lapisan AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.' }, 502);
    }
    // stream
    var ts = new TransformStream();
    var writer = ts.writable.getWriter();
    var enc = new TextEncoder();
    var push = function (o) { writer.write(enc.encode(JSON.stringify(o) + '\n')).catch(function () {}); };
    var hb = setInterval(function () { push({ t: 'delta', text: '' }); }, 4e3);
    (async function () {
      var rs = await raceChat(env, messages, { wantsStream: true, push: push, ollamaUrl: ollamaUrl, glmReady: glmReady });
      if (!rs) {
        var r3 = await callClouvia(env, messages, 45e3);
        if (r3) { r3 = await continueIfNeeded(env, messages, r3, { kind: 'clouvia' }); push({ t: 'delta', text: r3.text }); rs = { text: r3.text, model: r3.model, latency_ms: r3.first_ms || 0, models_tried: [r3.model] }; }
      }
      if (!rs) {
        var r4 = await callFallback(env, messages, 6e4);
        if (r4) { r4 = await continueIfNeeded(env, messages, r4, { kind: 'wai' }); push({ t: 'delta', text: r4.text }); rs = { text: r4.text, model: r4.model, latency_ms: r4.first_ms || 0, models_tried: [r4.model] }; }
      }
      if (!rs) {
        var r5 = await callGeminiModel(env, GEMINI_MODELS[1] || GEMINI_MODELS[0], messages, 45e3, null);
        if (r5) { r5 = await continueIfNeeded(env, messages, r5, { kind: 'gemini' }); push({ t: 'delta', text: r5.text }); rs = { text: r5.text, model: r5.model, latency_ms: r5.first_ms || 0, models_tried: [r5.model] }; }
      }
      clearInterval(hb);
      if (rs) {
        var fin = stripToolCalls(rs.text);
        fin = await verifyAndFixInstall(env, messages, fin, function (b) { push({ t: 'delta', text: b }); });
        push({ t: 'final', text: fin, model: rs.model, session_id: session_id });
        try {
          ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, fin));
          ctx.waitUntil(learnInBackground(env, session_id, lastUser && lastUser.content, fin, rs.model, rs.models_tried || [rs.model], rs.latency_ms || 0));
        } catch (e) {}
      } else {
        push({ t: 'error', error: 'Semua lapisan AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.' });
      }
      try { await writer.close(); } catch (e) {}
    })();
    return new Response(ts.readable, { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', ...CORS } });
  }

  // ---- MODE LAMA (X-Labs-Race: off) — sekuensial, perilaku v1 ----
  var oText = '';
  if (ollamaUrl && glmReady) {
    var oc = new AbortController();
    var guard2 = setTimeout(function () { try { oc.abort(); } catch (e) {} }, OLLAMA_TIMEOUT_MS);
    var firstBail = setTimeout(function () { try { oc.abort(); } catch (e) {} }, OLLAMA_FIRST_MS);
    try {
      var r = await fetch(ollamaUrl.replace(/\/+$/, '') + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages: messages, stream: false, think: false, keep_alive: '24h', options: { num_ctx: 16384, num_predict: -1 } }),
        signal: oc.signal
      });
      if (r.ok) {
        var jj = await r.json().catch(function () { return null; });
        var c = jj && jj.message && typeof jj.message.content === 'string' ? jj.message.content : '';
        if (c && c.trim()) oText = c;
      }
    } catch (e) {}
    clearTimeout(guard2);
    clearTimeout(firstBail);
  }

  var seq = [];
  if (oText.trim()) seq.push({ text: oText, model: OLLAMA_MODEL });
  var r2 = await callOpenRouterModel(env, (await orderedOrModels(env))[0], messages, 6e4, null);
  if (r2) seq.push(r2);

  if (!wantsStream) {
    if (!seq.length) { var s3 = await callClouvia(env, messages, 45e3); if (s3) seq.push(s3); }
    if (!seq.length) { var s4 = await callFallback(env, messages, 6e4); if (s4) seq.push(s4); }
    if (!seq.length) { var s5 = await callGeminiModel(env, GEMINI_MODELS[0], messages, 45e3, null); if (s5) seq.push(s5); }
    if (!seq.length) return json({ error: 'Semua lapisan AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.' }, 502);
    var sres = seq[0];
    var sfin = stripToolCalls(sres.text);
    sfin = await verifyAndFixInstall(env, messages, sfin, null);
    try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, sfin)); } catch (e) {}
    return json({ text: sfin, model: sres.model, session_id: session_id });
  }

  // mode lama stream — sederhana: pakai hasil sekuensial di atas
  var ts2 = new TransformStream();
  var w2 = ts2.writable.getWriter();
  var enc2 = new TextEncoder();
  var pushSeq = function (o) { w2.write(enc2.encode(JSON.stringify(o) + '\n')).catch(function () {}); };
  (async function () {
    var done2 = false;
    if (seq.length) {
      var s0 = seq[0];
      pushSeq({ t: 'delta', text: s0.text });
      var s0c = stripToolCalls(s0.text);
      s0c = await verifyAndFixInstall(env, messages, s0c, function (b) { pushSeq({ t: 'delta', text: b }); });
      pushSeq({ t: 'final', text: s0c, model: s0.model, session_id: session_id });
      try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, s0c)); } catch (e) {}
      done2 = true;
    }
    if (!done2) {
      var f3 = await callClouvia(env, messages, 45e3);
      if (!f3) f3 = await callFallback(env, messages, 6e4);
      if (!f3) f3 = await callGeminiModel(env, GEMINI_MODELS[0], messages, 45e3, null);
      if (f3) {
        var ftxt = stripToolCalls(f3.text);
        pushSeq({ t: 'delta', text: ftxt });
        pushSeq({ t: 'final', text: ftxt, model: f3.model, session_id: session_id });
        try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, ftxt)); } catch (e) {}
      } else {
        pushSeq({ t: 'error', error: 'Semua lapisan AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.' });
      }
    }
    try { await w2.close(); } catch (e) {}
  })();
  return new Response(ts2.readable, { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', ...CORS } });
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/health') {
      var ollamaUrl = await getOllamaUrl(env);
      return json({
        gateway: 'ok', mode: 'v2-race', ver: 'v2.4', ollama_url: ollamaUrl || null, model: OLLAMA_MODEL,
        race_candidates: OR_MODELS.concat(['gemini:' + GEMINI_MODELS[0], 'cfrest:llama-3.3-70b']),
        astra: 'openai/gpt-6-astra',
        background_learning: ['labs_dataset', 'labs_model_stats', 'labs_insights', 'juri ' + JUDGE_MODEL],
        fallbacks: ['clouvia', 'workers-ai', 'gemini']
      });
    }
    if (url.pathname === '/api/stats') {
      await ensureTables(env);
      var stats = [], ds = 0, ins = null;
      try { var r = await env.DB.prepare('SELECT model, wins, fails, total_latency_ms, score_sum, score_n, updated_at FROM labs_model_stats ORDER BY (wins - fails) DESC').all(); stats = r.results || []; } catch (e) {}
      try { var r2 = await env.DB.prepare('SELECT COUNT(*) c FROM labs_dataset').first(); ds = (r2 && r2.c) || 0; } catch (e) {}
      try { var r3 = await env.DB.prepare('SELECT insights, updated_at FROM labs_insights WHERE id = 1').first(); ins = r3 || null; } catch (e) {}
      return json({ model_stats: stats, dataset_rows: ds, insights: ins });
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') return handleChat(request, env, ctx);
    return json({ gateway: 'clincoo-labs-ai v2', endpoints: ['POST /api/chat', 'GET /health', 'GET /api/stats'] });
  }
};
