# grepai - Semantic Code Search & Call Graph Reference

`grepai` is the primary tool for semantic exploration and call graph tracing in this codebase. Use it whenever you need to understand *what* code does, find implementations by intent, or trace symbols before refactoring.

---

## When to Use grepai vs Standard Grep / Glob

| Task | Primary Tool | Rationale |
| :--- | :--- | :--- |
| Understanding functionality, intent, or domain logic | `grepai search` | Semantic matching across codebase embeddings |
| Tracing callers, callees, or call graphs before edits | `grepai trace` | AST-aware symbol tracing across modules |
| Exact string matching (imports, variable names, configs) | `grep_search` / ripgrep | Fast exact literal search |
| File path patterns (e.g., `**/*.ts`, `*.sql`) | `find_by_name` / fd | Direct filesystem pattern traversal |

---

## Usage & CLI Flags

> [!IMPORTANT]
> Always pass `--json` for structured AI consumption and `--compact` on searches to save ~80% context tokens.

### 1. Semantic Search
```bash
# ALWAYS use English queries for optimal semantic matching (--compact saves ~80% tokens)
grepai search "user authentication flow" --json --compact
grepai search "error handling middleware" --json --compact
grepai search "database connection pool" --json --compact
grepai search "API request validation" --json --compact
```

#### Query Tips
- **Use English for queries:** Semantic embedding models are trained predominantly on English documentation and comments.
- **Describe intent, not implementation:** Use `"handles user login"` rather than `"func Login"`.
- **Be specific:** `"JWT token validation"` is far more effective than `"token"`.
- **Results schema:** Each result includes file path, line numbers, relevance score, and code preview snippet.

---

## 2. Call Graph Tracing
Use `grepai trace` to understand symbol relationships before modifying any function, type, or module.

```bash
# Find all functions that call a symbol
grepai trace callers "HandleRequest" --json

# Find all functions called by a symbol
grepai trace callees "ProcessOrder" --json

# Build complete call graph (callers + callees) up to N levels deep
grepai trace graph "ValidateToken" --depth 3 --json
```

### Standard Workflow
1. Start with `grepai search` to find where relevant functionality lives.
2. Use `grepai trace` to map caller and callee dependencies.
3. Read specific files with `view_file` using line numbers provided by grepai.
4. Use standard ripgrep/grep only for exact string or literal identifier verification.

---

## 3. Troubleshooting & Fallback
If a `grepai` MCP call fails with `"no workspaces configured"` or a workspace-scoped error:
1. Retry without the workspace parameter.
2. Check the local `.grepai/` index and status (`grepai status` or local index check).
3. Only fall back to standard `grep_search` / `find_by_name` if both workspace-scoped and local `grepai` attempts fail.
