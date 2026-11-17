/** 只有产品/测试真实审定后才可改为 approved 并填写人员及日期。 */
export const DATASET_REVIEW: { version: string; status: 'draft' | 'approved'; productReviewer: string | null; testReviewer: string | null; reviewedAt: string | null } = {
  version: 'v1.2-chat-undo-fixture', status: 'draft', productReviewer: null, testReviewer: null, reviewedAt: null,
};

export function isReviewed(review: typeof DATASET_REVIEW): boolean {
  return review.status === 'approved' && !!review.productReviewer?.trim() && !!review.testReviewer?.trim() && !!review.reviewedAt && Number.isFinite(Date.parse(review.reviewedAt));
}
