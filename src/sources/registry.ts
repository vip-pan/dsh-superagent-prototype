/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

/** A SourceKind with its account and instance configuration types erased for registry-internal storage. */
export type AnySourceKind = SourceKind<any, any>


/** Splits a settings key into its kind and, for multi-instance kinds, the instance name after the first `:`. */
export function sourceKey(id: string): { kind: string; name?: string } {
  const at = id.indexOf(':')
  return at < 0 ? { kind: id } : { kind: id.slice(0, at), name: id.slice(at + 1) }
}

/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 * Multi-instance kinds (with `multi`) hold one account entry under the plain kind key plus one entry per stored `kind:<instance>` key; every lookup accepts either form.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, AnySourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: AnySourceKind) => () => void = () => () => {}) {}

  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register(kind: AnySourceKind): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind)
    const unregistered = this.registered(kind)
    return () => {
      this.kinds.delete(kind.kind)
      release()
      for (const name of [...this.health.keys()]) if (sourceKey(name).kind === kind.kind && name.includes(':')) this.health.get(name)!.release(), this.health.delete(name)
      unregistered()
    }
  }
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  /** Claims a per-instance health entry (`<kind>:<instance>`) of a multi-instance kind on first use; undefined for unknown shapes. */
  instanceHealth(id: string): HealthEntry | undefined {
    const { kind: kindId, name } = sourceKey(id)
    const kind = this.kinds.get(kindId)
    if (!kind?.multi || !name) return undefined
    const existing = this.health.get(id)
    if (existing) return existing
    const entry = this.board.claim(id, { state: 'starting', detail: '' })
    this.health.set(id, entry)
    return entry
  }
  kind(id: string): AnySourceKind | undefined { return this.kinds.get(id) }
  /** Stored instance keys of a multi-instance kind in stored order (enabled or not), such as `gitlab:group~name`. */
  instanceIds(kindId: string, settings = this.settings()): string[] {
    if (!this.kinds.get(kindId)?.multi) return []
    return Object.keys(settings.sources).filter(id => sourceKey(id).kind === kindId && sourceKey(id).name !== undefined)
  }
  /**
   * The stored instance a ticket from `source` belongs to. For multi-instance kinds a foreign or missing source maps to
   * the account's default instance (`defaultProject`) or, failing that, the first stored one — so chat tickets still land in one project.
   */
  instanceIdFor(source: string | undefined, kindId: string, settings = this.settings()): string | undefined {
    const kind = this.kinds.get(kindId)
    if (!kind?.multi) return kindId
    const stored = this.instanceIds(kindId, settings)
    if (source && sourceKey(source).kind === kindId) return stored.includes(source) ? source : undefined
    const account = this.resolve(kind, settings.sources[kindId]).config as Record<string, unknown>
    const project = typeof account.defaultProject === 'string' ? account.defaultProject : ''
    if (project) {
      const wanted = this.resolveMany(kind, settings).find(instance => (instance.config as Record<string, unknown>).repository === project)
      if (wanted) return wanted.id
    }
    return stored[0]
  }
  /** Every registered kind's account instance plus each stored multi-instance entry, ordered by ID, followed by stored instances whose kind is not installed. */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => [
      { ...this.resolve(kind, settings.sources[kind.kind]), installed: true },
      ...this.resolveMany(kind, settings).map(instance => ({ ...instance, installed: true })),
    ])
    const orphaned = Object.entries(settings.sources).filter(([id]) => !this.kinds.has(sourceKey(id).kind)).map(([id, stored]) =>
      ({ id, kind: sourceKey(id).kind, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const { kind: kindId, name } = sourceKey(id)
    const kind = this.kinds.get(kindId)
    if (!kind) return undefined
    if (name !== undefined) {
      if (!kind.multi) return undefined
      return this.resolveOne(kind, id, settings) as SourceInstance<C>
    }
    return this.resolve(kind, settings.sources[id]) as SourceInstance<C>
  }
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const { kind: kindId, name } = sourceKey(id)
    const kind = this.kinds.get(kindId)
    if (!kind) throw new Error(`Source kind not installed: ${kindId}`)
    if (name !== undefined) {
      if (!kind.multi) throw new Error(`Source kind is not multi-instance: ${kindId}`)
      return { enabled: value.enabled, config: kind.multi.schema.parse(value.config) }
    }
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kinds.get(sourceKey(id).kind)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kinds.get(sourceKey(id).kind)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const { kind: kindId, name } = sourceKey(channel.source)
    const kind = this.kinds.get(kindId)
    if (!kind) return false
    const instance = name !== undefined && kind.multi ? this.resolveOne(kind, channel.source, settings) : this.resolve(kind, settings.sources[kindId])
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  /**
   * Enabled environments keyed for merge. Multi-instance kinds contribute exactly one instance: the one named by
   * `source` (a trigger's Source) when it names one, else the account's default instance.
   */
  environments(settings = this.settings(), source?: string) {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      if (!kind.multi) {
        const instance = this.resolve(kind, settings.sources[kind.kind])
        return kind.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
      }
      const wanted = this.instanceIdFor(source, kind.kind, settings)
      if (!wanted) return []
      const instance = this.resolveOne(kind, wanted, settings)
      return kind.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kinds.get(sourceKey(message.channel.source).kind)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kinds.get(sourceKey(channel.source).kind)?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string, settings = this.settings()): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => {
      if (!kind.find) return []
      if (!kind.multi) return [kind.find(query)]
      return this.resolveMany(kind, settings).filter(instance => instance.enabled).map(instance => kind.find!(query, instance.config))
    })
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kinds.get(sourceKey(trigger.source).kind)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const { kind: kindId, name } = sourceKey(trigger.source)
    const kind = this.kinds.get(kindId)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const instance = name !== undefined && kind.multi ? this.resolveOne(kind, trigger.source, settings) : this.resolve(kind, settings.sources[kindId])
    const { config } = instance
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kindId} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const { kind: kindId, name } = sourceKey(input.source)
    const kind = this.kinds.get(kindId)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = name !== undefined && kind.multi ? this.resolveOne(kind, input.source, settings) : this.resolve(kind, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: AnySourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id: kind.kind, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
  /** Resolves one stored multi-instance entry under its full `kind:<instance>` key. */
  private resolveOne(kind: AnySourceKind, id: string, settings: Settings): SourceInstance {
    const stored = settings.sources[id]
    const parsed = kind.multi!.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.multi!.schema.parse({}) }
  }
  /** Resolves every stored multi-instance entry of `kind` in stored order. */
  private resolveMany(kind: AnySourceKind, settings: Settings, filter: (id: string) => boolean = () => true): SourceInstance[] {
    return this.instanceIds(kind.kind, settings).filter(filter).map(id => this.resolveOne(kind, id, settings))
  }
}
