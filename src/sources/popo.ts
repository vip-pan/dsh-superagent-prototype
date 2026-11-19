/** POPO source kind definition and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { PopoBotSchema } from '../deployment.ts'
import { popoLink, sendPopo } from './popo-channel.ts'
import { runPopo } from './popo-loops.ts'
import { popoThreadContext } from './popo-read.ts'
import { popoRef, SOURCE } from './popo-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

const PopoConfigSchema = PopoBotSchema.extend({
  readPageSize: z.number().int().min(1).max(50).default(20),
  chats: z.array(z.object({ chatId: z.string().regex(/^[\w@.\-]{1,64}$/), name: z.string().trim().max(60).optional() }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type PopoConfig = z.infer<typeof PopoConfigSchema>
export const popoKind: SourceKind<PopoConfig> = {
  kind: SOURCE,
  title: { zh: 'POPO', en: 'POPO' },
  description: { zh: '通过 popo-robot CLI 以机器人身份接入 POPO，接收私聊与群里的消息并发起工单。', en: 'Connects to POPO as a robot through the popo-robot CLI, receiving direct and group messages to originate work.' },
  schema: PopoConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '机器人的 popo-robot CLI', en: 'Robot popo-robot CLI' },
      hint: { zh: '命令名或绝对路径，指向已配置好机器人凭据的 popo-robot（可以是带 POPO_ROBOT_CONFIG_DIR 的包装脚本）；凭据只在 CLI 里，不进 dsh-superagent。保存时用 whoami 读取机器人账号，然后重启 dsh-superagent。', en: 'A command name or absolute path of a popo-robot with the robot\'s credentials configured (a wrapper that sets POPO_ROBOT_CONFIG_DIR works); the credentials stay in the CLI, never in dsh-superagent. Saving reads the robot account with whoami, then restarts dsh-superagent.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: 'POPO 只把群里 @ 机器人的消息推给机器人，群里的其他消息收不到，所以没有“全部消息”可选。这里列出的群，机器人被 @ 时一定接收；机器人需要先被加进群。', en: 'POPO pushes a group\'s messages to the robot only when they mention it; the others never arrive, so there is no "all messages" choice. A listed chat always receives the messages that mention the robot, which must have been added to the chat first.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群号', en: 'Chat' }, pattern: '[\\w@.\\-]{1,64}' },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '接收 @', en: 'Mentions' } }],
      hint: { zh: '机器人已被加入、但没列在上面的群。“接收 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats the robot has been added to that are not listed above. "Mentions" receives the messages there that mention the robot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' }, hint: { zh: '智能体读取会话时，每页的消息数。', en: 'Messages per page when agents read a session.' } },
  ],
  health: ['popo'],
  scope({ meta }, settings) {
    const ref = popoRef({ meta })
    if (!ref) return { listened: false, reason: 'session_unknown' }
    if (!ref.group) return settings.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = settings.chats.find(item => item.chatId === ref.session)
    if (chat) return { listened: true, observed: false, row: chat.chatId }
    return settings.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a session the Source still receives.
  channel: {
    allowed: (address, settings) =>
      popoKind.scope!({ meta: { session: address.session ?? '', sessionType: address.type } }, settings).listened,
    send: sendPopo, link: popoLink,
  },
  threadContext: popoThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/[\w@.\-]{3,64}/g) ?? [])].slice(0, 5) }),
  policy: {
    unnamed: { person: { zh: 'POPO 用户', en: 'POPO user' }, bot: { zh: 'POPO 机器人', en: 'POPO bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[\w@.\-]{1,64}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate account ids').default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[\w@.\-]{1,64}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 POPO 用户', en: 'POPO users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[\\w@.\\-]{1,64}' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人在接收的群里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。', en: 'Messages of a bot on this list, in chats the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots\' messages are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[\\w@.\\-]{1,64}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人私聊账号，总是明确的请求，不需要配置。', en: 'Someone on the list who messages the account directly always makes an explicit request; that needs no setting.' },
    rows(settings) {
      const parsed = PopoConfigSchema.parse(settings)
      const mentions = { zh: '接收 @', en: 'Mentions' }
      return [
        ...parsed.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: mentions,
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: parsed.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: parsed.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: parsed.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: parsed.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_POPO_ACCOUNT', description: { zh: 'POPO 机器人账号', en: 'The POPO robot account' } },
      { key: 'DSH_SUPERAGENT_POPO_CHAT', description: { zh: '接下工单的 POPO 会话；工单不是从 POPO 来的时候为空', en: 'The POPO session that started the ticket; empty when the ticket did not start on POPO' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_POPO_ACCOUNT: deployment.popo?.uid ?? '', DSH_SUPERAGENT_POPO_CHAT: trigger?.source === SOURCE ? String(trigger.meta.session ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.popo ? { cli: { zh: `当前机器人 ${deployment.popo.uid}`, en: `Current robot ${deployment.popo.uid}` } } : {},
}
/** Returns the POPO Source's settings, falling back to schema defaults while the POPO plugin is disabled. */
export const popoSettings = (sources: SourceRegistry): PopoConfig => sources.instance<PopoConfig>(SOURCE)?.config ?? PopoConfigSchema.parse({})

export const name = 'dsh-superagent-popo'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(popoKind), 'popo: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runPopo(sourceContext(ctx.orchestrator, popoKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
