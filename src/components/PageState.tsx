import type { ReactNode } from 'react'

export function PageState({ icon, title, children, action, tone = 'neutral' }: {
  icon: ReactNode
  title: string
  children: ReactNode
  action?: ReactNode
  tone?: 'neutral' | 'error'
}) {
  return (
    <section className={`page-state ${tone === 'error' ? 'state-error' : ''}`}>
      <div className="state-icon" aria-hidden="true">{icon}</div>
      <h2>{title}</h2>
      <div className="state-copy">{children}</div>
      {action && <div className="state-action">{action}</div>}
    </section>
  )
}
