import type { Router } from '../router'
import { registerRoomRoutes } from './rooms'
import { registerWorkerRoutes } from './workers'
import { registerGoalRoutes } from './goals'
import { registerDecisionRoutes } from './decisions'
import { registerTaskRoutes } from './tasks'
import { registerRunRoutes } from './runs'
import { registerMemoryRoutes } from './memory'
import { registerSkillRoutes } from './skills'
import { registerWatchRoutes } from './watches'
import { registerSettingRoutes } from './settings'
import { registerEscalationRoutes } from './escalations'
import { registerSelfModRoutes } from './self-mod'
import { registerChatRoutes } from './chat'
import { registerStatusRoutes } from './status'
import { registerWalletRoutes } from './wallet'
import { registerCredentialRoutes } from './credentials'
import { registerStationRoutes } from './stations'
import { registerRoomMessageRoutes } from './room-messages'
import { registerProviderRoutes } from './providers'
import { registerContactRoutes } from './contacts'

export function registerAllRoutes(router: Router): void {
  registerRoomRoutes(router)
  registerWorkerRoutes(router)
  registerGoalRoutes(router)
  registerDecisionRoutes(router)
  registerTaskRoutes(router)
  registerRunRoutes(router)
  registerMemoryRoutes(router)
  registerSkillRoutes(router)
  registerWatchRoutes(router)
  registerSettingRoutes(router)
  registerEscalationRoutes(router)
  registerSelfModRoutes(router)
  registerChatRoutes(router)
  registerStatusRoutes(router)
  registerWalletRoutes(router)
  registerCredentialRoutes(router)
  registerStationRoutes(router)
  registerRoomMessageRoutes(router)
  registerProviderRoutes(router)
  registerContactRoutes(router)
}
