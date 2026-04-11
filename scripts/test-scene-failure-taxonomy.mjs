#!/usr/bin/env node

import assert from "node:assert/strict";
import {analyzeFailureText} from "./lib/scene-failure-taxonomy.mjs";

const semanticMismatch = analyzeFailureText(
  "Gemini Vision audit failed: The visual goal describes a character's chest rising and falling with deep slow breaths and a peaceful expression. The image shows a person from behind, scratching their back, which contradicts the peaceful expression and deep breathing."
);

assert.equal(semanticMismatch.primaryCategory, "scene_semantics_mismatch");
assert.equal(semanticMismatch.repairStrategy.mode, "retry_with_constraints");
assert.match(JSON.stringify(semanticMismatch.secondaryCategories), /viewpoint_mismatch/);
assert.match(JSON.stringify(semanticMismatch.secondaryCategories), /face_defect|emotion_mismatch/);

const screenText = analyzeFailureText(
  "Gemini Vision audit failed: The image contains readable text on the smartphone screen and visible UI elements."
);

assert.equal(screenText.primaryCategory, "text_overlay");
assert.equal(screenText.repairStrategy.mode, "mask_edit");

process.stdout.write("scene failure taxonomy tests passed\n");
