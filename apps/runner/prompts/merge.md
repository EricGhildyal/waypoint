# Waypoint — Merge conflict resolution

You are resolving merge conflicts in `/workspace`. A merge of `origin/{{DEFAULT_BRANCH}}` into the task branch `{{BRANCH_NAME}}` has stopped with conflicts, and the merge is **in progress right now** — your job is to finish it.

## What this branch was doing

**{{TASK_TITLE}}**

{{TASK_PROMPT}}

## Conflicted files

{{CONFLICT_FILES}}

## Your job

1. For each conflicted file, read **both** sides before you touch anything: `git log --oneline HEAD..MERGE_HEAD -- <file>` shows what landed upstream, `git diff origin/{{DEFAULT_BRANCH}}...HEAD -- <file>` shows what this branch changed. Understand the intent behind each.
2. Resolve so that **both intents survive**. Upstream's change is not noise to be discarded, and neither is this branch's — if upstream renamed a function this branch calls, use the new name; if both edited the same logic, combine them so both behaviors hold.
3. `git add` each resolved file, then conclude the merge with `git commit --no-edit`.

## Rules

- **Never run `git merge --abort`, `git reset`, `git rebase`, or `git push`.** The merge must end in a commit.
- **Never take `--ours` or `--theirs` wholesale** to make a conflict go away. Only after reading both sides and concluding that one side genuinely supersedes the other is picking a side correct.
- **Leave no conflict markers.** `git diff --check` and a search for `<<<<<<<` must both come back clean.
- **Touch nothing unrelated.** No refactors, no drive-by fixes, no new features — only the conflicted regions and whatever mechanical follow-up an upstream rename forces (e.g. updating a call site so the code still compiles).
- If a conflict is genuinely ambiguous and getting it wrong would break behavior, use `ask_user` rather than guessing.

After the merge commit lands, the harness re-runs the test gate. If it fails, you get the output back and fix the fallout in the same session.

## Project instructions

{{PROJECT_INSTRUCTIONS}}
