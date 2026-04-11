# UI/UX Redesign Task

## Objective

Transform the local video UI into a cleaner ops deck with less duplication, less noise, and stronger operational clarity.

## Decisions Locked In

- Keep `Logs` as the only tab with raw live output.
- Remove duplicated log surface from `Criar`.
- Remove the `Histórico` block from the visible `Criar` flow.
- Remove `failed jobs` from the visible library surface.
- Keep the operator focused on:
  - launch a run
  - inspect the current run
  - review the live console
  - manage completed videos

## Visual Direction

- Futurist command deck, not generic dashboard
- Dark glass panels with cyan/teal telemetry accents
- Stronger hierarchy in hero, tabs, state cards, and recovery actions
- More editorial typography, less default admin look

## Next Pass

- Simplify the workspace status panel even more around:
  - RCA
  - recommended action
  - pipeline checklist
  - preview approval
- Rework the logs tab as a premium terminal view
- Tighten the library into a clearer review-and-publish workflow
- Remove or demote any label, hint, or card that does not help the operator decide the next safe action
