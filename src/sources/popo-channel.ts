/** POPO outbound channel: sends plain-text replies as the robot through `popo-robot send` and names sessions without a web link. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { popoThreadId } from './popo-trigger.ts'

/** `popo-robot` exits with 5 when the receiver or session does not exist. */
const NOT_FOUND = 5

/**
 * True when POPO permanently rejects a reply because the receiver no longer exists or cannot be messaged.
 * Only an error naming a missing receiver means the session is gone; timeouts and crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.exitCode === NOT_FOUND || /not\s*(be\s*)?(found|exist)|no\s+such\s+(user|team|group)|不存在/i.test(error.message))

/** Sends a message as the robot into the trigger's session: a user's account for a direct chat, the group's number for a group. */
export async function sendPopo(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const session = message.channel.address.session
  if (!session) throw new Error('Missing POPO reply target')
  const text = checkedImText(message.text)
  try {
    // The text follows `--text` so that text starting with a dash is never read as an option.
    await host.commands.popo(['send', session, '--text', text])
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** POPO sessions have no public deep link; the label names the chat so cards can still cite it. */
export const popoLink = (address: Record<string, string>): ChannelLink => ({
  url: '', label: { zh: 'POPO 消息', en: 'POPO message' },
  ...address.session ? { triggerId: `popo:${popoThreadId(address.session)}` } : {},
})
