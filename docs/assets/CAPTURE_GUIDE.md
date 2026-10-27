# TraceForge `docs/assets` — screenshot capture guide

The four workbench screenshots referenced by `README.md` §B are captured
from the running app and saved here as PNG files:

- `workbench-desktop-step1.png` — main laboratory interface & circuit
  selection (desktop, Step 1).
- `workbench-active-probing.png` — active progressive PCB probing with
  virtual measurements (desktop, Step 2).
- `workbench-completed-diagnosis.png` — completed diagnosis with
  ground-truth evaluation and rework guidance (desktop, Step 3).
- `workbench-mobile.png` — mobile responsive layout (390×844 viewport).

## How to capture

1. Run `npm run dev` and open the workbench (default
   `http://localhost:5173`).
2. Desktop shots: 1440×900 viewport, zero-cost simulated mode (no
   `META_API_KEY`), `f405-flight-controller` selected.
3. Mobile shot: 390×844 viewport with device emulation enabled.
4. Save each capture under the exact filename above; keep the UI in its
   default theme with no personal or secret data visible.
