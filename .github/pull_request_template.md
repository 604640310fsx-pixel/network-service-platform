# TEAM-COLLAB-V1 Task Record

> Keep this PR in Draft until its frozen acceptance and Packet-required validation are complete. Never include secrets, credentials, customer data, private configuration, or production values. Failed code must not be pushed only to satisfy this template.

## Mandatory core

- TASK_ID:
- AUTHOR / CURRENT_WRITER:
- WHAT_CHANGED:
- WHAT_DID_NOT_CHANGE:
- RESULT_VERSION: <!-- exact SHA or approved artifact version/hash -->
- SAFE_CLOSEOUT: <!-- worktree, user-change and sensitive-boundary result -->
- REMAINING_ISSUE: <!-- one real issue or NONE -->
- NEXT_AUTHORIZED_ACTION:

### Actual validations

<!-- Use actual evidence only. Packet-required items cannot be relabelled N/A. Allowed results: PASS, FAIL, NOT_RUN, N/A, UNVERIFIED. -->

| Requirement source | Command or method | Environment | Result | Exact HEAD/artifact |
| --- | --- | --- | --- | --- |
| V0 STATIC | `git diff --check` | local |  |  |

## Packet-conditional evidence

<!-- Include only rows/blocks required by this Task Packet, such as status/base/branch/handoff, exact-head CI, browser, migration, visual, external, ledger, or line-count evidence. Delete unused placeholder rows; do not mark a required row N/A. -->

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

<!-- Keep this block only when a handoff is required. The original author stops before ownership is explicitly transferred. -->

- From:
- To:
- HANDOFF_SHA / artifact version and hash:
- REMOTE_SHA (for pushed code):
- Worktree status:
- UNCOMMITTED_RELEVANT_WORK:
- ACTION_COUNTS:
- Forbidden next actions:
