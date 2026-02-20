import { createInterface } from 'readline'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ANSI colors
const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const BLUE = '\x1b[34m'
const GRAY = '\x1b[90m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const YELLOW = '\x1b[33m'

interface ChatMessage {
  id: number
  roomId: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

interface Room {
  id: number
  name: string
  queenWorkerId: number | null
}

function getConnection(): { token: string; port: string } {
  const dataDir = process.env.QUOROOM_DATA_DIR || join(homedir(), '.quoroom')
  try {
    const token = readFileSync(join(dataDir, 'api.token'), 'utf-8').trim()
    const port = readFileSync(join(dataDir, 'api.port'), 'utf-8').trim()
    return { token, port }
  } catch {
    console.error(`${RED}Cannot read server credentials from ${dataDir}${RESET}`)
    console.error(`${GRAY}Make sure the server is running: quoroom serve${RESET}`)
    process.exit(1)
  }
}

async function apiRequest<T>(port: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

async function selectRoom(port: string, token: string): Promise<number> {
  const rooms = await apiRequest<Room[]>(port, token, 'GET', '/api/rooms')
  if (rooms.length === 0) {
    console.error(`${RED}No rooms found. Create a room first.${RESET}`)
    process.exit(1)
  }
  if (rooms.length === 1) {
    console.log(`${GRAY}Using room: ${rooms[0].name}${RESET}`)
    return rooms[0].id
  }

  console.log(`\n${BOLD}Available rooms:${RESET}`)
  rooms.forEach((r, i) => {
    console.log(`  ${GRAY}${i + 1}.${RESET} ${r.name}`)
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`\n${GRAY}Select room (1-${rooms.length}): ${RESET}`, (answer) => {
      rl.close()
      const idx = parseInt(answer, 10) - 1
      if (idx >= 0 && idx < rooms.length) {
        resolve(rooms[idx].id)
      } else {
        console.error(`${RED}Invalid selection${RESET}`)
        process.exit(1)
      }
    })
  })
}

export async function startChat(args: string[]): Promise<void> {
  const { token, port } = getConnection()

  // Parse --room flag
  let roomId: number | null = null
  const roomIdx = args.indexOf('--room')
  if (roomIdx !== -1 && args[roomIdx + 1]) {
    roomId = parseInt(args[roomIdx + 1], 10)
  }

  if (!roomId) {
    roomId = await selectRoom(port, token)
  }

  // Load chat history
  try {
    const messages = await apiRequest<ChatMessage[]>(port, token, 'GET', `/api/rooms/${roomId}/chat/messages`)
    if (messages.length > 0) {
      console.log(`\n${GRAY}--- Chat history ---${RESET}`)
      for (const msg of messages) {
        if (msg.role === 'user') {
          console.log(`${BLUE}> ${msg.content}${RESET}`)
        } else {
          console.log(`${GREEN}${msg.content}${RESET}`)
        }
      }
      console.log(`${GRAY}--- End history ---${RESET}\n`)
    }
  } catch {
    // Non-fatal
  }

  console.log(`${YELLOW}Queen chat${RESET} ${GRAY}(type /help for commands, /exit to quit)${RESET}\n`)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${GRAY}queen> ${RESET}`
  })

  rl.prompt()

  rl.on('line', async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) {
      rl.prompt()
      return
    }

    // Special commands
    if (trimmed === '/exit' || trimmed === '/quit') {
      console.log(`${GRAY}Goodbye${RESET}`)
      rl.close()
      process.exit(0)
    }

    if (trimmed === '/clear') {
      try {
        await apiRequest(port, token, 'POST', `/api/rooms/${roomId}/chat/reset`)
        console.log(`${GRAY}Chat cleared${RESET}`)
      } catch (err) {
        console.error(`${RED}${err instanceof Error ? err.message : 'Failed'}${RESET}`)
      }
      rl.prompt()
      return
    }

    if (trimmed === '/status') {
      try {
        const status = await apiRequest<unknown>(port, token, 'GET', `/api/rooms/${roomId}/status`)
        console.log(JSON.stringify(status, null, 2))
      } catch (err) {
        console.error(`${RED}${err instanceof Error ? err.message : 'Failed'}${RESET}`)
      }
      rl.prompt()
      return
    }

    if (trimmed === '/logs') {
      try {
        const activity = await apiRequest<Array<{ summary: string; eventType: string; createdAt: string }>>(
          port, token, 'GET', `/api/rooms/${roomId}/activity?limit=10`
        )
        if (activity.length === 0) {
          console.log(`${GRAY}No recent activity${RESET}`)
        } else {
          for (const a of activity) {
            console.log(`${GRAY}[${a.eventType}]${RESET} ${a.summary}`)
          }
        }
      } catch (err) {
        console.error(`${RED}${err instanceof Error ? err.message : 'Failed'}${RESET}`)
      }
      rl.prompt()
      return
    }

    if (trimmed === '/help') {
      console.log(`${BOLD}Commands:${RESET}`)
      console.log(`  ${GRAY}/clear${RESET}   Reset chat history`)
      console.log(`  ${GRAY}/status${RESET}  Show room status`)
      console.log(`  ${GRAY}/logs${RESET}    Show recent activity`)
      console.log(`  ${GRAY}/exit${RESET}    Quit`)
      rl.prompt()
      return
    }

    // Send message to queen
    process.stdout.write(`${YELLOW}Thinking...${RESET}`)

    try {
      const result = await apiRequest<{ response: string }>(
        port, token, 'POST', `/api/rooms/${roomId}/chat`, { message: trimmed }
      )
      // Clear "Thinking..." line
      process.stdout.write('\r\x1b[K')
      console.log(`${GREEN}${result.response}${RESET}\n`)
    } catch (err) {
      process.stdout.write('\r\x1b[K')
      console.error(`${RED}${err instanceof Error ? err.message : 'Failed to send'}${RESET}\n`)
    }

    rl.prompt()
  })

  rl.on('close', () => {
    process.exit(0)
  })
}
