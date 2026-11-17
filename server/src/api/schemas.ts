import { z } from 'zod';
import { CATEGORIES } from '../domain/ledger.js';
import { REFUND_SNAPSHOT_PATTERN } from '../services/refund-snapshot.js';
import { adoptTemplateActionSchema, applyPrivateTemplateActionSchema, configureReadingActionSchema, configureLedgerActionSchema, configureGenericActionSchema, addGenericActionSchema, editGenericActionSchema } from '../templates/contracts.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const category = z.enum(CATEGORIES);
const scope = z.enum(['current_only', 'current_and_future', 'next_and_future']);

export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({type:z.literal('upgrade_community_template'),planId:uuid,targetVersion:z.number().int().positive(),expectedVersion:z.number().int().positive()}),
  adoptTemplateActionSchema,
  applyPrivateTemplateActionSchema,
  configureReadingActionSchema,
  configureLedgerActionSchema, configureGenericActionSchema, addGenericActionSchema, editGenericActionSchema,
  z.object({ type: z.literal('create_ledger'), budgetCents: z.number().int().nullable().optional() }),
  z.object({ type: z.literal('create_study'), name: z.string().max(20).nullable().optional(), activity: z.string().max(20).nullable().optional(), daysPerWeek: z.number().int().nullable().optional(), minMinutes: z.number().int().nullable().optional() }),
  z.object({ type: z.literal('add_expense'), amountCents: z.number().int(), category, date, note: z.string().max(200).optional() }),
  z.object({ type: z.literal('add_refund'), expenseId: uuid, amountCents: z.number().int(), date, note: z.string().max(200).optional() }),
  z.object({ type: z.literal('add_study'), planId: uuid, minutes: z.number().int(), date, note: z.string().max(200).optional() }),
  z.object({
    type: z.literal('edit_record'),
    correctionReason: z.enum(['understanding_error', 'normal_adjustment', 'unspecified']).optional(),
    recordId: uuid,
    expectedVersion: z.number().int().optional(),
    patch: z.object({ amountCents: z.number().int().optional(), minutes: z.number().int().optional(), category: category.optional(), date: date.optional(), note: z.string().max(200).optional() }),
  }),
  z.object({ type: z.literal('delete_record'), correctionReason: z.enum(['understanding_error', 'normal_adjustment', 'unspecified']).optional(), recordId: uuid, includeRefunds: z.boolean().optional(), expectedVersion: z.number().int().optional(), expectedRefundSnapshot: z.string().regex(REFUND_SNAPSHOT_PATTERN).optional() }),
  z.object({ type: z.literal('set_goal'), planId: uuid, param: z.enum(['budget_cents', 'days_per_week', 'min_minutes']), value: z.number().int(), scope }),
  z.object({ type: z.literal('rename_plan'), planId: uuid, name: z.string().min(1).max(20) }),
  z.object({ type: z.literal('archive_plan'), planId: uuid }),
  z.object({ type: z.literal('restore_plan'), planId: uuid }),
  z.object({ type: z.literal('set_view'), planId: uuid, hidden: z.array(z.string()).max(10).optional(), order: z.array(z.string()).max(10).optional() }),
]);

export const operationBody = z.object({
  clientOpId: z.string().min(8).max(120),
  inputAt: z.string().datetime({ offset: true }).optional(),
  actions: z.array(actionSchema).min(1).max(10),
});

export const chatBody = z.object({
  clientMsgId: z.string().min(8).max(120),
  text: z.string().max(500),
  inputAt: z.string().datetime({ offset: true }).optional(),
  scopePlanId: uuid.nullable().optional(),
  pendingId: uuid.nullable().optional(),
  choice: z.string().max(40).nullable().optional(),
});
