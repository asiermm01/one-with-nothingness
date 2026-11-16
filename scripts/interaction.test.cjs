const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(result.outputText, filename);
};

const { GestureRecognizer } = require("../src/lib/interaction/gesture-recognition.ts");
const { DEFAULT_USER_SETTINGS, INTERACTION_CONFIG, INTERACTION_TUNING_DEFAULTS, INTERACTION_TUNING_RANGES, particleCountForDensity } = require("../src/lib/interaction/config.ts");
const { getHandStatuses } = require("../src/lib/interaction/hand-status.ts");
const { createFieldTransform, transformFieldPoint } = require("../src/lib/interaction/field-transform.ts");
const { ConstellationGraph } = require("../src/lib/rendering/constellation-graph.ts");
const { createParticleColor, particleColorAt } = require("../src/lib/rendering/particle-colors.ts");
const { pulseRadialAcceleration } = require("../src/lib/rendering/particle-engine.ts");

const viewport = { width: 1000, height: 500 };
const tuning = { ...INTERACTION_TUNING_DEFAULTS, smoothing: 1 };

function hand(x, y, handedness, extended = ["thumb", "index", "middle", "ring", "pinky"]) {
  const keypoints = [];
  const add = (name, px, py) => keypoints.push({ name, x: px, y: py });
  add("wrist", x, y + 0.05);
  const fingers = [
    ["index", "index_finger", -0.03],
    ["middle", "middle_finger", -0.01],
    ["ring", "ring_finger", 0.01],
    ["pinky", "pinky_finger", 0.03],
  ];
  for (const [finger, prefix, offset] of fingers) {
    add(`${prefix}_mcp`, x + offset, y);
    add(`${prefix}_pip`, x + offset, y - 0.04);
    add(`${prefix}_tip`, x + offset, y + (extended.includes(finger) ? -0.09 : -0.01));
  }
  add("thumb_mcp", x - 0.04, y + 0.01);
  add("thumb_ip", x - 0.06, y);
  add("thumb_tip", x - (extended.includes("thumb") ? 0.08 : 0.04), y + (extended.includes("thumb") ? -0.01 : 0.01));
  return { keypoints, confidence: 1, handedness };
}

function harness() {
  const recognizer = new GestureRecognizer();
  let now = 1000;
  const tick = (hands, count = 1) => {
    let frame;
    for (let index = 0; index < count; index += 1) {
      now += 33;
      frame = recognizer.update(hands, now, tuning, viewport);
    }
    return frame;
  };
  const pair = (leftX, rightX) => [hand(leftX, 0.5, "Left"), hand(rightX, 0.5, "Right")];
  return { recognizer, tick, pair };
}

test("stretch starts from the committed state, accumulates, and does not drift on release", () => {
  const { tick, pair } = harness();
  const start = tick(pair(0.35, 0.65), 8);
  assert.equal(start.gesture, "STRETCH");
  assert.equal(start.universeScale, 1);
  const expanded = tick(pair(0.25, 0.75), 80);
  assert.ok(expanded.universeScale > 2);
  const released = tick([], 80);
  assert.equal(released.universeScale, expanded.universeScale);
  assert.equal(released.universeRotation, expanded.universeRotation);
  const resumed = tick(pair(0.3, 0.7), 1);
  assert.equal(resumed.universeScale, released.universeScale);
  const further = tick(pair(0.2, 0.8), 80);
  assert.ok(further.universeScale > expanded.universeScale);
  const stopped = tick([], 80);
  assert.equal(stopped.universeScale, further.universeScale);
  tick(pair(0.2, 0.8), 1);
  const smaller = tick(pair(0.35, 0.65), 80);
  assert.ok(smaller.universeScale < stopped.universeScale);
  assert.equal(tick([], 60).universeScale, smaller.universeScale);
});

test("stretch rotation passes full turns and stays continuous across gestures", () => {
  const { tick } = harness();
  const pairAt = (angle) => {
    const dx = Math.cos(angle) * 100 / viewport.width;
    const dy = Math.sin(angle) * 100 / viewport.height;
    return [hand(0.5 - dx, 0.5 - dy, "Left"), hand(0.5 + dx, 0.5 + dy, "Right")];
  };
  tick(pairAt(0), 8);
  for (let index = 1; index <= 60; index += 1) tick(pairAt(index * Math.PI / 24));
  const rotated = tick(pairAt(2.5 * Math.PI), 80);
  assert.ok(rotated.universeRotation > 2 * Math.PI);
  assert.equal(tick([], 40).universeRotation, rotated.universeRotation);
  const restarted = tick(pairAt(0), 1);
  assert.equal(restarted.universeRotation, rotated.universeRotation);
  tick(pairAt(Math.PI / 4), 80);
  const continued = tick([], 20);
  assert.ok(continued.universeRotation > rotated.universeRotation + 0.7);
});

test("zoom limits are bounded and TRACE exposes a cursor instead of freehand strokes", () => {
  const { tick, pair } = harness();
  tick(pair(0.46, 0.54), 8);
  const maximum = tick(pair(0.1, 0.9), 120);
  assert.equal(maximum.universeScale, INTERACTION_CONFIG.stretch.maximumScale);
  tick([], 1);
  tick(pair(0.1, 0.9), 1);
  const minimum = tick(pair(0.47, 0.53), 120);
  assert.equal(minimum.universeScale, INTERACTION_CONFIG.stretch.minimumScale);
  const frame = tick([hand(0.18, 0.5, "Left", ["index", "middle"])], 1);
  assert.equal(frame.gesture, "TRACE");
  assert.equal(frame.cursors[0].mode, "TRACE");
  assert.deepEqual(frame.cursors[0].position, frame.hands[0].cursorPoint);
  assert.equal("strokes" in frame, false);
});

test("particle density is bounded and rejects invalid values", () => {
  const maximum = INTERACTION_CONFIG.particles.maximumCount;
  assert.equal(particleCountForDensity(maximum + 1000), maximum);
  assert.equal(particleCountForDensity(-10), 0);
  assert.throws(() => particleCountForDensity(Number.NaN), /finite/);
  assert.throws(() => particleCountForDensity(Infinity), /finite/);
});

test("hand statuses reflect each hand's active interaction independently", () => {
  const { tick, pair } = harness();
  assert.deepEqual(getHandStatuses([]), { left: "NO DETECTADA", right: "NO DETECTADA" });
  let frame = tick([hand(0.3, 0.5, "Left", ["index"]), hand(0.7, 0.5, "Right", ["index", "middle"])]);
  assert.deepEqual(getHandStatuses(frame.hands), { left: "CURSOR", right: "TRACE" });
  frame = tick([hand(0.3, 0.5, "Left", ["index", "middle", "ring"])], 10);
  assert.deepEqual(getHandStatuses(frame.hands), { left: "EN REPOSO", right: "NO DETECTADA" });
  frame = tick(pair(0.3, 0.7), 10);
  assert.deepEqual(getHandStatuses(frame.hands), { left: "STRETCH", right: "STRETCH" });
  assert.deepEqual(getHandStatuses([{ handedness: "Unknown", interaction: "trace" }]),
    { left: "SIN IDENTIFICAR", right: "SIN IDENTIFICAR" });
});

test("PULSE requires the index-and-pinky pose and emits only once until released", () => {
  const { tick } = harness();
  const pulsePose = [hand(0.5, 0.5, "Right", ["index", "pinky"])];
  let frame = tick(pulsePose, 1);
  assert.equal(frame.gesture, "IDLE");
  assert.equal(frame.events.some((event) => event.type === "pulse"), false);
  frame = tick(pulsePose, 11);
  assert.equal(frame.gesture, "PULSE");
  assert.equal(frame.hands[0].isPulsePose, true);
  const firstPulse = frame.events.find((event) => event.type === "pulse");
  assert.ok(firstPulse);
  frame = tick(pulsePose, 20);
  assert.equal(frame.events.filter((event) => event.type === "pulse").length, 1);

  tick([hand(0.5, 0.5, "Right", ["index"])], 8);
  frame = tick(pulsePose, 12);
  const pulses = frame.events.filter((event) => event.type === "pulse");
  assert.equal(pulses.length, 2);
  assert.ok(pulses[1].id > firstPulse.id);
});

test("PULSE captures the smoothed index cursor at activation and keeps its field origin fixed", () => {
  const { tick, pair } = harness();
  tick(pair(0.35, 0.65), 8);
  tick([hand(0.4, 0.35, "Left"), hand(0.7, 0.65, "Right")], 80);
  tick([], 1);
  const cursor = tick([hand(0.6, 0.5, "Right", ["index"])], 1);
  assert.equal(cursor.gesture, "CURSOR");
  assert.notEqual(cursor.universeScale, 1);
  assert.notEqual(cursor.universeRotation, 0);

  const pose = [hand(0.6, 0.5, "Right", ["index", "pinky"])];
  let activation;
  for (let index = 0; index < 12; index += 1) {
    const frame = tick(pose);
    if (frame.events.some((event) => event.type === "pulse")) {
      activation = frame;
      break;
    }
  }
  assert.ok(activation);
  const pulse = activation.events.find((event) => event.type === "pulse");
  assert.deepEqual(pulse.center, cursor.cursors[0].position);
  assert.deepEqual(pulse.center, activation.hands[0].cursorPoint);
  assert.ok(Math.abs(pulse.center.x - 0.57) < 1e-10);
  assert.ok(Math.abs(pulse.center.y - 0.41) < 1e-10);
  const fieldOrigin = { ...pulse.fieldOrigin };
  const screen = { x: 0, y: 0 };
  transformFieldPoint(
    fieldOrigin.x * viewport.width,
    fieldOrigin.y * viewport.height,
    createFieldTransform(viewport.width, viewport.height, activation.universeScale, activation.universeRotation),
    screen,
  );
  assert.ok(Math.abs(screen.x - pulse.center.x * viewport.width) < 1e-9);
  assert.ok(Math.abs(screen.y - pulse.center.y * viewport.height) < 1e-9);

  const moved = tick([hand(0.8, 0.5, "Right", ["index", "pinky"])], 10);
  assert.equal(moved.events.filter((event) => event.type === "pulse").length, 1);
  assert.deepEqual(moved.events.find((event) => event.type === "pulse").fieldOrigin, fieldOrigin);
  tick(pair(0.35, 0.65), 8);
  const transformed = tick(pair(0.25, 0.75), 8);
  assert.notEqual(transformed.universeScale, activation.universeScale);
  assert.deepEqual(transformed.events.find((event) => event.type === "pulse").fieldOrigin, fieldOrigin);
  tick([hand(0.8, 0.5, "Right", ["index"])], 12);
  const repeated = tick([hand(0.8, 0.5, "Right", ["index", "pinky"])], 12);
  const pulses = repeated.events.filter((event) => event.type === "pulse");
  assert.equal(pulses.length, 2);
  assert.notDeepEqual(pulses[1].fieldOrigin, fieldOrigin);
});

test("PULSE maintains cursor smoothing without averaging in the pinky", () => {
  const recognizer = new GestureRecognizer();
  const smoothedTuning = { ...tuning, smoothing: 0.5 };
  let now = 1000;
  const tick = (pose) => recognizer.update([pose], now += 33, smoothedTuning, viewport);
  const previous = tick(hand(0.4, 0.5, "Right", ["index"]));
  const transition = tick(hand(0.6, 0.5, "Right", ["index", "pinky"]));
  assert.equal(transition.gesture, "CURSOR");
  assert.ok(Math.abs(transition.cursors[0].position.x - (previous.cursors[0].position.x + 0.57) / 2) < 1e-10);
  let activation = transition;
  while (!activation.events.some((event) => event.type === "pulse")) {
    activation = tick(hand(0.6, 0.5, "Right", ["index", "pinky"]));
    assert.ok(now < 2000, "PULSE did not activate");
  }
  assert.deepEqual(activation.events.find((event) => event.type === "pulse").center, activation.hands[0].cursorPoint);
});

test("PULSE is bounded, fades smoothly with distance and displaces particles less than before", () => {
  const radius = viewport.height * INTERACTION_CONFIG.pulse.influenceRadiusRatio;
  const strength = INTERACTION_TUNING_DEFAULTS.pulseStrength;
  assert.equal(pulseRadialAcceleration(20, 0, radius, strength), 0);
  assert.equal(pulseRadialAcceleration(radius, radius / INTERACTION_CONFIG.pulse.propagationSpeed, radius, strength), 0);
  assert.ok(pulseRadialAcceleration(radius - 0.01, radius / INTERACTION_CONFIG.pulse.propagationSpeed, radius, strength) < 1e-6);
  assert.ok(pulseRadialAcceleration(35, 35 / INTERACTION_CONFIG.pulse.propagationSpeed, radius, strength) >
    pulseRadialAcceleration(120, 120 / INTERACTION_CONFIG.pulse.propagationSpeed, radius, strength));
  const age = 50 / INTERACTION_CONFIG.pulse.propagationSpeed;
  assert.equal(pulseRadialAcceleration(50, age, radius, 0), 0);
  assert.ok(pulseRadialAcceleration(50, age, radius, strength * 2) >
    pulseRadialAcceleration(50, age, radius, strength));

  const simulate = (legacy) => {
    let position = 50;
    let velocity = 0;
    const delta = 1 / 60;
    for (let frame = 0; frame < 240; frame += 1) {
      const age = frame * delta;
      const offset = (position - age * 260) / 42;
      const acceleration = legacy
        ? (age <= 2.8 && age * 260 <= 282 && Math.abs(offset) <= 3
          ? 620 * Math.exp(-0.5 * offset * offset) * Math.exp(-age / 2.8)
          : 0)
        : pulseRadialAcceleration(position, age, radius, strength);
      velocity = Math.min(80, (velocity + acceleration * delta) * 0.986);
      position += velocity * delta;
    }
    return position - 50;
  };
  const displacement = simulate(false);
  assert.ok(displacement > 5 && displacement < 35, `Unexpected displacement: ${displacement}`);
  assert.ok(displacement < simulate(true) * 0.3);
});

test("ABSORB recognizes the original thumb-index pinch and requires the other fingers extended", () => {
  const { tick } = harness();
  const circle = hand(0.5, 0.5, "Right", ["middle", "ring", "pinky"]);
  const landmark = (name) => circle.keypoints.find((point) => point.name === name);
  Object.assign(landmark("thumb_ip"), { x: 0.44, y: 0.5 });
  Object.assign(landmark("thumb_tip"), { x: 0.45, y: 0.505 });
  Object.assign(landmark("index_finger_pip"), { x: 0.47, y: 0.46 });
  Object.assign(landmark("index_finger_tip"), { x: 0.45, y: 0.505 });
  let frame = tick([circle]);
  assert.equal(frame.gesture, "ABSORB");
  assert.equal(frame.hands[0].isAbsorbPose, true);
  assert.equal(frame.hands[0].interaction, "absorb");
  assert.equal(frame.hands[0].forceMode, "attract");

  const closePinch = hand(0.5, 0.5, "Right", ["middle", "ring", "pinky"]);
  const closeLandmark = (name) => closePinch.keypoints.find((point) => point.name === name);
  Object.assign(closeLandmark("thumb_ip"), { x: 0.45, y: 0.505 });
  Object.assign(closeLandmark("thumb_tip"), { x: 0.45, y: 0.505 });
  Object.assign(closeLandmark("index_finger_pip"), { x: 0.45, y: 0.505 });
  Object.assign(closeLandmark("index_finger_tip"), { x: 0.45, y: 0.505 });
  frame = tick([closePinch], 1);
  assert.equal(frame.gesture, "ABSORB");
  assert.equal(frame.hands[0].isAbsorbPose, true);

  const missingFinger = hand(0.5, 0.5, "Right", ["middle", "ring"]);
  const tip = missingFinger.keypoints.find((point) => point.name === "index_finger_tip");
  const thumb = missingFinger.keypoints.find((point) => point.name === "thumb_tip");
  Object.assign(tip, { x: 0.45, y: 0.505 });
  Object.assign(thumb, { x: 0.45, y: 0.505 });
  frame = tick([missingFinger], 1);
  assert.equal(frame.hands[0].isAbsorbPose, false);

  const missingJoint = { ...closePinch, keypoints: closePinch.keypoints.filter((point) => point.name !== "thumb_ip") };
  frame = tick([missingJoint], 1);
  assert.equal(frame.hands[0].isAbsorbPose, false);
  frame = tick([{ ...closePinch, confidence: tuning.confidenceThreshold - 0.01 }], 1);
  assert.equal(frame.hands.length, 0);
});

test("ABSORB restores pinch hysteresis and pose dwell timing", () => {
  const { tick } = harness();
  const pinch = (ratio) => {
    const pose = hand(0.5, 0.5, "Right", ["middle", "ring", "pinky"]);
    for (const name of ["thumb_ip", "index_finger_pip", "index_finger_tip"]) {
      Object.assign(pose.keypoints.find((point) => point.name === name), { x: 0.45, y: 0.505 });
    }
    Object.assign(pose.keypoints.find((point) => point.name === "thumb_tip"), {
      x: 0.45 + ratio * 0.06, y: 0.505,
    });
    return pose;
  };
  tick([hand(0.5, 0.5, "Right", ["index"])]);
  let frame = tick([pinch(0.28)]);
  assert.equal(frame.hands[0].pose, "ABSORB");
  assert.equal(frame.gesture, "CURSOR");
  frame = tick([pinch(0.36)], 4);
  assert.equal(frame.gesture, "ABSORB");
  assert.equal(frame.hands[0].isPinching, true);
  frame = tick([pinch(0.44)]);
  assert.equal(frame.hands[0].isPinching, false);
  assert.equal(frame.hands[0].isAbsorbPose, false);
  frame = tick([pinch(0.36)]);
  assert.equal(frame.hands[0].isPinching, false);
  frame = tick([pinch(0.28)]);
  assert.equal(frame.hands[0].isPinching, true);
});

test("GRAVITY starts at the slider midpoint", () => {
  const { min, max, step } = INTERACTION_TUNING_RANGES.gravityStrength;
  const strength = DEFAULT_USER_SETTINGS.interaction.gravityStrength;
  assert.equal(strength, 400);
  assert.equal((min + max) / 2, strength);
  assert.equal((strength - min) % step, 0);
});

test("VORTEX uses the secondary open palm only as a modifier for primary GRAVITY", () => {
  const { tick } = harness();
  const frame = tick([
    hand(0.35, 0.5, "Right", []),
    hand(0.65, 0.5, "Left"),
  ], 12);
  const primary = frame.hands.find((entry) => entry.handedness === "Right");
  const modifier = frame.hands.find((entry) => entry.handedness === "Left");
  assert.equal(frame.gesture, "VORTEX");
  assert.equal(primary.interaction, "vortex");
  assert.equal(primary.forceMode, "vortex");
  assert.equal(modifier.interaction, "none");

  const released = tick([
    hand(0.35, 0.5, "Right", []),
    hand(0.65, 0.5, "Left", []),
  ], 12);
  assert.equal(released.gesture, "GRAVITY");
  assert.equal(released.hands.find((entry) => entry.handedness === "Right").forceMode, "attract");
});

test("constellations keep unique bounded local links and retain them as stars move", () => {
  const graph = new ConstellationGraph(8, 100, 2);
  const x = Float32Array.from([0, 20, 40, 60, 80, 100, 120, 140]);
  const y = new Float32Array(8);
  const lifecycle = new Uint8Array(8);
  const added = graph.discover(40, 0, 90, x, y, lifecycle, 8, 3, 2, 1, 50);
  assert.ok(added > 0);
  assert.equal(graph.discover(40, 0, 90, x, y, lifecycle, 8, 3, 2, 1, 50), 0);
  const uniqueLinks = new Set(graph.connections.map(({ starAId, starBId }) => `${starAId}:${starBId}`));
  assert.equal(uniqueLinks.size, graph.connections.length);
  const degrees = new Uint8Array(8);
  for (const { starAId, starBId } of graph.connections) {
    degrees[starAId] += 1;
    degrees[starBId] += 1;
  }
  assert.ok([...degrees].every((degree) => degree <= 2));
  const existingCount = graph.connections.length;
  x[1] = 10000;
  assert.equal(graph.connections.length, existingCount);
  const preservedLinks = graph.connections.map(({ starAId, starBId }) => `${starAId}:${starBId}`);
  lifecycle[0] = 2;
  assert.deepEqual(
    graph.connections.map(({ starAId, starBId }) => `${starAId}:${starBId}`),
    preservedLinks,
  );
  lifecycle[0] = 0;
  assert.deepEqual(
    graph.connections.map(({ starAId, starBId }) => `${starAId}:${starBId}`),
    preservedLinks,
  );

  lifecycle[1] = 1;
  const activeGraph = new ConstellationGraph(8, 100, 2);
  activeGraph.rebuildSpatialIndex(x, y, lifecycle, 8, 200, 200, 40);
  activeGraph.discover(0, 0, 100, x, y, lifecycle, 8, 3, 2, 1, 150);
  assert.ok(activeGraph.connections.every(({ starAId, starBId }) => starAId !== 1 && starBId !== 1));

  const cappedGraph = new ConstellationGraph(8, 1, 2);
  cappedGraph.discover(40, 0, 90, x, y, new Uint8Array(8), 8, 3, 2, 1, 150);
  assert.equal(cappedGraph.isAtCapacity, true);
  const cappedLink = { ...cappedGraph.connections[0] };
  cappedGraph.discover(100, 0, 90, x, y, new Uint8Array(8), 8, 3, 2, 1, 150);
  assert.equal(cappedGraph.connections.length, 1);
  assert.deepEqual(cappedGraph.connections[0], cappedLink);
});

test("particle colors hold independently and transition smoothly without frame-by-frame randomness", () => {
  const state = { from: 0, to: 1, transitionAt: 10, duration: 4 };
  let randomCalls = 0;
  const random = () => { randomCalls += 1; return 0.5; };
  const initial = particleColorAt(state, 1, "nebula", random);
  assert.equal(particleColorAt(state, 10, "nebula", random), initial);
  const middle = particleColorAt(state, 12, "nebula", random);
  assert.notEqual(middle, initial);
  assert.equal(randomCalls, 0);
  const target = particleColorAt(state, 14, "nebula", random);
  assert.notEqual(target, middle);
  assert.equal(particleColorAt(state, 15, "nebula", random), target);
  assert.equal(randomCalls, 3);
  assert.equal(particleColorAt(state, 15, "monochrome", random), "#f2f0f5");
  assert.notDeepEqual(createParticleColor(0, () => 0.1), createParticleColor(0, () => 0.8));
});
