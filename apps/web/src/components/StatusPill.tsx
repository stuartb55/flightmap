import type { ConnectionState, ReceiverHealth } from '../types'

interface Props {
  status: ConnectionState | ReceiverHealth | 'ok' | 'error' | string
  label?: string
}

export function StatusPill({ status, label }: Props) {
  const semantic =
    status === 'live' || status === 'online' || status === 'ok'
      ? 'good'
      : status === 'offline' || status === 'error'
        ? 'bad'
        : 'warn'

  return (
    <span className={`status-pill status-pill-${semantic}`}>
      <span className="status-dot" aria-hidden="true" />
      {label ?? status}
    </span>
  )
}
