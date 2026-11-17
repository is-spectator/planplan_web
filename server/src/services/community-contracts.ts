import { z } from 'zod';
import { genericValueSchema, type TemplateDefinition } from '../templates/contracts.js';
export const communityCategorySchema=z.enum(['finance','reading','health','learning','life','other']);
export type CommunityCategory=z.infer<typeof communityCategorySchema>;
const values=z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/),genericValueSchema).refine(v=>Object.keys(v).length<=20);
const id={clientOpId:z.uuid()}, listing={...id,listingId:z.uuid(),expectedVersion:z.number().int().positive()}, submission={...id,submissionId:z.uuid(),expectedVersion:z.number().int().positive()};
export const communityRequestBody=z.discriminatedUnion('action',[
 z.strictObject({...id,action:z.literal('preview'),sourceTemplateId:z.string().regex(/^private\.[a-z0-9.-]+$/).max(80),sourceTemplateVersion:z.number().int().positive(),listingId:z.uuid().optional(),expectedVersion:z.number().int().positive().optional(),title:z.string().trim().min(1).max(40),description:z.string().trim().min(1).max(300),category:communityCategorySchema,authorName:z.string().trim().min(1).max(40),publicDefaults:z.strictObject({configuration:values.optional(),record:values.optional()}).optional()}).refine(v=>!!v.listingId===!!v.expectedVersion),
 z.strictObject({...id,action:z.literal('submit'),previewId:z.uuid(),publicHash:z.string().regex(/^[a-f0-9]{64}$/),confirmPublic:z.literal(true)}),
 z.strictObject({...submission,action:z.literal('withdraw')}),
 z.strictObject({...submission,action:z.literal('review'),decision:z.enum(['approve','reject']),reason:z.string().trim().max(500).optional()}).refine(v=>v.decision!=='reject'||!!v.reason),
 z.strictObject({...listing,action:z.literal('publish'),submissionId:z.uuid(),confirmPublic:z.literal(true)}),
 z.strictObject({...listing,action:z.literal('unlist'),reason:z.string().trim().max(300).optional()}),
 z.strictObject({...listing,action:z.literal('suspend'),reason:z.string().trim().min(1).max(500)}),
 z.strictObject({...listing,action:z.literal('restore')}),
 z.strictObject({...id,action:z.literal('report'),listingId:z.uuid(),templateVersion:z.number().int().positive(),reason:z.enum(['privacy','misleading','unsafe','other']),details:z.string().trim().max(1000).default('')}),
 z.strictObject({...id,action:z.literal('resolve_report'),reportId:z.uuid(),expectedVersion:z.number().int().positive(),resolution:z.enum(['dismissed','actioned']),reason:z.string().trim().min(1).max(500),expectedListingVersion:z.number().int().positive().optional()}).refine(v=>v.resolution!=='actioned'||v.expectedListingVersion!==undefined),
]);
export type CommunityRequest=z.infer<typeof communityRequestBody>;
export interface PublicCommunityPayload {title:string;description:string;category:CommunityCategory;authorName:string;definition:TemplateDefinition}
export interface CommunityPreview {id:string;publicHash:string;expiresAt:string;payload:PublicCommunityPayload;listingId:string;listingVersion:number}
export interface CommunitySubmission {id:string;listingId:string;version:number;status:'pending'|'approved'|'rejected'|'withdrawn'|'published';payload:PublicCommunityPayload;rejectionReason:string|null;publishedVersion:number|null;createdAt:string;updatedAt:string}
export interface CommunityListing {id:string;templateId:string;version:number;status:'unlisted'|'listed'|'suspended'|'author_deleted';title:string;description:string;category:CommunityCategory|null;author:{kind:'community'|'deleted';name:string};templateVersion:number|null;adoptionCount:number;moderationReason:string|null;publishedSubmissionId:string|null;latestSubmission:CommunitySubmission|null;createdAt:string;updatedAt:string}
export interface CommunityTemplate {id:string;templateId:string;source:'community';title:string;description:string;category:CommunityCategory;author:{kind:'community';name:string};templateVersion:number;adoptionCount:number;definition:TemplateDefinition;publishedAt:string}
export interface CommunityReport {id:string;listingId:string;templateVersion:number;version:number;reason:'privacy'|'misleading'|'unsafe'|'other';details:string;status:'open'|'dismissed'|'actioned';resolutionReason:string|null;createdAt:string;updatedAt:string}
export interface CommunityResult {clientOpId:string;kind:CommunityRequest['action'];transient:false;listing?:CommunityListing;preview?:CommunityPreview;submission?:CommunitySubmission;report?:CommunityReport}
export interface CommunityPaging {limit?:number;offset?:number}
export interface CommunityHistoryEvent {id:string;kind:'submitted'|'approved'|'rejected'|'published'|'withdrawn'|'unlisted'|'suspended'|'restored';at:string;status:string;submissionId:string|null;templateVersion:number|null;reason:string|null}
export interface CommunityHistory {listingId:string;submissions:CommunitySubmission[];totalSubmissions:number;events:CommunityHistoryEvent[];totalEvents:number}
