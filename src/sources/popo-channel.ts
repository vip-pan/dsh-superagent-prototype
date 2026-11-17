/** POPO outbound channel: sends plain-text replies through the agent account and names sessions without a web link. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { popoThreadId } from './popo-trigger.ts'

/**
 * True when POPO permanently rejects a reply because the receiver no longer exists or cannot be messaged.
 * Only a tool failure naming a missing receiver means the session is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError
  && (/not\s*(be\s*)?(found|exist)|no\s+such\s+(user|team|group)|不存在/i.test(error.message) || error.code === 404)
/**
 * Sends a message as the agent account into the trigger's session. Arguments pass through `execFile` argv, so message
 * text needs no shell quoting; `source=AGENT` marks automation-sent messages on both direct and team chats.
 */
export async function sendPopo(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const session = message.channel.address.session
  const type = message.channel.address.type
  if (!session) throw new Error('Missing POPO reply target')
  const tool = type === 'group' ? 'message_send_team' : 'message_send_p2p'
  const text = checkedImText(message.text)
  try {
    await host.commands.popo([tool, `message=${text}`, `receiver=${session}`, 'source=AGENT'])
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
