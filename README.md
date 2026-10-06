# clincoo-labs-ai — Gateway AI Orkestra Clincoo Labs

Worker Cloudflare yang menjalankan AI chat di *labs* Clincoo
(labs.clinqoo.biz.id / www.clinqoo.biz.id / modela.pages.dev).

## Orkestra lapisan (fallback berlapis) — optimasi kecepatan 6 Okt 2026
1. **L1 — Ollama pribadi** `gemma3:latest` via tunnel (cold-start dibatasi **4 detik**)
2. **L2 — Gemini** `gemini-3.6-flash` lalu `gemini-3-flash-preview` (paling cepat ~1.5s)
3. **L3 — OpenRouter** `z-ai/glm-5.3-flash` — streaming SSE + retry 429
4. **L4 — Clouvia** `router.clouvia.id` — `glm5.3-flash` lalu `free-model`
5. **L5 — Workers AI** — GPT-OSS 120B lalu Llama 3.3 70B

Plus: memori jangka panjang (6 baris), max_tokens 4096, heartbeat 4 detik,
pembatas konteks 6 pesan terakhir.

## Endpoint
- `POST /api/chat` — `{ messages, stream?, session_id?, action? }`
  → ndjson `{t:delta|final|error}` saat streaming, atau JSON `{text,model,session_id}`
- `GET /health` — status Ollama + daftar lapisan

## Deploy
```bash
npx wrangler deploy   # pakai wrangler.toml di repo ini
```

## Riwayat
- 6 Okt 2026: optimasi kecepatan — Ollama bail 4s, Gemini ke L2, max_tokens 4096,
  memori & konteks dipangkas. Target: first-token lebih cepat saat Ollama cold.
- 5 Okt 2026: rekonstruksi sumber dari bundel terdeploy + peningkatan
  (streaming L2 sungguhan, retry 429, lapisan Clouvia & Gemini baru,
  fallback Ollama cold 20s → 10s). Hasil uji: non-stream 3.3s (sebelumnya 17s),
  streaming per-token OK, Clouvia 2.7s OK, Gemini 1.5s OK.
