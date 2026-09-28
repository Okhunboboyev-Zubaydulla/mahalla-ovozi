# Mahalla Ovozi

Mahalla Ovozi provides cautious, evidence-backed situational awareness for District Hokims by synthesizing public signals from authorized Telegram groups into structured daily topics. It reduces manual message reading while leaving every real-world decision and response entirely to human leadership.

## Boundaries

Mahalla Ovozi is **not**:
- A citizen complaint portal, petition system, or public CRM. Citizens are evidence sources, not application users.
- A case-management or ticketing system (e.g., Jira/Zendesk). It does not track issue resolution or assign tasks to municipal departments.
- An automated decision-maker or verified truth engine. AI outputs are cautious summaries of unverified public discussions.

## Language

**District**:
One isolated customer deployment for one Hokim (labeled *Tuman* in the product UI), encapsulating its own Telegram bots, authorized groups, mahallas, topics, audit records, and subscription state.
_Avoid_: Tenant, workspace, organization, account, city.

**Mahalla**:
A recognized neighborhood community within a District (labeled *Mahalla* in the product UI). Authorized Telegram groups are mapped directly to their corresponding Mahalla.
_Avoid_: Neighborhood, borough, zone, precinct.

**Hokim**:
The executive head of the District administration (labeled *Hokim* in the product UI). The Hokim is the primary reader of the daily dashboard signals and holds zero administrative privileges over the application.
_Avoid_: Mayor, governor, admin, client, user, operator.

**Product Owner**:
The sole technical and commercial operator of the multi-district platform (labeled *Mahsulot egasi* in the product UI) who manages District deployments, bot credentials, subscriptions, and system health via the private Console.
_Avoid_: Superadmin, developer, staff, system administrator.

**Accepted Evidence**:
A raw Telegram message (labeled *Qabul qilingan dalil* in the product UI) that passed automated noise filtering, structural sanity checks, and semantic relevance analysis, preserved verbatim to substantiate a Topic.
_Avoid_: Message, chat, complaint, ticket, citizen report, grievance, incident.

**Topic**:
One same-day situation synthesized from related Accepted Evidence within a single District (labeled *Mavzu* in the product UI). A Topic is strictly bound to a single calendar day (00:00:00 to 23:59:59 `Asia/Tashkent`) and never rolls over across days.
_Avoid_: Issue, ticket, thread, incident, story, task, case, multi-day problem.

**Lane**:
One of the five executive dashboard signal groupings (labeled *Yo‘nalish* in the product UI): Water (`Suv`), Electricity (`Elektr`), Gas (`Gaz`), Waste (`Chiqindi`), or Hokim-related (`Hokimiyatga oid`). A single Topic may project into multiple relevant Lanes.
_Avoid_: Category, bucket, tag, column, board, department.

**Signal**:
An indicative pattern or public report of a community condition derived from Telegram evidence.
_Avoid_: Complaint, emergency, verified fact, petition, grievance.

**Audit Record**:
An append-only, immutable record capturing administrative, lifecycle, or security events (labeled *Audit yozuvi* in the product UI) without ever storing raw resident evidence or secrets.
_Avoid_: Activity log, event stream, access log.

## Technical Invariants & Constraints

- **Monorepo Structure:** Managed with `pnpm 10.x` workspaces and strict TypeScript 5.x ESM. Package manifests (`package.json`) and `pnpm-lock.yaml` own exact dependency versions.
- **Backend Architecture:** Fastify 5.x API and pg-boss worker run from the same codebase image; modular monolith structure under `apps/backend/src/modules/` with ports and adapters under `adapters/`.
- **Frontend Architecture:** React 19.x SPA bundled with Vite 6.x and routed via `react-router-dom` v7. Ant Design 5.x is the primary UI system using design tokens; TanStack Query 5.x owns server state.
- **Contracts:** `@mahalla-ovozi/api-contracts` houses browser-safe Zod request/response schemas. Database rows and provider SDK objects never cross the API boundary.
- **Time & Calendar:** Timestamps are stored as PostgreSQL `timestamptz` in UTC. Product calendar days and user-facing time calculations are derived strictly in `Asia/Tashkent`.
- **Testing Isolation:** All automated tests interacting with PostgreSQL or queues must run strictly against an isolated test database (`mahalla_ovozi_test`), never the development database (`mahalla_ovozi`).
- **Deployment & Infrastructure:** Single-host Docker Compose deployment on a domestic Linux VPS via Airnet.uz (Ubuntu 24.04 LTS, BKM data center, Tashkent), ensuring low-latency TAS-IX / UZ-IX connectivity and compliance with national data sovereignty standards.
