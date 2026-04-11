# Style Consistency Plan

Target system: `video.vamostestar.online` / `videos-flux2`

## Current Status

This plan is still valid, but it is no longer purely theoretical.

An MVP mitigation was already applied directly on the production host on `2026-04-11` in the remote file:

- `/root/repo/videos-flux2/scripts/generate-flux2-assets.mjs`

What the MVP already changed:

- stable run-level visual direction instead of aggressive per-scene camera rotation
- directive normalization to reduce contradictory framing
- reduced leakage of object-led close-up rules into full-human scenes

What is still missing from this plan:

- formal `visual-contract.json`
- measurable per-scene and per-run consistency score
- hard consistency QA gate
- selective repair loop driven by consistency score

Important repo note:

- this local repo does not currently contain the production `videos-flux2` codebase
- this plan therefore remains the authoritative design doc, but not a full mirror of implementation state

## Goal

Stop producing videos where scenes look like they came from different visual systems.

The pipeline must optimize for:

- one visual identity per run
- one approved source policy per run
- one measurable consistency score per run
- one clear recovery path when a scene drifts

## Problem Statement

Today the pipeline optimizes for "each scene works" rather than "all scenes belong to the same video".

That creates visible drift:

- different lighting and grading between scenes
- different composition rules inside the same run
- different character rendering from scene to scene
- retry outputs that satisfy semantics but break style
- mixed visual sources without a hard policy

## Root Causes

1. Style is prompt-only, not contract-based.
The chosen `imageStyle` behaves like prompt decoration, not a hard run-level contract.

2. Scene generation is independent.
The planner uses per-scene generation (`direct-scene`) with per-scene seeds and no stable visual anchor.

3. QA checks semantics more than cohesion.
The system retries for anatomy and scene meaning, but does not fail hard on run-level style drift.

4. Prompt composition is contradictory.
Generated prompts accumulate incompatible instructions like close-up, medium-wide, object-led macro, full figure, face visible, and wide environmental framing in the same scene.

5. Source policy is weak.
The pipeline allows practical drift between generated assets, retries, and source classes without a clear "single-source" or "mixed-on-purpose" rule.

## Assertive Decisions

These are the decisions to implement, not open questions:

1. Every run gets a `visual-contract.json` before any asset generation.
2. Every scene must inherit that contract.
3. Every run declares a source policy: `single-source` or `mixed-source-approved`.
4. Consistency becomes a QA gate, not a subjective note.
5. Failed consistency triggers selective scene repair before full rerender.
6. Resolution policy must be explicit and validated at output.

## Target Architecture

### 1. Run Visual Contract

Create a run-level artifact with:

- style preset id
- palette family
- lighting model
- contrast target
- composition family
- motion profile
- subject framing rules
- source policy
- caption-safe layout rules

This becomes the single source of truth for storyboard, asset plan, image prompts, retries, render props, and QA.

### 2. Prompt Normalization Layer

Build prompts from:

- scene intent
- run visual contract
- scene-specific constraints

Do not allow free accumulation of conflicting composition directives.

If a scene requests a face-readable portrait, it must not also receive macro object-led framing rules.

### 3. Source Policy Enforcement

Each run must declare:

- `single-source`
- `mixed-source-approved`

If the run is `single-source`, any fallback or alternate source should fail the run unless explicitly approved.

### 4. Consistency Scoring

Add run-level and scene-level scoring for:

- palette compatibility
- brightness and contrast band
- framing family
- subject scale
- visual density
- text contamination
- source-class compatibility

The output is a numeric score plus reasons per scene.

### 5. Recovery Flow

When consistency fails:

- regenerate only the failing scenes
- keep the same run visual contract
- keep the same approved source policy
- compare before/after score

Do not rerender the full video unless selective repair cannot recover the run.

### 6. Operator Visibility

Expose in the UI:

- selected style
- effective visual contract
- source policy
- consistency score
- failing scenes
- reason for failure

## Rollout

### Phase 1. Contract First

Deliver:

- `visual-contract.json`
- prompt inheritance from contract
- no-run-without-contract rule

Success:

- every new run produces a contract artifact
- prompts and asset plan reference the contract

### Phase 2. Remove Prompt Contradictions

Deliver:

- prompt normalization
- mutually exclusive composition rules
- style-safe retries

Success:

- prompt output no longer mixes incompatible framing instructions

### Phase 3. Add Consistency QA

Deliver:

- per-scene score
- per-run score
- thresholds
- hard fail on drift

Success:

- runs can fail for visual inconsistency even when semantics pass

### Phase 4. Add Recovery

Deliver:

- selective scene regeneration
- score improvement check
- scene replacement audit trail

Success:

- most drift is recoverable without full rerender

### Phase 5. UI and Regression Coverage

Deliver:

- consistency panel in UI
- canonical smoke runs
- regression checks for style and output policy

Success:

- operators can diagnose a drifted run in under one minute

## Definition Of Done

A run is "visually consistent" only if:

- all scenes inherit one visual contract
- source policy is respected
- output resolution matches policy
- consistency score passes threshold
- no scene is marked as drifted
- QA report explains the result without manual inspection

## Immediate Next Move

Implement Phase 1 and Phase 2 first.

Without those two, any later QA or retry work will only make failures clearer, not fewer.
