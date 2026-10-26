# Muse Code (`muse-spark-1.3`) Capability & Autonomy Benchmark Report

**Date:** 2026-10-26  
**Coordinator & Independent Auditor:** Antigravity  
**Evaluated Agent:** Muse Code CLI `1.4.13 (1.4.13-R6996.1)` running `muse-spark-1.3`  
**Isolated Benchmark Workspace:** `/Users/danny/agent-test/muse-autonomy-benchmark`  
**Benchmark Application:** **TaskFlow** — Local Project & Task Management Web Application (TypeScript + React + Vite + Vitest)

---

## 1. Executive Summary

To establish an empirical, evidence-backed governance contract in [`AGENTS.md`](file:///Users/danny/Desktop/muse%20hackathon/AGENTS.md), we conducted a 5-stage end-to-end software engineering benchmark of **Muse Code (`muse-spark-1.3`)** in a completely isolated disposable workspace (`/Users/danny/agent-test/muse-autonomy-benchmark`), alongside our production **TraceForge Phase 1.5 & Milestones B–E** runs.

### Key Empirical Findings
- **20 / 20 Core Software Engineering Capabilities Verified as `Independent Success`:** Across two non-interactive prompts (`Stage A` and `Stages B–E`), Muse Code autonomously executed **101 / 101 tool operations with 0 unrecovered failures** (`37/37` in Stage A; `64/64` across Stages B–E), creating nested directories, initializing Git, installing 63 npm packages, writing strict TypeScript + React + Vite code, refactoring modules across directories with `git mv`, injecting and recovering from a regression test failure, and managing multi-branch Git workflows (`main`, `feat/stage-b-enhancements`, `refactor/stage-c-modularize`, `fix/stage-d-recovery`).
- **Zero Antigravity Code Interventions Required:** Antigravity wrote **0 lines** of application or test code in both the TaskFlow benchmark (39/39 tests passing) and TraceForge Phase 1.5 / Milestones B–E (130/130 tests passing).
- **Where Supervision & Verification Remain Mandatory:**
  1. **Headless Browser / Visual Layout Rendering:** Muse Code runs in a headless CLI environment without an attached Chromium GUI inspector; it explicitly and honestly reported: *"Browser behavior is unverified — no Chromium runner here to check rendering."* Antigravity must retain visual/browser verification and independent QA.
  2. **Promotional Credit & Billing Telemetry:** `muse usage --json` reports `{"schemaVersion":1,"allowance":null,"reason":"no_allowance","hint":null}` for browser-authenticated sessions, meaning the CLI does not expose a live dollar balance query. Antigravity must track session counts, model call counts, and token estimates conservatively against the owner's $100.00 promotional credit budget.

---

## 2. Native Muse Code CLI (`1.4.13`) Architecture & Capability Audit

Inspected safely via `muse --help`, `muse exec --help`, `muse init --dry-run`, `muse model-profile show muse-spark-1.3`, `muse export --help`, and `muse trace inspect --help`:

| CLI Dimension | Verified Behavior in `Muse Code 1.4.13 (1.4.13-R6996.1)` |
| :--- | :--- |
| **Execution Modes** | Interactive TUI (`muse [PROMPT]`), headless non-interactive single-run (`muse exec [OPTIONS] [PROMPT]` or `--prompt-file <PATH>`), session continuation (`muse resume --last` or `<session-uuid>`), and stdio MSP server (`muse serve`). |
| **Model & Reasoning Resolution** | `--model muse-spark-1.3` resolves to `base_instructions_variant: full`, `default_reasoning_effort: high`. Supports `--reasoning-effort none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra`. |
| **Workspace & Sandbox Controls** | `--workspace <PATH>` roots policy-gated workspace tools at `<PATH>`. OS sandbox and approval are ON by default; `--yolo` (or `--trust-workspace --disable-approval --disable-sandbox`) enables autonomous headless execution within the target workspace. |
| **Filesystem & Shell Tools** | Native workspace file creation, surgical patching, directory creation, and managed platform shell execution (`npm`, `git`, `tsc`, `vitest`). Can be selectively restricted with `--disable-write` or `--disable-shell`. |
| **Git Worktree & Branching** | Supports direct Git commands via shell tool as well as session-level `--worktree <off\|create\|existing>` and `--subagent-worktree-isolation`. |
| **`AGENTS.md` Discovery** | Confirmed via `muse init --dry-run`: *"Muse Code reads this file as project rules when it runs in this directory."* Automatically loads root `AGENTS.md` when `--trust-workspace` or `--yolo` is active. |
| **Auditability & Session Export** | `muse export --last --out <file> --redacted` exports a complete `export_schema_version: 1` JSON trajectory containing every step, model call index, tool batch start/terminal outcome, and session uptime (`uptime_ms`). |

---

## 3. 20-Capability Empirical Evaluation Matrix

| # | Capability | Benchmark Test Performed | Classification | Observable Evidence |
| :-: | :--- | :--- | :--- | :--- |
| 1 | **Create directories** | Build nested folders (`src/components/cards/`, `src/domain/`, `src/storage/`, `src/styles/`, `tests/`, `docs/`) | **Independent Success** | All 6 nested directories created cleanly in `/Users/danny/agent-test/muse-autonomy-benchmark`. |
| 2 | **Create files** | Generate source, test, config, and documentation files | **Independent Success** | 17 files created in Stage A (`4211544`) + `src/storage/task-storage.ts` in Stage C (`d14c196`). |
| 3 | **Edit existing files** | Add due dates, sorting, completed filter, and JSON import/export in Stage B | **Independent Success** | Modified `task-manager.ts`, `App.tsx`, `TaskFilterBar.tsx`, `TaskCard.tsx`, and `task-manager.test.ts` (`5fc7351`) with 0 regressions (23 → 38 tests passing). |
| 4 | **Rename and move files** | Move `src/components/TaskCard.tsx` → `src/components/cards/TaskItemCard.tsx` | **Independent Success** | Executed `git mv` in Stage C (`d14c196`), preserving Git rename history and updating all imports. |
| 5 | **Delete files safely** | Create and remove `src/components/LegacyPlaceholder.tsx` and `UNCOMMITTED_CHECK.tmp` | **Independent Success** | Both obsolete/temporary files created, verified unreferenced, and safely removed prior to commit. |
| 6 | **Install dependencies** | Install `react`, `react-dom`, `typescript`, `vite`, `vitest`, `@vitejs/plugin-react` | **Independent Success** | Ran `npm install`, generating `package-lock.json` (2,195 lines) and installing packages cleanly. |
| 7 | **Modify `package.json`** | Configure `"dev"`, `"build"`, `"test"`, and `"preview"` scripts | **Independent Success** | `package.json` authored and verified via `npm test` and `npm run build`. |
| 8 | **Configure TypeScript** | Generate strict `tsconfig.json` and validate with `tsc --noEmit` | **Independent Success** | `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true` validated with 0 errors. |
| 9 | **Execute shell commands** | Run `npm install`, `npm test`, `npm run build`, and `git` commands | **Independent Success** | 101/101 tool batch executions completed across both benchmark runs. |
| 10 | **Run tests** | Execute `vitest run` and report exact counts | **Independent Success** | 23/23 in Stage A → 38/38 in Stages B & C → 39/39 in Stages D & E. |
| 11 | **Debug failures** | Diagnose deliberate priority-weight inversion in Stage D | **Independent Success** | Observed 2 failing priority sort tests in `f658398`, diagnosed inverted `PRIORITY_WEIGHTS`, repaired in `321347c`, and added pairwise regression test. |
| 12 | **Git initialization** | Initialize isolated repository with `main` branch and `.gitignore` | **Independent Success** | Initialized repo in `/Users/danny/agent-test/muse-autonomy-benchmark` (`4211544`). |
| 13 | **Git branching** | Create and switch across 3 feature/refactor/fix branches | **Independent Success** | Created `feat/stage-b-enhancements`, `refactor/stage-c-modularize`, and `fix/stage-d-recovery`. |
| 14 | **Git commits** | Stage files explicitly and create clean conventional commits | **Independent Success** | 5 clean, atomic commits (`4211544`, `5fc7351`, `d14c196`, `f658398`, `321347c`), zero build artifacts committed. |
| 15 | **Git merges** | Merge `fix/stage-d-recovery` back into `main` locally | **Independent Success** | Fast-forward merged into `main` in Stage E without remote operations. |
| 16 | **Documentation** | Author and update `README.md` and `docs/ARCHITECTURE.md` | **Independent Success** | Created in Stage A and updated in Stage C to reflect new module paths. |
| 17 | **Environment variables** | Create `.env.example` (`VITE_APP_TITLE=TaskFlow Workbench`) & `.gitignore` | **Independent Success** | `.env` and `.env.*` ignored while `.env.example` tracked safely. |
| 18 | **Error recovery** | Self-recover during implementation without Antigravity code edits | **Independent Success** | Recovered from Stage D regression and caught a differential reference-node bug during TraceForge Phase 1.5 testing on its own. |
| 19 | **Multi-step execution** | Complete Stages B, C, D, and E from a single multi-stage prompt | **Independent Success** | Executed all 4 stages sequentially in 231.4s (`01a17a0b-8c1e-7f73-9e2a-ab1697bc14aa`) with 0 human/coordinator interventions. |
| 20 | **Self-verification** | Run tests, typecheck, production build, and `git status` before finishing | **Independent Success** | Every stage concluded with `vitest run`, `tsc --noEmit && vite build`, and `git status` verification. |

---

## 4. Quantitative Stage-by-Stage Telemetry Summary

Metrics extracted directly from exported session trajectories (`muse export --last --redacted`):

| Run / Stage | Session ID | Prompts | Model Calls | Tool Batches (Succeeded / Failed) | Files Created / Modified / Moved / Deleted | Tests Passed / Failed | Build Outcome | Elapsed Time | Manual Antigravity Interventions |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **TaskFlow Stage A** (Initial Build + Git Init) | `01a179fc-6f1e-73f2-824f-6184f60d7ed3` | 1 | 5 | **37 / 0** | 17 created, 0 mod, 0 moved, 1 deleted (`LegacyPlaceholder.tsx`) | **23 / 0** | **PASS** (`154.13 kB` bundle) | `128.7 s` (`128,677 ms`) | **0** |
| **TaskFlow Stages B–E** (Features, Refactor, Bug Fix, Merge) | `01a17a0b-8c1e-7f73-9e2a-ab1697bc14aa` | 1 | 4 | **64 / 0** | 1 created (`task-storage.ts`), 6 mod, 1 moved (`TaskCard` → `TaskItemCard`), 1 deleted (`UNCOMMITTED_CHECK.tmp`) | **39 / 0** (after 2 deliberate fails in Stage D) | **PASS** (`159.23 kB` bundle) | `231.4 s` (`231,379 ms`) | **0** |
| **TraceForge Phase 1.5** (Milestone A: MNA Lab & Proxy) | `task-50` | 1 | 5 | **All succeeded (0 failed)** | 3 created, 6 modified | **105 / 0** | **PASS** (`214.08 kB` bundle) | `~488.0 s` | **0** |
| **TraceForge Milestones B–E** (Agentic Loop & Budget Ledger) | `01a17a02-006c-7b71-8ef3-aadeb935c174` | 1 | 4 | **61 / 0** | 2 created (`diagnostic-agent.ts`, `agentic-diagnosis.test.ts`), 4 modified | **130 / 0** | **PASS** (`236.61 kB` bundle) | `544.2 s` (`544,207 ms`) | **0** |

---

## 5. Independent Antigravity Verification of TaskFlow Benchmark

Antigravity independently verified `/Users/danny/agent-test/muse-autonomy-benchmark` after completion:
1. **Git History & Branch Topology (`git log --graph --oneline --all`):**
   - `4211544` — `feat: initial TaskFlow React+TS application and test suite` (`main` initial)
   - `5fc7351` — `feat(stage-b): add due dates, priority sorting, completed filter, and JSON import/export` (`feat/stage-b-enhancements`)
   - `d14c196` — `refactor(stage-c): extract storage module and move TaskItemCard component` (`refactor/stage-c-modularize`)
   - `f658398` — `test(stage-d): inject priority sort regression for recovery benchmark`
   - `321347c` — `fix(stage-d): repair priority sort order and add regression test` (`HEAD -> main, fix/stage-d-recovery`)
2. **Test Suite (`npm test`):** **39 / 39 passing** (`vitest run` in 203 ms).
3. **Production Build (`npm run build`):** **PASSED** (`tsc --noEmit && vite build` in 242 ms).
4. **Secret & Isolation Check:** Zero secrets, zero external API calls, and zero touches outside `/Users/danny/agent-test/muse-autonomy-benchmark`.
