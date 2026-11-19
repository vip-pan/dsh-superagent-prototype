import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveFeishuBot, resolveGithub, resolveGithubRepository, resolveGitlab, resolveGitlabProject, resolvePopo, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the GitHub account from its CLI, skipping the worker shims, or finds none when the GitHub Source names no CLI', async () => {
    const github = await resolveGithub(machine(), { cli: 'gh' }, probe, path)
    expect(github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(await resolveGithub(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveGithub(machine(), undefined, probe, path)).toBeUndefined()
    // Repositories verify separately: a renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect(await resolveGithubRepository(github!, 'acme/widgets', probe)).toBe('acme/widgets')
    expect(await resolveGithubRepository(github!, 'acme/gadgets', probe)).toBe('acme/widgets')
  })
  it('names what the GitHub account and each repository need and where it is set', async () => {
    const account = (cli: string) => ({ cli })
    const needs = (code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveGithub(machine(), github, probe, path)).rejects.toEqual(setupError('github', code, values))
    await needs('agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, account(join(dir, 'missing')))
    await needs('agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, account('bin/gh'))
    await needs('agentCliSignedOut', {}, account(program(join(dir, 'bin', 'gh-broken'), 'exit 1')))
    await needs('agentCliNoAccount', {}, account(program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`)))
    const repositoryNeeds = (code: string, values: Record<string, unknown>, cli: string, repository = 'acme/widgets') =>
      expect(resolveGithubRepository({ cli, login: 'Agent-Bot' }, repository, probe)).rejects.toEqual(setupError('github', code, values))
    await repositoryNeeds('repositoryUnset', {}, join(dir, 'bin', 'gh'), '')
    await repositoryNeeds('repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false))
    // Signed in, but the account cannot read the repository.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await repositoryNeeds('repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, unreadable)
    await repositoryNeeds('repositoryUnreported', { repository: 'acme/widgets' }, program(join(dir, 'bin', 'gh-flat'), `echo '{}'`))
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})

describe('GitLab and POPO accounts', () => {
  /** Fake glab signed in as `login` with `level` access (30 = Developer can push) to acme/widgets. */
  const glab = (file: string, login: string, id = 7, level = 30): string => program(file,
    `case "$*" in\n  "api user") echo '{"username":"${login}","id":${id}}' ;;\n  "api projects/acme%2Fwidgets") echo '{"path_with_namespace":"acme/widgets","permissions":{"project_access":{"access_level":${level}}}}' ;;\n  *) exit 1 ;;\nesac`)
  const account = { host: 'gitlab.acme.test', cli: 'glab' }
  it('reads the GitLab account from glab and canonicalizes one project path', async () => {
    glab(join(dir, 'bin', 'glab'), 'Agent-Bot')
    expect(await resolveGitlab(machine(), account, probe, path)).toEqual({ cli: join(dir, 'bin', 'glab'), host: 'gitlab.acme.test', login: 'Agent-Bot',
      noreply: '7-Agent-Bot@noreply.gitlab.acme.test' })
    expect(await resolveGitlab(machine(), {}, probe, path)).toBeUndefined()
    const resolved = await resolveGitlab(machine(), { host: account.host, cli: join(dir, 'bin', 'glab') }, probe, path)
    expect(await resolveGitlabProject(resolved!, 'acme/widgets', probe)).toBe('acme/widgets')
  })
  it('names what the GitLab account needs, refusing accounts that cannot sign in', async () => {
    const needs = (code: string, values: Record<string, unknown>, gitlab: unknown) =>
      expect(resolveGitlab(machine(), gitlab, probe, path)).rejects.toEqual(setupError('gitlab', code, values))
    await needs('gitlabHostUnset', {}, { cli: 'glab' })
    await needs('gitlabCliUnset', {}, { host: 'gitlab.acme.test' })
    await needs('gitlabCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { ...account, cli: join(dir, 'missing') })
    await needs('gitlabCliFailed', { host: 'gitlab.acme.test' }, { ...account, cli: program(join(dir, 'bin', 'glab-broken'), 'exit 1') })
    await needs('gitlabCliNoAccount', {}, { ...account, cli: program(join(dir, 'bin', 'glab-anon'), 'echo "{}"') })
  })
  it('names what one GitLab project needs, refusing projects that cannot push', async () => {
    glab(join(dir, 'bin', 'glab'), 'Agent-Bot')
    const resolved = await resolveGitlab(machine(), { host: account.host, cli: join(dir, 'bin', 'glab') }, probe, path)
    const needs = (code: string, values: Record<string, unknown>, cli: string) =>
      expect(resolveGitlabProject({ cli, host: account.host, login: 'Agent-Bot' }, 'acme/widgets', probe)).rejects.toEqual(setupError('gitlab', code, values))
    const unreadable = program(join(dir, 'bin', 'glab-out'), `case "$*" in\n  "api user") echo '{"username":"Agent-Bot","id":7}' ;;\n  *) echo 'glab: 404 Project Not Found (HTTP 404)' >&2; exit 1 ;;\nesac`)
    await needs('gitlabRepositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output: expect.stringContaining('HTTP 404') }, unreadable)
    await needs('gitlabRepositoryUnreported', { repository: 'acme/widgets' }, program(join(dir, 'bin', 'glab-flat'), `case "$*" in\n  "api user") echo '{"username":"Agent-Bot","id":7}' ;;\n  *) echo '{"path_with_namespace":"acme/widgets"}' ;;\nesac`))
    await needs('gitlabRepositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, glab(join(dir, 'bin', 'glab-reader'), 'Agent-Bot', 7, 20))
  })
  it('reads the POPO robot account from the popo-robot CLI, or finds none when the POPO Source names no CLI', async () => {
    const cli = (name: string, body: string) => program(join(dir, 'bin', name), body)
    const ok = cli('popo-robot', 'echo \'{"robotUid":"robot@app.robot.popo.com","appKey":"k"}\'')
    expect(await resolvePopo(machine(), { cli: ok }, probe, path)).toEqual({ cli: ok, uid: 'robot@app.robot.popo.com' })
    expect(await resolvePopo(machine(), {}, probe, path)).toBeUndefined()
    const needs = (code: string, values: Record<string, unknown>, popo: unknown) => expect(resolvePopo(machine(), popo, probe, path)).rejects.toEqual(setupError('popo', code, values))
    await needs('popoCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { cli: join(dir, 'missing') })
    await needs('popoCliFailed', {}, { cli: cli('popo-broken', 'echo "no credentials" >&2; exit 3') })
    await needs('popoNoAccount', {}, { cli: cli('popo-anon', 'echo \'{"robotUid":""}\'') })
  })
})
