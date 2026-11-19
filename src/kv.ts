/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'
import type { GitlabRetry } from './sources/gitlab.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source (multi-instance): per-instance notification cursor (keyed by instance ID) and pending retries (keyed by instance
   * ID, mapping the Issue or PR number to its retry); per-Issue/PR read cursor shared by notification and polled reads (keyed
   * `<instance>:<number>`); per-instance per-stream cursor, start times by kind, and ETag; per-instance default-branch CI state;
   * and per-PR CI fingerprint and revision (keyed `<instance>:<number>`; `revision` counts reported CI changes so each produces a
   * distinct Trigger ID).
   */
  github: { since: family<string, [instance: string]>('github-since:'), retries: family<Record<string, Retry>, [instance: string]>('github-retry:'),
    cursor: family<string, [thread: string]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: family<{ branch?: string; failures?: string[]; revision: number }, [instance: string]>('github-branch-ci:'),
    ci: family<{ fingerprint: string; revision: number }, [thread: string]>('github-ci:') },
  /**
   * GitLab Source (multi-instance): per-instance todo cursor (`since`, keyed by instance ID); pending retries (keyed
   * `<instance>:issue:<iid>` / `<instance>:mr:<iid>`); per-Issue/MR note cursor (keyed `<instance>:<kind>:<iid>`);
   * per-instance per-stream cursor and start times by kind; per-instance default-branch pipeline state; per-MR pipeline
   * fingerprint and revision (keyed `<instance>:mr:<iid>`).
   */
  gitlab: { since: family<string, [instance: string]>('gitlab-since:'), retries: record<Record<string, GitlabRetry>>('gitlab-retry'),
    cursor: family<string, [thread: string]>('gitlab-cursor:'),
    stream: family<{ since: string; started: Record<string, string> }, [stream: string]>('gitlab-stream:'),
    branchCi: family<{ branch?: string; failures?: string[]; revision: number }, [instance: string]>('gitlab-branch-ci:'),
    ci: family<{ fingerprint: string; revision: number }, [thread: string]>('gitlab-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
  /** POPO Source: known sessions mapped to `true` for direct messages; per-thread seen message IDs. */
  popo: { sessions: record<Record<string, boolean>>('popo-sessions'),
    seen: family<string[], [thread: string]>('popo-thread-seen:') },
}
