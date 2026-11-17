import { Signpost } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageState } from '../components/PageState'

export function NotFoundPage() {
  return (
    <div className="standard-page">
      <PageState icon={<Signpost size={29} />} title="这个页面不在这里"
        action={<Link className="button primary" to="/chat">返回对话</Link>}>
        <p>链接可能有误，或者页面已经移动。可以从对话重新开始。</p>
      </PageState>
    </div>
  )
}
