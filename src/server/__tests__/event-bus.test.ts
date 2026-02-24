import { describe, it, expect, beforeEach } from 'vitest'
import { eventBus, type WsEvent } from '../event-bus'

beforeEach(() => {
  eventBus.clear()
})

describe('EventBus', () => {
  it('emits to channel-specific handler', () => {
    const events: WsEvent[] = []
    eventBus.on('room:1', (e) => events.push(e))

    eventBus.emit('room:1', 'room:created', { id: 1 })

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('room:created')
    expect(events[0].channel).toBe('room:1')
    expect(events[0].data).toEqual({ id: 1 })
    expect(events[0].timestamp).toBeDefined()
  })

  it('does not emit to wrong channel', () => {
    const events: WsEvent[] = []
    eventBus.on('room:1', (e) => events.push(e))

    eventBus.emit('room:2', 'room:created', { id: 2 })

    expect(events).toHaveLength(0)
  })

  it('emits to wildcard handler for all channels', () => {
    const events: WsEvent[] = []
    eventBus.onAny((e) => events.push(e))

    eventBus.emit('room:1', 'room:created', { id: 1 })
    eventBus.emit('tasks', 'task:created', { id: 5 })

    expect(events).toHaveLength(2)
    expect(events[0].channel).toBe('room:1')
    expect(events[1].channel).toBe('tasks')
  })

  it('emits to both channel and wildcard handlers', () => {
    const channelEvents: WsEvent[] = []
    const allEvents: WsEvent[] = []
    eventBus.on('room:1', (e) => channelEvents.push(e))
    eventBus.onAny((e) => allEvents.push(e))

    eventBus.emit('room:1', 'test', { x: 1 })

    expect(channelEvents).toHaveLength(1)
    expect(allEvents).toHaveLength(1)
  })

  it('unsubscribes channel handler', () => {
    const events: WsEvent[] = []
    const unsub = eventBus.on('ch', (e) => events.push(e))

    eventBus.emit('ch', 'a', null)
    expect(events).toHaveLength(1)

    unsub()
    eventBus.emit('ch', 'b', null)
    expect(events).toHaveLength(1)
  })

  it('unsubscribes wildcard handler', () => {
    const events: WsEvent[] = []
    const unsub = eventBus.onAny((e) => events.push(e))

    eventBus.emit('ch', 'a', null)
    expect(events).toHaveLength(1)

    unsub()
    eventBus.emit('ch', 'b', null)
    expect(events).toHaveLength(1)
  })

  it('clear removes all handlers', () => {
    const events: WsEvent[] = []
    eventBus.on('ch', (e) => events.push(e))
    eventBus.onAny((e) => events.push(e))

    eventBus.clear()
    eventBus.emit('ch', 'a', null)

    expect(events).toHaveLength(0)
  })

  it('supports multiple handlers on same channel', () => {
    const events1: WsEvent[] = []
    const events2: WsEvent[] = []
    eventBus.on('ch', (e) => events1.push(e))
    eventBus.on('ch', (e) => events2.push(e))

    eventBus.emit('ch', 'test', null)

    expect(events1).toHaveLength(1)
    expect(events2).toHaveLength(1)
  })
})
