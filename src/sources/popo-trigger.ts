/** POPO message event normalization: search results and context rows become Triggers with deterministic IDs. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const SOURCE = 'popo'
/** POPO reports `sessionType: 3` for team (group) chats; other values are direct chats. */
const GROUP = 3

/**
 * A message row of `popo message_search`; `message_context` rows carry the same data under different names
 * (`uuid`, `timetag`, `context`), which `contextRow` normalizes into this shape.
 */
export const MessageRowSchema = z.looseObject({
  msg_id: z.string().nullish(), t_msg: z.union([z.number(), z.string()]).nullish(),
  nfrom: z.string().nullish(), session_id: z.string().nullish(), sessionType: z.number().nullish(),
  content: z.string().nullish(), sessionName: z.string().nullish(), memberName: z.string().nullish(),
})
export type MessageRow = z.infer<typeof MessageRowSchema>

/** A row of `popo message_context`: `{ timetag, nfrom, nto, context, uuid }`. */
const ContextRowSchema = z.looseObject({ uuid: z.string().nullish(), timetag: z.union([z.number(), z.string()]).nullish(),
  nfrom: z.string().nullish(), nto: z.string().nullish(), context: z.string().nullish() })
/** Normalizes a message_context row into a search-row shape so both paths share one Trigger builder. */
export function contextRow(row: z.infer<typeof ContextRowSchema>, session: string, group: boolean): MessageRow {
  return { msg_id: row.uuid ?? undefined, t_msg: row.timetag ?? undefined, nfrom: row.nfrom ?? undefined,
    session_id: session, sessionType: group ? GROUP : undefined, content: row.context ?? undefined }
}
/** Peels the `data` nesting `popo-cli` wraps tool payloads in, stopping at the object that carries `marker`. */
export function toolData<T extends Record<string, unknown>>(payload: unknown, marker: string): T {
  let current: unknown = payload
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if (typeof (current as Record<string, unknown>)[marker] !== 'undefined') return current as T
    current = (current as { data?: unknown }).data
  }
  throw new Error(`popo-cli returned no ${marker} payload`)
}

/** One page of `popo message_search`: newest first, `page + 1` while `has_more`. */
export const SearchPageSchema = z.looseObject({
  has_more: z.union([z.boolean(), z.number()]).nullish(), page: z.number().nullish(),
  result_list: z.array(MessageRowSchema).nullish(),
})
export type SearchPage = z.infer<typeof SearchPageSchema>

/** The response of `popo message_context`; each searched message contributes one group of surrounding rows. */
export const ContextPayloadSchema = z.looseObject({
  msgContext: z.array(z.looseObject({ sessionId: z.string().nullish(), sessionType: z.number().nullish(),
    contextInfo: z.array(z.array(ContextRowSchema)).nullish() }).nullable()).nullish(),
})

/** `t_msg` is epoch milliseconds, as a number or a numeric string. */
export const popoTime = (value: number | string | null | undefined): string =>
  new Date(Number(value ?? 0)).toISOString()

export const popoThreadId = (session: string): string => `session:${session}`
export const popoTriggerId = (messageId: string): string => key(SOURCE, messageId)
export const popoChannel = (session: string, group: boolean): { source: string; thread: string; address: Record<string, string> } =>
  ({ source: SOURCE, thread: `${SOURCE}:${popoThreadId(session)}`, address: { session, type: group ? 'group' : 'direct' } })

/** True when a message row belongs to a team (group) chat rather than a direct chat. */
export const isGroup = (row: MessageRow): boolean => row.sessionType === GROUP

export interface PopoRef { session: string; group: boolean }

/** The session reference a Trigger's thread names. */
export function popoRef(trigger: Pick<Trigger, 'meta'>): PopoRef | undefined {
  const session = trigger.meta.session, type = trigger.meta.sessionType
  if (typeof session !== 'string' || !session) return undefined
  return { session, group: type === 'group' }
}

/**
 * A message row becomes a Trigger; the sender's own messages are dropped. Direct chats address the agent; group chats
 * carry `addressed` only when a mention is present, which POPO search rows do not report, so group messages arrive
 * unaddressed and the Policy's admission table decides.
 */
export function popoTrigger(row: MessageRow, account: string): Trigger | undefined {
  if (!row.msg_id || !row.session_id) return undefined
  if (row.nfrom && account && row.nfrom === account) return undefined
  const group = isGroup(row)
  return {
    id: popoTriggerId(row.msg_id), source: SOURCE,
    threads: [{ source: SOURCE, id: popoThreadId(row.session_id) }],
    actor: { source: SOURCE, id: row.nfrom ?? '' }, human: true,
    ...!group ? { addressed: 'direct' as const } : {},
    at: popoTime(row.t_msg), text: row.content ?? '',
    channel: popoChannel(row.session_id, group),
    meta: { messageId: row.msg_id, session: row.session_id, sessionType: group ? 'group' : 'direct',
      ...row.sessionName ? { sessionName: row.sessionName } : {}, ...row.memberName ? { senderName: row.memberName } : {} },
  }
}
