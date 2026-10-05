// clincoo-labs-ai — gateway AI orkestra Clincoo Labs
// Sumber: rekonstruksi dari bundel terdeploy (5 Okt 2026) + peningkatan orkestra.
//
// Urutan lapisan (fallback berlapis):
//   L1  Ollama pribadi (gemma3) via tunnel — kalau server online & model ready
//   L2  OpenRouter GLM 5.3 Flash — kunci multi dari D1, retry antar kunci saat 429,
//       streaming SSE sungguhan (token mengalir, bukan muncul sekaligus)
//   L3  Clouvia (router.clouvia.id) — glm5.3-flash lalu free-model; system prompt
//       disuntik ke pesan user pertama (gateway membuang role system)
//   L4  Workers AI — GPT-OSS 120B lalu Llama 3.3 70B
//   L5  Gemini — 3.6 Flash lalu 3 Flash Preview, kunci multi (D1 + env)
//   ~   error ramah (teks sama persis seperti versi lama)
//
// Perubahan vs versi lama:
//   - OLLAMA_FIRST_MS 20s -> 10s (fallback lebih cepat saat Ollama cold)
//   - L2 kini streaming sungguhan + retry 429 antar kunci
//   - Lapisan Clouvia & Gemini BARU (dulu: langsung Workers AI lalu menyerah)
//   - Log lapisan lebih informatif (durasi + alasan lompat)

var OLLAMA_MODEL = 'gemma3:latest';
var OLLAMA_TIMEOUT_MS = 75e3;
var OLLAMA_FIRST_MS = 10e3; // turun dari 20s
var FALLBACK_AI = 'https://clincoo-be2.pages.dev/api/ai'; // butuh login; hanya info di /health
var OPENROUTER_MODEL = 'z-ai/glm-5.3-flash';
var CLOUVIA_MODELS = ['glm5.3-flash', 'free-model'];
var WORKERS_AI_MODELS = ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
var GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Labs-Force',
  'Access-Control-Max-Age': '86400'
};

var urlCache = { url: '', at: 0 };
var psCache = new Map();

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

// ===== L2: OpenRouter — streaming sungguhan + retry 429 antar kunci =====
async function callOpenRouter(env, messages, timeoutMs, onDelta) {
  var keys = await getOpenRouterKeys(env);
  if (!keys.length) { console.log('[L2] skip: tidak ada kunci'); return null; }
  var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
  var chatMsgs = messages.filter(function (m) { return m.role !== 'system'; });
  var payloadMsgs = sys ? [{ role: 'system', content: sys }, ...chatMsgs] : chatMsgs;
  var t0 = Date.now();

  for (var i = 0; i < keys.length; i++) {
    var ac = new AbortController();
    var t = setTimeout(function () { ac.abort(); }, timeoutMs || 6e4);
    try {
      var body = { model: OPENROUTER_MODEL, messages: payloadMsgs, max_tokens: 16384 };
      if (onDelta) body.stream = true;
      var res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[i], 'HTTP-Referer': 'https://labs.clinqoo.biz.id', 'X-Title': 'Clincoo Labs' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      clearTimeout(t);

      if (res.status === 429) {
        console.log('[L2] kunci#' + (i + 1) + ' rate limit (429)' + (i + 1 < keys.length ? ' — coba kunci berikutnya' : ' — semua kunci kena limit'));
        if (i + 1 < keys.length) await new Promise(function (r) { setTimeout(r, 700); });
        continue;
      }
      if (!res.ok) {
        console.log('[L2] kunci#' + (i + 1) + ' HTTP ' + res.status);
        continue;
      }

      if (onDelta && res.body) {
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '', acc = '';
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
              if (piece) { acc += piece; onDelta(piece); }
            } catch (e) {}
          }
        }
        if (acc.trim()) {
          console.log('[L2] stream OK ' + acc.length + ' char, ' + (Date.now() - t0) + 'ms');
          return { text: acc, model: 'glm-5.3-flash' };
        }
        console.log('[L2] stream kosong — lanjut');
        continue;
      }

      var data2 = await res.json().catch(function () { return {}; });
      var text = data2 && data2.choices && data2.choices[0] && data2.choices[0].message && data2.choices[0].message.content || '';
      if (typeof text === 'string' && text.trim()) {
        console.log('[L2] OK ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
        return { text: text, model: 'glm-5.3-flash' };
      }
    } catch (e) {
      clearTimeout(t);
      console.log('[L2] err: ' + String(e && e.message || e));
    }
  }
  return null;
}

// ===== L3: Clouvia — BARU =====
async function callClouvia(env, messages, timeoutMs) {
  var keys = await getClouviaKeys(env);
  if (!keys.length) { console.log('[L3] skip: tidak ada kunci Clouvia'); return null; }
  // Gateway Clouvia membuang role 'system' — suntik isinya ke pesan user pertama.
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
        if (typeof text === 'string' && text.trim()) {
          console.log('[L3] OK ' + model + ' ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
          return { text: text, model: model };
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
      if (typeof text === 'string' && text.trim()) {
        console.log('[L4] OK ' + model + ' ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
        return { text: text, model: model.split('/').pop() };
      }
    } catch (e) {
      clearTimeout(t);
      console.log('[L4] ' + model + ' err: ' + String(e && e.message || e));
    }
  }
  return null;
}

// ===== L5: Gemini — BARU =====
async function callGemini(env, messages, timeoutMs) {
  var keys = await getGeminiKeys(env);
  if (!keys.length) { console.log('[L5] skip: tidak ada kunci Gemini'); return null; }
  var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
  var contents = messages.filter(function (m) { return m.role !== 'system'; }).map(function (m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });
  var t0 = Date.now();
  for (var k = 0; k < keys.length; k++) {
    for (var mi = 0; mi < GEMINI_MODELS.length; mi++) {
      var model = GEMINI_MODELS[mi];
      var gbody = { contents: contents };
      if (sys) gbody.systemInstruction = { parts: [{ text: sys }] };
      var ac = new AbortController();
      var t = setTimeout(function () { ac.abort(); }, timeoutMs || 45e3);
      try {
        var res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[k] },
          body: JSON.stringify(gbody),
          signal: ac.signal
        });
        clearTimeout(t);
        if (!res.ok) { console.log('[L5] ' + model + ' HTTP ' + res.status); continue; }
        var d = await res.json().catch(function () { return {}; });
        var parts = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || [];
        var text = parts.map(function (p) { return p.text || ''; }).join('');
        if (text.trim()) {
          console.log('[L5] OK ' + model + ' ' + text.length + ' char, ' + (Date.now() - t0) + 'ms');
          return { text: text, model: model };
        }
      } catch (e) {
        clearTimeout(t);
        console.log('[L5] ' + model + ' err: ' + String(e && e.message || e));
      }
    }
  }
  return null;
}

function fallbackAsStream(fbText, fbModel, session_id) {
  var ts = new TransformStream();
  var writer = ts.writable.getWriter();
  var enc = new TextEncoder();
  (async function () {
    await writer.write(enc.encode(JSON.stringify({ t: 'delta', text: fbText }) + '\n'));
    await writer.write(enc.encode(JSON.stringify({ t: 'final', text: fbText, model: fbModel, session_id: session_id }) + '\n'));
    try { await writer.close(); } catch (e) {}
  })();
  return new Response(ts.readable, { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', ...CORS } });
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
  if (mBlock) {
    if (messages.length && messages[0].role === 'system') {
      messages[0] = { ...messages[0], content: messages[0].content + mBlock };
    } else {
      messages.unshift({ role: 'system', content: mBlock.trim() });
    }
  }

  var lastUser = null;
  for (var i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUser = messages[i]; break; }
  var wantsStream = body.stream === true;
  var forceFallback = req.headers.get('X-Labs-Force') === 'fallback';
  var ollamaUrl = forceFallback ? '' : await getOllamaUrl(env);

  // ---- L1: cek Ollama ready via /api/ps (cache 60 detik) ----
  var glmReady = false;
  if (ollamaUrl) {
    try {
      var cached = psCache.get(ollamaUrl);
      if (cached === undefined) {
        var acP = new AbortController();
        var tP = setTimeout(function () { acP.abort(); }, 5e3);
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

  // ---- L1: jalankan Ollama ----
  var oText = '';
  if (ollamaUrl && glmReady) {
    console.log('[L1] mulai, t=' + Date.now());
    var oBase = ollamaUrl.replace(/\/+$/, '');
    var t1 = Date.now();
    var ac2 = new AbortController();
    if (wantsStream) {
      try {
        req.signal.addEventListener('abort', function () { try { ac2.abort(); } catch (e) {} });
      } catch (e) {}
    }
    var got1 = false;
    var guard2 = setTimeout(function () { if (!got1) { try { ac2.abort(); } catch (e) {} } }, OLLAMA_TIMEOUT_MS);
    var firstBail = setTimeout(function () { if (!got1) { try { ac2.abort(); } catch (e) {} } }, OLLAMA_FIRST_MS);
    try {
      var r = await fetch(oBase + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages: messages, stream: false, think: false, keep_alive: '24h', options: { num_ctx: 16384, num_predict: -1 } }),
        signal: ac2.signal
      });
      if (r.ok) {
        var jj = await r.json().catch(function () { return null; });
        var c = jj && jj.message && typeof jj.message.content === 'string' ? jj.message.content : '';
        if (c && c.trim()) oText = c;
      }
      got1 = true;
    } catch (e) {
      console.log('[L1] err: ' + String(e && e.message || e) + ' setelah ' + (Date.now() - t1) + 'ms');
    }
    clearTimeout(guard2);
    clearTimeout(firstBail);
    console.log('[L1] selesai, hasil=' + oText.length + ' char, ' + (Date.now() - t1) + 'ms');
  }

  // ---- non-stream: jalur sederhana berurutan ----
  if (!wantsStream) {
    if (oText.trim()) {
      var ft1 = stripToolCalls(oText);
      try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, ft1)); } catch (e) {}
      return json({ text: ft1, model: OLLAMA_MODEL, session_id: session_id });
    }
    var r2 = await callOpenRouter(env, messages, 6e4, null);
    if (r2) {
      var ft2 = stripToolCalls(r2.text);
      try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, ft2)); } catch (e) {}
      return json({ text: ft2, model: r2.model, session_id: session_id });
    }
    var r3 = await callClouvia(env, messages, 45e3);
    if (r3) {
      var ft3 = stripToolCalls(r3.text);
      try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, ft3)); } catch (e) {}
      return json({ text: ft3, model: r3.model, session_id: session_id });
    }
    var r4 = await callFallback(env, messages, 6e4);
    if (r4) {
      var ft4 = stripToolCalls(r4.text);
      try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, ft4)); } catch (e) {}
      return json({ text: ft4, model: r4.model, session_id: session_id });
    }
    var r5 = await callGemini(env, messages, 45e3);
    if (r5) {
      var ft5 = stripToolCalls(r5.text);
      try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, ft5)); } catch (e) {}
      return json({ text: ft5, model: r5.model, session_id: session_id });
    }
    return json({ error: 'Semua lapisan AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.' }, 502);
  }

  // ---- stream: kirim progresif ----
  var ts = new TransformStream();
  var writer = ts.writable.getWriter();
  var enc = new TextEncoder();
  var push = function (o) { writer.write(enc.encode(JSON.stringify(o) + '\n')).catch(function () {}); };
  var hb = setInterval(function () { push({ t: 'delta', text: '' }); }, 4e3);

  (async function () {
    var done = false;
    var finalText = '', finalModel = '';
    if (oText.trim()) {
      // L1 sukses: keluarkan bertahap agar terasa mengalir.
      finalText = oText; finalModel = OLLAMA_MODEL;
      var chunks = Math.min(50, Math.max(1, Math.ceil(finalText.length / 30)));
      var per = Math.ceil(finalText.length / chunks);
      for (var i2 = 0; i2 < finalText.length; i2 += per) {
        push({ t: 'delta', text: finalText.slice(i2, Math.min(finalText.length, i2 + per)) });
        await new Promise(function (res) { setTimeout(res, 45); });
      }
      done = true;
    }
    if (!done) {
      // L2 streaming token sungguhan.
      var rL2 = await callOpenRouter(env, messages, 6e4, function (piece) { push({ t: 'delta', text: piece }); });
      if (rL2 && rL2.text) { finalText = rL2.text; finalModel = rL2.model; done = true; }
    }
    if (!done) {
      var rL3 = await callClouvia(env, messages, 45e3);
      if (rL3) { finalText = rL3.text; finalModel = rL3.model; push({ t: 'delta', text: finalText }); done = true; }
    }
    if (!done) {
      var rL4 = await callFallback(env, messages, 6e4);
      if (rL4) { finalText = rL4.text; finalModel = rL4.model; push({ t: 'delta', text: finalText }); done = true; }
    }
    if (!done) {
      var rL5 = await callGemini(env, messages, 45e3);
      if (rL5) { finalText = rL5.text; finalModel = rL5.model; push({ t: 'delta', text: finalText }); done = true; }
    }
    clearInterval(hb);
    if (done) {
      finalText = stripToolCalls(finalText);
      push({ t: 'final', text: finalText, model: finalModel, session_id: session_id });
      try { ctx.waitUntil(saveMemory(env, session_id, lastUser && lastUser.content, finalText)); } catch (e) {}
    } else {
      push({ t: 'error', error: 'Semua lapisan AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.' });
    }
    try { await writer.close(); } catch (e) {}
  })();

  return new Response(ts.readable, { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', ...CORS } });
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/health') {
      var ollamaUrl = await getOllamaUrl(env);
      var ollamaOk = false, modelOk = false;
      if (ollamaUrl) {
        try {
          var r = await fetch(ollamaUrl.replace(/\/+$/, '') + '/api/ps', { signal: AbortSignal.timeout(15e3) });
          if (r.ok) {
            var j = await r.json().catch(function () { return null; });
            ollamaOk = true;
            modelOk = !!(j && (j.models || []).some(function (m) { return (m.name || '').startsWith(OLLAMA_MODEL); }));
          }
        } catch (e) {}
      }
      return json({
        gateway: 'ok', ollama_url: ollamaUrl || null, ollama_online: ollamaOk, model_ready: modelOk, model: OLLAMA_MODEL,
        layers: [
          'L1 ollama:' + OLLAMA_MODEL,
          'L2 openrouter:' + OPENROUTER_MODEL,
          'L3 clouvia:' + CLOUVIA_MODELS.join('/'),
          'L4 workers-ai:' + WORKERS_AI_MODELS.map(function (m) { return m.split('/').pop(); }).join('/'),
          'L5 gemini:' + GEMINI_MODELS.join('/')
        ],
        fallback: FALLBACK_AI
      });
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') return handleChat(request, env, ctx);
    return json({ gateway: 'clincoo-labs-ai', endpoints: ['POST /api/chat', 'GET /health'] });
  }
};
