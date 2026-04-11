#!/usr/bin/env node

import assert from "node:assert/strict";
import {compileSceneSpecFromStoryboardScene, lintSceneSpec} from "./lib/scene-spec.mjs";

const calmBreathingScene = {
  title: "Respire Fundo",
  narration: "Respire fundo, sinta a tranquilidade e prepare-se para um sono reparador.",
  searchQuery: "close-up of a person s chest rising and falling with deep slow breaths a peaceful expression on their face",
  visualGoal: "A close-up of a person's chest rising and falling with deep slow breaths, a peaceful expression on their face.",
  sceneType: "stock"
};

const calmSpec = compileSceneSpecFromStoryboardScene(calmBreathingScene, {sceneNumber: 13});
assert.equal(calmSpec.subject.kind, "person");
assert.equal(calmSpec.camera.framing, "closeup");
assert.equal(calmSpec.camera.viewpoint, "front");
assert.equal(calmSpec.pose.bodyPose, "breathing");
assert.equal(calmSpec.pose.interaction, "none");
assert.equal(calmSpec.affect.emotion, "calm");
assert.equal(calmSpec.pose.faceVisibility, "clear");

const backViewConflictSpec = {
  ...calmSpec,
  camera: {
    ...calmSpec.camera,
    viewpoint: "back"
  },
  pose: {
    ...calmSpec.pose,
    faceVisibility: "clear"
  }
};

const backViewLint = lintSceneSpec(backViewConflictSpec);
assert.equal(backViewLint.ok, false);
assert.match(JSON.stringify(backViewLint.issues), /back|viewpoint|face/i);

const fullBodyConflictSpec = {
  ...calmSpec,
  camera: {
    ...calmSpec.camera,
    framing: "closeup"
  },
  constraints: {
    ...calmSpec.constraints,
    mustShow: ["full body", "face", "torso"]
  }
};

const fullBodyLint = lintSceneSpec(fullBodyConflictSpec);
assert.equal(fullBodyLint.ok, false);
assert.match(JSON.stringify(fullBodyLint.issues), /closeup|full body/i);

process.stdout.write("scene spec tests passed\n");
