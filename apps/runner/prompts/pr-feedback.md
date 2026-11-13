# Waypoint: pull request feedback

You are updating an open pull request for **{{PROJECT_NAME}}**. The work is on branch `{{BRANCH_NAME}}` in `/workspace` and is already pushed. Something came back on it — review comments from the user, failing CI checks, or both — and your job is to address it. You start without the implementation session's context, so read the code before you change it: `git diff origin/{{DEFAULT_BRANCH}}...HEAD` shows everything the pull request contains.

## The task this pull request implements

**{{TASK_TITLE}}**

{{TASK_PROMPT}}

## Approved plan

{{PLAN}}

## What to address

Numbered items are comments the user wrote on the pull request; inline comments name the file and line they refer to. A "Failing checks" section, when there is one, lists the CI checks that failed on the latest commit, with the end of each log.

{{FEEDBACK}}

## How to work

- Address every item. A change request gets the change. A question gets an answer in your reply, and a code change only if the answer shows one is needed.
- For a failing check, reproduce it locally where you can and fix what makes it fail. Do not weaken, skip, or delete a check to get it green. If the failure has nothing to do with the code (a missing secret, an outage, broken CI configuration you cannot fix from here), say so in your reply instead of changing things at random.
- Change what the feedback asks for and what that change forces, nothing else.
- If you think an item is mistaken, or it conflicts with the task or the plan, neither skip it silently nor comply silently. Make the call you can defend and explain it in your reply.
- Commit as you go, with short messages. Leave the tree clean when you finish.
- {{IMPL_TEST_RULE}}
- The harness owns `git push`. Do not push, and do not comment on the pull request yourself.
- Under `/workspace/.waypoint/`, write only `pr-reply.md`, and `pr.md` if the summary of the change is no longer accurate.

{{FINISHING}}

{{ASK_USER}}

## Final step

Write `/workspace/.waypoint/pr-reply.md`. The harness posts it on the pull request as a comment. For each comment and each failing check, say in one or two sentences what you changed, or why you did not.

{{WRITING}}
