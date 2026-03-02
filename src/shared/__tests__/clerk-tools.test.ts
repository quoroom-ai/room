import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { createRoom as createRoomFull } from '../room'
import { executeClerkTool } from '../clerk-tools'
import { getRoomCloudId } from '../cloud-sync'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

describe('executeClerkTool', () => {
  it('creates room from objective only and auto-generates room name', async () => {
    const created = await executeClerkTool(db, 'quoroom_create_room', {
      objective: 'Launch growth experiments and increase trial conversions',
    })
    expect(created.isError).toBeFalsy()
    expect(created.content).toContain('Created room')

    const rooms = queries.listRooms(db)
    expect(rooms.length).toBe(1)
    expect(rooms[0].goal).toBe('Launch growth experiments and increase trial conversions')
    expect(rooms[0].name.length).toBeGreaterThan(0)
    expect(rooms[0].name).not.toMatch(/\s/)
  })

  it('requires objective when creating a room', async () => {
    const created = await executeClerkTool(db, 'quoroom_create_room', { name: 'emptygoal' })
    expect(created.isError).toBe(true)
    expect(created.content.toLowerCase()).toContain('objective is required')
  })

  it('creates, updates, pauses, restarts, and deletes rooms', async () => {
    const created = await executeClerkTool(db, 'quoroom_create_room', {
      name: 'controlroom',
      goal: 'ship features',
      visibility: 'public',
      autonomyMode: 'semi',
      queenCycleGapMs: 120000,
      queenMaxTurns: 7,
    })
    expect(created.isError).toBeFalsy()
    expect(created.content).toContain('Created room "controlroom"')

    const room = queries.listRooms(db).find((r) => r.name === 'controlroom')
    expect(room).toBeTruthy()
    expect(room!.visibility).toBe('public')
    expect(room!.autonomyMode).toBe('semi')
    expect(room!.queenCycleGapMs).toBe(120000)
    expect(room!.queenMaxTurns).toBe(7)

    const updated = await executeClerkTool(db, 'quoroom_update_room', {
      roomName: 'controlroom',
      goal: 'scale to revenue',
      maxConcurrentTasks: 5,
      queenQuietFrom: '23:00',
      queenQuietUntil: '07:00',
    })
    expect(updated.isError).toBeFalsy()

    const updatedRoom = queries.getRoom(db, room!.id)!
    expect(updatedRoom.goal).toBe('scale to revenue')
    expect(updatedRoom.maxConcurrentTasks).toBe(5)
    expect(updatedRoom.queenQuietFrom).toBe('23:00')
    expect(updatedRoom.queenQuietUntil).toBe('07:00')

    const paused = await executeClerkTool(db, 'quoroom_pause_room', { roomId: room!.id })
    expect(paused.isError).toBeFalsy()
    expect(queries.getRoom(db, room!.id)!.status).toBe('paused')

    const restarted = await executeClerkTool(db, 'quoroom_restart_room', { roomId: room!.id, goal: 'new mission' })
    expect(restarted.isError).toBeFalsy()
    const restartedRoom = queries.getRoom(db, room!.id)!
    expect(restartedRoom.status).toBe('active')
    expect(restartedRoom.goal).toBe('new mission')

    const deleted = await executeClerkTool(db, 'quoroom_delete_room', { roomId: room!.id })
    expect(deleted.isError).toBeFalsy()
    expect(queries.getRoom(db, room!.id)).toBeNull()
  })

  it('starts and stops room runtime via clerk tools (including legacy aliases)', async () => {
    const created = await executeClerkTool(db, 'quoroom_create_room', {
      name: 'runtimecontrol',
      goal: 'test runtime controls',
    })
    expect(created.isError).toBeFalsy()

    const room = queries.listRooms(db).find((r) => r.name === 'runtimecontrol')
    expect(room).toBeTruthy()

    const stopped = await executeClerkTool(db, 'quoroom_stop_room', { roomId: room!.id })
    expect(stopped.isError).toBeFalsy()
    expect(stopped.content).toContain('Stopped room runtime')
    expect(queries.getRoom(db, room!.id)!.status).toBe('paused')

    const started = await executeClerkTool(db, 'quoroom_start_room', { roomId: room!.id })
    expect(started.isError).toBeFalsy()
    expect(started.content).toContain('Started room runtime')
    expect(queries.getRoom(db, room!.id)!.status).toBe('active')

    const legacyStop = await executeClerkTool(db, 'quoroom_stop_queen', { roomId: room!.id })
    expect(legacyStop.isError).toBeFalsy()
    expect(queries.getRoom(db, room!.id)!.status).toBe('paused')

    const legacyStart = await executeClerkTool(db, 'quoroom_start_queen', { roomId: room!.id })
    expect(legacyStart.isError).toBeFalsy()
    expect(queries.getRoom(db, room!.id)!.status).toBe('active')

    queries.updateRoom(db, room!.id, { status: 'stopped' })
    const blockedStart = await executeClerkTool(db, 'quoroom_start_room', { roomId: room!.id })
    expect(blockedStart.isError).toBe(true)
    expect(blockedStart.content.toLowerCase()).toContain('archived')
  })

  it('reads and writes global settings', async () => {
    const setResult = await executeClerkTool(db, 'quoroom_set_setting', {
      key: 'clerk_commentary_enabled',
      value: 'false',
    })
    expect(setResult.isError).toBeFalsy()
    expect(queries.getSetting(db, 'clerk_commentary_enabled')).toBe('false')

    const getResult = await executeClerkTool(db, 'quoroom_get_setting', {
      key: 'clerk_commentary_enabled',
    })
    expect(getResult.isError).toBeFalsy()
    expect(getResult.content).toBe('clerk_commentary_enabled=false')
  })

  it('lists rooms and returns errors for unknown room targets', async () => {
    createRoomFull(db, { name: 'alpha' })

    const listed = await executeClerkTool(db, 'quoroom_list_rooms', {})
    expect(listed.isError).toBeFalsy()
    expect(listed.content).toContain('alpha')

    const missing = await executeClerkTool(db, 'quoroom_pause_room', { roomName: 'does-not-exist' })
    expect(missing.isError).toBe(true)
    expect(missing.content.toLowerCase()).toContain('room not found')
  })

  it('sends keeper messages to a local room', async () => {
    const result = createRoomFull(db, { name: 'keepermsg' })

    const sent = await executeClerkTool(db, 'quoroom_message_room', {
      roomId: result.room.id,
      message: 'Please focus on shipping faster this week.',
    })
    expect(sent.isError).toBeFalsy()
    expect(sent.content).toContain('Sent keeper message')

    const escalations = queries.listEscalations(db, result.room.id)
    expect(escalations.length).toBe(1)
    expect(escalations[0].fromAgentId).toBeNull()
    expect(escalations[0].question).toContain('shipping faster')
  })

  it('queues inter-room message to another local room by room name', async () => {
    const from = createRoomFull(db, { name: 'sender' })
    const to = createRoomFull(db, { name: 'receiver' })

    const queued = await executeClerkTool(db, 'quoroom_message_other_room', {
      fromRoomId: from.room.id,
      toRoomName: 'receiver',
      subject: 'Coordination',
      body: 'Can you share your latest findings?',
    })
    expect(queued.isError).toBeFalsy()
    expect(queued.content).toContain('Queued inter-room message')

    const messages = queries.listRoomMessages(db, from.room.id)
    expect(messages.length).toBe(1)
    expect(messages[0].direction).toBe('outbound')
    expect(messages[0].toRoomId).toBe(getRoomCloudId(to.room.id))
    expect(messages[0].subject).toBe('Coordination')
  })

  it('creates tasks and schedules keeper reminders', async () => {
    const room = createRoomFull(db, { name: 'ops' })

    const createdTask = await executeClerkTool(db, 'quoroom_create_task', {
      name: 'Daily brief',
      prompt: 'Summarize room outcomes and blockers.',
      roomName: 'ops',
      workerId: room.queen.id,
      cronExpression: '0 9 * * *',
      maxTurns: 12,
    })
    expect(createdTask.isError).toBeFalsy()
    expect(createdTask.content).toContain('Created task "Daily brief"')

    const cronTask = queries.listTasks(db).find((task) => task.name === 'Daily brief')
    expect(cronTask).toBeTruthy()
    expect(cronTask!.triggerType).toBe('cron')
    expect(cronTask!.executor).toBe('claude_code')
    expect(cronTask!.roomId).toBe(room.room.id)

    const reminder = await executeClerkTool(db, 'quoroom_remind_keeper', {
      message: 'Review room performance before standup.',
      roomName: 'ops',
      scheduledAt: '2030-04-20T09:30:00-04:00',
    })
    expect(reminder.isError).toBeFalsy()
    expect(reminder.content).toContain('Scheduled keeper reminder')

    const reminderTask = queries.listTasks(db).find((task) => task.executor === 'keeper_reminder')
    expect(reminderTask).toBeTruthy()
    expect(reminderTask!.triggerType).toBe('once')
    expect(reminderTask!.roomId).toBe(room.room.id)
    expect(reminderTask!.prompt).toContain('Review room performance')
  })
})

describe('clerk log storage', () => {
  it('returns full clerk log by default', () => {
    for (let i = 1; i <= 250; i++) {
      queries.insertClerkMessage(db, i % 2 === 0 ? 'assistant' : 'user', `message ${i}`)
    }

    const all = queries.listClerkMessages(db)
    expect(all.length).toBe(250)
    expect(all[0].content).toBe('message 1')
    expect(all[249].content).toBe('message 250')
  })

  it('returns latest N clerk messages when limit is provided', () => {
    for (let i = 1; i <= 25; i++) {
      queries.insertClerkMessage(db, 'user', `message ${i}`)
    }

    const lastTen = queries.listClerkMessages(db, 10)
    expect(lastTen.length).toBe(10)
    expect(lastTen[0].content).toBe('message 16')
    expect(lastTen[9].content).toBe('message 25')
  })
})
