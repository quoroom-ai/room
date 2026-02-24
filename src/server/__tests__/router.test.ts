import { describe, it, expect } from 'vitest'
import { Router } from '../router'

describe('Router', () => {
  it('matches a simple path', () => {
    const router = new Router()
    router.get('/api/rooms', () => ({ data: 'rooms' }))

    const match = router.match('GET', '/api/rooms')
    expect(match).not.toBeNull()
    expect(match!.params).toEqual({})
  })

  it('returns null for unmatched path', () => {
    const router = new Router()
    router.get('/api/rooms', () => ({ data: [] }))

    expect(router.match('GET', '/api/tasks')).toBeNull()
  })

  it('returns null for unmatched method', () => {
    const router = new Router()
    router.get('/api/rooms', () => ({ data: [] }))

    expect(router.match('POST', '/api/rooms')).toBeNull()
  })

  it('extracts single param', () => {
    const router = new Router()
    router.get('/api/rooms/:id', () => ({ data: {} }))

    const match = router.match('GET', '/api/rooms/42')
    expect(match).not.toBeNull()
    expect(match!.params).toEqual({ id: '42' })
  })

  it('extracts multiple params', () => {
    const router = new Router()
    router.get('/api/rooms/:roomId/workers/:workerId', () => ({ data: {} }))

    const match = router.match('GET', '/api/rooms/1/workers/5')
    expect(match).not.toBeNull()
    expect(match!.params).toEqual({ roomId: '1', workerId: '5' })
  })

  it('decodes URI-encoded params', () => {
    const router = new Router()
    router.get('/api/settings/:key', () => ({ data: {} }))

    const match = router.match('GET', '/api/settings/my%20key')
    expect(match).not.toBeNull()
    expect(match!.params).toEqual({ key: 'my key' })
  })

  it('registers all HTTP methods', () => {
    const router = new Router()
    router.get('/api/x', () => ({ data: 'get' }))
    router.post('/api/x', () => ({ data: 'post' }))
    router.patch('/api/x', () => ({ data: 'patch' }))
    router.put('/api/x', () => ({ data: 'put' }))
    router.delete('/api/x', () => ({ data: 'delete' }))

    expect(router.match('GET', '/api/x')).not.toBeNull()
    expect(router.match('POST', '/api/x')).not.toBeNull()
    expect(router.match('PATCH', '/api/x')).not.toBeNull()
    expect(router.match('PUT', '/api/x')).not.toBeNull()
    expect(router.match('DELETE', '/api/x')).not.toBeNull()
  })

  it('matches first route when multiple match', () => {
    const router = new Router()
    router.get('/api/rooms/:id', () => ({ data: 'first' }))
    router.get('/api/rooms/:roomId', () => ({ data: 'second' }))

    const match = router.match('GET', '/api/rooms/1')
    expect(match!.params).toEqual({ id: '1' })
  })

  it('does not partially match paths', () => {
    const router = new Router()
    router.get('/api/rooms', () => ({ data: [] }))

    expect(router.match('GET', '/api/rooms/extra')).toBeNull()
    expect(router.match('GET', '/api')).toBeNull()
  })

  it('calls handler with context and returns result', async () => {
    const router = new Router()
    router.get('/api/rooms/:id', (ctx) => ({
      data: { id: ctx.params.id }
    }))

    const match = router.match('GET', '/api/rooms/7')
    const result = await match!.handler({
      params: match!.params,
      query: {},
      body: undefined,
      db: {} as any
    })
    expect(result).toEqual({ data: { id: '7' } })
  })
})
