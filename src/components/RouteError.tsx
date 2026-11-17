import { TriangleAlert } from 'lucide-react'
import { PageState } from './PageState'

export function RouteError() {
  return (
    <main className="standalone-state">
      <PageState icon={<TriangleAlert size={28} />} title="页面暂时没能打开" tone="error"
        action={<button className="button primary" onClick={() => window.location.reload()}>重新加载</button>}>
        <p>请重新加载页面后再试。刷新会清除当前页面尚未发送的草稿。</p>
        <a className="text-link" href="/chat">返回对话</a>
      </PageState>
    </main>
  )
}
