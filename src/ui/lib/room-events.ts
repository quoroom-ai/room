export const ROOMS_UPDATE_EVENT = 'rooms:updated' as const
export const ROOMS_QUEEN_STATE_EVENT = 'rooms:queen_state' as const

export const ROOM_ESCALATION_CREATED_EVENT = 'escalation:created' as const
export const ROOM_ESCALATION_RESOLVED_EVENT = 'escalation:resolved' as const
export const ROOM_DECISION_CREATED_EVENT = 'decision:created' as const
export const ROOM_DECISION_RESOLVED_EVENT = 'decision:resolved' as const
export const ROOM_DECISION_VOTE_CAST_EVENT = 'decision:vote_cast' as const
export const ROOM_DECISION_KEEPER_VOTE_EVENT = 'decision:keeper_vote' as const

export const ROOM_GOAL_CREATED_EVENT = 'goal:created' as const
export const ROOM_GOAL_UPDATED_EVENT = 'goal:updated' as const
export const ROOM_GOAL_DELETED_EVENT = 'goal:deleted' as const
export const ROOM_GOAL_PROGRESS_EVENT = 'goal:progress' as const

export const ROOM_MESSAGE_CREATED_EVENT = 'room_message:created' as const
export const ROOM_MESSAGE_UPDATED_EVENT = 'room_message:updated' as const
export const ROOM_MESSAGE_DELETED_EVENT = 'room_message:deleted' as const

export const ROOM_SKILL_CREATED_EVENT = 'skill:created' as const
export const ROOM_SKILL_UPDATED_EVENT = 'skill:updated' as const
export const ROOM_SKILL_DELETED_EVENT = 'skill:deleted' as const

export const ROOM_CREDENTIAL_CREATED_EVENT = 'credential:created' as const
export const ROOM_CREDENTIAL_DELETED_EVENT = 'credential:deleted' as const

export const ROOM_WALLET_SENT_EVENT = 'wallet:sent' as const
export const ROOM_WALLET_RECEIVED_EVENT = 'wallet:received' as const

export const ROOM_UPDATED_EVENT = 'room:updated' as const
export const ROOM_PAUSED_EVENT = 'room:paused' as const
export const ROOM_RESTARTED_EVENT = 'room:restarted' as const
export const ROOM_QUEEN_STARTED_EVENT = 'room:queen_started' as const
export const ROOM_QUEEN_STOPPED_EVENT = 'room:queen_stopped' as const

export const RUN_CREATED_EVENT = 'run:created' as const
export const RUN_COMPLETED_EVENT = 'run:completed' as const
export const RUN_FAILED_EVENT = 'run:failed' as const

export const ROOM_SELF_MOD_EDITED_EVENT = 'self_mod:edited' as const
export const ROOM_SELF_MOD_REVERTED_EVENT = 'self_mod:reverted' as const

export const ROOM_ESCALATION_EVENT_TYPES = new Set([
  ROOM_ESCALATION_CREATED_EVENT,
  ROOM_ESCALATION_RESOLVED_EVENT,
])

export const ROOM_MESSAGE_EVENT_TYPES = new Set([
  ROOM_MESSAGE_CREATED_EVENT,
  ROOM_MESSAGE_UPDATED_EVENT,
  ROOM_MESSAGE_DELETED_EVENT,
])

export const ROOM_DECISION_EVENT_TYPES = new Set([
  ROOM_DECISION_CREATED_EVENT,
  ROOM_DECISION_RESOLVED_EVENT,
  ROOM_DECISION_VOTE_CAST_EVENT,
  ROOM_DECISION_KEEPER_VOTE_EVENT,
])

export const ROOM_GOAL_EVENT_TYPES = new Set([
  ROOM_GOAL_CREATED_EVENT,
  ROOM_GOAL_UPDATED_EVENT,
  ROOM_GOAL_DELETED_EVENT,
  ROOM_GOAL_PROGRESS_EVENT,
])

export const ROOM_SKILL_EVENT_TYPES = new Set([
  ROOM_SKILL_CREATED_EVENT,
  ROOM_SKILL_UPDATED_EVENT,
  ROOM_SKILL_DELETED_EVENT,
])

export const ROOM_CREDENTIAL_EVENT_TYPES = new Set([
  ROOM_CREDENTIAL_CREATED_EVENT,
  ROOM_CREDENTIAL_DELETED_EVENT,
])

export const ROOM_BADGE_EVENT_TYPES = new Set([
  ...ROOM_ESCALATION_EVENT_TYPES,
  ...ROOM_DECISION_EVENT_TYPES,
  ...ROOM_MESSAGE_EVENT_TYPES,
])

export const ROOM_WALLET_EVENT_TYPES = new Set([
  ROOM_WALLET_SENT_EVENT,
  ROOM_WALLET_RECEIVED_EVENT,
])

export const ROOM_BALANCE_EVENT_TYPES = new Set([
  ...ROOM_WALLET_EVENT_TYPES,
])

export const ROOM_NETWORK_EVENT_TYPES = new Set([
  ROOM_UPDATED_EVENT,
  ROOM_PAUSED_EVENT,
  ROOM_RESTARTED_EVENT,
])

export const ROOM_SETTINGS_REFRESH_EVENT_TYPES = new Set([
  ...ROOM_NETWORK_EVENT_TYPES,
  ROOM_QUEEN_STARTED_EVENT,
  ROOM_QUEEN_STOPPED_EVENT,
  ...ROOM_CREDENTIAL_EVENT_TYPES,
])
