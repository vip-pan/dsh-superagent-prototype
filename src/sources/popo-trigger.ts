/** POPO message normalization: the popo-robot CLI's event and history lines become Triggers and context messages with deterministic IDs. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const SOURCE = 'popo'
const DIRECT_EVENT = 'IM_P2P_TO_ROBOT_MSG'
const MENTION_EVENT = 'IM_CHAT_TO_ROBOT_AT_MSG'

/** One message of a session, from a robot event or the history API. */
export interface PopoMessage { id: string; from: string; at: string; text: string; session: string; group: boolean; mentioned?: boolean }

/**
 * One line of `popo-robot listen` or `popo-robot history`: the CLI's normalized event or message. Only the fields the Source reads
 * are checked; the rest of the contract (kind, quote, file, command) passes through unread.
 */
export const PopoLineSchema = z.looseObject({
  type: z.string(), eventType: z.string().nullish(), id: z.string().nullish(), at: z.string().nullish(),
  session: z.looseObject({ id: z.string().nullish(), type: z.enum(['p2p', 'group']).nullish() }).default({}),
  from: z.string().nullish(), text: z.string().nullish(), mentionsRobot: z.boolean().default(false),
})
export type PopoLine = z.infer<typeof PopoLineSchema>
const str = (value: unknown): string => typeof value === 'string' ? value : ''

/** The message a robot event line carries; other events (recalls, joins, commands) and status lines are not messages. */
export function eventMessage(line: PopoLine): PopoMessage | undefined {
  if (line.type !== 'event' || (line.eventType !== DIRECT_EVENT && line.eventType !== MENTION_EVENT)) return undefined
  const id = str(line.id), from = str(line.from)
  const group = line.session.type === 'group'
  const session = str(line.session.id) || (group ? '' : from)
  if (!id || !session) return undefined
  return { id, from, session, group, ...line.mentionsRobot && group ? { mentioned: true } : {}, at: str(line.at) || new Date().toISOString(), text: str(line.text) }
}

export const popoThreadId = (session: string): string => `session:${session}`
export const popoTriggerId = (messageId: string): string => key(SOURCE, messageId)
export const popoChannel = (session: string, group: boolean): { source: string; thread: string; address: Record<string, string> } =>
  ({ source: SOURCE, thread: `${SOURCE}:${popoThreadId(session)}`, address: { session, type: group ? 'group' : 'direct' } })

export interface PopoRef { session: string; group: boolean }
/** The session reference a Trigger's thread names. */
export function popoRef(trigger: Pick<Trigger, 'meta'>): PopoRef | undefined {
  const session = trigger.meta.session, type = trigger.meta.sessionType
  if (typeof session !== 'string' || !session) return undefined
  return { session, group: type === 'group' }
}

/**
 * A message becomes a Trigger; the robot's own messages are dropped. Direct chats address the agent, group messages
 * only when they mention the robot, and the Policy's admission table decides about the rest.
 */
export function popoTrigger(message: PopoMessage, robot: string): Trigger | undefined {
  if (robot && message.from === robot) return undefined
  return {
    id: popoTriggerId(message.id), source: SOURCE,
    threads: [{ source: SOURCE, id: popoThreadId(message.session) }],
    actor: { source: SOURCE, id: message.from }, human: true,
    ...!message.group ? { addressed: 'direct' as const } : message.mentioned ? { addressed: 'mention' as const } : {},
    at: message.at, text: message.text,
    channel: popoChannel(message.session, message.group),
    meta: { messageId: message.id, session: message.session, sessionType: message.group ? 'group' : 'direct' },
  }
}

/** A history line as a message of the session. */
export function historyMessage(line: PopoLine, session: string, group: boolean): PopoMessage {
  return { id: str(line.id), from: str(line.from), session, group, at: str(line.at) || new Date(0).toISOString(), text: str(line.text) }
}
