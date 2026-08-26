# TEAM-COLLAB-V1 Task Record

> Keep this pull request in Draft until the frozen acceptance criteria and required validation are complete. Do not include credentials, secrets, customer data, or production configuration.

## TASK_ID

<!-- Stable task identifier, for example TEAM-WORKFLOW-BASE-01. -->

- TASK_ID:
- STATUS:
- TASK_BRANCH:

## BASE_SHA

<!-- Record the frozen base branch and full base SHA. -->

- BASE_BRANCH:
- BASE_SHA:
- CURRENT_HEAD_SHA:

## CURRENT_WRITER

<!-- Exactly one active writer for overlapping files; use NONE when no writer is active. -->

- CURRENT_WRITER:
- NEXT_WRITER:

## FROZEN_SCOPE

<!-- List allowed files/actions and explicit forbidden scope. -->

### Allowed

-

### Forbidden

-

## CHECKPOINTS

<!-- Add one row per checkpoint. Do not replace failed or superseded evidence silently. -->

| ID | Status | HEAD | Changed files | Result |
| --- | --- | --- | --- | --- |
| CP-01 |  |  |  |  |

## TEST_RESULTS

<!-- Record exact commands, execution environment, result, and the tested HEAD. -->

| Validation level | Command | Environment | Result | HEAD |
| --- | --- | --- | --- | --- |
| V0 STATIC | `git diff --check` | local |  |  |

### CI checks

- [ ] Website check
- [ ] Website build
- [ ] Auth service build
- [ ] Auth service full test
- [ ] Lockfiles unchanged

## SENSITIVE_GATE

- [ ] No credentials, tokens, keys, or customer data are included.
- [ ] No production configuration, deployment, or real transaction was used.
- [ ] Auth, payment, Migration, Secrets, Billing, and branch protection are unchanged unless separately authorized and documented.
- Required sensitive approval: `NOT_APPLICABLE` / <!-- approval reference -->

## OPEN_RISKS

<!-- Use only BLOCKER, SHOULD_FIX, or DEFERRED. Write NONE when empty. -->

-

## NEXT_ACTION

<!-- One smallest authorized action, its owner, and any approval required. -->

- Action:
- Owner:
- Required approval:

## Handoff

- From:
- To:
- Last completed checkpoint:
- Worktree status:
- User changes preserved:
- Notes:

## Authorization audit

- [ ] Stage was explicitly authorized and used explicit paths only.
- [ ] Commit was explicitly authorized.
- [ ] Push was explicitly authorized for this task branch.
- [ ] Draft PR was explicitly authorized with the recorded base.
- [ ] No merge or deploy was performed.
