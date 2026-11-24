/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { INSTANCE_SETUP_FIELDS, SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import { policyVersion } from '../../policy.ts'
import { clonePath, repositoryNodes } from '../../repositories.ts'
import { sourceKey, type SourceRegistry } from '../../sources/registry.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  // An instance id such as github:owner~name belongs to its kind, so resolve the kind from the key rather than the whole id.
  const { kind, name } = sourceKey(id)
  const declared = sources.kind(kind)
  const policy = declared?.policy
  // The account card of a multi-instance kind carries no policy; each instance's card does.
  if (!policy || (declared!.multi && name === undefined)) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      // An instance card of a multi-instance kind renders its own fields; the account card renders the account's.
      const fields = kind && instance.id.includes(':') ? kind.multi?.fields ?? [] : kind?.fields ?? []
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.id] ?? INSTANCE_SETUP_FIELDS[instance.kind] ?? [], fields, facts: kind?.facts?.(setup.deployment) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health),
        // A multi-instance kind's cards carry the fields of one instance, so the panel can offer a new one before any is stored.
        ...kind?.multi && !instance.id.includes(':') ? { instanceFields: kind.multi.fields ?? [] } : {} }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings),
      // Every repository with the clone its tickets are made from, so all the locations are in one place.
      repositories: repositoryNodes(settings).map(node => ({ id: node.id, kind: node.kind, repository: node.repository,
        path: clonePath(node, stateDir), configured: node.localPath !== '' })) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
