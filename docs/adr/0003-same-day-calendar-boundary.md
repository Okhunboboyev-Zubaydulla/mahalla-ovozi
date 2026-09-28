---
status: accepted
date: 2026-08-12
---

# Same-Day Calendar Boundary for Topics

Topics are bound strictly to a single calendar day (00:00:00 to 23:59:59 `Asia/Tashkent`). Related Telegram messages from different calendar days are never merged into the same Topic, and Topics never roll over past midnight.

## Considered Options

- **Rolling 24-Hour Windows:** Rejected because rolling timeframes make dashboard summaries unpredictable, constantly shifting as hours pass, which prevents Hokims from reviewing a fixed daily record.
- **Cross-Day Persistent Issue Tracking (Jira-style):** Rejected because Mahalla Ovozi is an executive situational briefing tool, not a municipal ticketing or workflow resolution engine.

## Consequences

- If a power outage or utility issue spans overnight, it is represented as distinct same-day Topics on each affected calendar day.
- Partitioning, database queries, and AI prompt context remain bounded to exact dates, preventing token bloat and query degradation.
- Hokims can review historical days as immutable, static records of what was reported on that specific date.
