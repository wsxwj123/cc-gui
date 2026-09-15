# Design-time check result — 2026-09-10 (guard rework complete)

- Full-suite guard re-audit (main session): beyond the previously recorded FB-T36, three more tests used handles not locked by INTERFACE.md — FB-T24 (`.xterm-rows`), FB-T31/FB-T32 (`data-role`, `data-message-kind`, `aria-label="你"`).
- Rework: old `terminal-ui.spec.mjs` archived to `.devflow/archive/first-batch-guard-20260910/`; violating test blocks removed from `media-ui.spec.mjs` and `notifications-ui.spec.mjs`.
- A new independent test-design agent (no access to prior specs, PLAN, research, or product source) redesigned FB-T36, FB-T24, FB-T31, FB-T32 from `BRIEF.md` + `INTERFACE.md` only, writing `terminal-ui.spec.mjs`, `code-run-ui.spec.mjs`, `notification-origin.spec.mjs`.
- Main-session guard re-check of all 9 spec files: only contract-locked handles (roles/names, contract-listed copy, locked `data-message-id`, standard HTML/ARIA semantics, browser platform APIs) remain. PASS.
- `node --check`: 11/11 authored `.mjs` files passed. Playwright `--list`: exit 0; 38 tests in 9 spec files.
- No server, model, product test, Windows/Tauri test, or six-hour test was run. No product behavior is marked passed; all 38 items remain NOT_VERIFIED.
- FB-T38 validates only operator-supplied evidence fields; it does not verify that a binary was built from a particular commit.
- Declared design assumptions (manual/platform verification listed in spec headers):
  - FB-T36 assumes the terminal panel gains keyboard focus on open and terminal text is DOM-rendered.
  - FB-T24 assumes the confirm button matches `/^(确认|确定|运行)$/` and the run button is inside the code block.
  - FB-T31/T32: the contract does not pin the presentation form of confirmed notifications; the design asserts the raw marker stays visible and does not land inside a user/merged bubble ("存在才收紧" strategy).
