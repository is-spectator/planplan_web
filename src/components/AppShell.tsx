import { useEffect, useRef } from 'react'
import { Asterisk, FilePenLine, LayoutGrid, MessageCircle, Store, UserRound } from 'lucide-react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useSession } from '../auth/SessionProvider'
import { useRecovery, RecoveryFeedback } from '../lib/RecoveryProvider'

const destinations = [
  { to: '/chat', label: '对话', icon: MessageCircle },
  { to: '/plans', label: '计划', icon: LayoutGrid },
  { to: '/market', label: '市场', icon: Store },
  { to: '/create', label: '创作', icon: FilePenLine },
  { to: '/me', label: '我的', icon: UserRound },
]

function Navigation({ mobile = false }: { mobile?: boolean }) {
  const { pathname } = useLocation()
  return (
    <nav aria-label={mobile ? '底部导航' : '主导航'} className={mobile ? 'mobile-nav' : 'side-nav'}>
      {destinations.filter(({ to }) => !mobile || to !== '/create').map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} className={({ isActive }) => `nav-link${isActive || to === '/create' && (pathname.startsWith('/community') || pathname.startsWith('/publish')) ? ' active' : ''}`}>
          <Icon size={19} aria-hidden="true" /><span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

export function AppShell() {
  const { offline, stale, lastSyncedAt, user } = useSession()
  const { entry, conflict } = useRecovery()
  const { pathname } = useLocation()
  const main = useRef<HTMLElement>(null)
  const previousPath = useRef(pathname)
  const title = pathname === '/login' ? '登录' : destinations.find(({ to }) => pathname === to || pathname.startsWith(`${to}/`))?.label ?? (pathname.startsWith('/community') ? '社区作品' : pathname.startsWith('/publish') ? '发布模板' : pathname === '/review' ? '模板审核' : '页面未找到')

  useEffect(() => {
    document.title = `${title} · PlanPlan`
    if (previousPath.current !== pathname) {
      main.current?.focus({ preventScroll: true })
      window.scrollTo(0, 0)
      previousPath.current = pathname
    }
  }, [pathname, title])

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <aside className="sidebar">
        <Link to="/chat" className="brand" aria-label="PlanPlan 首页">
          <span className="brand-mark"><Asterisk size={25} strokeWidth={2} aria-hidden="true" /></span>
          <span>PlanPlan</span>
        </Link>
        <div className="sidebar-caption">让每一点行动，都有回响。</div>
        <Navigation />
        <div className="sidebar-bottom">
          <div className="sidebar-note"><span className="small-star">✳</span><p>从一笔记录开始，<br />慢慢靠近想要的生活。</p></div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <Link to="/chat" className="mobile-brand"><Asterisk size={23} aria-hidden="true" />PlanPlan</Link>
          <span className="desktop-title">{title}</span>
        </header>
        <main id="main-content" ref={main} tabIndex={-1} className="main-content"><div className="global-feedback"><RecoveryFeedback global />{user && (offline || stale) && <p className="sync-status" role="status">{offline ? '网络已断开，当前显示的是此前读取的内容。' : '暂时无法同步，正在显示此前读取的内容。'}{lastSyncedAt && `上次同步 ${new Date(lastSyncedAt).toLocaleTimeString('zh-CN')}`}<Link className="text-link" to="/me">查看提交与恢复</Link></p>}{(entry || conflict) && <Link className="text-link" to="/me">查看提交详情与内容对照</Link>}</div><Outlet /></main>
      </div>
      <Navigation mobile />
    </div>
  )
}
