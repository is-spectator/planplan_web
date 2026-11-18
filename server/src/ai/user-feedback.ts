import type { LlmErrorKind } from './llm.js';

/** Chat and creation share one user-facing mapping. Internal kinds stay in logs. */
export type AiFeedbackScene = 'chat' | 'creation';

const RETRY_OR_RECORD = '可以稍后重试，或在恢复提示里取消本次重试后，到计划详情手动记录。';
const RETRY_OR_EDIT = '可以稍后重试，或在恢复提示里取消本次重试后继续手动编辑。';
const MANUAL_RECORD = '请在恢复提示里取消本次重试后，到计划详情手动记录。';
const MANUAL_EDIT = '请在恢复提示里取消本次重试后继续手动编辑。';

function chat(lead: string, next: string): string {
  return `${lead}这次没有更改计划或记录。${next}`;
}

function creation(lead: string, next: string): string {
  return `${lead}原草稿已保留。${next}`;
}

/**
 * Safe copy for an already classified model failure.
 * The text never includes provider payloads, status codes, model ids, or request ids.
 */
export function aiFailureMessage(kind: LlmErrorKind, scene: AiFeedbackScene): string {
  switch (kind) {
    case 'invalid_output':
      return scene === 'chat' ? chat('AI这次没有生成可用结果。', RETRY_OR_RECORD) : creation('AI这次没有生成可用结果。', RETRY_OR_EDIT);
    case 'rate_limited':
      return scene === 'chat'
        ? chat('AI请求暂时受限，请稍后再试。', '也可以在恢复提示里取消本次重试后，到计划详情手动记录。')
        : creation('AI请求暂时受限，请稍后再试。', '也可以在恢复提示里取消本次重试后继续手动编辑。');
    case 'timeout':
      return scene === 'chat' ? chat('AI处理超时。', RETRY_OR_RECORD) : creation('AI处理超时。', RETRY_OR_EDIT);
    case 'unavailable':
      return scene === 'chat'
        ? chat('AI暂时不可用，请稍后再试。', '也可以在恢复提示里取消本次重试后，到计划详情手动记录。')
        : creation('AI暂时不可用，请稍后再试。', '也可以在恢复提示里取消本次重试后继续手动编辑。');
    case 'billing':
    case 'unauthorized':
    case 'invalid_request':
    case 'accounting_unavailable':
      return scene === 'chat' ? chat('AI暂时无法完成这次处理。', MANUAL_RECORD) : creation('AI暂时无法完成这次处理。', MANUAL_EDIT);
    default: {
      const unexpected: never = kind;
      throw new Error(`Unhandled model failure: ${String(unexpected)}`);
    }
  }
}
