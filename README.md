# clincoo-labs-ai — Gateway AI Orkestra Clincoo Labs

Worker Cloudflare yang menjalankan AI chat di *labs* Clincoo
(labs.clinqoo.biz.id / www.clinqoo.biz.id / modela.pages.dev).

## Orkestra lapisan (fallback berlapis)
1. **L1 — Ollama pribadi** `gemma3:latest` via tunnel Cloudflare (URL dari D1
   `LABS_OLLAMA_URL`, deteksi ready via `/api/ps`, cold-start dibatasi 10 detik)
2. **L2 — OpenRouter** `z-ai/glm-5.3-flash` — kunci multi dari D1, retry antar
   kunci saat 429, streaming SSE sungguhan (token mengalir per potongan)
3. **L3 — Clouvia** `router.clouvia.id` — `glm5.3-flash` lalu `free-model`;
   system prompt disuntik ke pesan user pertama (gateway membuang role system)
4. **L4 — Workers AI** — `@cf/openai/gpt-oss-120b` lalu Llama 3.3 70B
5. **L5 — Gemini** — `gemini-3.6-flash` lalu `gemini-3-flash-preview`, kunci
   multi dari D1

Plus: memori jangka panjang lintas sesi (tabel `agent_memory` D1), pemangkasan
format tool-call `[[...]]`, heartbeat 4 detik saat streaming, pembatas konteks
12 pesan terakhir.

## Endpoint
- `POST /api/chat` — `{ messages, stream?, session_id?, action? }`
  → ndjson `{t:delta|final|error}` saat streaming, atau JSON `{text,model,session_id}`
- `GET /health` — status Ollama + daftar lapisan

## Deploy
```bash
npx wrangler deploy   # pakai wrangler.toml di repo ini
```

## Riwayat
- 5 Okt 2026: rekonstruksi sumber dari bundel terdeploy + peningkatan
  (streaming L2 sungguhan, retry 429, lapisan Clouvia & Gemini baru,
  fallback Ollama cold 20s → 10s). Hasil uji: non-stream 3.3s (sebelumnya 17s),
  streaming per-token OK, Clouvia 2.7s OK, Gemini 1.5s OK.
