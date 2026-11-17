/** GitLab outbound channel: posts issue and merge request notes under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError, validItems } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), system: z.boolean().nullish(),
  author: z.looseObject({ username: z.string().nullish() }).nullish(),
})
/** True when the project, issue, or merge request is deleted (404/410); GitLab also 404s confidential items the account lost access to. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** Posts a note with an embedded HTML marker so retries do not create duplicate notes. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { gitlab } = commands.deployment
  if (!gitlab) throw new Error('The GitLab Source has no working CLI')
  const kind = message.channel.address.kind === 'mr' ? 'mr' : 'issue'
  const iid = Number(message.channel.address.iid)
  if (!iid) throw new Error('Missing GitLab reply target')
  const path = `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const mine = (note: z.infer<typeof NoteSchema>) =>
      !note.system && sameName(note.author?.username ?? '', gitlab.login) && (note.body ?? '').includes(marker)
    const recent = await commands.gitlabApi(z.array(z.unknown()), `${path}?sort=desc&order_by=created_at&per_page=100`)
    if (validItems(NoteSchema, recent).some(mine)) return 'sent'
    await commands.gitlabApi(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const iid = address.iid ?? ''
  const mr = address.kind === 'mr'
  return { url: address.url ?? (links.gitlab ? `https://${links.gitlab.host}/${links.gitlab.repository}/-/${mr ? 'merge_requests' : 'issues'}/${iid}` : ''),
    label: { zh: `GitLab ${mr ? '!' : '#'}${iid}`, en: `GitLab ${mr ? '!' : '#'}${iid}` } }
}
