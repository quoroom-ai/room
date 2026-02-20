/**
 * E2E test helpers — utilities for Playwright browser tests.
 * Server is managed by global-setup.ts / global-teardown.ts.
 */

import { readFileSync } from 'node:fs'
import { type Page } from '@playwright/test'

const PORT = 3701
const BASE = `http://127.0.0.1:${PORT}`

let _token: string | null = null
let _userToken: string | null = null

function loadState() {
  if (!_token) {
    const state = JSON.parse(readFileSync('/tmp/quoroom-e2e.json', 'utf-8'))
    _token = state.token
    _userToken = state.userToken
  }
}

/** Read the agent token written by global-setup (full access). */
export function getToken(): string {
  loadState()
  return _token!
}

/** Read the user token from global-setup (restricted in auto mode). */
export function getUserToken(): string {
  loadState()
  return _userToken!
}

export function getBaseUrl(): string {
  return BASE
}

/**
 * Inject a mini test-runner UI into the browser page.
 * Shows a dark panel with formatted JSON results + status badges.
 * Screenshots of this page look clean and informative.
 *
 * Navigates to the server first to establish localhost origin,
 * then replaces DOM content via evaluate (page.setContent gives about:blank origin).
 */
export async function injectTestUI(page: Page, title: string): Promise<void> {
  // Navigate to server to establish http://127.0.0.1:3700 origin
  // Server returns 404 for non-API routes, but that's fine — we just need the origin
  await page.goto(BASE, { waitUntil: 'load' })

  // Replace page content with test UI via DOM manipulation (preserves origin)
  await page.evaluate((t) => {
    document.open()
    document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${t} — Quoroom E2E</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #c9d1d9; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; padding: 24px; }
    h1 { color: #58a6ff; font-size: 18px; margin-bottom: 16px; }
    .test { margin-bottom: 16px; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
    .test-header { background: #161b22; padding: 10px 14px; display: flex; align-items: center; gap: 10px; }
    .test-header .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge.pass { background: #238636; color: #fff; }
    .badge.fail { background: #da3633; color: #fff; }
    .badge.info { background: #1f6feb; color: #fff; }
    .test-header .label { color: #8b949e; }
    .test-body { padding: 12px 14px; background: #0d1117; }
    .test-body pre { white-space: pre-wrap; word-break: break-all; color: #7ee787; font-size: 12px; line-height: 1.5; }
    .test-body pre.error { color: #f85149; }
    .summary { margin-top: 20px; padding: 14px; background: #161b22; border-radius: 8px; border: 1px solid #30363d; }
    .summary span { color: #58a6ff; font-weight: 600; }
  </style>
</head>
<body>
  <h1>${t}</h1>
  <div id="results"></div>
  <div id="summary" class="summary" style="display:none"></div>
</body>
</html>`)
    document.close()
  }, title)
}

/** Add a test result card to the page. */
export async function addResult(
  page: Page,
  name: string,
  status: number,
  body: unknown,
  expected: number
): Promise<void> {
  const pass = status === expected
  await page.evaluate(({ name, status, body, pass, expected }) => {
    const container = document.getElementById('results')!
    const div = document.createElement('div')
    div.className = 'test'
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    div.innerHTML = `
      <div class="test-header">
        <span class="badge ${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</span>
        <span>${name}</span>
        <span class="label">HTTP ${status} ${pass ? '' : `(expected ${expected})`}</span>
      </div>
      <div class="test-body">
        <pre class="${pass ? '' : 'error'}">${bodyStr}</pre>
      </div>
    `
    container.appendChild(div)
  }, { name, status, body, pass, expected })
}

/** Show summary at bottom of page. */
export async function addSummary(page: Page, passed: number, failed: number): Promise<void> {
  await page.evaluate(({ passed, failed }) => {
    const el = document.getElementById('summary')!
    el.style.display = 'block'
    el.innerHTML = `<span>${passed} passed</span> · ${failed > 0 ? `<span style="color:#f85149">${failed} failed</span>` : 'all tests passed'}`
  }, { passed, failed })
}

/**
 * Browser-side fetch helper. Runs fetch() inside the page context.
 * Returns { status, body }.
 */
export async function browserFetch(
  page: Page,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string; headers?: Record<string, string> }
): Promise<{ status: number; body: any }> {
  return page.evaluate(async ({ base, method, path, body, token, extraHeaders }) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    })
    let parsed: any
    const text = await res.text()
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, body: parsed }
  }, {
    base: BASE,
    method,
    path,
    body: opts?.body ?? null,
    token: opts?.token ?? null,
    extraHeaders: opts?.headers ?? {}
  })
}
