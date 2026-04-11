# Style Consistency Stories

## Definition Of Ready

Each story must name:

- affected pipeline stage
- artifact to create or modify
- acceptance criteria that can be checked from outputs or reports

## Definition Of Done

`Visually consistent video` means:

- one visual contract per run
- one enforced source policy per run
- one measurable consistency report per run
- no scene-level drift beyond threshold
- operator can see what failed and why

## Stories

### ST-01 Run Visual Contract

Objective:
Create a single source of truth for visual identity per run.

Scope:

- generate `visual-contract.json` at run start
- include style, palette, lighting, composition family, motion profile, source policy, caption-safe layout

Acceptance:

- every run writes `visual-contract.json`
- storyboard, asset plan, and render props reference the contract
- run fails early if contract is missing

Dependencies:

- none

Primary risk:

- contract too abstract to drive generation and QA

### ST-02 Prompt Inheritance From Contract

Objective:
Make every scene inherit the same visual identity.

Scope:

- inject contract into storyboard enrichment
- inject contract into visual planning
- inject contract into scene prompt generation

Acceptance:

- each generated scene prompt records contract inheritance
- prompts stay inside style boundaries of the run

Dependencies:

- ST-01

Primary risk:

- model still ignores parts of the contract

### ST-03 Prompt Conflict Normalization

Objective:
Stop contradictory prompt instructions inside a single scene.

Scope:

- define mutually exclusive framing classes
- prevent macro and full-body directives from coexisting
- prevent portrait and object-led framing from coexisting unless explicitly allowed

Acceptance:

- prompt builder emits one framing family per scene
- contradictory prompt patterns are blocked in tests

Dependencies:

- ST-02

Primary risk:

- over-normalization removes useful scene specificity

### ST-04 Source Policy Enforcement

Objective:
Prevent accidental mixing of incompatible visual sources.

Scope:

- add `sourcePolicy` at run level
- classify scene outputs by source class
- fail `single-source` runs that mix classes

Acceptance:

- each scene has `sourceClass`
- run report shows source mix clearly
- unauthorized mixing fails QA

Dependencies:

- ST-01

Primary risk:

- useful fallbacks get blocked without override path

### ST-05 Scene Consistency Scoring

Objective:
Turn style drift into measurable output.

Scope:

- compute per-scene consistency score
- compare against run contract
- report reasons for drift

Acceptance:

- each scene receives score and reasons
- artifacts show low-scoring dimensions

Dependencies:

- ST-01
- ST-02

Primary risk:

- false positives from weak heuristics

### ST-06 Run-Level Consistency Gate

Objective:
Fail runs that are semantically correct but visually inconsistent.

Scope:

- aggregate scene scores into run score
- add threshold policy
- fail run on drift, not only on semantics/anatomy

Acceptance:

- QA can fail a run for consistency reasons
- report lists top failing scenes

Dependencies:

- ST-04
- ST-05

Primary risk:

- more failed runs before repair flow exists

### ST-07 Selective Scene Repair

Objective:
Repair drift without rerendering the whole video.

Scope:

- regenerate only failing scenes
- keep same run visual contract
- compare score before and after

Acceptance:

- repair flow touches only failing scenes
- run report shows delta before/after repair

Dependencies:

- ST-05
- ST-06

Primary risk:

- repaired scenes improve locally but still feel off in sequence

### ST-08 Output Policy Validation

Objective:
Make final output policy explicit and enforced.

Scope:

- validate final resolution against profile
- record effective render scale
- fail policy mismatch

Acceptance:

- report shows intended and actual output dimensions
- no more silent mismatch between profile and rendered MP4

Dependencies:

- none

Primary risk:

- performance cost if native render becomes mandatory

### ST-09 UI Consistency Panel

Objective:
Make style consistency debuggable without opening raw JSON artifacts.

Scope:

- show visual contract
- show source policy
- show scene scores
- show failure reasons

Acceptance:

- operator can explain a style failure from UI alone

Dependencies:

- ST-05
- ST-06

Primary risk:

- UI becomes passive telemetry instead of actionable control

### ST-10 Regression Suite For Canonical Runs

Objective:
Prevent visual consistency regressions.

Scope:

- define canonical runs for key channel/style combinations
- compare scores and output policy on future changes

Acceptance:

- canonical runs exist
- regressions surface in automated validation

Dependencies:

- ST-05
- ST-06
- ST-08

Primary risk:

- external model variance makes tests noisy

## Recommended Order

1. ST-01
2. ST-02
3. ST-03
4. ST-08
5. ST-04
6. ST-05
7. ST-06
8. ST-07
9. ST-09
10. ST-10
