---
trigger: always_on
---

# Engineering Code Preferences, Error Handling & Dependencies

This document details the engineering preferences for authoring, refactoring, and maintaining application code in this repository.

---

## 1. Code Style & Architecture

### Stack & Conventions
- **Stack & Ecosystem:** Respect the established project structure and active runtime/package manager. Choose the most pragmatic, best-suited technology stack and language for the specific problem without dogmatic restrictions.
- **Language:** Comments and docstrings in English only.
- **Paradigm:** Prefer functional programming over Object-Oriented Programming.
  - Use OOP classes strictly for external system connectors, client adapters, or stateful hardware interfaces.
  - Core domain logic must be written as pure functions: modify return values only; never mutate input parameters or external global state.
- **Philosophy:** DRY, KISS, YAGNI. Prefer simple, native, well-supported APIs over bespoke micro-frameworks. Avoid premature abstraction.

### Function & Interface Design
- **Single-Purpose Functions:** Each function must perform exactly one conceptual operation.
  - No multi-mode behavior.
  - No boolean flag parameters that branch internal execution into completely separate workflows.
- **Explicit Parameters:** Never use default parameter values. All parameters must be explicitly declared and passed.
- **Deduplication:** Always check whether helper logic already exists in the repository before authoring a new function.

### Strict Typing & Runtime Validation
- Apply strict static types to function return values, local variables, collections, and complex domain entities.
- Avoid weak or escape-hatch types (`any`, `unknown`, loose dictionaries/hashes).
- **Runtime Validation:** Validate all external and boundary data (API request bodies, query parameters, external service payloads, environment configs) at runtime (e.g., via Zod or TypeBox schemas).
  - Explicitly require needed fields; strip or ignore unvalidated extra fields.

---

## 2. Error Handling & Observability

### Explicit Failure (No Silent Recovery)
- **Raise Errors Explicitly:** Never swallow or silently ignore errors.
- **Specific Error Classes:** Use or define specific error classes that describe precisely what failed (e.g., `NotFoundError`, `ConflictError`, `ValidationError`).
- **No Catch-All Swallowing:** Avoid broad `try/catch` blocks that catch all exceptions and mask root causes.
- **No Symptom-Masking Guards:** Do not add silent fallback values or defensive guards that hide invalid state or upstream contract breaks. Code must either succeed deterministically or fail loudly.

### External Services & Retries
- When calling external APIs or network services: retry transient network errors with structured warnings, then rethrow the final error if retries are exhausted.

### Diagnostic Error Messages & Structured Logging
- Error messages must be actionable and informative: explain what failed, why it failed, relevant request identifiers, and HTTP status codes. Avoid generic `"Something went wrong"`.
- **Structured Logging:** Pass dynamic values as structured metadata properties on logger calls (e.g., `logger.error({ districtId, err }, "Failed to fetch mahalla")`), rather than interpolating strings.

---

## 3. Dependency Management & Library Adoption

### Selection Criteria
- Prefer battle-tested, standard, and officially maintained packages or services over custom-written solutions.
- Before introducing any new dependency, verify whether an existing installed library already provides the capability.
- **Pragmatic Tool Selection:** Evaluate tools, managed services, and libraries objectively based on execution speed, reliability, cost, and maintainability. Choose the most optimal option for the scenario—whether managed vendor service or open-source—without dogmatic bias.

### Installation & Inspection Hygiene
- Install dependencies in the local project environment, never globally.
- Persist dependency additions directly into project configuration and lockfiles.
- Verify package health, maintenance activity, security posture, and compatibility before adoption.
- When working with installed packages whose documentation is unclear, read the installed type declaration files or source code in the project environment rather than guessing behavior.
