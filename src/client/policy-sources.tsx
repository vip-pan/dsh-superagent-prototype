/** The Policy's part on each Source: one tab per Source kind, and under a multi-instance kind (GitHub, GitLab) one collapsible row per watched repository. */
import { useState } from 'react'
import { ADMISSION_DEFAULTS, ADMISSION_OPTIONS, type Admission, type AdmissionCell } from '../admission.ts'
import type { AdmissionRowView } from '../sources/kind.ts'
import type { SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { SourceField } from './settings-kit.tsx'
import { localized, valueLabel, when } from './text.ts'
import { Hint, LabelValue, Section } from './widgets.tsx'

const kindOf = (id: string) => id.split(':')[0]!
const isInstance = (source: SourceView) => source.id.includes(':')
/** An instance is named by its repository or project; a kind's own Source by its title. */
const nameOf = (t: Parameters<typeof localized>[0], source: SourceView) => {
  const repository = source.value.config.repository
  return isInstance(source) && typeof repository === 'string' && repository ? repository : localized(t, source.title)
}
const allowedCount = (part: Part) => Array.isArray(part.allowed) ? part.allowed.length : 0

/** Every Source that has a Policy part, grouped by kind: tabs across the kinds, and within a multi-instance kind one row per instance. */
export function PolicySources({ sources, part, saved, dirty, reload, onChange }: {
  sources: SourceView[]; part: (id: string) => Part; saved: (id: string) => Part; dirty: boolean; reload: () => Promise<void>
  onChange: (id: string, next: Part) => void
}) {
  const { t } = usePanel()
  const kinds = [...new Set(sources.map(source => kindOf(source.id)))]
  const [tab, setTab] = useState<string>()
  const [expanded, setExpanded] = useState<Record<string, Set<string>>>({})
  if (!kinds.length) return null
  const kind = kinds.find(item => item === tab) ?? kinds[0]!
  const group = sources.filter(source => kindOf(source.id) === kind)
  // The first instance is open until the person opens or closes one, so a kind with a few repositories still shows something.
  const open = expanded[kind] ?? new Set(group.slice(0, 1).map(source => source.id))
  const toggle = (id: string) => { const next = new Set(open); if (next.has(id)) next.delete(id); else next.add(id); setExpanded({ ...expanded, [kind]: next }) }
  const render = (source: SourceView) => <SourcePart key={source.id} source={source} part={part(source.id)} saved={saved(source.id)} dirty={dirty}
    reload={reload} onChange={next => onChange(source.id, next)} />
  return <Section title={t('policyPerSource')} hint={t('policyPerSourceHint')}>
    {kinds.length > 1 && <div className="dt-subtabs" role="tablist" aria-label={t('policyPerSource')}>
      {kinds.map(item => <button key={item} type="button" role="tab" aria-selected={item === kind} className="dt-subtab" onClick={() => setTab(item)}>
        {valueLabel(t, 'source', item)}{sources.some(source => kindOf(source.id) === item && isInstance(source))
          && <span className="dt-count"> {sources.filter(source => kindOf(source.id) === item).length}</span>}
      </button>)}
    </div>}
    {group.some(isInstance)
      ? <div className="dt-instances">{group.map(source => <DisclosureRow key={source.id} icon={<Icon name="inbox" />}
        title={nameOf(t, source)} open={open.has(source.id)} onToggle={() => toggle(source.id)}
        collapsedContent={<span className="dt-rule-preview">{t('policyAllowedCount', { count: String(allowedCount(part(source.id))) })}</span>}>
        <div className="dt-disclosure-body">{render(source)}</div>
      </DisclosureRow>)}</div>
      : group.map(render)}
  </Section>
}

export type Part = Record<string, unknown>
function SourcePart({ source, part, saved, dirty, onChange, reload }: {
  source: SourceView; part: Part; saved: Part; dirty: boolean; onChange: (next: Part) => void; reload: () => Promise<void>
}) {
  const { t, call, notify } = usePanel()
  const policy = source.policy!
  const sync = policy.sync
  const run = useAction(() => call('POST policy-sync/:id', { id: source.id }), { reload })
  // Syncing saves the Policy block, so require unsaved edits to be saved or discarded first.
  const syncNow = () => { if (dirty) notify(t('syncNeedsSave')); else void run.run() }
  return <div className="dt-part">
    {policy.fields.map(field => <SourceField key={field.key} field={field} value={part[field.key]} saved={saved[field.key]} fact={undefined}
      labels={source.labels}
      onChange={next => onChange({ ...part, [field.key]: next })} />)}
    {sync && <div className="dt-row-buttons">
      <Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={run.busy || !sync.ready} onClick={syncNow}>{localized(t,
        sync.label)}</Button>
      {sync.health?.state === 'ready' && sync.health.at && <LabelValue label={t('syncDone')} value={when(sync.health.at, t('lang'))} />}
      {sync.health?.state === 'error' && <span className="dt-error dt-clamp">{sync.health.detail}</span>}
    </div>}
    {policy.rows ? <AdmissionTable rows={policy.rows} labels={source.labels} table={(part.admission ?? {}) as AdmissionTable}
      explicit={localized(t, policy.explicit)}
      onChange={admission => onChange({ ...part, admission })} />
      : <div className="dt-field"><span className="dt-field-head">{t('explicitRequest')}</span><span>{localized(t,
        policy.explicit)}</span></div>}
  </div>
}

type AdmissionTable = Record<string, Partial<Record<AdmissionCell, Admission>>>
const CELLS: readonly AdmissionCell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
function AdmissionTable({ rows, labels, table, explicit, onChange }: {
  rows: AdmissionRowView[]; labels: Record<string,
    string>; table: AdmissionTable; explicit: string; onChange: (table: AdmissionTable) => void
}) {
  const { t } = usePanel()
  const name = (row: AdmissionRowView) => labels[row.id] ?? localized(t, row.label)
  const set = (row: string, cell: AdmissionCell, value: Admission) => onChange({ ...table, [row]: { ...table[row], [cell]: value } })
  const select = (row: AdmissionRowView, cell: AdmissionCell) => {
    const value = table[row.id]?.[cell] ?? ADMISSION_DEFAULTS[cell]
    // Reserve a fixed-width slot for the warning icon so selecting a value never shifts column widths.
    return <td key={cell}><span className="dt-admission-cell">
      <select className="dt-select" aria-label={`${name(row)} · ${t(`admissionCell.${cell}`)}`} value={value} onChange={event => set(row.id,
        cell, event.target.value as Admission)}>
        {ADMISSION_OPTIONS[cell].map(option => <option key={option} value={option}>{t(`admissionValue.${option}`)}</option>)}
      </select>
      <span className="dt-admission-slot">{cell === 'unlistedAddressed' && value === 'explicit' && <InfoTip
        text={t('admissionAnyoneWarning')} icon="alert" warn />}</span>
    </span></td>
  }
  return <Section title={t('admission')} hint={t('admissionHint')}>
    <Hint>{explicit}</Hint>
    <table className="dt-table dt-admission">
      <thead>
        <tr><th rowSpan={2}>{t('admissionScope')}</th><th>{t('admissionListed')}</th><th colSpan={2}>{t('admissionUnlisted')}</th></tr>
        <tr><th>{t('admissionUnaddressed')}</th><th>{t('admissionAddressed')}</th><th>{t('admissionUnaddressed')}</th></tr>
      </thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td className="dt-admission-scope">{name(row)}<small>{localized(t, row.note)}</small></td>
        {CELLS.map(cell => row.cells[cell] ? select(row, cell) : <td key={cell} className="dt-admission-na"
          aria-label={t('admissionNotReceived')}>—</td>)}
      </tr>)}</tbody>
    </table>
    <Hint>{t('admissionFootnote')}</Hint>
  </Section>
}
