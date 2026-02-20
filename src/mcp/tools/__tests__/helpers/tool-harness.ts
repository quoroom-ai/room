export type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

export function createToolHarness(): {
  toolHandlers: Map<string, ToolHandler>
  mockServer: {
    registerTool: (_name: string, _opts: unknown, handler: ToolHandler) => void
  }
  getResponseText: (result: { content: Array<{ type: string; text: string }> }) => string
} {
  const toolHandlers = new Map<string, ToolHandler>()
  const mockServer = {
    registerTool: (_name: string, _opts: unknown, handler: ToolHandler) => {
      toolHandlers.set(_name, handler)
    }
  }
  return {
    toolHandlers,
    mockServer,
    getResponseText: (result) => result.content[0].text
  }
}
