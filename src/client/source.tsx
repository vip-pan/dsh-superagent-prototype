/** Source status view (health, filtered Triggers, dropped replies) and Source settings cards. */
import { useEffect, useId, useState, type FormEvent } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Input, Modal, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Field, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, errorText, healthText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LabelValue, LoadState, Section, SetupMessage, StatusHead, When } from './widgets.tsx'

/** Sources with their own settings tab, in the order the tabs read; a plugin that is not enabled still has its tab. */
const KNOWN_KINDS = ['gitlab', 'github', 'popo', 'feishu']
const kindOf = (id: string) => id.split(':')[0]!
/**
 * One Source card: the account (or the whole Source) of a kind, or, with `instance`, one watched repository or project of a
 * multi-instance kind, which names it, can be removed, and keeps its repository fixed because the instance is named after it.
 */
function SourceCard({ source, instance, locked, cascade }: { source: SourceView; instance?: boolean; locked?: boolean; cascade?: { kind: string; count: number } }) {
  const { t, call, notify, restart } = usePanel()
  const { running, state } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // Saving a modified setup-sensitive field restarts dsh-superagent, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  const description = localized(t, source.description)
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (original: FieldSpec) => {
    const spec: FieldSpec = instance && original.type === 'text' && original.key === 'repository' ? { ...original, readonly: true } : original
    return <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  }
  const advanced = source.fields.filter(spec => spec.advanced)
  const remove = async () => {
    const result = await call('DELETE settings/:block', { block: `source:${source.id}`, body: { revision: source.revision } })
    try { sessionStorage.removeItem(`dsh-superagent/draft/${state?.masterId ?? ''}/source:${source.id}`) } catch { /* A kept draft is harmless. */ }
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    if (result.restarting) restart(); else await reload()
  }
  const title = instance && typeof saved.config.repository === 'string' ? saved.config.repository : localized(t, source.title)
  return <form id={`dt-source-${source.id}`} className="dt-card" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title">
            <span className="dt-card-title">{title}</span>{description && !instance && <InfoTip text={description} />}
            {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
          </div>
        </div>
        {source.installed && <Switch checked={value.enabled} disabled={locked} onChange={enabled => draft.edit({ ...value, enabled })}
          label={t('sourceEnable', { name: title })} />}
        {instance && source.installed && <ConfirmButton label={t('remove')} title={t('sourceRemoveTitle', { name: title })}
          message={t('sourceRemoveConfirm', { name: title })} onConfirm={remove} />}
      </div>
      {problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
      </div>}
      {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
      {source.installed && source.fields.filter(spec => !spec.advanced).map(field)}
      {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}>
        <div className="dt-disclosure-body">{advanced.map(field)}</div>
      </DisclosureRow>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running })
      : draft.dirty && saved.enabled && !value.enabled && cascade?.count ? t(`sourceCascade.${NOUN[cascade.kind] ?? 'repository'}`, { count: cascade.count }) : undefined}
      onDiscard={draft.discard} />
  </form>
}

/** The noun of what a multi-instance Source watches, which words its section, its button and its hints. */
const NOUN: Record<string, 'repository' | 'project'> = { github: 'repository', gitlab: 'project' }
type TextField = Extract<FieldSpec, { type: 'text' }>
/** A kind no plugin provides: its tab stays so the page lists everything the panel supports, and says why there is nothing to set. */
function MissingSource({ kind }: { kind: string }) {
  const { t } = usePanel()
  const name = valueLabel(t, 'source', kind)
  return <section id={`dt-source-${kind}`} className="dt-card">
    <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">
      <span className="dt-card-title">{name}</span><Tag tone="warning">{t('sourceNotInstalled')}</Tag>
    </div></div></div>
    <Hint>{t('sourceMissingHint', { name })}</Hint>
  </section>
}
/** Adds a watched repository or project: its name is all an instance needs, and saving checks the agent account's access to it. */
function AddInstance({ kind, spec, taken, disabled }: { kind: string; spec: TextField | undefined; taken: string[]; disabled?: boolean }) {
  const { t, call, notify, restart } = usePanel()
  const { reload } = useSettings()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const form = useId()
  const noun = NOUN[kind] ?? 'repository'
  const close = () => { if (!busy) { setOpen(false); setName(''); setError(undefined) } }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const repository = name.trim()
    const id = `${kind}:${repository.replaceAll('/', '~')}`
    if (taken.some(item => item.toLowerCase() === id.toLowerCase())) { setError(t('sourceInstanceExists', { name: repository })); return }
    setBusy(true); setError(undefined)
    try {
      const result = await call('PUT settings/:block', { block: `source:${id}`, body: { value: { enabled: true, config: { repository } },
        revision: 0 } })
      notify(t(result.restarting ? 'savedRestarting' : 'saved'))
      setOpen(false); setName('')
      if (result.restarting) restart(); else await reload()
    } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} disabled={disabled} onClick={() => setOpen(true)}>{t(`sourceAdd.${noun}`)}</Button>
    <Modal open={open} onClose={close} title={t(`sourceAdd.${noun}`)} closeLabel={t('close')} description={t(`sourceAddHint.${noun}`)}
      footer={<>
        <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" form={form} disabled={busy || !name.trim()}>{t('sourceAddConfirm')}</Button>
      </>}>
      <form id={form} className="dt-add-form" onSubmit={event => { void submit(event) }}>
        <Field label={spec ? localized(t, spec.label) : t(`sourceInstances.${noun}`)} hint={localized(t, spec?.hint)}>
          <Input required autoFocus value={name} spellCheck={false} {...spec?.pattern ? { pattern: spec.pattern } : {}}
            onChange={event => { setName(event.target.value); setError(undefined) }} />
        </Field>
        {error && <p className="dt-error" role="alert">{error}</p>}
      </form>
    </Modal>
  </>
}
/** One kind's tab: its account (or the whole Source) on top, then, for a multi-instance kind, every watched repository or project. */
function SourceTab({ kind, sources }: { kind: string; sources: SourceView[] }) {
  const { t } = usePanel()
  const top = sources.find(source => source.id === kind)
  const instances = sources.filter(source => source.id.startsWith(`${kind}:`))
  if (!top) return <MissingSource kind={kind} />
  const noun = NOUN[kind] ?? 'repository'
  const spec = top.instanceFields?.find((field): field is TextField => field.type === 'text' && field.key === 'repository')
  // A repository or project runs only under its Source: while the Source is off, none can be switched on or added.
  const off = top.installed && !top.value.enabled
  return <div className="dt-form">
    <SourceCard source={top} cascade={{ kind, count: instances.filter(source => source.value.enabled).length }} />
    {top.instanceFields && <Section title={t(`sourceInstances.${noun}`)} count={instances.length} hint={t(`sourceInstancesHint.${noun}`)}
      action={top.installed ? <AddInstance kind={kind} spec={spec} taken={instances.map(source => source.id)} disabled={off} /> : undefined}>
      {off && <Hint>{t(`sourceLocked.${noun}`, { name: valueLabel(t, 'source', kind) })}</Hint>}
      {instances.length === 0 ? <Hint>{t(`sourceInstancesEmpty.${noun}`)}</Hint>
        : <div className="dt-instances">{instances.map(source => <SourceCard key={source.id} source={source} instance locked={off} />)}</div>}
    </Section>}
  </div>
}
/**
 * Source settings, one tab per kind the panel supports, whether or not its plugin is enabled or anything is configured.
 * \`focus\` names the tab by a Source id, such as \`github\` or \`gitlab:group~name\`, and scrolls to its card.
 */
export function SourceSettings({ focus }: { focus?: string }) {
  const { t, navigate } = usePanel()
  const { sources } = useSettings().settings
  const kinds = [...KNOWN_KINDS, ...new Set(sources.map(source => kindOf(source.id)))].filter((kind, index, list) => list.indexOf(kind) === index)
  const first = kinds.find(kind => sources.some(source => source.id === kind && source.installed && source.value.enabled)) ?? kinds[0]!
  const current = focus && kinds.includes(kindOf(focus)) ? kindOf(focus) : first
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus, current])
  return <div className="dt-form">
    <div className="dt-subtabs" role="tablist" aria-label={t('sourceKindsLabel')}>
      {kinds.map(kind => <button key={kind} type="button" role="tab" id={`dt-source-tab-${kind}`} aria-controls="dt-source-panel"
        aria-selected={kind === current} className="dt-subtab" onClick={() => navigate(settingsRoute('source', { source: kind }), true)}>
        {valueLabel(t, 'source', kind)}
      </button>)}
    </div>
    <div id="dt-source-panel" role="tabpanel" aria-labelledby={`dt-source-tab-${current}`} className="dt-form">
      <SourceTab key={current} kind={current} sources={sources} />
    </div>
    <ConfigHistory blocks={['source:']} />
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
function SourceRow({ source }: { source: SourceStatusRow }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const [filteredOpen, setFilteredOpen] = useState(false)
  const { problem, dropped } = source
  const { dot, label: state } = sourceMark(t, source.state)
  const { received, filtered, lastAt } = source.stats
  // Omit healthy parts and suppress per-part notes when a setup problem already explains why the Source is stopped.
  const notes = source.enabled && !problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  return <li className="dt-row">
    <Dot state={dot} label={state} />
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-row-name">{localized(t, source.title)}</span><span className="dt-status-text"
        data-state={dot}>{state}</span></div>
      <div className="dt-row-meta">
        {received > 0 && <LabelValue label={t('sourceReceivedLabel')}
          value={received} />}{filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={filtered} />}
        {lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(lastAt, t('lang'))} />}
      </div>
      {problem && <p className="dt-error">
        <SetupMessage problem={problem} lead /> <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
          {t('sourceOpenSettings')}
        </button>
      </p>}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
      </p>)}
      {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
        onToggle={() => setFilteredOpen(!filteredOpen)}>
        <div className="dt-disclosure-body">
          <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
            className="dt-row-main">
            <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
              || t('empty')}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
          </div></li>)}</ul>
        </div>
      </DisclosureRow>}
      {dropped.length > 0 && <DroppedReplies items={dropped} />}
    </div>
  </li>
}

export function SourceStatus() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  // Global deployment setup problems halt all Sources and show at the top; Source-specific setup problems show on that Source's row.
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="source" />
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!data} />
    {data && <ul className="dt-list">{data.map(source => <SourceRow key={source.id} source={source} />)}</ul>}
  </div>
}
