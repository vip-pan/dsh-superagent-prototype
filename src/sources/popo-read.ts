/** Trigger-scoped POPO context reader: session pages and single messages from the history API, without entering intake. */
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { CliError, validItems } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { historyMessage, PopoLineSchema, popoRef, type PopoMessage } from './popo-trigger.ts'

/** The session a POPO resource reads; every read is anchored to an accepted trigger of that session. */
export interface PopoSessionRef { triggerId: string; session: string; group: boolean; messageId?: string; at?: string }

/** Anchors a resource read to a Trigger's session. */
function sessionRef(trigger: Trigger): PopoSessionRef {
  const ref = popoRef(trigger)
  if (!ref) throw new Error('A POPO source trigger is required')
  const messageId = typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined
  return { triggerId: trigger.id, session: ref.session, group: ref.group, messageId, at: trigger.at }
}

/** Messages of one session before `end` (epoch milliseconds), newest first, as `popo-robot history` answers: the last 30 days only. */
async function history(commands: Commands, ref: PopoSessionRef, end: number, count: number, tally: { skipped: number }): Promise<PopoMessage[]> {
  const output = await commands.popo(['history', ref.session, '--type', ref.group ? 'group' : 'p2p', '--before', String(end), '--count', String(count)])
  const lines = output.split('\n').filter(line => line.trim()).map((line): unknown => { try { return JSON.parse(line) } catch { return undefined } })
  return validItems(PopoLineSchema, lines, tally).filter(line => line.type === 'message').map(line => historyMessage(line, ref.session, ref.group))
    .filter(message => message.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

export interface PopoPage { status: string; messages: ContextMessage[]; next_resource: string | null; skipped?: number }
const view = (message: PopoMessage): ContextMessage => ({ id: message.id, from: message.from, at: message.at, text: message.text })

/**
 * Validates a model-supplied resource string before any network request. The grammar matches the bundled skill:
 * `popo/<trigger-id>/messages/<page>`, where page 1 is the newest messages and a later page is the `next_resource` a page returned.
 */
export function popoResource(resource: string) {
  const match = /^popo\/([^/]+)\/messages\/(\d+)$/.exec(resource)
  if (!match) throw new Error('Use popo/<trigger-id>/messages/1; follow returned next_resource for another page')
  return { triggerId: match[1]!, page: Number(match[2]!) }
}

/** Reads one page of a session's messages, newest first; `next_resource` names the page that continues before the oldest message. */
export async function readPopo(commands: Commands, ref: PopoSessionRef, resource: string, pageSize: number): Promise<PopoPage> {
  const request = popoResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A POPO source trigger of this session is required')
  const end = request.page === 1 ? Date.now() + 1000 : request.page
  const tally = { skipped: 0 }
  const messages = await history(commands, ref, end, pageSize, tally)
  const oldest = messages.length ? Date.parse(messages[messages.length - 1]!.at) - 1 : 0
  const more = messages.length >= pageSize && oldest > 1 && oldest < end
  return { status: messages.length ? 'available' : 'empty', messages: messages.map(view),
    next_resource: more ? `popo/${ref.triggerId}/messages/${oldest}` : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}

/** True when the history API itself refuses the read: the account is not on its allow list, or is not in the group. */
const refused = (error: unknown): boolean => error instanceof CliError && (error.exitCode === 5 || /not\s*(found|exist)|不存在/i.test(error.message))

export const popoThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, part, cursor, config) => {
    const ref = sessionRef(trigger)
    if (part === 'thread') {
      const page = cursor ? Number(cursor) : 1
      if (!Number.isInteger(page) || page < 1) throw new Error('POPO thread pages are numbered from 1 or by a returned cursor')
      const body = await readPopo(commands, ref, `popo/${ref.triggerId}/messages/${page}`, config.readPageSize)
      const next = body.next_resource?.split('/').pop()
      return { messages: body.messages, next, body: { ...body }, status: body.status }
    }
    // POPO messages carry no reply metadata, so the topic root and the replied-to message both resolve to the trigger's own message,
    // found among the messages just before its time.
    const time = Date.parse(ref.at ?? '')
    if (!Number.isFinite(time) || !ref.messageId) throw new Error('The POPO source message is unavailable; retained trigger text is still readable')
    try {
      const own = (await history(commands, ref, time + 1000, 50, { skipped: 0 })).find(message => message.id === ref.messageId)
      return { messages: own ? [view(own)] : [], body: { status: own ? 'available' : 'unavailable' }, status: own ? 'available' : 'unavailable' }
    } catch (error) {
      if (refused(error)) return { messages: [], body: { status: 'gone' }, status: 'gone' }
      throw error
    }
  },
}
