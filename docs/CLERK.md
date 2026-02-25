# Clerk Guide

The Clerk is the keeper-facing global assistant in Quoroom.

Unlike room chat, Clerk has a system-wide view and can help manage multiple rooms from one place.

## What Clerk Can Do

- Answer questions about active rooms, goals, workers, and recent activity
- Create, update, pause, restart, and delete rooms
- Start/stop queen loops
- Create tasks and reminders
- Send keeper messages to rooms and inter-room messages
- Emit live commentary while agents run

Clerk actions are implemented as tool calls in `src/shared/clerk-tools.ts`.

## Setup Paths

In the dashboard, open the **Clerk** tab and click **Setup**.

Available model paths:

- `claude` (Claude subscription path)
- `codex` (Codex/ChatGPT subscription path)
- `openai:gpt-4o-mini` (OpenAI API path)
- `anthropic:claude-3-5-sonnet-latest` (Anthropic API path)
- `gemini:gemini-2.5-flash` (Gemini API path)

For API paths, Clerk Setup validates keys before storing them.

## API Key Resolution Order

When Clerk uses an API model, keys are resolved in this order:

1. Room credential (`openai_api_key` / `anthropic_api_key` / `gemini_api_key`) from any room
2. Clerk-saved key (`clerk_openai_api_key` / `clerk_anthropic_api_key` / `clerk_gemini_api_key`)
3. Environment variable (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`)

Implementation: `resolveClerkApiKey()` in `src/server/routes/clerk.ts`.

## Live Commentary Behavior

The commentary engine listens to room cycle events and emits updates to WebSocket channel `clerk` with event type `clerk:commentary`.

Current behavior:

- Poll interval: every 8 seconds
- Pauses after keeper sends a Clerk message
- Resume threshold: 60 seconds of keeper silence
- Can be disabled with setting `clerk_commentary_enabled=false`

Implementation: `src/server/clerk-commentary.ts`.

## Keeper Alert Digest Cadence

Clerk external alerts (email/Telegram) for pending keeper requests are now batched by default.

- Default digest cadence: once every 6 hours
- Urgent backlog cadence: at most once per hour for large bursts
- New items are queued and included in the next digest window

Optional settings (minutes):

- `clerk_notify_min_interval_minutes` (default 360)
- `clerk_notify_urgent_min_interval_minutes` (default 60)

Set either value to `0` to disable that specific cooldown.

## Clerk HTTP API

All routes are under the local API server:

- `GET /api/clerk/messages` — list Clerk conversation + commentary messages
- `POST /api/clerk/chat` — send keeper message to Clerk
- `POST /api/clerk/reset` — clear Clerk session + messages
- `GET /api/clerk/status` — model, configured state, commentary toggle, API auth status
- `POST /api/clerk/api-key` — validate + save Clerk API key (`openai_api`, `anthropic_api`, or `gemini_api`)
- `PUT /api/clerk/settings` — update `model` and/or `commentaryEnabled`

Route implementation: `src/server/routes/clerk.ts`.

## Troubleshooting

- Clerk says key missing: add key in Clerk Setup, set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, or add room credential in Room Settings (Clerk can reuse it)
- Commentary not appearing: confirm rooms are active and generating cycle events, check `clerk_commentary_enabled` is not `false`, and wait at least 60 seconds after your last Clerk message
- Clerk not responding: confirm a model is selected in Clerk Setup and check provider availability in Settings/server logs
