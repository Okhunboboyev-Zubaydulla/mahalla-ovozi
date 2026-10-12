---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

- **Approval gate:** Do not edit, branch, or commit anything until the user has approved a concrete plan for this work. Reading the spec and tickets is always allowed; making changes is not. There is no size or simplicity exemption.

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

- Run typechecking and the directly affected single test files as you go. Never run a repository-wide test suite unless the user explicitly instructs it.

Once done, use /code-review to review the work.

- Committing, pushing, branching, or opening a pull request requires explicit user permission. Until it is given, leave all changes uncommitted; uncommitted work represents the user's review state.
