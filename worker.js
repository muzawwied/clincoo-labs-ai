// clincoo-labs-ai — minimal fast gateway (emergency restore 6 Okt 2026)
// Full orkestra akan dikembalikan; sementara prioritas kecepatan via Gemini.

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Labs-Force',
  'Access-Control-Max-Age': '86400'
};
var GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];
var OPENROUTER_MODEL = 'z-ai/glm-5.3-flash';

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function d1Keys(env, like) {
  try {
    var rows = await env.DB.prepare("SELECT value FROM env_vars WHERE key LIKE '" + like + "' ORDER BY key").all();
    return (rows.results || []).map(function (r) { return String(r.value || '').trim(); }).filter(Boolean);
  } catch (e) { return []; }
}

async function callGemini(env, messages) {
  var keys = (await d1Keys(env, 'GEMINI_API_KEY%'));
  if (env.GEMINI_API_KEY) keys.unshift(env.GEMINI_API_KEY);
  var seen = new Set(); keys = keys.filter(function (k) { if (seen.has(k)) return false; seen.add(k); return true; });
  if (!keys.length) return null;
  var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
  var contents = messages.filter(function (m) { return m.role !== 'system'; }).map(function (m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });
  for (var k = 0; k < keys.length; k++) {
    for (var mi = 0; mi < GEMINI_MODELS.length; mi++) {
      var model = GEMINI_MODELS[mi];
      try {
        var gbody = { contents: contents };
        if (sys) gbody.systemInstruction = { parts: [{ text: sys }] };
        var res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[k] },
          body: JSON.stringify(gbody)
        });
        if (!res.ok) continue;
        var d = await res.json().catch(function () { return {}; });
        var parts = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || [];
        var text = parts.map(function (p) { return p.text || ''; }).join('');
        if (text.trim()) return { text: text, model: model };
      } catch (e) {}
    }
  }
  return null;
}

async function callOpenRouter(env, messages) {
  var keys = await d1Keys(env, 'OPENROUTER_API_KEY%');
  if (env.OPENROUTER_API_KEY) keys.unshift(env.OPENROUTER_API_KEY);
  var seen = new Set(); keys = keys.filter(function (k) { if (seen.has(k)) return false; seen.add(k); return true; });
  if (!keys.length) return null;
  var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
  var chatMsgs = messages.filter(function (m) { return m.role !== 'system'; });
  var payload = sys ? [{ role: 'system', content: sys }].concat(chatMsgs) : chatMsgs;
  for (var i = 0; i < keys.length; i++) {
    try {
      var res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[i], 'HTTP-Referer': 'https://labs.clinqoo.biz.id', 'X-Title': 'Clincoo Labs' },
        body: JSON.stringify({ model: OPENROUTER_MODEL, messages: payload, max_tokens: 4096 })
      });
      if (res.status === 429) continue;
      if (!res.ok) continue;
      var data = await res.json().catch(function () { return {}; });
      var text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
      if (text.trim()) return { text: text, model: 'glm-5.3-flash' };
    } catch (e) {}
  }
  return null;
}

async function handleChat(req, env) {
  var body = {};
  try { body = await req.json(); } catch (e) {}
  var messages = Array.isArray(body.messages) ? body.messages.filter(function (m) {
    return m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && m.content !== undefined;
  }).map(function (m) { return { role: m.role, content: String(m.content || '') }; }) : [];
  if (messages.length > 8) {
    var sys = messages[0] && messages[0].role === 'system' ? [messages[0]] : [];
    var rest = messages[0] && messages[0].role === 'system' ? messages.slice(1) : messages;
    messages = sys.concat(rest.slice(-6));
  }
  if (!messages.length) return json({ error: 'messages kosong' }, 400);
  var session_id = body.session_id || ('ls_' + Date.now());

  var r = await callGemini(env, messages);
  if (!r) r = await callOpenRouter(env, messages);
  if (!r) return json({ error: 'Semua lapisan AI sedang tidak bisa dihubungi. Coba lagi sebentar lagi.' }, 502);
  return json({ text: r.text, model: r.model, session_id: session_id });
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/health') {
      return json({ gateway: 'ok', mode: 'fast-minimal', layers: ['L1 gemini', 'L2 openrouter'] });
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') return handleChat(request, env);
    return json({ gateway: 'clincoo-labs-ai', endpoints: ['POST /api/chat', 'GET /health'] });
  }
};
