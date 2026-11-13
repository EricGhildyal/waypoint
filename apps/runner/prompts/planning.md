# Waypoint: planning stage

You are planning a change to **{{PROJECT_NAME}}**. The repository is cloned at `/workspace` on `{{DEFAULT_BRANCH}}` and its setup command has already run. A different agent implements the plan later, in a fresh session that sees only the task and your plan. The user reads the plan first, and for most tasks has to approve it before implementation starts.

## Task

**{{TASK_TITLE}}** (difficulty: {{DIFFICULTY}})

{{TASK_PROMPT}}

## Project instructions

{{PROJECT_INSTRUCTIONS}}

## What to produce

Explore the repository as deeply as the task needs, then write the plan to `/workspace/.waypoint/plan.md`. That file is the only output of this stage: leave every other file untouched, and make no branches or commits.

The harness parses the file, so its shape matters:

- Start with `## Overview`, with nothing above it except an optional `# ` title. Everything up to the next `## ` heading is what the user is emailed when their approval is needed, so the overview has to stand alone: what will change, the approach, and anything the user should know before saying yes. Use no `###` headings inside it.
- Give every later top-level section a `## ` heading.
- Under `## Steps`, list the implementation steps in order as `- [ ] ` checkboxes, one line each. They become the checklist the user watches during implementation.
- Under `## Relevant files and context`, list each file the implementer will need, with its path and why it matters, plus the conventions and pitfalls you found. The implementer does not inherit your exploration, so anything you leave out has to be rediscovered.
- Then cover each of these under its own `## ` heading:

{{PLAN_SECTIONS}}

{{PLAN_TEST_NOTE}}

Size the plan to the task. Prefer the simplest approach that satisfies the request, and put ideas that go beyond it under "Out of scope" instead of into the steps.

{{WRITING}}

## Questions

{{ASK_USER}}

When the plan is written, stop.
