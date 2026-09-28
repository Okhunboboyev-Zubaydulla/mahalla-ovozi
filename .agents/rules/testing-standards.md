# Testing Standards, Database Isolation & Debugging

This document outlines the testing conventions, test-first development loop, database isolation guarantees, and debugging strategies for this repository.

---

## 1. Database & Environment Isolation

> [!CAUTION]
> **Strict Test Database Isolation (Non-Negotiable Invariant)**
> All automated tests (Vitest, integration tests, E2E fixtures) that touch PostgreSQL or `pg-boss` queues **MUST** execute exclusively against the isolated test database:
> ```
> Test Database: mahalla_ovozi_test
> Development Database: mahalla_ovozi (strictly for localhost:5173 and staging)
> ```
> Never point test runners at `mahalla_ovozi`, and never insert test fixtures or run teardown truncate scripts against the active development environment.

---

## 2. Testing Philosophy & Priorities

### Real Integrations over Shallow Mocks
- **Smoke & Integration Priority:** Prefer real integration and end-to-end tests over shallow unit tests that mock away databases and external services.
- **No Fake Mocks:** Avoid mocking databases, ORMs, or message brokers when a live test database container or instance is available. Test against real tables and queues.
- **Do Not Test Static Artifacts:** Do not write test cases for static text, UI labels, static configuration strings, or prompt text unless runtime application behavior directly depends on them.

### Test-First Cycle (Red-Green-Refactor)
For substantial feature behavior, architectural changes, or bug fixes:
1. **Write failing test first (Red):** Write an integration test reproducing the bug or asserting the new capability.
2. **Execute to confirm failure:** Verify the test fails specifically for the expected root cause.
3. **Implement minimal fix (Green):** Write the simplest, cleanest code to make the test pass.
4. **Refactor & harden:** Clean up duplication while ensuring all suite tests remain green.
5. **Diagnose failures cleanly:** When checks fail, diagnose whether the failure stems from the code, test expectation, environment, or pre-existing state. Never delete, weaken, or disable tests to artificially pass verification.

---

## 3. UI & Frontend Testing Boundaries

- **Selector Stability:** Use stable, semantic attributes (`data-testid`, accessibility roles `role="..."`, or test IDs) instead of brittle CSS hierarchy selectors or translatable user-visible text.
- **Browser Automation Boundary:**
  - Do **not** drive the browser for routine manual visual inspection unless browser automation is explicitly approved.
  - Browser interaction via devtools or Playwright is permitted strictly for deep troubleshooting or debugging sessions.
  - Run non-interactive automated test suites (e.g., `pnpm test`), and provide the user with clear, concise manual steps for UI visual sign-off.

---

## 4. Systematic Debugging

- **Form Multiple Hypotheses:** When diagnosing an unexpected error or failing test, formulate at least two plausible hypotheses before touching any code.
- **Validate Assumptions with Evidence:** Add targeted, temporary debug assertions or inspect logs to confirm which hypothesis matches reality.
- **No Shotgun Debugging:** Never randomly change code hoping the error goes away. Identify root cause first, then apply an elegant fix.
