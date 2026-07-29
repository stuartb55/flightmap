import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Clock3,
  Database,
  HardDrive,
  Info,
  RadioTower,
  RefreshCw,
  Server,
  ShieldCheck,
  Wifi,
} from 'lucide-react'
import { StatusPill } from '../components/StatusPill'
import { api } from '../lib/api'
import {
  compactNumber,
  formatBytes,
  formatDateTime,
} from '../lib/format'
import type { SystemStatus } from '../types'

function DataRow({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="system-data-row">
      <span>{label}{hint ? <small>{hint}</small> : null}</span>
      <strong>{value}</strong>
    </div>
  )
}

function formatRate(value: number | null | undefined, suffix: string) {
  return value == null ? '—' : `${value.toLocaleString('en-GB', { maximumFractionDigits: 1 })} ${suffix}`
}

function formatUptime(seconds: number | null) {
  if (seconds == null) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

export function SystemPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    else setLoading(true)
    try {
      const result = await api.status()
      setStatus(result)
      setError(null)
      setLastChecked(new Date())
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'System status is unavailable')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [load])

  return (
    <div className="standard-page system-page">
      <header className="standard-page-header system-header">
        <div className="page-heading">
          <span className="eyebrow">READ-ONLY HEALTH</span>
          <h1>System</h1>
          <p>Receiver, ingestion, retention, and aircraft database status.</p>
        </div>
        <div className="system-header-actions">
          {status ? <StatusPill status={status.overall} label={status.overall === 'ok' ? 'All systems nominal' : status.overall} /> : null}
          <button className="secondary-button" type="button" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
            Refresh
          </button>
        </div>
      </header>

      {error ? (
        <div className="system-error" role="alert">
          <Wifi size={18} />
          <span><strong>Status endpoint unavailable</strong><small>{error}</small></span>
        </div>
      ) : null}

      {loading && !status ? (
        <div className="system-grid">
          {Array.from({ length: 4 }, (_, index) => <div className="system-card skeleton-card" key={index} />)}
        </div>
      ) : status ? (
        <>
          <section className="health-overview">
            <div className="health-score">
              <span className={`health-ring health-${status.overall}`}>
                {status.overall === 'ok' ? <CheckCircle2 size={31} /> : <Activity size={31} />}
              </span>
              <span><small>Application health</small><strong>{status.overall === 'ok' ? 'Operational' : status.overall}</strong></span>
            </div>
            <div><small>Application version</small><strong>{status.version ?? 'Development'}</strong></div>
            <div><small>Process uptime</small><strong>{formatUptime(status.uptimeSeconds)}</strong></div>
            <div><small>Last checked</small><strong>{lastChecked?.toLocaleTimeString('en-GB') ?? '—'}</strong></div>
          </section>

          <div className="system-grid">
            <section className="system-card">
              <header>
                <span className="system-card-icon receiver"><RadioTower size={20} /></span>
                <div><span className="eyebrow">SOURCE</span><h2>ADS-B receiver</h2></div>
                <StatusPill status={status.receiver.status} />
              </header>
              <div className="system-card-body">
                <DataRow label="Aircraft poll" value={formatDateTime(status.receiver.lastAircraftPollAt)} />
                <DataRow label="Statistics poll" value={formatDateTime(status.receiver.lastStatsPollAt)} />
                <DataRow label="Snapshot age" value={status.receiver.latencyMs == null ? '—' : `${Math.round(status.receiver.latencyMs)} ms`} />
                <DataRow label="Receiver software" value={status.receiver.software ?? '—'} />
                <DataRow label="Source URL" value={status.receiver.url ?? 'Configured privately'} />
              </div>
            </section>

            <section className="system-card">
              <header>
                <span className="system-card-icon collector"><Activity size={20} /></span>
                <div><span className="eyebrow">PIPELINE</span><h2>Collector</h2></div>
                <StatusPill status={status.collector.status} />
              </header>
              <div className="system-card-body">
                <DataRow label="Snapshot rate" value={formatRate(status.collector.snapshotRate, '/ sec')} />
                <DataRow label="Receiver message rate" value={formatRate(status.collector.aircraftRate, 'messages / sec')} />
                <DataRow label="Poll interval" value={status.collector.pollIntervalMs == null ? '—' : `${status.collector.pollIntervalMs.toLocaleString()} ms`} />
                <DataRow label="Rejected records" value={compactNumber(status.collector.rejectedRecords)} hint="since process start" />
                <DataRow label="Last error" value={status.collector.lastError ?? 'None'} />
              </div>
            </section>

            <section className="system-card">
              <header>
                <span className="system-card-icon database"><Database size={20} /></span>
                <div><span className="eyebrow">STORAGE</span><h2>PostgreSQL</h2></div>
                <StatusPill status={status.database.status} />
              </header>
              <div className="system-card-body">
                <div className="database-size">
                  <HardDrive size={17} />
                  <span><small>Database size</small><strong>{formatBytes(status.database.sizeBytes)}</strong></span>
                </div>
                <DataRow
                  label="Configured capacity"
                  value={formatBytes(status.database.capacityBytes)}
                  hint={status.database.usePercent == null ? undefined : `${status.database.usePercent.toFixed(1)}% used`}
                />
                <DataRow label="Detailed retention" value={status.database.retainedDays == null ? '—' : `${status.database.retainedDays} days`} />
                <DataRow label="Oldest detailed sample" value={formatDateTime(status.database.oldestSampleAt)} />
                <DataRow label="Newest detailed sample" value={formatDateTime(status.database.newestSampleAt)} />
                <div className="retention-note"><ShieldCheck size={15} /><span>Aircraft and daily summaries are preserved indefinitely.</span></div>
              </div>
            </section>

            <section className="system-card">
              <header>
                <span className="system-card-icon metadata"><Server size={20} /></span>
                <div><span className="eyebrow">LOOKUP DATA</span><h2>Aircraft metadata</h2></div>
                <StatusPill status={status.metadata.status} />
              </header>
              <div className="system-card-body">
                <DataRow label="Database version" value={status.metadata.version ?? '—'} />
                <DataRow label="Aircraft records" value={compactNumber(status.metadata.rowCount)} />
                <DataRow label="Last successful update" value={formatDateTime(status.metadata.updatedAt)} />
                <DataRow label="Next scheduled check" value={formatDateTime(status.metadata.nextUpdateAt)} />
                <DataRow label="Last error" value={status.metadata.lastError ?? 'None'} />
                <div className="retention-note"><Info size={15} /><span>Updates are staged and validated before becoming active.</span></div>
              </div>
            </section>
          </div>

          <footer className="system-footer">
            <Clock3 size={14} />
            Health refreshes every 10 seconds while this page is visible.
          </footer>
        </>
      ) : null}
    </div>
  )
}
