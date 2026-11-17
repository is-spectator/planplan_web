import { lazy, Suspense } from 'react'

const CreationPage = lazy(() => import('./CreationPage').then(module => ({ default: module.CreationPage })))
const CreationDraftPage = lazy(() => import('./CreationPage').then(module => ({ default: module.CreationDraftPage })))
const PrivateTemplatePage = lazy(() => import('./CreationPage').then(module => ({ default: module.PrivateTemplatePage })))

export function CreationRoute({ screen }: { screen: 'list' | 'draft' | 'template' }) {
  const Page = screen === 'list' ? CreationPage : screen === 'draft' ? CreationDraftPage : PrivateTemplatePage
  return <Suspense fallback={<p className="plan-loading" role="status">正在打开创作…</p>}><Page /></Suspense>
}
