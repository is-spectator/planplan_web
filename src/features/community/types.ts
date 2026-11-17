import type { GenericValues, TemplateDefinition } from '../../lib/contracts'
export const communityCategories = { finance: '财务', reading: '阅读', health: '健康', learning: '学习', life: '生活', other: '其他' } as const
export type CommunityCategory = keyof typeof communityCategories
export interface PublicCommunityPayload { title: string; description: string; category: CommunityCategory; authorName: string; definition: TemplateDefinition }
export interface CommunityPreview { id: string; publicHash: string; expiresAt: string; payload: PublicCommunityPayload; listingId: string; listingVersion: number }
export interface CommunitySubmission { id: string; listingId: string; version: number; status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'published'; payload: PublicCommunityPayload; rejectionReason: string | null; publishedVersion: number | null; createdAt: string; updatedAt: string }
export interface CommunityListing { id: string; templateId: string; version: number; status: 'unlisted' | 'listed' | 'suspended' | 'author_deleted'; title: string; description: string; category: CommunityCategory | null; author: { kind: 'community' | 'deleted'; name: string }; templateVersion: number | null; adoptionCount: number; moderationReason: string | null; publishedSubmissionId: string | null; latestSubmission: CommunitySubmission | null; createdAt: string; updatedAt: string }
export interface MarketTemplate { id: string; templateId: string; source: 'official' | 'community'; title: string; description: string; category: CommunityCategory; author: { kind: string; name: string }; templateVersion: number; adoptionCount: number | null; definition: TemplateDefinition }
export interface CommunityReport { id: string; listingId: string; templateVersion: number; version: number; reason: 'privacy' | 'misleading' | 'unsafe' | 'other'; details: string; status: 'open' | 'dismissed' | 'actioned'; resolutionReason: string | null; createdAt: string; updatedAt: string }
export type CommunityAction =
 | { action: 'preview'; sourceTemplateId: string; sourceTemplateVersion: number; listingId?: string; expectedVersion?: number; title: string; description: string; category: CommunityCategory; authorName: string; publicDefaults?: { configuration?: GenericValues; record?: GenericValues } }
 | { action: 'submit'; previewId: string; publicHash: string; confirmPublic: true }
 | { action: 'withdraw'; submissionId: string; expectedVersion: number }
 | { action: 'review'; submissionId: string; expectedVersion: number; decision: 'approve' | 'reject'; reason?: string }
 | { action: 'publish'; listingId: string; expectedVersion: number; submissionId: string; confirmPublic: true }
 | { action: 'unlist' | 'suspend'; listingId: string; expectedVersion: number; reason: string }
 | { action: 'restore'; listingId: string; expectedVersion: number }
 | { action: 'report'; listingId: string; templateVersion: number; reason: CommunityReport['reason']; details: string }
 | { action: 'resolve_report'; reportId: string; expectedVersion: number; resolution: 'dismissed' | 'actioned'; reason: string; expectedListingVersion?: number }
export interface CommunityResult { clientOpId: string; kind: CommunityAction['action']; transient: false; listing?: CommunityListing; preview?: CommunityPreview; submission?: CommunitySubmission; report?: CommunityReport }
