import type { ReactNode } from 'react'
import { useSession } from '../auth/SessionProvider'
import { RecoveryProvider } from '../lib/RecoveryProvider'

export function AccountScope({ children }: { children: ReactNode }) {
  const { user } = useSession()
  return <RecoveryProvider key={user?.id ?? 'anonymous'}>{children}</RecoveryProvider>
}
