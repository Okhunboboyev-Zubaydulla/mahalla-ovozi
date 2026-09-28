---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

## Where to save it

Save to a **machine-level handoff root, one folder per project**:

```
<handoff-root>/<project>/<handoff-file>.md
```

### Resolving the root

Use `$HANDOFF_ROOT` if it is set, otherwise default to `~/software-development-session-handoffs/`.

On this machine that resolves to:

```
C:/Users/Zubaydulla/software-development-session-handoffs/
```

so this project's handoffs go to:

```
C:/Users/Zubaydulla/software-development-session-handoffs/<project>/
```

The root is deliberately **tool-agnostic, harness-agnostic, and portable**:

- The `~` anchor is the same on Windows, macOS, and Linux — unlike a drive-root path such as `C:/...`, which exists only on Windows.
- It belongs to the **developer**, not to any agent, IDE, or CLI. Switching tools does not invalidate the convention.
- `$HANDOFF_ROOT` lets a specific machine or project redirect the root (another drive, a synced folder) **without editing this skill**. Only the root changes; the `<project>/` layout and the rules below stay the same.

### Never save a handoff to these two places

- **Not the OS temporary directory.** This destroyed real work: a completed handoff written to `%LOCALAPPDATA%\Temp` was silently lost when temp was cleared, taking every earlier handoff stored the same way. A reboot, a cleanup tool, or a disk-pressure sweep wipes temp without warning. A handoff is the one artifact the next session depends on, so it must outlive a temp sweep.
- **Not the workspace.** The handoff describes work that may not be committed yet, and the next session must not treat it as project content. It also pollutes `git status` for the agent that follows — exactly the noise this process exists to avoid.

### Conventions

- **Project folder:** a short stable slug matching the repo, e.g. `mahalla-ovozi`. Create it if missing. Do not nest by date, branch, or session id — one folder per project, so a later session finds every past handoff in one listing.
- **Filename:** `handoff-<project>-after-<finding-or-topic>.md`, e.g. `handoff-mahalla-ovozi-after-L3-P04-01.md`.
- **Superseding:** when a new handoff replaces an older one, name the older file in the new document's header, mark it superseded, and **leave it on disk**. Do not silently delete it — the record of what was believed earlier is part of the handoff's value.

## What to include

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
