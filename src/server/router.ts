/**
 * Minimal URL pattern-matching router for the HTTP API.
 * Compiles path patterns like /api/rooms/:id to RegExp at registration time.
 */

import type Database from 'better-sqlite3'

export interface RouteContext {
  params: Record<string, string>
  query: Record<string, string>
  body: unknown
  db: Database.Database
}

export interface ApiResponse {
  status?: number
  data?: unknown
  error?: string
}

export type RouteHandler = (ctx: RouteContext) => Promise<ApiResponse> | ApiResponse

interface CompiledRoute {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
}

export class Router {
  private routes: CompiledRoute[] = []

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler)
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler)
  }

  patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler)
  }

  put(path: string, handler: RouteHandler): void {
    this.add('PUT', path, handler)
  }

  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler)
  }

  private add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = []
    const patternStr = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name)
      return '([^/]+)'
    })
    this.routes.push({
      method,
      pattern: new RegExp(`^${patternStr}$`),
      paramNames,
      handler
    })
  }

  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = pathname.match(route.pattern)
      if (match) {
        const params: Record<string, string> = {}
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1])
        })
        return { handler: route.handler, params }
      }
    }
    return null
  }
}
