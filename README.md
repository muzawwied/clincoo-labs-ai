# clincoo-labs-ai — Gateway AI Orkestra Clincoo Labs

Worker Cloudflare yang menjalankan AI chat di *labs* Clincoo
(labs.clinqoo.biz.id / www.clinqoo.biz.id / modela.pages.dev).

## Mode saat ini: **fast-minimal** (6 Okt 2026)

Prioritas kecepatan:
1. **Gemini** `gemini-3.6-flash` → `gemini-3-flash-preview` (~1.5s)
2. **OpenRouter** `z-ai/glm-5.3-flash` (fallback)

max_tokens 4096, konteks dipangkas 6 pesan.

> Versi orkestra penuh (Ollama + Clouvia + Workers AI) diganti sementara
> dengan gateway minimal agar AI **lebih cepat** dan stabil.

## Endpoint
- `POST /api/chat` — `{ messages, session_id? }` → JSON `{text, model, session_id}`
- `GET /health` — status gateway

## Deploy
```bash
npx wrangler deploy
```

## Riwayat
- 6 Okt 2026: fast-minimal — Gemini first untuk jawaban lebih cepat
- 5 Okt 2026: orkestra L1–L5 lengkap
