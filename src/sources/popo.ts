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
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  chats: z.array(z.object({ chatId: z.string().regex(/^[\w@.\-]{1,64}$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type PopoConfig = z.infer<typeof PopoConfigSchema>
export const popoKind: SourceKind<PopoConfig> = {
  kind: SOURCE,
  title: { zh: 'POPO', en: 'POPO' },
  description: { zh: '轮询下列群和私聊的消息，接收私聊与群消息并发起工单。', en: 'Polls messages of the listed chats and direct messages, receiving them to originate work.' },
  schema: PopoConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '账号的 popo-cli', en: 'Account popo-cli' },
      hint: { zh: '命令名或绝对路径，指向登录了智能体账号的 popo-cli；执行器以 popo-cli 调用它。保存时读取账号，然后重启 dsh-superagent。', en: 'A command name or absolute path of a popo-cli signed in to the agent account; the Executor calls it as popo-cli. Saving reads the account, then restarts dsh-superagent.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '“仅订阅”只接收已有工单的会话的消息；“全部消息”也接收其余消息，评估可以按规则从中推断工作。', en: '"Subscribed only" receives messages of sessions that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: '[\\w@.\\-]{1,64}' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅订阅', en: 'Subscribed only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅订阅', en: 'Subscribed only' } }],
      hint: { zh: '账号已加入、但没列在上面的群。“仅订阅”接收那里已有工单的会话的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats the account has joined that are not listed above. "Subscribed only" receives messages of sessions that have Tickets; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' }, hint: { zh: '智能体读取会话时，每页的消息数。', en: 'Messages per page when agents read a session.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / s' }, hint: { zh: '两次消息搜索之间的最小间隔。', en: 'The minimum interval between message searches.' } },
  ],
  health: ['popo'],
  scope({ meta }, settings) {
    const ref = popoRef({ meta })
    if (!ref) return { listened: false, reason: 'session_unknown' }
    if (!ref.group) return settings.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = settings.chats.find(item => item.chatId === ref.session)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
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
      const subscribed = { zh: '仅订阅', en: 'Subscribed only' }
      return [
        ...parsed.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : subscribed,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: parsed.otherChats === 'mentions' ? subscribed : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: parsed.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: parsed.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: parsed.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_POPO_ACCOUNT', description: { zh: 'POPO 账号；popo-cli 以它行事', en: 'The POPO account; popo-cli acts as it' } },
      { key: 'DSH_SUPERAGENT_POPO_CHAT', description: { zh: '接下工单的 POPO 会话；工单不是从 POPO 来的时候为空', en: 'The POPO session that started the ticket; empty when the ticket did not start on POPO' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_POPO_ACCOUNT: deployment.popo?.uid ?? '', DSH_SUPERAGENT_POPO_CHAT: trigger?.source === SOURCE ? String(trigger.meta.session ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.popo ? { cli: { zh: `当前账号 ${deployment.popo.uid}`, en: `Current account ${deployment.popo.uid}` } } : {},
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
