#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildGeminiVisionAuditGuardrails,
  sanitizeShotText,
  shotAllowsAbstractScreenContent,
  shotNeedsBlankDeviceScreen,
  shotNeedsStatusUiSignal
} from "./generate-flux2-assets.mjs";

const createShot = (overrides = {}) => ({
  coverageText: "",
  mustShow: [],
  supportingDetails: [],
  setting: "",
  composition: "",
  action: "",
  ...overrides
});

const mapShot = createShot({
  coverageText: "A secure encrypted map on a tablet in a command center.",
  mustShow: ["secure encrypted map on a tablet"],
  supportingDetails: ["tactical map on a screen"]
});

assert.equal(
  sanitizeShotText("secure encrypted map on a tablet"),
  "slate device showing an abstract tactical map panel"
);
assert.equal(shotAllowsAbstractScreenContent(mapShot), true);
assert.equal(shotNeedsBlankDeviceScreen(mapShot), false);
assert.match(
  buildGeminiVisionAuditGuardrails({shot: mapShot}).join("\n"),
  /abstract tactical map panel/i
);

const genericScreenShot = createShot({
  coverageText: "A character staring at a tablet screen in a dark room.",
  mustShow: ["tablet screen"]
});

assert.equal(shotAllowsAbstractScreenContent(genericScreenShot), false);
assert.equal(shotNeedsBlankDeviceScreen(genericScreenShot), true);

const outageShot = createShot({
  coverageText: "Phone showing gps unavailable while the driver looks confused.",
  mustShow: ["crossed-out navigation pin"],
  supportingDetails: ["no signal"]
});

assert.equal(shotNeedsStatusUiSignal(outageShot), true);
assert.match(
  buildGeminiVisionAuditGuardrails({shot: outageShot}).join("\n"),
  /symbolic outage cue/i
);

process.stdout.write("flux2 rules regression tests passed\n");
