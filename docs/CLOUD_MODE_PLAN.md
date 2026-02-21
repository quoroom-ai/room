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
  - `Run in cloud` -> `/cloud/new` (new flow).

### Cloud setup flow (`/cloud/new`)

Steps:

1. Sign in / create account.
2. Choose plan/tier/region (reuse stations selection UI pattern).
3. Enter room name + optional goal + optional provider credentials.
4. Stripe checkout.
5. Provisioning screen (30-120s) with live status.
6. Redirect to hosted app URL (for example `https://app.quoroom.ai/r/{roomId}`).

### Hosted app behavior

- Same dashboard UX as local app, but API base points to hosted backend.
- Persistent login session.
- Mobile responsive + installable PWA.
- Unauthenticated users are redirected to login.

## 4) Architecture

### 4.0 Surface split

- **Public surface** (`quoroom.ai`): landing, docs, public rooms, pricing, station purchase entry.
- **Private surface** (`app.quoroom.ai`): account auth, instance management, hosted Room dashboard.
- Hosted Room dashboard route example: `app.quoroom.ai/r/{instanceId}`.

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

Exit criteria:

- Can provision/destroy test instance manually through internal endpoint.

## Phase 1: Purchase + Provision MVP (4-7 days)

- Landing `Run in cloud` CTA.
- New `/cloud/new` flow with server picker and Stripe checkout.
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

Exit criteria:

- Same app bundle works in local and cloud mode.

## Phase 3: Mobile + PWA hardening (2-4 days)

- Verify responsive behavior for all primary tabs on narrow widths.
- Ensure install prompt behavior on iOS/Android.
- Improve service-worker cache strategy for hosted deploys (versioned cache keys, robust offline shell).

Exit criteria:

- Lighthouse PWA pass + manual install verified on iOS Safari and Android Chrome.

## Phase 4: Ops + Safety (3-5 days)

- Instance quotas and abuse protections.
- Runtime logs/metrics, alerts, restart policies.
- Billing edge cases (failed payment, cancellation, grace period).
- Backup/restore strategy for Fly volumes.

Exit criteria:

- On-call runbook and failure drills completed.

## 8) Code Touchpoints

`room` repo:

- `src/server/auth.ts` (add cloud-mode verifier path)
- `src/server/index.ts` (origin/handshake behavior split by mode)
- `src/ui/lib/auth.ts` (token acquisition strategy by mode)
- `src/ui/App.tsx` + `src/ui/components/ConnectPage.tsx` (local probe vs cloud routing)
- `src/server/routes/status.ts` (expose mode capabilities)
- `src/server/access.ts` (room-level ACL hooks in cloud mode)

`cloud` repo:

- landing page route/components (add `Run in cloud`)
- stations-like server selection page
- auth routes/controllers/middleware (ported from `auto` patterns)
- Stripe checkout + webhook handlers
- Fly provisioning worker and status polling endpoints

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
