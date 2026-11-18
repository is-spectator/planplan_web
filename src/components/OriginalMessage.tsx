export function OriginalMessage({ text }: { text: string }) {
  if (!text) return null
  return <details className="plan-notice original-message"><summary>原消息</summary><p>{text}</p></details>
}
