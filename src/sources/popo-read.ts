/** Trigger-scoped POPO context reader: session pages and single messages, without entering intake. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { CliError, validItems, type Commands } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { contextRow, ContextPayloadSchema, MessageRowSchema, popoRef, popoTime, SearchPageSchema, toolData, type MessageRow } from './popo-trigger.ts'

/** The session a POPO resource reads; every read is anchored to an accepted trigger of that session. */
export interface PopoSessionRef { triggerId: string; session: string; group: boolean; messageId?: string; at?: string }

/** Anchors a resource read to a Trigger's session, reconstructing POPO's integer `sessionType` (3 = group). */
function sessionRef(trigger: Trigger): PopoSessionRef {
  const ref = popoRef(trigger)
  if (!ref) throw new Error('A POPO source trigger is required')
  const messageId = typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined
  return { triggerId: trigger.id, session: ref.session, group: ref.group, messageId, at: trigger.at }
}

/** Runs `popo message_search` restricted to one session's messages within a time window, newest first. */
async function searchSession(commands: Commands, session: string, group: boolean, start: number, end: number,
  page: number, pageSize: number, tally: { skipped: number }): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
  const sessionList = JSON.stringify([{ sessionId: session, sessionType: group ? 3 : 1 }])
  const args = ['message_search', `sessionList=${sessionList}`, 'type=1', `page=${page}`, `pageSize=${pageSize}`,
    'msgType=0', `timeStart=${start}`, `timeEnd=${end}`]
  const payload = toolData<Record<string, unknown>>(await commands.popo(args), 'result_list')
  const result = SearchPageSchema.parse(payload)
  const rows = validItems(MessageRowSchema, result.result_list ?? [], tally).filter(row => row.session_id === session)
  return { rows, hasMore: result.has_more === true || result.has_more === 1 }
}

/** Reads the context block around one message: POPO answers with the message itself among its neighbours. */
async function contextAround(commands: Commands, ref: PopoSessionRef, messageId: string, time: number): Promise<MessageRow[]> {
  const sessionMsg = JSON.stringify([{ sessionId: ref.session, sessionType: ref.group ? 3 : 1, uuids: [messageId], msgTime: [time] }])
  const payload = toolData<Record<string, unknown>>(await commands.popo(['message_context', `sessionMsg=${sessionMsg}`]), 'msgContext')
  const result = ContextPayloadSchema.parse(payload)
  const block = result.msgContext?.find(item => item?.sessionId === ref.session) ?? result.msgContext?.[0]
  return (block?.contextInfo ?? []).flat().map(row => contextRow(row, ref.session, ref.group))
}

export interface PopoPage { status: string; messages: ContextMessage[]; next_resource: string | null; skipped?: number }
function view(row: MessageRow): ContextMessage {
  return { id: row.msg_id ?? '', from: row.memberName || row.nfrom || '', at: popoTime(row.t_msg), text: row.content ?? '' }
}

/**
 * Validates a model-supplied resource string before any network request. The grammar matches the bundled skill:
 * `popo/<trigger-id>/messages/<page>` with page starting at 1.
 */
export function popoResource(resource: string) {
  const match = /^popo\/([^/]+)\/messages\/(\d+)$/.exec(resource)
  if (!match) throw new Error('Use popo/<trigger-id>/messages/1; follow returned next_resource for another page')
  return { triggerId: match[1]!, page: Number(match[2]!) }
}

/**
 * Reads one page of a session's messages, newest first, or all of it when the trigger's own message is no longer in
 * the window. The search window is bounded to guard against unbounded history pulls: it starts 14 days before now.
 */
export async function readPopo(commands: Commands, ref: PopoSessionRef, resource: string, pageSize: number): Promise<PopoPage> {
  const request = popoResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A POPO source trigger of this session is required')
  const end = Date.now() + 1000
  const start = end - 14 * 24 * 3600_000
  const tally = { skipped: 0 }
  const { rows, hasMore } = await searchSession(commands, ref.session, ref.group, start, end, request.page - 1, pageSize, tally)
  return { status: rows.length ? 'available' : 'empty', messages: rows.map(view),
    next_resource: hasMore ? `popo/${ref.triggerId}/messages/${request.page + 1}` : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}

function messageTime(ref: PopoSessionRef): number {
  const time = Date.parse(ref.at ?? '')
  if (!Number.isFinite(time) || !ref.messageId) throw new Error('The POPO source message is unavailable; retained trigger text is still readable')
  return time
}

export const popoThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, part, cursor, config) => {
    const ref = sessionRef(trigger)
    if (part === 'thread') {
      const page = cursor ? Number(cursor) : 1
      if (!Number.isInteger(page) || page < 1) throw new Error('POPO thread pages are numbered from 1')
      const body = await readPopo(commands, ref, `popo/${ref.triggerId}/messages/${page}`, config.readPageSize)
      return { messages: body.messages, next: body.next_resource ? String(page + 1) : undefined, body: { ...body }, status: body.status }
    }
    // POPO search rows carry no reply metadata, so the topic root and the replied-to message both resolve to the
    // message's own context block; the single message named by the trigger is returned alone.
    const time = messageTime(ref)
    try {
      const rows = await contextAround(commands, ref, ref.messageId!, time)
      const own = rows.find(row => row.msg_id === ref.messageId)
      return { messages: own ? [view(own)] : [], body: { status: own ? 'available' : 'unavailable' }, status: own ? 'available' : 'unavailable' }
    } catch (error) {
      if (error instanceof CliError && /not\s*(found|exist)|不存在/i.test(error.message)) return { messages: [], body: { status: 'gone' }, status: 'gone' }
      throw error
    }
  },
}
