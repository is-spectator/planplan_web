import { lazy, Suspense } from 'react'
const PlansPage = lazy(() => import('./PlansPage').then(module => ({ default: module.PlansPage })))
const PlanDetailPage = lazy(() => import('./PlansPage').then(module => ({ default: module.PlanDetailPage })))
const AccountPage = lazy(() => import('./AccountPage').then(module => ({ default: module.AccountPage })))
const MarketPage = lazy(() => import('./MarketPage').then(module => ({ default: module.MarketPage })))
const TemplateDetailPage = lazy(() => import('./MarketPage').then(module => ({ default: module.TemplateDetailPage })))
export function AppRoute({ screen }: { screen: 'plans' | 'plan' | 'account' | 'market' | 'template' }) {
  const Page = { plans: PlansPage, plan: PlanDetailPage, account: AccountPage, market: MarketPage, template: TemplateDetailPage }[screen]
  return <Suspense fallback={<p className="plan-loading" role="status">正在打开页面…</p>}><Page /></Suspense>
}
