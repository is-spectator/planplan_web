# Platform frontend QA — 2026-11-16

归档说明：2026-11-16，将本机 `/tmp/planplan-platform-qa/QA_REPORT.md` 的最终报告（含重启与清理补充）保存到 plans。原始结果与限制保持不变，仅将附件文件名改为已核对存在的绝对链接。只归档此报告，没有复制会话凭据、数据备份、截图或导出附件；附件仍保存在本机临时证据目录，其链接不代表外部可访问或长期保管。

相关：[本机最终技术验证](platform-final-verification-2026-11-16.md)、[真实AI评测现状](platform-ai-evaluation-2026-11-16.md)、[全版本TODO（12/18）](../todos/2026-11-16-platform-completion.md)。132项浏览器结果不代表真实设备、独立用户试用或生产发布完成。

Frontend source is frozen. Chromium and WebKit each passed 66 distinct cases: **132/132 overall**. This includes **44 newly added platform cases** (22 per browser), plus **88 existing regression cases** (44 per browser). Repeated targeted reruns are excluded from the denominator.

## Environment and scope

- Frontend: http://127.0.0.1:5173; backend: http://127.0.0.1:8788, actual local database with migrations through M17.
- Browser plugin not available. Used existing Playwright caches, Chromium headless shell 1248 and WebKit 2248; no dependency downloads or user browser were used.
- Main desktop 1280×900; mobile 375×812, with existing 320/390/800 responsive regression checks.
- Only isolated platform-author, platform-consumer, and platform-reviewer synthetic accounts were used. Normal UI login first; later isolated cookie reuse avoided login throttling. No credentials or session contents are included here.
- 66 protocol/static/public-read cases and 66 authenticated actual-API/browser cases. Mocked protocol cases are not represented as actual model/database verification.

## Pass counts, per browser

| Suite | Cases | Coverage |
|---|---:|---|
| platform | 3 | P02 category spend/refund/net, negative trends, name/budget conflict, legacy study goals |
| platform-v2 | 8 | defaults, week/month metrics, publish/review/market/update/report, feedback/recovery/sync |
| platform-live | 9 | actual saved definitions, reviewed public listing, adoption/defaults, upgrade, moderation, sync/conflict, response-loss recovery, source message, deletion/history |
| platform-management-live | 2 | actual ledger rename/refund categories/trend and legacy study settings |
| chat | 4 | messages, confirmations, numeric/product wording |
| creation | 9 | 8-type editor, private save/adopt/fork/apply, recovery/export and mobile |
| foundation | 5 | navigation/layout/theme/storage behavior |
| functionality | 7 | actual plan/record/account flows |
| generic | 8 | dynamic forms, defaults/units, existing generic plan flows |
| session | 5 | session/recovery/isolated-account behavior |
| templates | 6 | public presentation and actual official adoption/setup |
| **Total** | **66** | **Chromium 66/66; WebKit 66/66** |

## Verified product paths

1. Creation → manual week/month definition and suggestions → private save → public-content preview → explicit submit → separate reviewer approval → author explicit publish → public search/filter/detail → consumer explicit adoption. Private settings, records, and private conversation never appear in public preview.
2. Adopted plan starts pending without automatic template defaults → explicit suggested configuration → independently enabled record defaults → new record accepts false and preserves explicitly cleared null → edit does not silently reapply defaults. Returned provenance is displayed using field names.
3. Day/week/month metrics render backend-provided values, sample counts, first-partial-period note, categories including empty and unfilled values, and day-granularity trend with a zero axis. Legacy finance shows spend/refund/net and true negative values.
4. New community version does not alter existing plans → compare available version → explicit compatible upgrade → original records remain. Report/reviewer suspension removes public listing while adopted plans remain; reviewer can release suspension and author separately republishes.
5. Visible-page changes update across sessions. Version conflict retains entered values alongside latest contents. Lost-response feedback resolves by original client ID after refresh without duplicate tickets. Feedback submission requires content/diagnostic preview, persists, and displays reviewer replies/history.
6. Author/reviewer history shows real submission/status events. Confirmed private draft/template deletion removes private endpoints and future adoption access while preserving already-adopted plan configuration/records and independently published community versions.
7. Exactly **one** allowed actual model request created a 10-minute record, with two default-origin fields, on 2026-11-16T07:21:42.794Z. Chromium verified record → original own message. WebKit verified the same persisted source read-only; it did not invoke the model again.
8. Two actual UI-triggered ZIP downloads were parsed and checked: consumer adopted records/community adoption/feedback; author preserved records from deleted sources, absence of deleted private drafts/templates, and retained unlisted community history.

## Rendered checks

| Check | Result |
|---|---|
| Intended route/title and meaningful content | Pass |
| Blank page / framework overlay | None observed |
| Runtime errors | 0 in final actual browser/export checks |
| Desktop and mobile visual review | Pass; no horizontal overflow at 375px |
| User interaction with actual saved state | Pass in 66 actual-API/browser cases |
| Source code typecheck/build/lint | Pass; `npm run build` includes `tsc -b`; `npm run lint` passes |
| Initial JS bundle | 272.34 kB (84.93 kB gzip), after route lazy loading; no large-chunk warning |

## Failures found and resolved

- Community upgrade endpoint required an explicit targetVersion. UI now obtains the recommended public version, requests an explicit comparison, and only then offers confirmation; full actual upgrade passed in both browsers.
- Existing chat assertion expected ungrouped numbers; updated to the intended product formatter (2,000 / 1,200).
- Fresh synthetic secondary account lacked a legacy plan expected by an older cross-account test; seeded only its synthetic plan and reran the full affected actual suite successfully. No original accounts were modified for this adjustment.
- Long community titles wrapped the source badge; corrected flex behavior. Period labels no longer incorrectly say daily for week/month metrics. Trend zero-line token and mobile axis text were corrected and rendered again.
- Final route splitting removed the initial >500kB build warning; navigation/theme/no-storage subset was rerun in both browsers (3 cases each, counted once above).

## Evidence and cleanup

- [frontend-source-manifest.json](/tmp/planplan-platform-qa/frontend-source-manifest.json): SHA-256 for frozen frontend source/config/tests.
- [chromium-platform-ids.json](/tmp/planplan-platform-qa/chromium-platform-ids.json), [webkit-platform-ids.json](/tmp/planplan-platform-qa/webkit-platform-ids.json): retained actual plan/record/listing IDs, including deleted private sources.
- [chromium-creation-ids.json](/tmp/planplan-platform-qa/chromium-creation-ids.json), [webkit-creation-ids.json](/tmp/planplan-platform-qa/webkit-creation-ids.json): retained 8-type creation/adoption records from regression.
- [chromium-platform-source.json](/tmp/planplan-platform-qa/chromium-platform-source.json): successful real model/source-message IDs and time.
- [export-and-visual-check.json](/tmp/planplan-platform-qa/export-and-visual-check.json), [author-verified-export.zip](/tmp/planplan-platform-qa/author-verified-export.zip), [consumer-verified-export.zip](/tmp/planplan-platform-qa/consumer-verified-export.zip): actual download checks, 11 expected ZIP entries each.
- [public-cleanup.json](/tmp/planplan-platform-qa/public-cleanup.json): exactly four listings matching this run's synthetic author and title pattern were unlisted; all four public detail reads returned 404. Adopted plans, records, review/history, and private test data remain. Market now displays only the three official templates.
- Representative final screenshots: [platform-final-plan-desktop.png](/tmp/planplan-platform-qa/platform-final-plan-desktop.png), [platform-final-plan-mobile.png](/tmp/planplan-platform-qa/platform-final-plan-mobile.png), [platform-final-market.png](/tmp/planplan-platform-qa/platform-final-market.png), [platform-final-creation.png](/tmp/planplan-platform-qa/platform-final-creation.png).
- Specific workflow screenshots: [chromium-platform-periods.png](/tmp/planplan-platform-qa/chromium-platform-periods.png), [chromium-platform-conflict.png](/tmp/planplan-platform-qa/chromium-platform-conflict.png), [chromium-platform-feedback.png](/tmp/planplan-platform-qa/chromium-platform-feedback.png), [chromium-platform-recovered.png](/tmp/planplan-platform-qa/chromium-platform-recovered.png), [chromium-platform-history.png](/tmp/planplan-platform-qa/chromium-platform-history.png), [chromium-platform-deleted-source-plan.png](/tmp/planplan-platform-qa/chromium-platform-deleted-source-plan.png), [chromium-platform-source-message.png](/tmp/planplan-platform-qa/chromium-platform-source-message.png), [webkit-platform-periods.png](/tmp/planplan-platform-qa/webkit-platform-periods.png), [webkit-platform-conflict.png](/tmp/planplan-platform-qa/webkit-platform-conflict.png), [webkit-platform-feedback.png](/tmp/planplan-platform-qa/webkit-platform-feedback.png), [webkit-platform-recovered.png](/tmp/planplan-platform-qa/webkit-platform-recovered.png), [webkit-platform-history.png](/tmp/planplan-platform-qa/webkit-platform-history.png), [webkit-platform-deleted-source-plan.png](/tmp/planplan-platform-qa/webkit-platform-deleted-source-plan.png), [webkit-platform-source-message.png](/tmp/planplan-platform-qa/webkit-platform-source-message.png), plus negative-trend and legacy-study screenshots: [chromium-platform-negative-live.png](/tmp/planplan-platform-qa/chromium-platform-negative-live.png), [webkit-platform-negative-live.png](/tmp/planplan-platform-qa/webkit-platform-negative-live.png), [chromium-platform-legacy-study-live.png](/tmp/planplan-platform-qa/chromium-platform-legacy-study-live.png), [webkit-platform-legacy-study-live.png](/tmp/planplan-platform-qa/webkit-platform-legacy-study-live.png).
- Six session cookie JSONs, all four temporary result/trace directories, temporary runners/configs, and the WebKit runner copy were removed after the post-restart check. Redacted logs, IDs, screenshots, and synthetic ZIPs are retained. The two fresh author/consumer sessions were signed out through the UI.

## Remaining limits

This verifies the local candidate using existing browser caches, not deployment or external real-device testing. Final backend matrix and backup/restore/restart were coordinated by the parent/domain agents. Fresh-login post-restart browser/ZIP verification passed at 2026-11-16T07:45:56.869Z; see the addendum below. No public release or real-user usability trial is claimed.

## Post-restart addendum

- Two fresh ordinary UI logins (author and consumer), without stored cookies, passed. Creation and adopted-plan pages render correctly; the two original 8-type definitions preserve every field ID/type. Community version 2, the 100-minute target, and false record default remain.
- Two new actual UI-triggered ZIP downloads contain all 11 expected entries. Six selected records (two original 8-type records, two adopted records whose private sources were deleted, two community records) are deeply equal to pre-restart export objects. This supplemental check is not added to the 132 distinct E2E denominator.
- Runtime errors during authenticated checks: 0. Mobile 375px overflow: none. Both sessions were explicitly signed out; no browser runner remains.
- The temporary read-only script's first direct API assertion omitted the required capability/expected-user headers and correctly received 409. The runner was corrected to send the same headers as the app; no product change was required. Expected unauthenticated startup probes were excluded from authenticated runtime-error collection.
- Evidence: [postrestart-check.json](/tmp/planplan-platform-qa/postrestart-check.json), [postrestart-author-export.zip](/tmp/planplan-platform-qa/postrestart-author-export.zip), [postrestart-consumer-export.zip](/tmp/planplan-platform-qa/postrestart-consumer-export.zip), [postrestart-creation-desktop.png](/tmp/planplan-platform-qa/postrestart-creation-desktop.png), [postrestart-plan-desktop.png](/tmp/planplan-platform-qa/postrestart-plan-desktop.png), [postrestart-plan-mobile.png](/tmp/planplan-platform-qa/postrestart-plan-mobile.png).
