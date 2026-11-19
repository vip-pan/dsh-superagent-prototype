import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { CliError, commandError } from '../src/infra/commands.ts'
import { dropLegacyPopo } from '../src/policy.ts'
import { popoKind } from '../src/sources/popo.ts'
import { sendPopo } from '../src/sources/popo-channel.ts'
import { listened, runPopo } from '../src/sources/popo-loops.ts'
import { readPopo } from '../src/sources/popo-read.ts'
import { eventMessage, historyMessage, PopoLineSchema, popoTrigger } from '../src/sources/popo-trigger.ts'

/** A line of `popo-robot listen` as the CLI's normalized event contract prints it. */
const line = (extra: Record<string, unknown>) => PopoLineSchema.parse({ type: 'event', eventType: 'IM_P2P_TO_ROBOT_MSG', id: 'u1', at: '2026-01-02T02:00:00.000Z',
  session: { id: 'ann@corp', type: 'p2p' }, from: 'ann@corp', text: 'fix it', ...extra })

describe('POPO messages', () => {
  it('turns direct messages and mentions into Triggers, and drops the robot\'s own', () => {
    const message = eventMessage(line({}))!
    expect(message.at).toBe('2026-01-02T02:00:00.000Z')
    expect(popoTrigger(message, 'bot@app')).toMatchObject({ id: expect.any(String), source: 'popo', addressed: 'direct', human: true, actor: { id: 'ann@corp' },
      threads: [{ source: 'popo', id: 'session:ann@corp' }], channel: { address: { session: 'ann@corp', type: 'direct' } }, text: 'fix it', meta: { session: 'ann@corp', sessionType: 'direct' } })
    const mention = eventMessage(line({ eventType: 'IM_CHAT_TO_ROBOT_AT_MSG', id: 'u2', session: { id: '1000014361', type: 'group' }, text: 'go', mentionsRobot: true }))!
    expect(popoTrigger(mention, 'bot@app')).toMatchObject({ addressed: 'mention', text: 'go', channel: { address: { session: '1000014361', type: 'group' } } })
    expect(popoTrigger({ ...message, from: 'bot@app' }, 'bot@app')).toBeUndefined()
  })
  it('reads only message events: status lines, other events and lines without an id or session are not messages', () => {
    expect(eventMessage(PopoLineSchema.parse({ type: 'status', state: 'ready' }))).toBeUndefined()
    expect(eventMessage(line({ eventType: 'IM_MSG_EDIT' }))).toBeUndefined()
    expect(eventMessage(line({ id: '' }))).toBeUndefined()
    expect(eventMessage(line({ session: {}, from: '' }))).toBeUndefined()
    // A direct message without a session id is the sender's own session.
    expect(eventMessage(line({ session: { type: 'p2p' } }))).toMatchObject({ session: 'ann@corp', group: false })
  })
  it('turns history lines into messages', () => {
    expect(historyMessage(PopoLineSchema.parse({ type: 'message', id: 'h', from: 'ann@corp', text: 'hey', at: '2026-01-02T02:00:00.000Z' }), 'g', true))
      .toEqual({ id: 'h', from: 'ann@corp', session: 'g', group: true, at: '2026-01-02T02:00:00.000Z', text: 'hey' })
  })
})

describe('POPO replies and reads', () => {
  const host = (popo: (args: string[]) => Promise<string>) => ({ commands: { popo, deployment: { popo: { cli: 'popo-robot', uid: 'bot@app' } } } }) as never
  const message = (session: string): OutboundMessage => ({ id: 'dsh-superagent:r1', text: 'done', kind: 'reply', channel: { source: 'popo', thread: 'popo:session:' + session, address: { session, type: 'group' } } }) as OutboundMessage
  it('sends a reply through the CLI, reporting a vanished receiver as gone and other failures as errors', async () => {
    const popo = vi.fn(async (_args: string[]) => '{}')
    expect(await sendPopo(host(popo), message('1000014361'))).toBe('sent')
    expect(popo).toHaveBeenCalledWith(['send', '1000014361', '--text', 'done'])
    expect(await sendPopo(host(async () => { throw new CliError('group not found', undefined, 5) }), message('1'))).toBe('gone')
    expect(await sendPopo(host(async () => { throw new CliError('no such group', undefined, 1) }), message('1'))).toBe('gone')
    await expect(sendPopo(host(async () => { throw new CliError('busy', 500, 1) }), message('1'))).rejects.toBeInstanceOf(CliError)
  })
  it('reads a session newest first and names the page that continues before the oldest message', async () => {
    const rows = [{ type: 'message', id: 'a', from: 'ann@corp', text: 'one', at: new Date(1_000_000).toISOString() },
      { type: 'message', id: 'b', from: 'bob@corp', text: 'two', at: new Date(2_000_000).toISOString() }, { type: 'message', id: '', text: 'dropped' }, { oops: true }]
    const popo = vi.fn(async (_args: string[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\nnot json\n')
    const ref = { triggerId: 't1', session: '1000014361', group: true }
    const page = await readPopo({ popo } as never, ref, 'popo/t1/messages/1', 2)
    expect(page.messages.map(m => m.id)).toEqual(['b', 'a'])
    expect(page.next_resource).toBe('popo/t1/messages/999999')
    expect(popo.mock.calls[0]![0]).toEqual(['history', '1000014361', '--type', 'group', '--before', expect.any(String), '--count', '2'])
    await expect(readPopo({ popo } as never, ref, 'popo/other/messages/1', 2)).rejects.toThrow('trigger')
    await expect(readPopo({ popo } as never, ref, 'popo/t1/thread', 2)).rejects.toThrow('popo/<trigger-id>')
  })
  it('keeps the CLI\'s API error number as the error code and its exit status', () => {
    const failure = Object.assign(new Error('x'), { code: 5, stderr: '{"error":{"code":"not_found","message":"no such group","errcode":60001}}' })
    expect(commandError(failure, 'popo-robot')).toMatchObject({ message: 'no such group (60001)', code: 60001, exitCode: 5 })
  })
})

describe('POPO chat settings', () => {
  const config = { cli: 'popo-robot', readPageSize: 20, directMessages: true, otherChats: 'none' as 'none' | 'mentions' }
  it('receives the mentions of a listed chat and of other chats only when switched on, and offers no all-messages mode', () => {
    const settings = { ...config, chats: [{ chatId: '1696900' }] }
    const scope = (session: string, on = settings) => popoKind.scope!({ meta: { session, sessionType: 'group' } }, on)
    expect(scope('1696900')).toMatchObject({ listened: true, observed: false })
    expect(scope('42')).toMatchObject({ listened: false })
    expect(scope('42', { ...settings, otherChats: 'mentions' })).toMatchObject({ listened: true, observed: false })
    const chats = popoKind.fields!.find(field => field.key === 'chats')!
    expect(JSON.stringify(chats)).not.toContain('"all"')
    expect(popoKind.policy!.rows!(settings).find(row => row.id === '1696900')!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
  })
  it('lets the receive switches decide which sessions a message may come from', () => {
    const settings = { ...config, chats: [{ chatId: '1' }] }
    const group = (session: string) => ({ id: 'm', from: 'a', at: '', text: '', session, group: true })
    expect(listened(group('1'), settings)).toBe(true)
    expect(listened(group('2'), settings)).toBe(false)
    expect(listened({ ...group('a@b'), group: false }, { ...settings, directMessages: false })).toBe(false)
  })
  it('asks for the CLI alone: the robot\'s credentials live in popo-robot, not in the settings', () => {
    expect(popoKind.fields!.find(field => field.key === 'cli')).toBeDefined()
    expect(popoKind.fields!.map(field => field.key)).not.toEqual(expect.arrayContaining(['appKey']))
  })
  it('drops the keys earlier versions stored: the receive mode, the popo-cli path with its interval, and the robot credentials', () => {
    const stored = { sources: { popo: { enabled: true, config: { cli: 'popo-cli', pollSeconds: 60, chats: [{ chatId: '1', listen: 'all' }, { chatId: '2', listen: 'mentions' }] } } } }
    expect(dropLegacyPopo(stored)).toEqual({ sources: { popo: { enabled: true, config: { chats: [{ chatId: '1' }, { chatId: '2' }] } } } })
    const keyed = { sources: { popo: { enabled: false, config: { appKey: 'k', appSecret: 's', aesKey: 'a', directMessages: true } } } }
    expect(dropLegacyPopo(keyed)).toEqual({ sources: { popo: { enabled: false, config: { directMessages: true } } } })
    const current = { sources: { popo: { enabled: true, config: { cli: 'popo-robot-agent', chats: [{ chatId: '1' }] } } } }
    expect(dropLegacyPopo(current)).toBe(current)
  })
})

describe('POPO listener', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })
  /** A popo-robot whose `listen` prints the given lines and then stays up; it records its arguments. */
  function robot(lines: unknown[]): string {
    dir = mkdtempSync(join(tmpdir(), 'popo-listen-'))
    const path = join(dir, 'popo-robot')
    writeFileSync(path, `#!/bin/sh\necho "$*" > '${dir}/args'\n${lines.map(item => `echo '${JSON.stringify(item)}'`).join('\n')}\nexec sleep 60\n`)
    chmodSync(path, 0o755)
    return path
  }
  function context(cli: string, config: object) {
    const reports: { state: string; detail?: string }[] = [], received: { text: string; addressed?: string }[] = [], state = new Map<string, unknown>()
    const ctx = { ready: Promise.resolve(), configured: () => true, config: () => config, deployment: { stateDir: dir, popo: { cli, uid: 'bot@app' } },
      report: (_: string, health: { state: string; detail?: string }) => reports.push(health), receive: async (trigger: { text: string; addressed?: string }) => { received.push(trigger) },
      threads: { describe: () => {} }, state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) } }
    return { ctx: ctx as never, reports, received }
  }
  it('runs popo-robot listen, reports it ready and receives the listened messages once', async () => {
    const cli = robot([{ type: 'status', state: 'connecting' }, { type: 'status', state: 'ready', detail: 'subscribed as bot@app' },
      line({}), line({}), line({ id: 'u2', session: { id: '9', type: 'group' }, eventType: 'IM_CHAT_TO_ROBOT_AT_MSG', mentionsRobot: true })])
    const { ctx, reports, received } = context(cli, { directMessages: true, chats: [], otherChats: 'none' })
    const stop = new AbortController()
    const running = runPopo(ctx, stop.signal)
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000 })
    expect(received[0]).toMatchObject({ text: 'fix it', addressed: 'direct' })
    expect(reports).toContainEqual(expect.objectContaining({ state: 'ready', detail: 'Connected' }))
    stop.abort(); await running
    expect(received).toHaveLength(1)
  }, 20_000)
})
