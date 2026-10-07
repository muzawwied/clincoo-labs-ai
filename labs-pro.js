// clincoo-labs-pro v1.0 — "Orkestra Pro" (upgrade Labs AI Clincoo, 7 Okt 2026)
//
// Fitur "naik kelas" dibanding labs-ai lama:
//  1. WORKSPACE PRIBADI: simpan/baca/hapus file & gambar user (D1, tersistem di tabel labs_pro_ws)
//  2. MODE AGENT: AI bisa memecah tugas gede jadi langkah, memakai tools (tulis file besar,
//     baca workspace, analisa kode) dalam loop berpikir-aksi-hasil, lalu lapor hasil.
//  3. BALAPAN MODEL: /api/race mengadu semua kandidat paralel, menampilkan semua jawaban,
//     latency, dan pemenang (untuk "test test balapan AI").
//  4. ANALISA KODE: /api/analisis — pemeriksaan statis cepat (bug umum, injeksi SQL, XSS,
//     kurung timpang, await di loop, rahasia tertanam, dll.) + review AI.
//  5. CEPAT: strategi race-first (jawaban tercepat menang) + fallback berjenjang.
//
// Jalur model (tanpa kunci berbayar): Workers AI (binding AI) + Ollama publik (tunnel).
// Kunci OPENROUTER/GEMINI bisa ditambah via secret nanti untuk menambah kandidat.

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx).catch(e => json({ error: String(e && e.message || e) }, 500));
  }
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
}

var env_ollama = ''; // diisi di handle() dari env
function ollamaBase(env) { return ((env && env.OLLAMA_URL) || env_ollama || '').trim(); }

const AI_CANDIDATES = [
  { name: 'llama-3.3-70b', type: 'ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  { name: 'llama-3.1-8b', type: 'ai', model: '@cf/meta/llama-3.1-8b-instruct' }
];
const OLLAMA_CANDIDATE = { name: 'gemma3', type: 'ollama', model: 'gemma3:latest' };

function candidates(env) {
  const url = ollamaBase(env);
  return url ? AI_CANDIDATES.concat([OLLAMA_CANDIDATE]) : AI_CANDIDATES;
}

// ---------- D1 helpers ----------
async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS labs_pro_ws (name TEXT PRIMARY KEY, type TEXT DEFAULT \'text\', content TEXT, size INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS labs_pro_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS labs_pro_stats (model TEXT PRIMARY KEY, wins INTEGER DEFAULT 0, fails INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)')
  ]);
}

async function saveMsg(env, sid, role, content) {
  try {
    await env.DB.prepare('INSERT INTO labs_pro_msgs (session_id, role, content) VALUES (?,?,?)').bind(sid, role, String(content).slice(0, 8000)).run();
    await env.DB.prepare('DELETE FROM labs_pro_msgs WHERE session_id=? AND id NOT IN (SELECT id FROM labs_pro_msgs WHERE session_id=? ORDER BY id DESC LIMIT 20)').bind(sid, sid).run();
  } catch (e) {}
}
async function loadMsgs(env, sid) {
  const r = await env.DB.prepare('SELECT role, content FROM labs_pro_msgs WHERE session_id=? ORDER BY id ASC').bind(sid).all();
  return (r.results || []).map(m => ({ role: m.role, content: m.content }));
}
async function statWin(env, model) {
  try { await env.DB.prepare('INSERT INTO labs_pro_stats (model, wins, updated_at) VALUES (?,1,datetime(\'now\')) ON CONFLICT(model) DO UPDATE SET wins=wins+1, updated_at=datetime(\'now\')').bind(model).run(); } catch (e) {}
}
async function statFail(env, model) {
  try { await env.DB.prepare('INSERT INTO labs_pro_stats (model, fails, updated_at) VALUES (?,1,datetime(\'now\')) ON CONFLICT(model) DO UPDATE SET fails=fails+1, updated_at=datetime(\'now\')').bind(model).run(); } catch (e) {}
}

// ---------- Model calls ----------
async function callAI(env, cand, messages, maxTokens, timeoutMs) {
  if (cand.type === 'ai') {
    const url = 'https://api.cloudflare.com/client/v4/accounts/' + (env.CF_AI_ACCOUNT_ID || '') + '/ai/run/' + cand.model;
    const res = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (env.CF_AI_TOKEN || '') },
      body: JSON.stringify({ messages, max_tokens: maxTokens || 2048 })
    }), timeoutMs || 20000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const r = d && d.result || {};
    const ch = (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || r.response || '';
    if (!String(ch).trim()) throw new Error('kosong');
    return String(ch);
  }
  // ollama
  const res = await withTimeout(fetch(ollamaBase(env) + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cand.model, messages, stream: false })
  }), timeoutMs || 15000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const d = await res.json();
  const text = d && d.message && d.message.content || '';
  if (!String(text).trim()) throw new Error('kosong');
  return String(text);
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + ms + 'ms')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// Balapan: semua kandidat jalan paralel; kembalikan {pemenang, detail[]}
async function raceChat(env, messages, maxTokens, timeoutMs) {
  const cands = candidates(env);
  const start = Date.now();
  const jobs = cands.map(c =>
    callAI(env, c, messages, maxTokens, timeoutMs)
      .then(text => ({ model: c.name, ok: true, text, ms: Date.now() - start }))
      .catch(e => ({ model: c.name, ok: false, error: String(e && e.message || e), ms: Date.now() - start }))
  );
  const all = await Promise.all(jobs);
  const ok = all.find(r => r.ok) || all[0];
  for (const r of all) { if (r.ok) statWin(env, r.model); else statFail(env, r.model); }
  return { winner: ok.ok ? { model: ok.model, text: ok.text } : null, detail: all.map(r => ({ model: r.model, ok: r.ok, ms: r.ms, error: r.error || undefined, text: r.ok ? String(r.text).slice(0, 2000) : undefined })) };
}

// ---------- Workspace tools ----------
async function wsList(env) {
  const r = await env.DB.prepare('SELECT name, type, size, updated_at FROM labs_pro_ws ORDER BY name').all();
  return r.results || [];
}
async function wsSave(env, name, content, type) {
  name = String(name || '').trim();
  if (!name || name.includes('..') || name.startsWith('/')) throw new Error('nama file tidak valid');
  if (name.length > 120) throw new Error('nama terlalu panjang');
  const size = String(content || '').length;
  if (size > 900000) throw new Error('file terlalu besar (maks ~900 KB per file)');
  await env.DB.prepare('INSERT INTO labs_pro_ws (name, type, content, size, updated_at) VALUES (?,?,?,?,datetime(\'now\')) ON CONFLICT(name) DO UPDATE SET type=excluded.type, content=excluded.content, size=excluded.size, updated_at=datetime(\'now\')')
    .bind(name, type === 'base64' ? 'base64' : 'text', String(content), size).run();
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM labs_pro_ws').first();
  if (cnt && cnt.c > 200) { const old = await env.DB.prepare('SELECT name FROM labs_pro_ws ORDER BY updated_at ASC LIMIT 1').first(); if (old) await env.DB.prepare('DELETE FROM labs_pro_ws WHERE name=?').bind(old.name).run(); }
  return { saved: name, size };
}
async function wsRead(env, name) {
  const r = await env.DB.prepare('SELECT name, type, content, size, updated_at FROM labs_pro_ws WHERE name=?').bind(String(name || '')).first();
  if (!r) throw new Error('file tidak ditemukan: ' + name);
  return r;
}
async function wsDelete(env, name) {
  const r = await env.DB.prepare('DELETE FROM labs_pro_ws WHERE name=?').bind(String(name || '')).run();
  return { deleted: r.meta && r.meta.changes > 0 };
}

// ---------- Analisa kode statis ----------
function staticAnalyze(code) {
  const f = [];
  const add = (lvl, msg) => f.push({ level: lvl, msg });
  const bal = s => { let n = 0; for (const c of s) { if (c === '{') n++; if (c === '}') n--; if (n < 0) return n; } return n; };
  if (bal(code) !== 0) add('error', 'Kurung kurawal { } tidak seimbang (' + bal(code) + ') — kemungkinan blok tidak ditutup');
  let n2 = 0; for (const c of code) { if (c === '(') n2++; if (c === ')') n2--; } if (n2 !== 0) add('error', 'Kurung ( ) tidak seimbang (' + n2 + ')');
  if (/eval\s*\(/.test(code)) add('error', 'eval() terdeteksi — risiko injeksi kode, hindari');
  if (/innerHTML\s*=/.test(code) && !/innerHTML\s*=\s*['"`]/.test(code)) add('error', 'innerHTML diisi variabel — risiko XSS; pakai textContent atau sanitasi');
  if (/document\.write/.test(code)) add('error', 'document.write() — usang & rawan XSS');
  if (/(SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,150}?(\+\s*[A-Za-z_$]|\$\{)/i.test(code)) add('error', 'SQL dirangkai dengan penyambungan variabel — risiko injeksi SQL; pakai parameter bind (?)');
  if (/\bvar\s+\w/.test(code)) add('warn', 'Masih pakai var — ganti let/const');
  if (/[^=!<>]==[^=]/.test(code)) add('warn', 'Perbandingan == longgar (pakai ===)');
  if (/for\s*\([^)]*\)\s*{[^}]*await/.test(code)) add('warn', 'await di dalam for-loop — paralelkan dengan Promise.all agar cepat');
  if (/sk-[a-zA-Z0-9]{16,}|AIza[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}/.test(code)) add('error', 'RAHASIA tertanam di kode (API key/token) — pindahkan ke env/secret!');
  const cl = (code.match(/console\.log/g) || []).length;
  if (cl > 3) add('info', cl + ' console.log tertinggal — bersihkan untuk produksi');
  const tf = (code.match(/TODO|FIXME/g) || []).length;
  if (tf) add('info', tf + ' TODO/FIXME belum selesai');
  if (/fetch\s*\(/.test(code) && !/try\s*{/.test(code) && !/\.catch\(/.test(code)) add('warn', 'fetch tanpa try/catch atau .catch() — error tak tertangani');
  if (/setTimeout\s*\(\s*["']/.test(code)) add('warn', 'setTimeout dengan string — jalankan fungsi, bukan string');
  if (!f.length) add('ok', 'Tidak ditemukan pola masalah umum. Bagus!');
  return f;
}

// ---------- Agent loop ----------
const SYSTEM_AGENT = [
  'Kamu adalah "Orkestra Pro", AI asisten teknis Clincoo Labs. Kamu PUNYA TOOLS untuk menyelesaikan tugas besar.',
  'Aturan menjawab — WAJIB jawab DALAM SATU OBJEK JSON saja (tanpa teks lain):',
  '{"think":"...pikiran singkat...","actions":[{"tool":"...","args":{...}}],"final":"...jawaban untuk user..."}',
  'Jika tugas masih butuh aksi (membuat file, membaca file, analisa kode), isi "actions" dan kosongkan/isi singkat "final".',
  'Jika tugas sudah selesai atau cukup dijawab langsung, kosongkan "actions" dan isi "final" dengan jawaban lengkap.',
  'TOOLS YANG TERSEDIA:',
  '1. {"tool":"ws_save","args":{"name":"namafile.txt","content":"isi lengkap file","type":"text"}} — tulis/ubah file di workspace (untuk file besar/karya AI: tulis SEKALIGUS penuh). Untuk file gambar pakai "type":"base64".',
  '2. {"tool":"ws_read","args":{"name":"namafile"}} — baca isi file.',
  '3. {"tool":"ws_list","args":{}} — daftar file di workspace.',
  '4. {"tool":"ws_delete","args":{"name":"namafile"}} — hapus file.',
  '5. {"tool":"analyze_code","args":{"code":"...kode..."} — temukan masalah/bug/jebakan dalam kode.',
  'Gunakan bahasa Indonesia yang santai. Untuk tugas besar: pecah menjadi beberapa actions dalam satu giliran, ulangi sampai selesai (maksimal 6 giliran). Sebutkan file yang kamu buat di "final".'
].join('\n');

function extractJson(text) {
  const s = text.indexOf('{');
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

async function runTool(env, tool, args) {
  args = args || {};
  if (tool === 'ws_save') return wsSave(env, args.name, args.content, args.type);
  if (tool === 'ws_read') { const r = await wsRead(env, args.name); return { name: r.name, type: r.type, size: r.size, content: String(r.content).slice(0, 60000) }; }
  if (tool === 'ws_list') { const l = await wsList(env); return { files: l.map(x => ({ name: x.name, type: x.type, size: x.size })) }; }
  if (tool === 'ws_delete') return wsDelete(env, args.name);
  if (tool === 'analyze_code') return { temuan: staticAnalyze(String(args.code || '')) };
  return { error: 'tool tidak dikenal: ' + tool };
}

async function agentTurn(env, history, task, maxRounds) {
  const rounds = [];
  const msgs = [{ role: 'system', content: SYSTEM_AGENT }].concat(history.slice(-8), [{ role: 'user', content: task }]);
  const wsFiles = await wsList(env).catch(() => []);
  if (wsFiles.length) msgs.push({ role: 'system', content: 'File yang sudah ada di workspace: ' + wsFiles.map(f => f.name + ' (' + f.size + ' B)').join(', ') });
  let finalText = '', modelUsed = '';
  for (let r = 0; r < (maxRounds || 6); r++) {
    const res = await raceChat(env, msgs, 4096, 25000);
    if (!res.winner) { finalText = 'Semua model gagal merespons. Coba lagi sebentar.'; break; }
    modelUsed = res.winner.model;
    const out = res.winner.text;
    const j = extractJson(out);
    if (!j) { finalText = out; rounds.push({ round: r + 1, model: modelUsed, direct: true }); break; }
    const actions = Array.isArray(j.actions) ? j.actions.slice(0, 8) : [];
    const results = [];
    for (const a of actions) results.push({ tool: a && a.tool, result: await runTool(env, a && a.tool, a && a.args) });
    rounds.push({ round: r + 1, model: modelUsed, think: (j.think || '').slice(0, 300), actions: actions.map(a => a.tool), results });
    if (j.final && String(j.final).trim()) { finalText = String(j.final); break; }
    if (!actions.length) { finalText = j.final || '(selesai tanpa jawaban)'; break; }
    msgs.push({ role: 'assistant', content: out.slice(0, 12000) });
    msgs.push({ role: 'user', content: 'HASIL AKSI:\n' + JSON.stringify(results).slice(0, 12000) + '\n\nLanjutkan. Selesaikan tugas atau beri "final".' });
  }
  if (!finalText) finalText = 'Tugas selesai dalam batas langkah. File hasil ada di workspace.';
  return { final: finalText, rounds, model: modelUsed };
}

// ---------- Router ----------
async function handle(request, env, ctx) {
  env_ollama = (env && env.OLLAMA_URL) || '';
  await ensureTables(env);
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method === 'GET' && (path === '/' || path === '')) return new Response(UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
  if (request.method === 'GET' && path === '/health')
    return json({ gateway: 'clincoo-labs-pro v1.0 (Orkestra Pro)', kandidat: candidates(env).map(c => c.name), fitur: ['chat', 'agent+tools', 'balapan', 'analisa_kode', 'workspace'] });
  if (request.method === 'GET' && path === '/api/stats') {
    const r = await env.DB.prepare('SELECT * FROM labs_pro_stats ORDER BY wins DESC').all();
    return json({ stats: r.results || [] });
  }

  // Workspace
  if (path === '/api/ws') {
    if (request.method === 'GET') {
      const name = url.searchParams.get('name');
      if (name) { try { const f = await wsRead(env, name); return json(f); } catch (e) { return json({ error: String(e && e.message || e) }, 404); } }
      return json({ files: await wsList(env) });
    }
    if (request.method === 'POST') {
      try { const b = await request.json(); const r = await wsSave(env, b.name, b.content, b.type); return json(r); } catch (e) { return json({ error: String(e && e.message || e) }, 400); }
    }
    if (request.method === 'DELETE') {
      const name = url.searchParams.get('name');
      if (!name) return json({ error: 'param name wajib' }, 400);
      return json(await wsDelete(env, name));
    }
  }
  if (path.startsWith('/f/') && request.method === 'GET') {
    const name = decodeURIComponent(path.slice(3));
    try {
      const f = await wsRead(env, name);
      const ct = f.type === 'base64'
        ? (/\.(png|jpe?g|gif|webp)$/i.test(name) ? 'image/' + (name.split('.').pop() || 'png').toLowerCase() : 'application/octet-stream')
        : 'text/plain; charset=utf-8';
      const body = f.type === 'base64' ? Uint8Array.from(atob(f.content), c => c.charCodeAt(0)) : f.content;
      return new Response(body, { headers: { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' } });
    } catch (e) { return json({ error: 'file tidak ditemukan' }, 404); }
  }

  if (request.method !== 'POST') return json({ error: 'Method tidak didukung' }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) {}

  // Chat biasa (cepat) + opsional mode agent
  if (path === '/api/chat') {
    const sid = body.session_id || ('lp_' + Date.now());
    const prompt = String(body.prompt || body.message || '').trim();
    const mode = body.mode || 'chat';
    const history = await loadMsgs(env, sid).catch(() => []);
    if (mode === 'agent') {
      const r = await agentTurn(env, history, prompt);
      await saveMsg(env, sid, 'user', prompt);
      await saveMsg(env, sid, 'assistant', r.final);
      return json({ text: r.final, model: r.model || 'orkestra-pro', session_id: sid, rounds: r.rounds.length });
    }
    const msgs = [{ role: 'system', content: 'Kamu "Orkestra Pro", AI asisten Clincoo Labs. Jawab ringkas, akurat, santai dalam Bahasa Indonesia.' }].concat(history.slice(-8), [{ role: 'user', content: prompt }]);
    const r = await raceChat(env, msgs, 2048, 20000);
    if (!r.winner) return json({ text: 'Semua kandidat gagal, coba lagi.', model: 'none', session_id: sid, detail: r.detail }, 503);
    await saveMsg(env, sid, 'user', prompt);
    await saveMsg(env, sid, 'assistant', r.winner.text);
    return json({ text: r.winner.text, model: r.winner.model, session_id: sid, ms: (r.detail.find(d => d.model === r.winner.model) || {}).ms });
  }

  // Balapan terbuka
  if (path === '/api/race') {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json({ error: 'param prompt wajib' }, 400);
    const msgs = [{ role: 'user', content: prompt }];
    const r = await raceChat(env, msgs, 2048, 30000);
    return json({ prompt, pemenang: r.winner ? r.winner.model : null, detail: r.detail });
  }

  // Analisa kode
  if (path === '/api/analisis') {
    const code = String(body.code || '');
    if (!code) return json({ error: 'param code wajib' }, 400);
    const temuan = staticAnalyze(code);
    let review = '';
    try {
      const msgs = [
        { role: 'system', content: 'Kamu reviewer kode senior. Berikan review singkat (maks 150 kata) bahasa Indonesia: bug logika, keamanan, performa, dan saran perbaikan prioritas.' },
        { role: 'user', content: 'Review kode ini dan daftar temuan statis berikut:\n\nTEMUAN STATIS: ' + JSON.stringify(temuan) + '\n\nKODE:\n' + code.slice(0, 20000) }
      ];
      const r = await raceChat(env, msgs, 1024, 25000);
      review = r.winner ? r.winner.text : '';
    } catch (e) {}
    return json({ temuan, review_ai: review });
  }

  // Mode agent langsung
  if (path === '/api/agent') {
    const task = String(body.task || body.prompt || '').trim();
    if (!task) return json({ error: 'param task wajib' }, 400);
    const sid = body.session_id || ('lp_' + Date.now());
    const history = await loadMsgs(env, sid).catch(() => []);
    const r = await agentTurn(env, history, task, body.max_rounds || 6);
    await saveMsg(env, sid, 'user', task);
    await saveMsg(env, sid, 'assistant', r.final);
    return json({ text: r.final, model: r.model || 'orkestra-pro', session_id: sid, langkah: r.rounds });
  }

  return json({ error: 'Endpoint tidak dikenal: ' + path }, 404);
}

// ---------- UI sederhana bawaan ----------
var UI_HTML = '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orkestra Pro — Clincoo Labs</title><style>'
+ 'body{background:#0b0e14;color:#dfe6f3;font-family:system-ui,Segoe UI,sans-serif;margin:0;padding:16px;max-width:860px;margin:auto}'
+ 'h1{font-size:1.3rem}h1 b{color:#7c5cff}.tab{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}'
+ '.tab button{background:#151a26;color:#9fb0d9;border:1px solid #232b3d;padding:8px 14px;border-radius:10px;cursor:pointer}'
+ '.tab button.on{background:#7c5cff;color:#fff;border-color:#7c5cff}'
+ 'textarea,input{width:100%;box-sizing:border-box;background:#11141f;color:#dfe6f3;border:1px solid #232b3d;border-radius:10px;padding:10px;font-family:monospace}'
+ 'button.go{background:#7c5cff;color:#fff;border:0;border-radius:10px;padding:10px 18px;margin-top:8px;cursor:pointer;font-weight:600}'
+ '.out{background:#11141f;border:1px solid #232b3d;border-radius:10px;padding:12px;margin-top:10px;white-space:pre-wrap;font-size:.9rem;min-height:40px}'
+ '.file{display:inline-block;background:#151a26;border:1px solid #232b3d;border-radius:8px;padding:6px 10px;margin:4px;font-size:.85rem}'
+ 'img.prev{max-width:180px;border-radius:8px;margin:4px}small{color:#7787a8}</style></head><body>'
+ '<h1>🎹 <b>Orkestra Pro</b> <small>Clincoo Labs</small></h1>'
+ '<div class="tab"><button id="t-chat" class="on" onclick="tab(1)">Chat</button><button id="t-agent" onclick="tab(2)">Agent (tugas besar)</button><button id="t-race" onclick="tab(3)">Balapan AI</button><button id="t-anal" onclick="tab(4)">Analisa Kode</button><button id="t-ws" onclick="tab(5)">Workspace</button></div>'
+ '<div id="p1"><textarea id="c1" rows="4" placeholder="Tanya apa saja..."></textarea><button class="go" onclick="chat()">Kirim</button><div class="out" id="o1"></div></div>'
+ '<div id="p2" style="display:none"><textarea id="c2" rows="4" placeholder="Contoh: Buatkan file laporan.md berisi rencana bisnis kopi digital, lalu analisa kodenya index.js"></textarea><button class="go" onclick="agent()">Jalankan Agent</button><div class="out" id="o2"></div></div>'
+ '<div id="p3" style="display:none"><textarea id="c3" rows="3" placeholder="Prompt yang sama diadu ke semua model..."></textarea><button class="go" onclick="race()">Balap!</button><div class="out" id="o3"></div></div>'
+ '<div id="p4" style="display:none"><textarea id="c4" rows="8" placeholder="Tempel kode di sini..."></textarea><button class="go" onclick="anal()">Analisa</button><div class="out" id="o4"></div></div>'
+ '<div id="p5" style="display:none"><input type="file" id="fu"><button class="go" onclick="up()">Simpan ke Workspace</button><div class="out" id="o5"></div><button class="go" style="background:#31435f" onclick="loadWs()">Muat daftar file</button></div>'
+ '<script>'
+ 'var S=localStorage.lp_sid||(localStorage.lp_sid="lp_"+Date.now());'
+ 'function tab(n){for(var i=1;i<=5;i++){document.getElementById("p"+i).style.display=i===n?"":"none";document.getElementById("t-"+["","chat","agent","race","anal","ws"][i]).className=i===n?"on":""}}'
+ 'async function post(p,b){var r=await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json()}'
+ 'async function chat(){var o=document.getElementById("o1");o.textContent="...";var d=await post("/api/chat",{prompt:document.getElementById("c1").value,session_id:S});o.textContent="["+d.model+"] "+d.text}'
+ 'async function agent(){var o=document.getElementById("o2");o.textContent="Agent bekerja...";var d=await post("/api/agent",{task:document.getElementById("c2").value,session_id:S});o.textContent=d.text+"\\n\\n— langkah: "+(d.langkah||[]).map(function(l){return "R"+l.round+"("+l.model+") "+(l.actions||[]).join(",")}).join(" | ")}'
+ 'async function race(){var o=document.getElementById("o3");o.textContent="Balapan dimulai...";var d=await post("/api/race",{prompt:document.getElementById("c3").value});var s="🏆 Pemenang: "+d.pemenang+"\\n";(d.detail||[]).forEach(function(x){s+="\\n["+x.model+"] "+(x.ok?"OK "+x.ms+"ms":"GAGAL: "+x.error)+"\\n"+((x.text||"").slice(0,300))+"\\n"});o.textContent=s}'
+ 'async function anal(){var o=document.getElementById("o4");o.textContent="Menganalisa...";var d=await post("/api/analisis",{code:document.getElementById("c4").value});var s="";(d.temuan||[]).forEach(function(t){s+="• ["+t.level+"] "+t.msg+"\\n"});o.textContent=s+"\\nREVIEW AI:\\n"+(d.review_ai||"-")}'
+ 'async function up(){var f=document.getElementById("fu").files[0];if(!f){return}var o=document.getElementById("o5");var rd=new FileReader();rd.onload=async function(){var isImg=/^image\\//.test(f.type);var b=await post("/api/ws",{name:f.name,content:rd.result.split(",").pop(),type:isImg?"base64":"text"});o.textContent=JSON.stringify(b);loadWs()};rd.readAsDataURL(f)}'
+ 'async function loadWs(){var o=document.getElementById("o5");var d=await fetch("/api/ws").then(function(r){return r.json()});var s="";(d.files||[]).forEach(function(x){s+=x.type==="base64"?"<span class=file>🖼 "+x.name+" ("+x.size+" B) <a style=color:#9db href=/f/"+encodeURIComponent(x.name)+">lihat</a> <a style=color:#f66 href=# onclick=\\"del(\x27"+x.name+"\x27);return false\\">hapus</a></span>":"<span class=file>📄 "+x.name+" ("+x.size+" B) <a style=color:#f66 href=# onclick=\\"del(\x27"+x.name+"\x27);return false\\">hapus</a></span>" + (x.name.match(/\\.(png|jpe?g|gif|webp)$/i)?"<img class=prev src=/f/"+encodeURIComponent(x.name)+">":"")});o.innerHTML=s||"Workspace kosong"}'
+ 'async function del(n){await fetch("/api/ws?name="+encodeURIComponent(n),{method:"DELETE"});loadWs()}'
+ '<\/script></body></html>';
