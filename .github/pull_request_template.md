# TEAM-COLLAB-V1 Task Record

> Keep this PR in Draft until its frozen acceptance and Packet-required validation are complete. Never include secrets, credentials, customer data, private configuration, or production values. Failed code must not be pushed only to satisfy this template.

## Mandatory core

- TASK_ID:
- STATUS: `READY | IN_PROGRESS | VALIDATING | HANDOFF_READY | BLOCKED | STOPPED | DONE`
- CURRENT_WRITER:
- BASE_BRANCH:
- BASE_SHA:
- HANDOFF_SHA / CURRENT_HEAD_SHA:
- TASK_BRANCH:

### Changed files and scope

<!-- List exact paths and a short diff summary. State forbidden scope that was relevant. -->

- Changed files:
- Diff summary:
- Scope result: `PASS | FAIL`

### Actual validations

<!-- Use actual evidence only. Packet-required items cannot be relabelled N/A. Allowed results: PASS, FAIL, NOT_RUN, N/A, UNVERIFIED. -->

| Requirement source | Command or method | Environment | Result | Exact HEAD/artifact |
| --- | --- | --- | --- | --- |
| V0 STATIC | `git diff --check` | local |  |  |

### Risks and unknowns

<!-- Use only BLOCKER, SHOULD_FIX, or DEFERRED; write NONE when empty. -->

- RISKS_OR_UNKNOWNS:

### Next authorized action

- NEXT_AUTHORIZED_ACTION:
- Owner:
- Required approval:

## Packet-conditional evidence

<!-- Include only rows/blocks required by this Task Packet, such as exact-head CI, browser, migration, visual, external, ledger, or line-count evidence. Delete unused placeholder rows; do not mark a required row N/A. -->

| Packet requirement | Evidence/run/job/version | Result | Notes |
| --- | --- | --- | --- |
|  |  |  |  |

## Sensitive and authorization gates

- [ ] No credential, token, key, customer data, private configuration, or production value is included.
- [ ] User and unrelated worktree changes were preserved.
- [ ] Stage used explicit authorized paths only.
- [ ] Commit, push, and this Draft PR were each authorized.
- [ ] No unauthorized dependency, lockfile, Migration, Auth/security, external, merge, release, deploy, or production action occurred.

## Handoff

- From:
- To:
- HANDOFF_SHA / artifact version and hash:
- REMOTE_SHA (for pushed code):
- Worktree status:
- UNCOMMITTED_RELEVANT_WORK:
- ACTION_COUNTS:
- Forbidden next actions:
