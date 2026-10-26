# TraceForge — Phase 1

Multimodal Hardware Diagnostic & PCB Semantic Reverse-Engineering Engine
(Meta Global AI Developer Hackathon 2026, Indie Track · Push the Frontier).

## Stack

Vite + React + TypeScript · clean CSS workbench theme · Vitest.

## Run

```sh
npm install
npm run dev      # workbench at http://localhost:5173
npm test         # unit suite (simulated fixture mode, no keys needed)
npm run build    # production bundle
npm run preview  # serve the bundle
```

## Modes

Without `META_API_KEY` the Meta client runs in **Simulated** mode on
pre-recorded high-fidelity traces. Set `META_API_KEY` (and toggle to Live in
the header) to hit the Meta Model API (`muse-spark-1.3` / `sam-3.1`).

## Layout

- `src/lib/meta-client.ts` — Meta Model API client, tool schemas, datasheet assembly, fixtures
- `src/lib/electrical.ts` — Ohm's law, continuity, rail validation
- `src/lib/diagnostic-parser.ts` — structured output validation + stream parsing
- `src/data/samples.ts` — 3 reference boards (F405, ESP32-S3, USB-C PD)
- `src/components/` — header, PCB canvas, workbench panels
- `tests/` — Vitest suite
