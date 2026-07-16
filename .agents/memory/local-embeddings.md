---
name: Local embeddings via transformers.js
description: Replit AI proxies have no embeddings endpoint; how this project does semantic search
---

Rule: the Replit OpenAI and Gemini AI-integration proxies do NOT support `/embeddings`. For semantic search, compute embeddings locally with `@huggingface/transformers` (Xenova/all-MiniLM-L6-v2, 384-dim, `pooling:"mean", normalize:true`, dtype "q8") and store in pgvector `vector(384)`.

**Why:** proxy returns `400 Endpoint 'POST /embeddings' is not supported`; local also fits the product's privacy/local-first goal.

**How to apply:** any new embedding use must go through the local embedder (see api-server ai-enrichment). `@huggingface/transformers` must be listed in esbuild `external` in api-server build.mjs or the bundle fails on `onnxruntime-node`.

Also: media library taxonomy stores photos as media_type `"photo"`, while LLM intent vocab and UI often say `"image"` — normalize in both directions (backend WHERE clause expansion, frontend isVisualMediaType) or photos silently drop out of filters/thumbnails.
