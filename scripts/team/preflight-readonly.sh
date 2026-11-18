#!/usr/bin/env bash

set -u

export GIT_OPTIONAL_LOCKS=0

base_branch=""
expected_base_sha=""
argument_error="NO"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-branch)
      if [ "$#" -lt 2 ]; then
        argument_error="YES"
        break
      fi
      base_branch="$2"
      shift 2
      ;;
    --expected-base-sha)
      if [ "$#" -lt 2 ]; then
        argument_error="YES"
        break
      fi
      expected_base_sha="$2"
      shift 2
      ;;
    *)
      argument_error="YES"
      shift
      ;;
  esac
done

repository_root="UNKNOWN"
current_branch="UNKNOWN"
local_head="UNKNOWN"
git_status="UNKNOWN"
remote_base_sha="UNKNOWN"
base_sha_match="UNKNOWN"
agents_file="MISSING"
claude_file="MISSING"
team_collab_file="MISSING"
result="PASS"
exit_code=0

if detected_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  repository_root="$detected_root"

  detected_branch=$(git -C "$repository_root" branch --show-current 2>/dev/null || true)
  if [ -n "$detected_branch" ]; then
    current_branch="$detected_branch"
  else
    current_branch="DETACHED"
  fi

  if detected_head=$(git -C "$repository_root" rev-parse HEAD 2>/dev/null); then
    local_head="$detected_head"
  fi

  if detected_status=$(git -C "$repository_root" status --short --branch 2>/dev/null); then
    git_status="$detected_status"
  fi

  if [ -f "$repository_root/AGENTS.md" ]; then
    agents_file="PRESENT"
  fi
  if [ -f "$repository_root/CLAUDE.md" ]; then
    claude_file="PRESENT"
  fi
  if [ -f "$repository_root/docs/team/TEAM-COLLAB-V1.md" ]; then
    team_collab_file="PRESENT"
  fi

  if [ -n "$base_branch" ] && git -C "$repository_root" remote get-url origin >/dev/null 2>&1; then
    if remote_line=$(git -C "$repository_root" ls-remote --exit-code origin "refs/heads/$base_branch" 2>/dev/null); then
      detected_remote_sha=$(printf '%s\n' "$remote_line" | awk 'NR == 1 { print $1 }')
      if [ -n "$detected_remote_sha" ]; then
        remote_base_sha="$detected_remote_sha"
      fi
    fi
  fi
fi

if [ "$remote_base_sha" != "UNKNOWN" ] && [ -n "$expected_base_sha" ]; then
  normalized_remote_sha=$(printf '%s' "$remote_base_sha" | tr '[:upper:]' '[:lower:]')
  normalized_expected_sha=$(printf '%s' "$expected_base_sha" | tr '[:upper:]' '[:lower:]')
  if [ "$normalized_remote_sha" = "$normalized_expected_sha" ]; then
    base_sha_match="YES"
  else
    base_sha_match="NO"
  fi
fi

if [ "$argument_error" = "YES" ] ||
   [ "$repository_root" = "UNKNOWN" ] ||
   [ -z "$base_branch" ] ||
   [ -z "$expected_base_sha" ] ||
   [ "$remote_base_sha" = "UNKNOWN" ] ||
   [ "$agents_file" = "MISSING" ] ||
   [ "$claude_file" = "MISSING" ] ||
   [ "$team_collab_file" = "MISSING" ]; then
  result="BLOCKED"
  exit_code=2
elif [ "$base_sha_match" = "NO" ]; then
  result="DRIFT"
  exit_code=1
fi

printf 'PREFLIGHT_MODE: READ_ONLY\n'
printf 'REPOSITORY_ROOT: %s\n' "$repository_root"
printf 'CURRENT_BRANCH: %s\n' "$current_branch"
printf 'LOCAL_HEAD: %s\n' "$local_head"
printf 'GIT_STATUS:\n%s\n' "$git_status"
printf 'BASE_BRANCH: %s\n' "${base_branch:-UNKNOWN}"
printf 'REMOTE_BASE_SHA: %s\n' "$remote_base_sha"
printf 'EXPECTED_BASE_SHA: %s\n' "${expected_base_sha:-UNKNOWN}"
printf 'BASE_SHA_MATCH: %s\n' "$base_sha_match"
printf 'AGENTS_FILE: %s\n' "$agents_file"
printf 'CLAUDE_FILE: %s\n' "$claude_file"
printf 'TEAM_COLLAB_FILE: %s\n' "$team_collab_file"
printf 'WORKTREE_MUTATED: NO\n'
printf 'RESULT: %s\n' "$result"

exit "$exit_code"
