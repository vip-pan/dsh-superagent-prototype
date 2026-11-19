/** POPO background loop: one `popo-robot listen` process delivering the robot's events as NDJSON lines, each a message to receive. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import type { PopoBot } from '../deployment.ts'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import { consumerRetry } from './feishu-loops.ts'
import { eventMessage, PopoLineSchema, popoTrigger, SOURCE, type PopoLine, type PopoMessage } from './popo-trigger.ts'
import type { PopoConfig } from './popo.ts'

const SEEN_LIMIT = 200
/** A failed connection stays quiet; three in a row report. */
const FAILURES_BEFORE_ERROR = 3
/** How often a running connection checks that the Source is still on. */
const SWITCH_CHECK_MS = 5000

const settings = (ctx: SourceContext): PopoConfig | undefined => ctx.config<PopoConfig>(SOURCE)

/** True when the session's messages pass the Source's receive switches; the Policy's admission still applies downstream. */
export function listened(message: PopoMessage, config: PopoConfig): boolean {
  if (!message.group) return config.directMessages
  return config.chats.some(chat => chat.chatId === message.session) || config.otherChats === 'mentions'
}

/** True when `id` is new for the thread; remembers it and trims the remembered ids to `SEEN_LIMIT`. */
function seen(ctx: SourceContext, thread: string, id: string): boolean {
  const remembered = ctx.state.get(KV.popo.seen(thread)) ?? []
  if (remembered.includes(id)) return false
  ctx.state.set(KV.popo.seen(thread), [...remembered, id].slice(-SEEN_LIMIT))
  return true
}

async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  for (const ref of trigger.threads) {
    const chat = trigger.meta.sessionType === 'group' ? { value: String(trigger.meta.session) } : { value: { zh: '私聊', en: 'Direct message' } }
    ctx.threads.describe(threadKey(ref), { facts: { chat } })
    ctx.state.set(KV.popo.sessions, { ...ctx.state.get(KV.popo.sessions) ?? {}, [String(trigger.meta.session)]: true })
  }
}

/** Receives the message of one event when its session is listened to and the Source is on. */
export async function handleEvent(ctx: SourceContext, line: PopoLine): Promise<boolean> {
  const config = settings(ctx), bot = ctx.deployment.popo
  if (!config || !bot) return false
  const message = eventMessage(line)
  if (!message || !listened(message, config)) return false
  const trigger = popoTrigger(message, bot.uid)
  if (!trigger || !seen(ctx, trigger.threads[0]!.id, message.id)) return false
  await receive(ctx, trigger)
  return true
}

/** A status line of `popo-robot listen`: its connection state, with the reason when it is not ready. */
const StatusSchema = z.looseObject({ type: z.literal('status'), state: z.string(), detail: z.string().nullish() })

/**
 * Runs one `popo-robot listen` until it exits or `signal` aborts. Its deduplication state lives beside the Source's own state so a restart
 * does not replay what it already delivered. Status lines drive the Source's health; event lines are received in order.
 */
async function listen(ctx: SourceContext, bot: PopoBot, signal: AbortSignal): Promise<void> {
  const state = join(ctx.deployment.stateDir, 'popo-listen.json')
  const child = spawn(bot.cli, ['listen', '--state-file', state], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const stdout = createInterface({ input: child.stdout }), stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(), diagnostic = '', failures = 0
  const stop = (): void => { child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  stderr.on('line', (line: string) => { diagnostic = line.slice(0, 2000) })
  stdout.on('line', (text: string) => {
    chain = chain.then(async () => {
      if (text.length > 1_048_576) throw new Error('POPO event exceeds 1 MiB')
      const json: unknown = JSON.parse(text)
      const status = StatusSchema.safeParse(json)
      if (status.success) {
        if (status.data.state === 'ready') { failures = 0; ctx.report(SOURCE, { state: 'ready', detail: 'Connected', at: new Date().toISOString() }) }
        else if ((status.data.state === 'reconnecting' || status.data.state === 'failed') && !signal.aborted) {
          failures += 1
          if (failures >= FAILURES_BEFORE_ERROR) ctx.report(SOURCE, health('error', 'connectionFailures', { count: String(failures), error: status.data.detail ?? diagnostic }))
        }
        return
      }
      const line = PopoLineSchema.safeParse(json)
      // Events read after the Source is switched off are dropped; the process stops within seconds.
      if (line.success && settings(ctx)) await handleEvent(ctx, line.data)
    }).catch(error => { ctx.report(SOURCE, { state: 'error', detail: String(error) }) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => signal.aborted ? resolve() : reject(new Error(`popo-robot listen exited (${code}): ${diagnostic}`)))
    })
  } finally { signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let retry: number | undefined
  while (!signal.aborted) {
    const bot = ctx.deployment.popo
    if (!settings(ctx)) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else if (!bot) ctx.report(SOURCE, health('paused', 'popoUnset'))
    else {
      // The process runs while the Source is on; switching it off stops it.
      const running = new AbortController()
      const stop = () => running.abort()
      signal.addEventListener('abort', stop, { once: true })
      const timer = setInterval(() => { if (!settings(ctx)) running.abort() }, SWITCH_CHECK_MS)
      const began = Date.now()
      try { await listen(ctx, bot, running.signal) }
      catch (error) { if (!running.signal.aborted) ctx.report(SOURCE, health('error', 'connectionFailures', { count: '1', error: String(error) })) }
      finally { clearInterval(timer); signal.removeEventListener('abort', stop) }
      if (signal.aborted) break
      if (!running.signal.aborted) { retry = consumerRetry(retry, Date.now() - began); await delay(retry, undefined, { signal }).catch(() => {}); continue }
    }
    await pause(SWITCH_CHECK_MS, signal)
  }
}

/** Runs the POPO listener until `signal` aborts; `apply` contains an escaping failure as source health. */
export function runPopo(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  return watch(ctx, signal)
}
