# Reading template contract (v1)

This directory defines the first reading slice of S1. Ledger and water definitions are contract examples only; the available catalogue currently exposes `official.reading`, version `1`. `legacy.study` describes learning plans that existed when migration 11 ran; it is not offered for adoption and does not imply reading-specific settings.

## API integration

The application routes call the functions in `services/templates.ts`:

- `listAvailableTemplates(q)` returns an array, wrapped by the route as `{ templates }`.
- `getAvailableTemplate(q, templateId)` returns the definition directly.
- `getPlanTemplate(q, userId, planId, today)` returns `TemplatePlanState` directly. Ownership is checked before looking up a binding. An unbound plan returns `not_found`.

Template mutations use the existing operations endpoint, result lookup, account lock, data version and recovery queue. They require the explicit `reading-template-v1` client capability and exactly one template action per operation; a configuration patch can contain multiple settings. The supported actions and limits are defined in `contracts.ts`. No new record kind, plan kind, lifecycle status or operation-result item type is added for this slice.

Both mutations persist an optional `OperationResult.templatePlan` alongside the existing result. Adoption returns the established `plan_created` item. Configuration returns a compatibility `plan_updated` item; capable clients use `templatePlan` to label it as a settings change rather than a rename. Neither adoption nor configuration is undoable: users amend configuration or archive/restore a plan. Ordinary record edits/deletes/undo continue through the existing study engine.

Successful template operations bind the stable operation ID to a canonical hash of actions and explicit input time. Same ID/different content, including an ID previously used by an ordinary operation, is rejected as `operation_changed`. An omitted HTTP `inputAt` remains omitted in the hash so a server-clock change does not break a same-body retry. Clients still preserve an explicit original `inputAt` as required by the shared recovery contract. Failure rolls back both request binding and business writes.

## Configuration and goals

- Setup status (`pending`/`ready`) is independent of plan lifecycle (`active`/`archived`). Optional targets may remain unset after setup is completed.
- Omitted patch fields remain unchanged. `null` explicitly clears current book or a goal; `completeSetup: true` finishes setup. Cancelling makes no request and preserves the instance.
- `expectedVersion` is mandatory. Plan name/date/lifecycle/view changes and goal changes from existing operation paths also advance the binding's configuration version. The number is monotonic, not necessarily incremented by exactly one for a compound patch.
- Name is at most 20 characters, current book at most 80; weekly days are 1–7, minute targets 1–1440. Start date can change only while pending with no goal, record (including deleted records), or lifecycle history, and cannot be in the future. Archived plans must first be restored.
- Goal scopes use the existing weekly rule precedence: current only, current and future, or next and future. Missing scope defaults to current and future. Clearing creates a rule segment with `cleared=true`; its stored integer value is a compatibility placeholder, never a target. Rule readers return null for that segment while preserving earlier and later periods.
- `config.daysPerWeek` and `minMinutes` represent the requested business week's active rules. `goalEffectiveFrom` identifies those winning segments; `nextWeekGoals` reports the next week's actual effective values, including scheduled clears. It is not a reflection of the last patch.

Reading facts remain ordinary study records with integer minutes. Book, reading position and reflection are explicitly labelled notes; a position is never interpreted as a quantity of pages read. Template setup and examples create no factual records. Structured reading fields and generic records are outside this slice.

## Migration, privacy and compatibility

Migration 11 is a frozen SQL snapshot; never regenerate it from current runtime definitions after deployment. Future definitions require a new immutable version and migration. It adds template tables, legacy study bindings and a goal-clear marker without rewriting existing plan or record values. Existing money/study types and bearer authentication remain compatible. New template actions are gated before execution; older clients continue using established operations and goal views, including null goals.

New private bindings and request hashes cascade with account deletion. Public official definitions contain synthetic examples only. Export adds `templates.json` with private plan definitions and configuration; the existing plan export includes target clear semantics. Runtime definition capabilities are checked as well as schema validity, so a valid definition requiring an unimplemented engine cannot be adopted.

Tests in `test/templates.test.ts` cover definition validation, catalogue availability, immutable versions, adoption replay/conflicts, account isolation, setup, concurrent configuration changes, goal scope/clear behaviour, archival boundaries, export/deletion, legacy migration and isolated disk reopen. HTTP authentication and capability enforcement are covered separately by `test/template-api.test.ts`.
