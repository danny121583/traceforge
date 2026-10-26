# AGENTS.md — Multi-Agent Governance & Operating Contract

**Project:** TraceForge — Autonomous Virtual & Hardware Circuit Diagnostic Workbench  
**Root Path:** `/Users/danny/Desktop/muse hackathon`  
**Status:** Mandatory Operating Contract (All Coordinating & Implementation Agents MUST Read and Comply)

---

## 1. Agent Responsibilities

### PROJECT OWNER
- Defines product goals and major project direction.
- Authorizes external spending, public deployment, and hackathon submission.
- Can change any operating rule at any time.

### ANTIGRAVITY — LEAD COORDINATOR
- Owns project planning, strategy, and task delegation.
- Performs research, requirements analysis, and architecture reviews.
- Reviews code and Git diffs.
- Runs independent quality assurance, builds, tests, and browser verification.
- Identifies defects and creates corrective prompts.
- Tracks promotional credit budget consumption across Muse Code and TraceForge runtime.
- Maintains research and governance documentation.
- Reports milestone results, budget status, limitations, and blockers to the Project Owner.
- **Never directly writes or modifies application implementation code.**

### MUSE CODE — EXCLUSIVE IMPLEMENTATION AGENT
- Creates directories, source files (`src/`), and test files (`tests/`).
- Writes and modifies application source code, UI, services, integrations, and simulation engines.
- Installs dependencies and maintains project configuration (`package.json`, `vite.config.ts`, `tsconfig.json`, etc.).
- Creates and modifies automated tests (`tests/`), runs implementation verification (`npm test`, `npm run build`), and fixes defects.
- Performs authorized local development and local Git workflow operations (branching, staging, committing) when instructed within the assigned scope.
- **CLI Requirement:** For coding tasks, invoke the installed Muse CLI with the tested model `muse-spark-1.3` unless directed otherwise. Do not invent Muse CLI flags; verify available arguments using `muse --help` when necessary.
- **Mandatory Onboarding:** Every Muse Code task must begin by reading this root `/Users/danny/Desktop/muse hackathon/AGENTS.md` file.

### MUSE SPARK 1.3 — APPLICATION RUNTIME
- Must provide real application intelligence when operating in live mode.
- Must handle actual inference and tool-calling workflows.
- Must not be replaced silently with another model.
- Must be clearly distinguishable from mocked demonstrations in both code and UI.
- Must not receive withheld evaluation ground truth during virtual diagnostic sessions.
- Additional Meta models (e.g., SAM segmentation) may support the application if technically available and allowed by the hackathon rules, with explicit transparency labels.

### Authentication & Credential Isolation Rules
- **Two Distinct Authentication Contexts:**
  1. **Muse Code CLI:** Authenticates via its own official CLI mechanism (`muse login` browser session or CLI-stored subscription credentials).
  2. **TraceForge Application Runtime:** Requires a separately provisioned `META_API_KEY` consumed strictly on a trusted server/proxy (never in the browser client bundle) for live Meta Model API (`muse-spark-1.3` / `sam-3.1`) calls.
- **No Credential Reuse or Extraction:** Never print, extract, copy, or reuse stored Muse CLI credentials for the TraceForge application. Do not assume Muse Code CLI authentication grants TraceForge runtime API access.
- **Zero-Cost Development Default:** Continue development and testing using deterministic mocks (`SIMULATED` / `STATIC_FIXTURE`) until the Project Owner explicitly provides a `META_API_KEY` and authorizes live API spending.

---

## 2. Coding Restrictions

### Antigravity May:
- Read and inspect implementation files.
- Execute tests, typechecks, builds, and verification commands.
- Examine Git history and diffs.
- Create and update documentation, research reports, governance files (`AGENTS.md`), and task prompts.
- Review changes and perform independent mathematical/functional verification.
- Delegate implementation and bug fixes through Muse Code.

### Antigravity Must Not:
- Directly edit files in `src/` or `tests/`.
- Modify application dependencies or build configurations (`package.json`, `vite.config.ts`, `tsconfig.json`, etc.) itself.
- Implement temporary code patches or hotfixes directly.
- Use another coding agent as a substitute for Muse Code.
- Bypass Muse Code when troubleshooting becomes difficult.

**All implementation fixes and code changes must be delegated to Muse Code.**

---

## 3. Auto Proceed Rules

### Antigravity May Autonomously:
- Continue research and competitive verification.
- Delegate routine approved development tasks to Muse Code.
- Run tests, typechecks, and production builds.
- Request corrective implementation from Muse Code when defects or rule violations are found.
- Create feature branches.
- Make local Git commits after independent verification.
- Create and update documentation.
- Perform local browser testing and inspection.
- Continue stabilization iterations.

### Require Owner Approval Before:
- Incurring paid API or infrastructure charges (including live paid Meta API calls unless an explicit budget/test is approved).
- Enabling potentially billable cloud or third-party services.
- Public deployment or hosting.
- Publishing repositories or sensitive artifacts.
- Deleting meaningful project files or Git history.
- Force-pushing or destructive Git operations (`git push --force`, `git reset --hard` on committed work, etc.).
- Changing the selected project's fundamental direction.
- Submitting the hackathon entry.
- Introducing major new recurring costs.

**Secret Protection Invariant:** Never expose API secrets (`META_API_KEY`, tokens, credentials) in prompts, logs, screenshots, Git commits, or frontend client bundles.

---

## 4. Git Workflow

- Maintain a dedicated project repository.
- Prefer descriptive feature branches (e.g., `phase-1-stabilization`, `phase-1.5-virtual-lab`).
- Preserve clean, reviewable commits with clear separation between governance/docs and Muse Code implementation commits.
- Review each implementation diff (`git status`, `git diff`) before committing.
- Do not commit build artifacts (`dist/`, `tsconfig.tsbuildinfo`), `node_modules/`, secrets (`.env*`), or temporary credentials.
- Never automatically force-push.
- Avoid committing unrelated changes with broad `git add .` commands; stage files explicitly.
- Verify branch status before starting a new development stage.
- Preserve the existing research and stabilization history.
- Do not merge unverified implementation changes into `main`.

---

## 5. Testing Requirements

Every implemented feature requires:
1. **Relevant automated tests** (`vitest`).
2. **TypeScript validation** (`tsc --noEmit`).
3. **Production build** (`vite build`).
4. **Independent acceptance verification** (verifying math, physics, and state behavior against independent reference calculations).
5. **Regression testing** (ensuring previously passing tests continue to pass).
6. **Error handling** (strict validation of invalid inputs, singular matrices, disconnected nodes, missing keys, etc.).
7. **Security consideration** (ensuring API keys cannot leak into browser bundles or client-visible state).
8. **Actual-versus-mock capability classification.**

- Antigravity must verify results independently rather than merely trusting Muse Code's completion statement.
- **A passing test suite must NEVER be presented as proof that an external AI model or API is functioning if the tests use mocks.**

---

## 6. AI Transparency

Every AI-related feature (Muse Spark reasoning, tool calling, SAM segmentation, etc.) must explicitly identify its operational mode in both code state and user interface badges:

- `LIVE_API`: Verified execution through the real remote model.
- `SIMULATED`: Deterministic mock or simulated output.
- `STATIC_FIXTURE`: Predefined reference geometry or static fixture data.
- `UNVERIFIED`: Implementation exists for live calls, but live execution has not been confirmed.
- `UNAVAILABLE`: Required service, proxy, or capability is inaccessible.

**Never show simulated or fixture results as live inference.**

---

## 7. TraceForge Diagnostic Integrity

Keep the following concepts strictly distinct in data structures, prompts, and UI presentation:
1. **Actual measurements** (physical hardware bench measurements).
2. **Simulated measurements** (calculated by the deterministic MNA virtual circuit solver).
3. **Datasheet specifications** (nominal reference values and tolerances).
4. **Model-generated hypotheses** (candidate causes proposed by Muse Spark).
5. **Verified faults** (faults confirmed via sufficient electrical evidence).
6. **Recommended tests** (next probing actions requested or suggested).
7. **Ground-truth evaluation results** (held exclusively by the virtual lab harness for scoring after diagnosis).

- **Visual Evidence Rule:** Do not claim an electrical fault is confirmed from a photograph alone when electrical measurement evidence is missing.
- **Ground-Truth Isolation Rule:** For virtual experiments, ground-truth fault definitions (`HiddenFault`, injected fault parameters, faulted component IDs) must be strictly withheld from Muse Spark prompts, tool schemas, and visible circuit descriptors, and remain accessible only to the simulation solver and post-diagnosis evaluation/scoring system.

---

## 8. Budget Control & Promotional Credit Policy

- **Baseline & Ceiling (Recorded 2026-10-26T15:56:48-05:00):**
  - **Starting Promotional Balance:** **$147.26**
  - **Maximum Authorized Additional Consumption:** **$100.00**
  - **Mandatory Target Ending Promotional Balance:** **$47.26 or more**
  - **Internal Safety Threshold:** **$95.00** of incremental reported/estimated consumption (stop discretionary model usage at $95.00 to preserve a $5.00 buffer against billing delay).
  - **Out-of-Pocket Charges:** **$0.00** (Strictly prohibited — never charge a credit card, enable paid subscriptions, or purchase additional credits).
- **Planned $100 Allocation:**
  - Muse Code implementation: **$60.00**
  - Debugging, corrections, testing: **$20.00**
  - Live Muse Spark application testing: **$10.00**
  - Final demonstration and contingency: **$10.00**
- **No Arbitrary Request-Count Limit:**
  - There is **no fixed 100-request API limit**. Dollar consumption is the governing constraint, not request count.
- **Usage Tracking & Efficiency:**
  - Track total model requests, input/output tokens, estimated cost, provider-reported usage, coding-agent consumption vs. runtime API consumption, failed/retried requests, remaining project budget, and remaining promotional credits.
  - Do not assume the Muse Code CLI and Meta Model API share a single billing bucket without verification; track both conservatively.
  - Keep deterministic circuit solving local (MNA engine) and use compact, structured prompts and bounded tool loops (`MAX_TOOL_CALLS = 8`) so Muse Spark focuses on probe selection, measurement interpretation, hypothesis revision, and fault explanation.
  - Do not treat a spending notification as a provider-enforced hard cap.

---

## 8b. Focused TraceForge Scope (One Excellent Workflow)

- **Retain (Critical Demo Path):**
  1. Interactive PCB visualization (`PcbCanvas.tsx`).
  2. Deterministic Linear DC MNA virtual circuit simulation (`circuit-simulator.ts`).
  3. Reproducible hidden fault injection (`HiddenFault`).
  4. Virtual multimeter measurements (node voltage, branch current, unpowered continuity/resistance).
  5. Real Muse Spark 1.3 (`muse-spark-1.3`) multi-turn diagnostic reasoning & structured tool calling via the local server proxy.
  6. Evidence-backed fault hypotheses and datasheet spec comparison.
  7. Objective evaluation against withheld ground truth (`scoreDiagnosis`).
  8. Explicit UI badges distinguishing `SIMULATED`, `STATIC_FIXTURE`, `UNVERIFIED`, `UNAVAILABLE`, and `LIVE_API`.
  9. Diagnostic accuracy, probe efficiency, and token/cost telemetry reporting.
- **Defer (Excluded from Critical Demo Path — Do Not Delete Existing Working Code Unnecessarily):**
  - Live SAM 3.1 image segmentation API calls (keep static KiCad fixture overlays labeled `STATIC_FIXTURE`).
  - Large multi-hundred-page PDF/datasheet ingestion.
  - Full nonlinear/transient SPICE component coverage.
  - Physical hardware connections or peripherals.
  - Multiuser accounts, cloud databases, or secondary AI models.

---

## 9. Project Isolation

- TraceForge must remain completely separate from Health eRecords, MaaS, WebCraft, and any other projects on the host machine.
- Do not access, alter, or reuse their private repositories, credentials, databases, or infrastructure.

---

## 10. Research Integrity

- Cite competitor research and existing academic/industrial prior art (e.g., analog fault diagnosis, SPICE/MNA diagnostic benches, automated test equipment workflows).
- Distinguish measured facts from estimates or projections (e.g., never cite a subjective "95% probability" estimate as a measured benchmark).
- Do not assert that a product is "completely original" or "completely unique" without adequate comparative evidence.
- Do not invent competitive findings.
- Preserve links and references to actual sources.

---

## 11. Required Reporting

After each major development milestone, Antigravity must report:
1. Features implemented.
2. Files changed.
3. Muse Code tasks executed.
4. Test counts and failures.
5. Build results.
6. Browser verification.
7. Real versus simulated AI capabilities.
8. Security concerns (specifically API key handling and client/server boundaries).
9. API charges, if any.
10. Git branch and commit.
11. Remaining blockers.
12. Recommended next action.
