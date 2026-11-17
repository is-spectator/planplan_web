import { lazy, Suspense } from 'react'
const CommunityPage = lazy(() => import('./CommunityPage').then(module => ({ default: module.CommunityPage })))
const PublishPage = lazy(() => import('./CommunityPage').then(module => ({ default: module.PublishPage })))
const ReviewPage = lazy(() => import('./ReviewPage').then(module => ({ default: module.ReviewPage })))
export function CommunityRoute({ screen }: { screen: 'works' | 'publish' | 'review' }) {
  const Page = screen === 'publish' ? PublishPage : screen === 'review' ? ReviewPage : CommunityPage
  return <Suspense fallback={<p className="plan-loading" role="status">正在读取内容…</p>}><Page /></Suspense>
}
