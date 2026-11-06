#!/usr/bin/env bash
# Files one report when a CI job fails: a comment on the pull request, or otherwise an issue labelled "failure".
# Usage: report-failure.sh <job name> [test output file]
set -uo pipefail
job="$1" out="${2:-}" repo="$GITHUB_REPOSITORY"
run_url="$GITHUB_SERVER_URL/$repo/actions/runs/$GITHUB_RUN_ID"
# The step that failed, read from this run's job list (each step is named "Step N: ..."). GitHub may not have
# recorded the failed step's result yet when this runs, so fall back to the first numbered step not yet marked success.
step=$(gh api "repos/$repo/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs" \
  --jq ".jobs[] | select(.name == \"$job\") | [.steps[] | select(.name | startswith(\"Step \"))] | (map(select(.conclusion == \"failure\")) + map(select(.conclusion != \"success\" and .conclusion != \"skipped\")))[0].name // empty" 2>/dev/null | head -n 1)
step="${step:-an unnamed step (see the run)}"

{
  echo "**Job:** $job"
  echo "**Failed at:** $step"
  sha="${PR_HEAD_SHA:-$GITHUB_SHA}"; echo "**Commit:** ${sha:0:7}"
  echo "**Run:** $run_url"
  if [ -n "$out" ] && [ -s "$out" ]; then
    echo
    echo "Raw output of the failing tests (lines cut at 500 characters, first 150 lines):"
    echo '```'
    { grep -E -A 14 '^\s*not ok' "$out" || tail -n 60 "$out"; } | cut -c 1-500 | head -n 150
    echo '```'
  fi
} > report.md

if [ -n "${PR_NUMBER:-}" ]; then
  gh pr comment "$PR_NUMBER" --repo "$repo" --body-file report.md
else
  gh label create failure --repo "$repo" --color B60205 --description "Automated failure report" --force > /dev/null
  gh issue create --repo "$repo" --label failure --title "[FAILED] $job — $step" --body-file report.md
fi
