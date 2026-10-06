// clincoo-labs-ai — gateway AI orkestra Clincoo Labs
// Sumber: rekonstruksi dari bundel terdeploy (5 Okt 2026) + peningkatan orkestra.
//
// Urutan lapisan (fallback berlapis) — dioptimasi kecepatan 6 Okt 2026:
//   L1  Ollama pribadi (gemma3) — hanya jika ready, bail cepat 4s
//   L2  Gemini 3.6 Flash (paling cepat ~1.5s) lalu 3 Flash Preview
//   L3  OpenRouter GLM 5.3 Flash — streaming SSE + retry 429
//   L4  Clouvia (glm5.3-flash / free-model)
//   L5  Workers AI — GPT-OSS 120B lalu Llama 3.3 70B
//   ~   error ramah
//
// Optimasi kecepatan:
//   - OLLAMA_FIRST_MS 10s -> 4s
//   - /api/ps timeout 5s -> 2s
//   - max_tokens 16384 -> 4096 (generate lebih cepat)
//   - memori 12 -> 6 baris
//   - Gemini dipindah ke L2 (sebelumnya L5, paling cepat di uji)

var OLLAMA_MODEL = 'gemma3:latest';
var OLLAMA_TIMEOUT_MS = 45e3; // turun dari 75s
var OLLAMA_FIRST_MS = 4e3; // turun dari 10s — bail cepat jika Ollama cold
var FALLBACK_AI = 'https://clincoo-be2.pages.dev/api/ai'; // butuh login; hanya info di /health
var OPENROUTER_MODEL = 'z-ai/glm-5.3-flash';
var CLOUVIA_MODELS = ['glm5.3-flash', 'free-model'];
var WORKERS_AI_MODELS = ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
var GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];
