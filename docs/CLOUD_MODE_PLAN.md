# Cloud Mode Rollout Plan

Date: 2026-02-21
Owners: `cloud` repo + `room` repo

## 1) Goal

Ship a dual-path product:

- `Run locally` (current flow)
- `Run in cloud` (new hosted flow)

User should be able to:

1. Click `Run in cloud` on landing page.
2. Pick server tier/region on a stations-like page.
3. Pay with Stripe.
4. Get a Room server provisioned on Fly.io automatically.
5. Open the same UI in **remote mode** (desktop + mobile), install as PWA, and control the hosted room.

## 1.2 Pricing Baseline (2026-02-21)

Current planned monthly tiers:

- `micro` — `$9/mo`
- `small` — `$25/mo`
- `medium` — `$89/mo`
- `large` — `$179/mo`

Notes:

- These prices assume current `TIER_TO_GUEST` machine shapes (shared for micro/small, performance for medium/large).
- LLM subscription cost is not included (user brings Claude/Codex subscription or API key).

## 1.1 Locked Decisions (2026-02-21)

- Remote dashboard is **private by default** (authenticated access only).
- Use **one dashboard codebase** (`room/src/ui`) for both local and cloud modes.
- `cloud` repo hosts public pages + control-plane app (auth, billing, provisioning), not a second dashboard implementation.
- Reuse proven auth patterns from `auto` repo (email/password + Google OAuth + verification/reset + refresh).
- Support local and cloud in parallel:
  - Local: `localhost:3700` flow remains.
  - Cloud: hosted app domain (example: `app.quoroom.ai`) with account auth.

## 2) Current State (from this `room` repo)

- Local-first UI already exists with a connect gate (`src/ui/components/ConnectPage.tsx`).
- Cloud stations already exist through `quoroom.ai` APIs (`src/shared/cloud-sync.ts`, `src/server/routes/stations.ts`).
- Stations UI already links to cloud stations page (`src/ui/components/StationsPanel.tsx`).
- Auth is localhost-only handshake + local token model (`src/server/auth.ts`, `src/server/index.ts`).
- PWA support already exists (manifest + service worker + install prompt).

Gap: no end-to-end hosted Room instance lifecycle and no secure remote-control auth model for non-localhost access.

## 3) Product UX

### Landing

In `cloud` landing page:

- Primary CTA block with two actions:
  - `Run locally` -> existing installer/download flow.
- `Run in cloud` -> `/app/new` (new flow).

### Cloud setup flow (`/app/new`)

Steps:

1. Sign in / create account.
2. Choose plan/tier/region (reuse stations selection UI pattern).
3. Enter room name + optional goal + optional provider credentials.
4. Stripe checkout.
5. Provisioning screen (30-120s) with live status.
6. Redirect to hosted app URL (for example `https://app.quoroom.ai/app/r/{roomId}`).

### Hosted app behavior

- Same dashboard UX as local app, but API base points to hosted backend.
- Persistent login session.
- Mobile responsive + installable PWA.
- Unauthenticated users are redirected to login.

## 4) Architecture

### 4.0 Surface split

- **Public surface** (`quoroom.ai`): landing, docs, public rooms, pricing, station purchase entry.
- **Private surface** (`app.quoroom.ai`): account auth, instance management, hosted Room dashboard.
- Hosted Room dashboard route example: `app.quoroom.ai/app/r/{instanceId}`.

## 4.1 Control plane (`cloud` repo)

Responsibilities:

- Account auth + sessions.
- Billing (Stripe customer/subscription lifecycle).
- Provisioning orchestration (Fly app/machine creation).
- Mapping user -> room instance -> runtime URL.
- Runtime access tokens (JWT/session exchange).
- Authorization policy: owner/member access to instances (private ACL).

Data model additions:

- `users`
- `user_identities` (oauth providers)
- `user_sessions` / `refresh_tokens`
- `cloud_instances` (owner, region, tier, status, fly_app, machine_id, url)
- `cloud_instance_members` (private access control list)
- `instance_subscriptions` (stripe ids, billing status)
- `instance_events` (audit/provisioning log)

## 4.2 Runtime plane (`room` server running on Fly)

Responsibilities:

- Run existing Room API/UI + WS.
- Persist state to attached Fly volume.
- Accept cloud-issued auth for remote UI.

New runtime mode flag:

- `QUOROOM_DEPLOYMENT_MODE=cloud|local` (default `local`).

Behavior in `cloud` mode:

- Disable localhost-only handshake restriction.
- Trust cloud JWT/JWKS or signed session token.
- Strict CORS allowlist from control-plane domain(s).
- Rate limits and request-size limits for internet exposure.
- Enforce instance-level ACL checks on all room-scoped operations.

## 5) Auth Strategy (answering “login/password?”)

Decision: implement **full auth now** by reusing the `auto` stack patterns.

Scope:

- Email/password signup + login.
- Google OAuth login.
- Email verification + resend verification.
- Forgot/reset password.
- Access + refresh tokens (cookie + bearer fallback for compatibility).

Reuse sources (reference implementation):

- `/Users/vasily/projects/auto/apps/api/src/routes/auth.ts`
- `/Users/vasily/projects/auto/apps/api/src/controllers/authController.ts`
- `/Users/vasily/projects/auto/apps/api/src/config/passport.ts`
- `/Users/vasily/projects/auto/apps/api/src/middleware/auth.ts`
- `/Users/vasily/projects/auto/apps/api/src/utils/jwt.ts`
- `/Users/vasily/projects/auto/apps/api/src/utils/oauth.ts`

## 5.1 LLM Subscription Auth in Cloud Runtime

Goal: keep subscription-based providers available in hosted mode (not API-key-only).

### Runtime prerequisites

- Yes: if we support `claude_subscription` and `codex_subscription` in cloud mode, each hosted Room instance must include both CLIs.
- Runtime image bootstrap:
  - Install Codex CLI (`npm i -g @openai/codex`).
  - Install Claude Code (native installer preferred; npm fallback only if needed).
- Startup health checks:
  - `codex --version`
  - `claude --version`
- `/api/status` should expose runtime provider availability in cloud mode.

### Provider authorization flow

- Codex subscription:
  - Start auth from remote UI with device flow (`codex login --device-auth`).
  - Show code + verification URL in UI; user completes in browser.
  - Persist credentials on that instance only.
- Claude subscription:
  - Start auth from remote UI by launching CLI login flow and guiding user to browser-based sign-in.
  - Team/enterprise setups can use Claude for Teams/Enterprise or Claude Console auth.
  - If interactive subscription auth is blocked in specific headless deployments, fallback path is Anthropic API key mode.

### Token and isolation rules

- Provider auth state is private per runtime instance.
- Control plane stores only metadata (connected/disconnected, provider, last check), not provider tokens.
- One tenant per runtime instance (no shared host-level credential store across users).
- Disconnect action revokes/clears provider auth files on instance.
- Instance destroy guarantees auth state deletion.

## 6) API Contract Plan

## 6.1 Control plane endpoints (new, `cloud`)

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET  /api/auth/google`
- `GET  /api/auth/google/callback`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET  /api/auth/me`
- `POST /api/cloud/instances` -> create draft instance + return checkout session
- `POST /api/cloud/instances/:id/checkout/confirm` -> verify payment, enqueue provisioning
- `GET /api/cloud/instances/:id/status` -> provisioning state
- `POST /api/cloud/instances/:id/runtime-token` -> short-lived token for runtime UI
- `POST /api/cloud/instances/:id/providers/codex/connect` -> start device auth, return code+URL
- `POST /api/cloud/instances/:id/providers/codex/disconnect`
- `POST /api/cloud/instances/:id/providers/claude/connect` -> start CLI login flow
- `POST /api/cloud/instances/:id/providers/claude/disconnect`

Stripe webhooks:

- `checkout.session.completed`
- `invoice.payment_failed`
- `customer.subscription.deleted`

## 6.2 Runtime (`room`) changes

- Add cloud auth verifier middleware in server auth path.
- Keep existing local token flow untouched for `local` mode.
- Add explicit mode in `/api/status` so UI can render local vs cloud behavior.

## 6.3 UI API-base strategy

Current UI assumes localhost in many places.

Add:

- `VITE_APP_MODE=local|cloud`
- `VITE_API_URL` mandatory in cloud mode.
- Router/auth-level mode switch:
  - local mode: keep current connect/probe flow.
  - cloud mode: skip localhost probing entirely.
- Auth provider split:
  - `LocalAuthProvider`: existing handshake/token model.
  - `CloudAuthProvider`: account session + refresh flow from control plane.
- No duplicated dashboard folder. Same components/tabs in both modes.

## 7) Implementation Phases

## Phase 0: Foundations (2-4 days)

- Lift reusable auth code from `auto` into `cloud` (adapted to Quoroom schemas).
- Define cloud instance schema and lifecycle states.
- Add Fly machine template for Room runtime (image, volume, health checks).
- Add Stripe product/price mapping for tiers.
- Build runtime image with `codex` + `claude` preinstalled and version-checked.

Exit criteria:

- Can provision/destroy test instance manually through internal endpoint.

## Phase 1: Purchase + Provision MVP (4-7 days)

- Landing `Run in cloud` CTA.
- New `/app/new` flow with server picker and Stripe checkout.
- Private app shell (`app.quoroom.ai`) with login + authenticated instance list.
- Webhook-driven provisioning to Fly.
- Provisioning progress page.

Exit criteria:

- Paid user receives working runtime URL within target SLA.

## Phase 2: Remote Mode in Room UI (4-6 days)

In `room` repo:

- Introduce deployment mode and cloud auth verifier.
- Add remote-safe CORS policy.
- Add explicit API mode in `/api/status`.
- Update UI gate logic to support cloud mode without localhost probing.
- Add provider connection UX in Room settings (connect/disconnect/status for Claude/Codex subscription).

Exit criteria:

- Same app bundle works in local and cloud mode.

Status update (2026-02-21, `room` repo):

- Completed:
  - Added runtime deployment mode switch (`local|cloud`) in server auth/startup.
  - Cloud-mode CORS/origin handling + cloud user token support in auth validator.
  - Disabled localhost handshake in cloud mode.
  - Added `deploymentMode` to `/api/status`.
  - Added UI app-mode switch (`VITE_APP_MODE`) in auth layer.
  - Cloud UI auth path now uses `token` query/localStorage + `/api/auth/verify` (works with signed runtime JWT).
  - Cloud mode skips localhost probe/connect gate and opens dashboard directly.
  - Added runtime JWT validation path (`QUOROOM_CLOUD_JWT_SECRET`) with instance binding (`QUOROOM_CLOUD_INSTANCE_ID`) for hosted access tokens.
  - Added cloud-member role support (`member`) in auth + RBAC for safer shared instance access.
  - Added provider auth helper routes:
    - `GET /api/providers/status`
    - `POST /api/providers/:provider/connect`
    - `POST /api/providers/:provider/disconnect`
  - Added provider connect/disconnect controls in Room settings UI for Claude/Codex subscription mode.
- Pending in `room`:
  - JWKS / key-rotation path (current MVP uses shared HMAC secret).

Status update (2026-02-21, follow-up):

- Completed:
  - Added provider auth session manager in runtime (`codex login` / `claude login` spawn, stdout/stderr capture, timeout/cancel lifecycle).
  - Added provider auth session APIs:
    - `GET /api/providers/:provider/session`
    - `GET /api/providers/sessions/:sessionId`
    - `POST /api/providers/sessions/:sessionId/cancel`
  - Added WebSocket live streaming for provider auth sessions on channel `provider-auth:{sessionId}` with line-by-line updates and status events.
  - Updated Room Settings UI to show live login output, detected verification URL/device code, and cancel/refresh controls.
  - WebSocket client now auto-connects on first subscription to prevent silent no-stream cases.

## Phase 3: Mobile + PWA hardening (2-4 days) — COMPLETE

- Verify responsive behavior for all primary tabs on narrow widths.
- Ensure install prompt behavior on iOS/Android.
- Improve service-worker cache strategy for hosted deploys (versioned cache keys, robust offline shell).

Exit criteria:

- Lighthouse PWA pass + manual install verified on iOS Safari and Android Chrome.

Execution checklist (implemented):

- Service worker upgraded to build-versioned caches via `sw.js?v={buildId}` registration.
- Added offline fallback page (`/offline.html`) for navigation failures.
- Cache strategy split:
  - documents: network-first, offline fallback
  - static assets/icons/manifest: stale-while-revalidate
  - API/WS excluded from SW cache
- Added iOS/manual-install detection in UI install prompt state.
- Added mobile/PWA smoke e2e coverage:
  - mobile sidebar/header usability
  - manifest and service-worker availability checks
- Updated static file cache headers in room server:
  - no-store for HTML + `sw.js`
  - long immutable cache for hashed `/assets/*`
  - bounded cache for icons/fonts/manifest
- ErrorBoundary component for graceful crash recovery.
- Safe localStorage wrapper (storage.ts) for environments with restricted storage.

## Phase 4: Ops + Safety (3-5 days) — IN PROGRESS

- Instance quotas and abuse protections.
- Runtime logs/metrics, alerts, restart policies.
- Billing edge cases (failed payment, cancellation, grace period).
- Backup/restore strategy for Fly volumes.

Exit criteria:

- On-call runbook and failure drills completed.

Status update (2026-02-22):

- Self-healing station checkout when Stripe webhook is missed.
- Per-instance JWT secrets for provisioning isolation.
- `update-fly-machines.js` script with `--image` arg, tier guest config sync, and error handling.
- Room token re-issue on master auth (engine crash recovery).
- Station billing/payments endpoint aggregating Stripe + crypto history.

## Phase 5: Telegram Mini App (2026-02-22) — COMPLETE

Telegram users can access cloud swarms directly inside Telegram.

Implementation (in `cloud` repo):

- Telegram initData validation (HMAC-SHA256) with auto-account creation.
- `telegram_users` table linking Telegram IDs to user accounts.
- Webhook handler for `/start` command (inline keyboard with web_app button).
- Existing `app.html` and `app-swarm.html` detect Telegram environment and adapt UI (hide header/footer, BackButton, expand).
- Magic-link browser auth (`browser-token` / `browser-validate`) for opening Stripe checkout in external browser (Telegram forbids third-party payment processing).
- Bot menu button set via API: "Open Swarms" → `https://quoroom.ai/app`.

## 8) Code Touchpoints

`room` repo:

- `src/server/auth.ts` (add cloud-mode verifier path)
- `src/server/index.ts` (origin/handshake behavior split by mode)
- `src/ui/lib/auth.ts` (token acquisition strategy by mode)
- `src/ui/App.tsx` + `src/ui/components/ConnectPage.tsx` (local probe vs cloud routing)
- `src/server/routes/status.ts` (expose mode capabilities)
- `src/server/access.ts` (room-level ACL hooks in cloud mode)
- `src/shared/model-provider.ts` (subscription readiness must reflect real provider auth state in cloud mode)
- `src/ui/components/RoomSettingsPanel.tsx` (subscription provider connect/disconnect actions)

`cloud` repo:

- landing page route/components (add `Run in cloud`)
- stations-like server selection page
- auth routes/controllers/middleware (ported from `auto` patterns)
- Stripe checkout + webhook handlers
- Fly provisioning worker and status polling endpoints
- provider-connect worker/actions (codex device auth + claude login orchestration)

## 9) Risks and Mitigations

- Security risk exposing runtime directly:
  - Mitigate with short-lived tokens, CORS allowlist, rate limits, strict TLS, audit logs.
- Provisioning failures / slow boot:
  - Queue + retries + surfaced status events + automatic cleanup.
- Billing-provision race conditions:
  - Idempotency keys and webhook-driven state machine.
- Mobile UX regression:
  - Dedicated QA matrix before launch.

## 10) Suggested Build Order (fastest path)

1. Control-plane checkout + provisioning API skeleton.
2. Fly runtime template working end-to-end.
3. Runtime cloud auth mode in `room`.
4. Cloud-mode UI switch (skip localhost probe).
5. Landing CTA + purchase flow polish.
6. Mobile/PWA hardening and launch gate.
