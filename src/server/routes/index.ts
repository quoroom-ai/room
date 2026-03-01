import type { Router } from '../router'
import { registerRoomRoutes } from './rooms'
import { registerWorkerRoutes } from './workers'
import { registerGoalRoutes } from './goals'
import { registerDecisionRoutes } from './decisions'
import { registerTaskRoutes } from './tasks'
import { registerRunRoutes } from './runs'
import { registerMemoryRoutes } from './memory'
import { registerSkillRoutes } from './skills'
import { registerSettingRoutes } from './settings'
import { registerEscalationRoutes } from './escalations'
import { registerSelfModRoutes } from './self-mod'
import { registerStatusRoutes } from './status'
import { registerWalletRoutes } from './wallet'
import { registerCredentialRoutes } from './credentials'
import { registerRoomMessageRoutes } from './room-messages'
import { registerProviderRoutes } from './providers'
import { registerContactRoutes } from './contacts'
import { registerClerkRoutes } from './clerk'

export function registerAllRoutes(router: Router): void {
  registerRoomRoutes(router)
  registerWorkerRoutes(router)
  registerGoalRoutes(router)
  registerDecisionRoutes(router)
  registerTaskRoutes(router)
  registerRunRoutes(router)
  registerMemoryRoutes(router)
  registerSkillRoutes(router)
  registerSettingRoutes(router)
  registerEscalationRoutes(router)
  registerSelfModRoutes(router)
  registerStatusRoutes(router)
  registerWalletRoutes(router)
  registerCredentialRoutes(router)
  registerRoomMessageRoutes(router)
  registerProviderRoutes(router)
  registerContactRoutes(router)
  registerClerkRoutes(router)
}
