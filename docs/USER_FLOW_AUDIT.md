# User Flow Audit (Room App)

Date: 2026-02-27  
Scope: `quoroom-ai/room` local server + dashboard (`src/server`, `src/ui`, `e2e`)

## 1) Usual User Flow (Happy Path)

This is the most typical keeper path in current code:

1. Open dashboard (`http://localhost:3700`) and complete token handshake (`GET /api/auth/handshake`).
2. Create a room (`POST /api/rooms`) from sidebar `+ New Room`.
3. Open room `Settings` and set:
   - queen model/provider (Claude/Codex/OpenAI API/Anthropic API)
   - activity controls and governance settings
4. Use `Overview` + `Clerk` to observe activity and coordinate keeper actions.
5. Create/update Workers, Tasks, Goals, and Skills.
6. Track Decisions/Votes and Messages (escalations + room messages).
7. Monitor Transactions (wallet + billing) and Stations.
8. Review task run history and self-mod audit data, then pause/restart/archive room as needed.

## 1.1) New Guided Setup Flow (Current UX)

After creating a room:

1. User is routed to Room Settings automatically.
2. A setup popup appears once for that newly created room.
3. Popup guides keeper through:
- choose setup path (Claude sub / Codex sub / OpenAI API / Anthropic API)
- review required prerequisites and likely outcome
- apply selected model path directly
4. Keeper can reopen the same setup popup later via Room Settings -> Queen -> "Setup guide".

Why this matters:
- Reduces misconfiguration when users have no subscription or missing API keys.
- Prioritizes subscription-based setup when already connected.

## 1.2) Room Setup Variants (Most Important)

When configuring a new room, model/provider choice changes reliability, cost, and required keeper actions:

1. Claude subscription path (`model=claude` or other Claude subscription variants)
- Keeper action:
  - Ensure Claude CLI is installed.
  - Connect via Room Settings -> Queen -> Status -> Connect.
- Outcome:
  - Usually best quality + lowest setup friction when subscription exists.
  - No API key maintenance in room credentials.

2. Codex subscription path (`model=codex`)
- Keeper action:
  - Ensure Codex CLI is installed.
  - Connect via Room Settings -> Queen -> Status -> Connect.
- Outcome:
  - Strong coding behavior, simple auth flow for ChatGPT/Codex subscribers.

3. OpenAI API path (`model=openai:gpt-4o-mini`)
- Keeper action:
  - Add/validate `openai_api_key` in room credentials.
- Outcome:
  - Key-based billing control, deterministic API ownership.
  - Fails closed if key missing/invalid.

4. Anthropic API path (`model=anthropic:claude-3-5-sonnet-latest`)
- Keeper action:
  - Add/validate `anthropic_api_key` in room credentials.
- Outcome:
  - Key-based Anthropic workflow, explicit credential management.

Important:
- If subscription is detected in runtime (Claude or Codex connected), that path should be recommended first.
- If no subscription is detected, explicitly guide user toward API-key path.

## 2) Full User Flow Catalog (Functional)

## A. Entry + Auth
- Local mode SPA load + static assets + PWA files (`index.html`, `manifest.webmanifest`, `sw.js`).
- Local token handshake and verify (`/api/auth/handshake`, `/api/auth/verify`).
- Remote-origin gate behavior (`ConnectPage` + localhost probing).
- Cloud mode auth path (JWT/member roles via `validateCloudJwt`).

## B. Room Lifecycle
- Create room.
- List rooms and select active room.
- Update room metadata (name, goal, visibility, activity controls).
- Pause/restart room.
- Queen start/stop.
- Archive/delete room.

## C. Execution Flows
- Worker CRUD and default worker selection.
- Task CRUD + pause/resume + manual run + reset-session + run logs.
- Skills CRUD + auto-activate.

## D. Governance + Collaboration
- Goals CRUD + subgoals + progress updates.
- Decisions proposal/vote/resolve + keeper vote.
- Escalations resolve/reply.
- Room messages list/read/reply.
- Clerk chat send/reset/history.

## E. Knowledge + Audit
- Memory entity CRUD, observations, relations, search/stats.
- Task run history/log stream + self-mod audit + revert.

## F. Finance + Infra
- Wallet data, transaction history, balance aggregation, revenue summary.
- Onramp URL/redirect flow.
- Cloud stations list/start/stop/cancel/delete.
- Crypto checkout flow for station provisioning.

## G. Platform/Ops
- Global settings (advanced mode, notifications, telemetry, plans, queen default model).
- Status checks (resources, CLI availability, deployment mode, update info).
- Update download path.
- Provider connect/install/disconnect session flows.

## 3) What Was Tested In This Audit

Executed locally:

- `npm test`
  - Result: `53 files`, `907 tests`, `0 failed`.
- `npm run test:e2e`
  - Result: `34/34 passed` (Playwright Chromium).

E2E currently validates:
- auth/security basics
- core CRUD cycles (rooms/workers/tasks/goals/decisions)
- websocket subscribe + live events
- UI load/navigation and room management behavior
- mobile sidebar usability + PWA endpoints

Unit/integration route tests cover most core routes (`rooms/tasks/workers/goals/decisions/memory/skills/settings/stations/messages/runs`).

Browser flow automation added:
- `e2e/setup-flow.test.ts`
  - setup popup appears after room creation
  - subscription recommendation logic
  - model-path apply behavior
  - archive uses cloud-station deletion endpoint
- `e2e/test-buttons.test.ts`
  - hardened with transient-request retries to reduce flaky `ECONNRESET` failures

## 4) Main Failure Points / Bug Candidates

## Resolved In This Branch
1. Archive flow now uses correct cloud station APIs and surfaces errors.
- Fixed:
  - `src/ui/components/RoomSettingsPanel.tsx` archive path now uses `api.cloudStations.list/delete`.
  - Archive now reports partial failures instead of silently ignoring them.

2. Removed dead local station mutation methods from UI API client.
- Fixed:
  - `src/ui/lib/client.ts` no longer exposes removed local `/api/stations` mutation routes.

## High (Remaining)
1. Provider/onramp flows are not covered by Playwright E2E.
- Evidence:
  - Routes exist (`src/server/routes/providers.ts`, `src/server/routes/status.ts`, `src/server/routes/wallet.ts`) but no dedicated E2E spec.
- Impact:
  - Real-world regressions likely where CLI/env/runtime dependencies differ from dev machine.

## Medium (Remaining)
2. Heavy silent error handling in UI masks operational failures.
- Evidence: frequent `.catch(() => {})` in critical flows (`App.tsx`, `RoomSettingsPanel.tsx`, polling + archive actions).
- Impact:
  - False “healthy” UX, delayed bug discovery, poor diagnostics.

## 5) Fix Queue For Other Agents

1. Add E2E tests for unvalidated high-risk flows.
- Provider connect/install/disconnect lifecycle.
- Archive room with active cloud stations (assert cancellation happened).
- Wallet onramp URL/redirect behavior.

2. Add explicit user-visible error states for destructive actions.
- Archive, station actions, provider sessions, credential validation.

3. Keep setup guidance in sync with model/provider behavior.
- Post-create setup popup should remain aligned with actual model options and auth prerequisites.

## 6) Notes For Agents

- Current test baseline is green and archive/station mismatch is fixed in this branch.
- Next stability wins are in provider/onramp E2E coverage and reducing silent UI catches.
- Setup UX now includes a post-create guided popup and should be treated as the primary keeper onboarding path for room model selection.
