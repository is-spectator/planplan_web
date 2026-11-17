import type { TemplateDefinition } from '../../lib/contracts'

export interface CreationDraft {
  id: string
  version: number
  name: string
  definition: TemplateDefinition | null
  messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }[]
  changeSummary: string[]
  canUndo: boolean
  savedTemplate: { id: string; version: number; name: string } | null
  sourcePlanId: string | null
  sourcePlanVersion: number | null
  createdAt: string
  updatedAt: string
}
export type CreationAction =
  | { action: 'create' }
  | { action: 'fork'; sourceTemplateId: string; sourceTemplateVersion: number }
  | { action: 'fork'; sourcePlanId: string }
  | { action: 'message'; draftId: string; expectedVersion: number; text: string }
  | { action: 'update'; draftId: string; expectedVersion: number; definition: TemplateDefinition }
  | { action: 'undo' | 'save'; draftId: string; expectedVersion: number }
export interface CreationResult { clientOpId: string; kind: CreationAction['action']; draft: CreationDraft; transient: boolean; message?: string }
export interface PrivateTemplate { id: string; version: number; name: string; description: string; draftId: string; updatedAt: string }
