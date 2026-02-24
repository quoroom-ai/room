import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { browserActionPersistent, type BrowserAction } from '../../shared/web-tools'

export function registerBrowserTools(server: McpServer): void {
  server.registerTool(
    'quoroom_browser',
    {
      title: 'Browser',
      description:
        'Control a headless Chromium browser to interact with websites. '
        + 'Navigate pages, click buttons, fill forms, submit, scroll, take snapshots and screenshots. '
        + 'Use for multi-step web interactions: signup forms, account creation, service configuration, purchases. '
        + 'Pass sessionId from a previous call to maintain cookies and login state across calls.',
      inputSchema: {
        url: z.string().describe('Starting URL to navigate to'),
        actions: z.array(z.object({
          type: z.enum([
            'navigate', 'click', 'fill', 'select', 'wait', 'submit', 'snapshot',
            'scroll', 'hover', 'press', 'type', 'screenshot', 'waitForSelector'
          ]).describe('Action type'),
          url: z.string().optional().describe('URL for navigate action'),
          text: z.string().optional().describe('Visible text to find and click'),
          selector: z.string().optional().describe('CSS selector for click/fill/select/submit/hover/waitForSelector'),
          value: z.string().optional().describe('Value for fill/select, key name for press (Enter/Tab/Escape), text for type'),
          ms: z.number().optional().describe('Milliseconds for wait/waitForSelector'),
          direction: z.enum(['up', 'down']).optional().describe('Scroll direction'),
          amount: z.number().optional().describe('Scroll pixels (default: 500)'),
        })).describe(
          'Sequence of browser actions. Tip: always end with a snapshot action to see the current page state.'
        ),
        sessionId: z.string().optional().describe(
          'Session ID from a previous quoroom_browser call. Pass this to resume the same browser session '
          + 'with cookies, localStorage, and login state preserved. Omit to start a fresh session.'
        ),
        timeout: z.number().optional().describe('Overall timeout in milliseconds (default: 60000)')
      }
    },
    async ({ url, actions, sessionId, timeout }) => {
      try {
        const result = await browserActionPersistent(
          url,
          actions as BrowserAction[],
          sessionId,
          timeout ?? 60_000
        )
        return {
          content: [{ type: 'text' as const, text: result.snapshot }]
        }
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Browser error: ${(e as Error).message}` }],
          isError: true
        }
      }
    }
  )
}
