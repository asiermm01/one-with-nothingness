import type p5 from "p5";
import type {
  InteractionFrame,
  ParticleCanvasHandle,
  Point2D,
  StarConnection,
  UserSettings,
} from "../interaction/types";
import { INTERACTION_CONFIG, particleCountForDensity } from "../interaction/config";
import { createParticleColor, particleColorAt, type ParticleColorState } from "./particle-colors";
import { ConstellationGraph } from "./constellation-graph";
import {
  createFieldTransform,
  inverseTransformFieldPoint,
  transformFieldPoint,
  type FieldTransform,
} from "../interaction/field-transform";

// El shader de fondo se ejecuta en WebGL: calcula el color de los píxeles en
// la GPU. La matriz inversa mantiene el fondo alineado con el campo transformado.
const backgroundVertexShader = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
varying vec2 vUv;
void main() {
  vUv = aTexCoord;
  vec4 position = uModelViewMatrix * vec4(aPosition, 1.0);
  gl_Position = uProjectionMatrix * position;
}
`;

const backgroundFragmentShader = `
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uFocus;
uniform float uIntensity;
uniform int uMode;
uniform vec4 uFieldInverse;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = vUv;
  vec2 screenOffset = (vec2(uv.x, 1.0 - uv.y) - 0.5) * uResolution;
  vec2 worldOffset = vec2(
    uFieldInverse.x * screenOffset.x + uFieldInverse.z * screenOffset.y,
    uFieldInverse.y * screenOffset.x + uFieldInverse.w * screenOffset.y
  );
  vec2 worldUv = vec2(0.5 + worldOffset.x / uResolution.x, 0.5 - worldOffset.y / uResolution.y);
  vec2 aspectUv = vec2(worldUv.x * uResolution.x / uResolution.y, worldUv.y);
  float time = uTime * 0.035;
  float field = fbm(aspectUv * 2.2 + vec2(time, -time * 0.72));
  field += fbm(aspectUv * 4.1 - vec2(time * 0.6, time)) * 0.34;
  float cloud = smoothstep(0.36, 0.9, field);
  float distanceToFocus = distance(uv, uFocus);
  float focusGlow = exp(-distanceToFocus * 4.2) * 0.25;
  vec3 base = vec3(0.012, 0.014, 0.022);
  vec3 violet = vec3(0.075, 0.035, 0.17);
  vec3 lavender = vec3(0.11, 0.085, 0.16);
  vec3 green = vec3(0.035, 0.10, 0.06);
  vec3 color = mix(base, violet, cloud * 0.82);
  color = mix(color, lavender, smoothstep(0.58, 0.82, field) * 0.62);
  color += focusGlow * vec3(0.25, 0.18, 0.42) * uIntensity;
  if (uMode == 1) color = mix(base, green, cloud * 0.8);
  else if (uMode == 2) color = mix(base, vec3(0.09), cloud);
  else color += green * smoothstep(0.68, 0.92, fbm(aspectUv * 3.2 + time));
  float vignette = smoothstep(0.98, 0.18, distance(uv, vec2(0.5)));
  gl_FragColor = vec4(color * vignette, 1.0);
}
`;

interface EngineOptions {
  container: HTMLElement;
  interactionRef: { current: InteractionFrame };
  settingsRef: { current: UserSettings };
  onReady: (handle: ParticleCanvasHandle) => void;
  onFeedback: (message: string) => void;
}

export interface ParticlePerformanceSnapshot {
  fps: number | null;
  frameIntervalMs: number;
  drawTimeMs: number;
  simulationTimeMs: number;
  constellationTimeMs: number;
  count: number;
  maximum: number;
  visible: number;
  scale: number;
  quality: string;
}

declare global {
  interface Window {
    __particleDiagnostics?: () => unknown;
    __particlePerformance?: () => ParticlePerformanceSnapshot;
  }
}

// Arrays tipados paralelos: cada índice representa una partícula. La capacidad
// se reserva al inicializarlos y está limitada por el presupuesto configurado.
interface ParticleBuffers {
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  trailX: Float32Array;
  trailY: Float32Array;
  trailTime: Float32Array;
  size: Float32Array;
  phase: Float32Array;
  lifecycle: Uint8Array;
  opacity: Float32Array;
  absorbX: Float32Array;
  absorbY: Float32Array;
  absorbSince: Float32Array;
  color: ParticleColorState[];
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const pulseRadialAcceleration = (
  distance: number,
  age: number,
  maximumRadius: number,
  strength: number,
) => {
  const { propagationSpeed, waveWidth, decaySeconds, onsetSeconds } = INTERACTION_CONFIG.pulse;
  const waveOffset = (distance - age * propagationSpeed) / waveWidth;
  if (age <= 0 || age >= decaySeconds || distance >= maximumRadius || Math.abs(waveOffset) >= 3) return 0;
  const edge = Math.exp(-4.5);
  const wave = (Math.exp(-0.5 * waveOffset * waveOffset) - edge) / (1 - edge);
  const remaining = 1 - distance / maximumRadius;
  const falloff = remaining * remaining * (3 - 2 * remaining);
  const remainingTime = 1 - age / decaySeconds;
  const fadeOut = remainingTime * remainingTime * (3 - 2 * remainingTime);
  return strength * wave * falloff * (1 - Math.exp(-age / onsetSeconds)) *
    Math.exp(-age / decaySeconds) * fadeOut;
};

const segmentMayBeVisible = (
  x1: number, y1: number, x2: number, y2: number, width: number, height: number,
) => Math.max(x1, x2) >= -2 && Math.min(x1, x2) <= width + 2 &&
  Math.max(y1, y2) >= -2 && Math.min(y1, y2) <= height + 2;

interface TrailSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  time: number;
  intensity: number;
}

// Búfer circular acotado para estelas temporales de movimiento de partículas.
// Los segmentos caducan por edad y, si se llena, se descarta el más antiguo.
class TrailHistory {
  private readonly segments: (TrailSegment | undefined)[];
  private start = 0;
  private length = 0;
  private generated = 0;
  private expired = 0;
  private dropped = 0;
  private cleared = 0;

  constructor(private readonly capacity: number) {
    this.segments = new Array(capacity);
  }

  clear() {
    if (process.env.NODE_ENV !== "production") this.cleared += this.length;
    this.segments.fill(undefined);
    this.start = 0;
    this.length = 0;
  }

  add(segment: TrailSegment) {
    if (this.length === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.length -= 1;
      if (process.env.NODE_ENV !== "production") this.dropped += 1;
    }
    this.segments[(this.start + this.length) % this.capacity] = segment;
    this.length += 1;
    if (process.env.NODE_ENV !== "production") this.generated += 1;
  }

  diagnostics(now: number) {
    const oldest = this.length > 0 ? this.segments[this.start] : undefined;
    return {
      active: this.length,
      capacity: this.capacity,
      generated: this.generated,
      expired: this.expired,
      dropped: this.dropped,
      cleared: this.cleared,
      oldestAgeSeconds: oldest ? now - oldest.time : null,
    };
  }

  render(layer: p5.Graphics, now: number, opacity: number, thickness: number) {
    const lifetime = INTERACTION_CONFIG.trails.lifetimeSeconds;
    while (this.length > 0) {
      const segment = this.segments[this.start]!;
      if (now - segment.time < lifetime) break;
      this.segments[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.length -= 1;
      if (process.env.NODE_ENV !== "production") this.expired += 1;
    }

    layer.clear();
    if (this.length === 0) return false;
    // Agrupar por opacidad permite dibujar muchos segmentos con menos llamadas.
    const paths: (Path2D | undefined)[] = new Array(16);
    for (let index = 0; index < this.length; index += 1) {
      const segment = this.segments[(this.start + index) % this.capacity]!;
      const strength = clamp((1 - (now - segment.time) / lifetime) * segment.intensity, 0, 1);
      if (strength <= 0) continue;
      const bucket = Math.min(paths.length - 1, Math.floor(strength * paths.length));
      const path = paths[bucket] ?? (paths[bucket] = new Path2D());
      path.moveTo(segment.x1, segment.y1);
      path.lineTo(segment.x2, segment.y2);
    }

    const context = layer.drawingContext as CanvasRenderingContext2D;
    context.save();
    context.lineWidth = thickness;
    context.lineCap = "round";
    context.strokeStyle = "#f2f0f5";
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index];
      if (!path) continue;
      context.globalAlpha = clamp((opacity / 255) * (index + 0.5) / paths.length, 0, 1);
      context.stroke(path);
    }
    context.restore();
    return true;
  }
}

const inspectShader = (
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): string[] => {
  const errors: string[] = [];
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return ["Unable to create WebGL shaders."];
  }
  for (const [shader, source, name] of [
    [vertex, vertexSource, "vertex"],
    [fragment, fragmentSource, "fragment"],
  ] as const) {
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      errors.push(`${name}: ${gl.getShaderInfoLog(shader) || "compilation failed"}`);
    }
  }
  if (errors.length === 0) {
    const program = gl.createProgram();
    if (!program) {
      errors.push("Unable to create WebGL program.");
    } else {
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        errors.push(`link: ${gl.getProgramInfoLog(program) || "link failed"}`);
      }
      gl.deleteProgram(program);
    }
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return errors;
};

interface ActivePulse {
  x: number;
  y: number;
  startedAt: number;
}

const drawConnectionBatch = (
  p: p5,
  connections: StarConnection[],
  particles: ParticleBuffers,
  particleCount: number,
  transform: FieldTransform,
  width: number,
  height: number,
  opacity: number,
) => {
  if (connections.length === 0 || opacity <= 0) return;
  // Los extremos se vuelven a leer y transformar cada fotograma desde sus estrellas.
  const point: Point2D = { x: 0, y: 0 };
  p.push();
  p.resetShader();
  p.noFill();
  p.stroke(242, 240, 245, 34 * opacity);
  p.strokeWeight(0.65);
  p.beginShape(p.LINES);
  for (const connection of connections) {
    const { starAId, starBId } = connection;
    if (
      starAId >= particleCount ||
      starBId >= particleCount ||
      particles.lifecycle[starAId] === 2 ||
      particles.lifecycle[starBId] === 2 ||
      particles.opacity[starAId] <= 0.02 ||
      particles.opacity[starBId] <= 0.02
    ) continue;
    transformFieldPoint(
      particles.x[starAId],
      particles.y[starAId],
      transform,
      point,
    );
    p.vertex(point.x - width / 2, point.y - height / 2);
    transformFieldPoint(
      particles.x[starBId],
      particles.y[starBId],
      transform,
      point,
    );
    p.vertex(point.x - width / 2, point.y - height / 2);
  }
  p.endShape();
  p.pop();
};

/**
 * Carga p5 y GSAP en el navegador, crea el lienzo y devuelve una función de
 * limpieza. Las refs aportan el estado más reciente sin reconstruir el motor.
 */
export async function createParticleEngine({
  container,
  interactionRef,
  settingsRef,
  onReady,
  onFeedback,
}: EngineOptions): Promise<() => void> {
  const [p5Module, gsapModule] = await Promise.all([import("p5"), import("gsap")]);
  const P5 = p5Module.default;
  const gsap = gsapModule.gsap;
  let particleCount = particleCountForDensity(settingsRef.current.density);
  let initializedParticleCount = particleCount;
  let particles: ParticleBuffers;
  let particleTrailLayer: p5.Graphics | null = null;
  let paused = false;
  let destroyed = false;
  let backgroundProgram: p5.Shader;
  let instance: p5 | null = null;
  let lastTime = 0;
  let lastClearVersion = 0;
  let clearFadeStartedAt: number | null = null;
  let completedFrames = 0;
  let lastCompletedFrameAt = 0;
  let lastFrameStartedAt = 0;
  let frameIntervalMs = 0;
  let drawTimeMs = 0;
  let simulationTimeMs = 0;
  let constellationTimeMs = 0;
  let visibleParticleCount = 0;
  let diagnostics: (() => unknown) | undefined;
  let performanceSnapshot: (() => ParticlePerformanceSnapshot) | undefined;
  const graph = new ConstellationGraph(
    INTERACTION_CONFIG.particles.maximumCount,
    INTERACTION_CONFIG.constellation.maximumConnections,
    INTERACTION_CONFIG.constellation.maximumConnectionsPerStar,
  );
  const lastTracePositions = new Map<string, Point2D>();
  const vortexBlend = new Map<string, number>();
  const pulses: ActivePulse[] = [];
  let lastPulseEventId = 0;
  let lastConstellationFeedbackAt = Number.NEGATIVE_INFINITY;
  let lastRespawnFeedbackAt = Number.NEGATIVE_INFINITY;
  let constellationCapacityNotified = false;
  let fadingConnections: StarConnection[] = [];
  const particleHistory = new TrailHistory(12000);

  const initializeParticles = (buffers: ParticleBuffers, start: number, end: number, width: number, height: number) => {
    const now = instance ? instance.millis() * 0.001 : 0;
    for (let index = start; index < end; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.pow(Math.random(), 0.66) * 0.54;
      buffers.x[index] = width * (0.5 + Math.cos(angle) * radius);
      buffers.y[index] = height * (0.5 + Math.sin(angle) * radius);
      buffers.vx[index] = (Math.random() - 0.5) * 0.18;
      buffers.vy[index] = (Math.random() - 0.5) * 0.18;
      buffers.size[index] = Math.random() * 2.1 + 0.7;
      buffers.phase[index] = Math.random() * 1000;
      buffers.lifecycle[index] = 0;
      buffers.opacity[index] = 1;
      buffers.absorbX[index] = 0;
      buffers.absorbY[index] = 0;
      buffers.absorbSince[index] = 0;
      buffers.color[index] = createParticleColor(now);
    }
  };

  const makeParticles = (count: number, width: number, height: number) => {
    const capacity = INTERACTION_CONFIG.particles.maximumCount;
    const buffers: ParticleBuffers = {
      x: new Float32Array(capacity),
      y: new Float32Array(capacity),
      vx: new Float32Array(capacity),
      vy: new Float32Array(capacity),
      trailX: new Float32Array(capacity).fill(Number.NaN),
      trailY: new Float32Array(capacity).fill(Number.NaN),
      trailTime: new Float32Array(capacity).fill(Number.NaN),
      size: new Float32Array(capacity),
      phase: new Float32Array(capacity),
      lifecycle: new Uint8Array(capacity),
      opacity: new Float32Array(capacity),
      absorbX: new Float32Array(capacity),
      absorbY: new Float32Array(capacity),
      absorbSince: new Float32Array(capacity),
      color: new Array<ParticleColorState>(capacity),
    };
    initializeParticles(buffers, 0, count, width, height);
    initializedParticleCount = count;
    return buffers;
  };
  particles = makeParticles(particleCount, 1, 1);

  // El redimensionado transforma las posiciones, no las identidades de estrella.
  const resizeCanvases = (width: number, height: number) => {
    if (!instance || destroyed) return;
    const scaleX = width / instance.width;
    const scaleY = height / instance.height;
    instance.resizeCanvas(width, height, true);
    particleTrailLayer?.resizeCanvas(width, height);
    particleTrailLayer?.clear();
    particleHistory.clear();
    for (let index = 0; index < initializedParticleCount; index += 1) {
      particles.x[index] *= scaleX;
      particles.y[index] *= scaleY;
      particles.vx[index] *= scaleX;
      particles.vy[index] *= scaleY;
      particles.absorbX[index] *= scaleX;
      particles.absorbY[index] *= scaleY;
      particles.trailX[index] = Number.NaN;
      particles.trailY[index] = Number.NaN;
      particles.trailTime[index] = Number.NaN;
    }
  };

  const sketch = (p: p5) => {
    instance = p;

    // p5 llama setup una vez y draw en su bucle de animación del navegador.
    p.setup = () => {
      if (destroyed) return;
      const width = Math.max(container.clientWidth, window.innerWidth);
      const height = Math.max(container.clientHeight, window.innerHeight);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
      p.pixelDensity(pixelRatio);
      p.createCanvas(width, height, p.WEBGL);
      p.noStroke();
      p.frameRate(60);
      particleTrailLayer = p.createGraphics(width, height);
      particleTrailLayer.pixelDensity(1);
      particles = makeParticles(particleCount, width, height);
      lastPulseEventId = Math.max(0, ...interactionRef.current.events.map((event) => event.id));
      backgroundProgram = p.createShader(backgroundVertexShader, backgroundFragmentShader);
      if (process.env.NODE_ENV !== "production") {
        performanceSnapshot = () => ({
          fps: frameIntervalMs > 0 ? 1000 / frameIntervalMs : null,
          frameIntervalMs,
          drawTimeMs,
          simulationTimeMs,
          constellationTimeMs,
          count: particleCount,
          maximum: INTERACTION_CONFIG.particles.maximumCount,
          visible: visibleParticleCount,
          scale: interactionRef.current.universeScale,
          quality: p.pixelDensity() > 1.25 ? "FULL" : "EFFICIENT",
        });
        window.__particlePerformance = performanceSnapshot;
        diagnostics = () => {
          const now = p.millis() * 0.001;
          const state = interactionRef.current;
          const transform = createFieldTransform(
            p.width, p.height, state.universeScale, state.universeRotation,
          );
          const point: Point2D = { x: 0, y: 0 };
          let invalidParticles = 0;
          let outsideViewport = 0;
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          const inspectPoint = (x: number, y: number) => {
            transformFieldPoint(x, y, transform, point);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
            if (point.x < 0 || point.x > p.width || point.y < 0 || point.y > p.height) {
              outsideViewport += 1;
            }
            return true;
          };
          for (let index = 0; index < particleCount; index += 1) {
            if (!inspectPoint(particles.x[index], particles.y[index])) invalidParticles += 1;
          }
          const gl = p.drawingContext as WebGLRenderingContext | WebGL2RenderingContext;
          return {
            loop: {
              paused,
              scheduled: !paused && !destroyed,
              completedFrames,
              lastCompletedFrameAgeMs: lastCompletedFrameAt
                ? performance.now() - lastCompletedFrameAt
                : null,
              documentVisibility: document.visibilityState,
            },
            canvas: { width: p.width, height: p.height },
            particles: {
              count: particleCount,
              maximum: INTERACTION_CONFIG.particles.maximumCount,
              visible: visibleParticleCount,
              invalid: invalidParticles,
              absorbing: particles.lifecycle.subarray(0, particleCount).filter((state) => state === 1).length,
              absorbed: particles.lifecycle.subarray(0, particleCount).filter((state) => state === 2).length,
            },
            performance: performanceSnapshot?.(),
            constellation: {
              connections: graph.connections.length,
              capacity: INTERACTION_CONFIG.constellation.maximumConnections,
            },
            transformedOutsideViewport: outsideViewport,
            transformedBounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null,
            trails: { particle: particleHistory.diagnostics(now) },
            webgl: {
              contextLost: gl.isContextLost(),
              error: gl.getError(),
              backgroundShaderErrors: inspectShader(gl, backgroundVertexShader, backgroundFragmentShader),
            },
          };
        };
        window.__particleDiagnostics = diagnostics;
      }
      onReady({
        pause: () => {
          paused = true;
          p.noLoop();
        },
        resume: () => {
          paused = false;
          p.loop();
        },
        reset: () => {
          particles = makeParticles(particleCount, p.width, p.height);
          graph.clear();
          constellationCapacityNotified = false;
          lastTracePositions.clear();
          vortexBlend.clear();
          pulses.length = 0;
          fadingConnections = [];
          clearFadeStartedAt = null;
          particleTrailLayer?.clear();
          particleHistory.clear();
          lastTime = 0;
        },
        capture: () => {
          p.saveCanvas("one-with-nothingness", "png");
        },
      });
    };

    // Cada fotograma toma una instantánea de las refs, simula, transforma y
    // compone las capas; delta acotado evita saltos grandes tras una pausa.
    p.draw = () => {
      if (paused || !particles || !particleTrailLayer || destroyed) return;
      const frameStartedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;
      const now = p.millis() * 0.001;
      const delta = lastTime ? clamp(now - lastTime, 0.001, 0.04) : 1 / 60;
      lastTime = now;
      const width = p.width;
      const height = p.height;
      const state = interactionRef.current;
      const fieldTransform = createFieldTransform(
        width,
        height,
        state.universeScale,
        state.universeRotation,
      );
      const { intensity, persistence, density, mode } = settingsRef.current;
      const trailLayer = particleTrailLayer;
      const activeHands = state.hands;
      const transformedPoint: Point2D = { x: 0, y: 0 };
      const focus =
        activeHands.find((hand) => hand.handedness === "Right")?.center ??
        activeHands[0]?.center ??
        state.mouse;
      const requestedParticleCount = particleCountForDensity(density);
      if (requestedParticleCount !== particleCount) {
        if (requestedParticleCount > particleCount) {
          if (requestedParticleCount > initializedParticleCount) {
            initializeParticles(particles, initializedParticleCount, requestedParticleCount, width, height);
            initializedParticleCount = requestedParticleCount;
          }
          particles.trailX.fill(Number.NaN, particleCount, requestedParticleCount);
          particles.trailY.fill(Number.NaN, particleCount, requestedParticleCount);
          particles.trailTime.fill(Number.NaN, particleCount, requestedParticleCount);
        }
        particleCount = requestedParticleCount;
      }

      p.clear();
      p.shader(backgroundProgram);
      backgroundProgram.setUniform("uTime", now);
      backgroundProgram.setUniform("uResolution", [
        width * p.pixelDensity(),
        height * p.pixelDensity(),
      ]);
      backgroundProgram.setUniform("uFocus", [focus.x, 1 - focus.y]);
      backgroundProgram.setUniform("uIntensity", intensity / 100);
      backgroundProgram.setUniform("uMode", mode === "monochrome" ? 2 : mode === "filament" ? 1 : 0);
      const determinant = fieldTransform.a * fieldTransform.d - fieldTransform.b * fieldTransform.c;
      backgroundProgram.setUniform("uFieldInverse", [
        fieldTransform.d / determinant,
        -fieldTransform.b / determinant,
        -fieldTransform.c / determinant,
        fieldTransform.a / determinant,
      ]);
      p.rect(-width / 2, -height / 2, width, height);
      p.resetShader();

      const fieldScale = Math.hypot(fieldTransform.a, fieldTransform.b);
      const forceRange = Math.min(width, height) * INTERACTION_CONFIG.forces.rangeRatio / fieldScale;
      const forceRangeSquared = forceRange * forceRange;
      const minimumForceDistanceSquared = 2 / (fieldScale * fieldScale);
      const forceStrength =
        settingsRef.current.interaction.gravityStrength *
        (intensity / 100) *
        settingsRef.current.interaction.forceMultiplier / fieldScale;
      // Las fuerzas actúan en el espacio del campo, por eso los puntos de
      // pantalla de manos y ratón pasan primero por la matriz inversa.
      const forceTargets = activeHands.map((hand) => {
        const target = hand.interaction === "absorb" ? hand.pinchPoint : hand.center;
        const point: Point2D = { x: 0, y: 0 };
        inverseTransformFieldPoint(target.x * width, target.y * height, fieldTransform, point);
        return point;
      });
      const activeAbsorbIndex = activeHands.findIndex((hand) => hand.interaction === "absorb");
      const activeAbsorbTarget =
        activeAbsorbIndex === -1 ? null : forceTargets[activeAbsorbIndex];
      // VORTEX añade su componente orbital gradualmente sin cambiar el centro GRAVITY.
      const vortexBlends = activeHands.map((hand) => {
        const target = hand.interaction === "vortex" ? 1 : 0;
        const previous = vortexBlend.get(hand.id) ?? 0;
        const next = p.lerp(
          previous,
          target,
          1 - Math.exp(-delta / INTERACTION_CONFIG.vortex.transitionSeconds),
        );
        vortexBlend.set(hand.id, next);
        return next;
      });
      for (const id of vortexBlend.keys()) {
        if (!activeHands.some((hand) => hand.id === id)) vortexBlend.delete(id);
      }

      if (state.clearVersion !== lastClearVersion) {
        lastClearVersion = state.clearVersion;
        fadingConnections = graph.connections.slice();
        graph.clear();
        constellationCapacityNotified = false;
        lastTracePositions.clear();
        pulses.length = 0;
        lastPulseEventId = Math.max(
          lastPulseEventId,
          ...state.events.map((event) => event.id),
        );
        clearFadeStartedAt = now;
      }

      for (const event of state.events) {
        if (event.id <= lastPulseEventId) continue;
        lastPulseEventId = event.id;
        if (event.type !== "pulse") continue;
        if (pulses.length >= INTERACTION_CONFIG.pulse.maximumActive) {
          onFeedback("PULSE · ESPERA A QUE TERMINE LA ONDA");
          continue;
        }
        pulses.push({ x: event.fieldOrigin.x * width, y: event.fieldOrigin.y * height, startedAt: now });
        onFeedback("PULSE · ONDA EMITIDA");
      }

      const maximumPulseRadius =
        Math.min(width, height) * INTERACTION_CONFIG.pulse.influenceRadiusRatio / fieldScale;
      const pulseStrength = settingsRef.current.interaction.pulseStrength;
      for (let index = pulses.length - 1; index >= 0; index -= 1) {
        const age = now - pulses[index].startedAt;
        if (
          age > INTERACTION_CONFIG.pulse.decaySeconds ||
          age * INTERACTION_CONFIG.pulse.propagationSpeed >
            maximumPulseRadius + INTERACTION_CONFIG.pulse.waveWidth * 3
        ) {
          pulses.splice(index, 1);
        }
      }
      const mouseTarget: Point2D = { x: 0, y: 0 };
      inverseTransformFieldPoint(
        state.mouse.x * width, state.mouse.y * height, fieldTransform, mouseTarget,
      );
      const trailIntensity =
        persistence / INTERACTION_CONFIG.trails.defaultIntensity;
      const particleTrailDistanceSquared =
        INTERACTION_CONFIG.trails.particleSampleDistance ** 2;
      const particleTrailInterval =
        INTERACTION_CONFIG.trails.particleSampleIntervalSeconds;
      const particleTrailStride = INTERACTION_CONFIG.trails.particleSampleStride;
      const maximumTrailDistanceSquared = (Math.min(width, height) * 0.4) ** 2;
      const particleTrailAlpha =
        INTERACTION_CONFIG.trails.particleOpacity * trailIntensity;
      const damping = Math.pow(0.986, delta * 60);
      const phaseTime = now * 0.18;
      const flowTime = now * 0.15;
      const shimmerTime = now * 0.7;
      const simulationStartedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;

      // Cada índice conserva su identidad; los estados absorbidos se suspenden
      // y reaparecen sin alterar las relaciones de la red.
      for (let index = 0; index < particleCount; index += 1) {
        let x = particles.x[index];
        let y = particles.y[index];
        let vx = particles.vx[index];
        let vy = particles.vy[index];
        const phase = particles.phase[index];
        if (particles.lifecycle[index] === 2) {
          if (now - particles.absorbSince[index] < INTERACTION_CONFIG.absorb.respawnDelaySeconds) {
            continue;
          }
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.sqrt(Math.random()) * 0.46;
          x = width * (0.5 + Math.cos(angle) * radius);
          y = height * (0.5 + Math.sin(angle) * radius);
          vx = (Math.random() - 0.5) * 0.18;
          vy = (Math.random() - 0.5) * 0.18;
          particles.lifecycle[index] = 0;
          particles.opacity[index] = 0;
          particles.trailX[index] = Number.NaN;
          particles.trailY[index] = Number.NaN;
          particles.trailTime[index] = Number.NaN;
          if (now - lastRespawnFeedbackAt >= 2.5) {
            lastRespawnFeedbackAt = now;
            onFeedback("UNA ESTRELLA HA REGRESADO");
          }
        }

        if (particles.lifecycle[index] === 1) {
          if (activeAbsorbTarget) {
            particles.absorbX[index] = activeAbsorbTarget.x;
            particles.absorbY[index] = activeAbsorbTarget.y;
          }
          const dx = particles.absorbX[index] - x;
          const dy = particles.absorbY[index] - y;
          const distance = Math.max(Math.hypot(dx, dy), 0.001);
          const acceleration =
            forceStrength * INTERACTION_CONFIG.forces.absorbMultiplier;
          vx += (dx / distance) * acceleration * delta;
          vy += (dy / distance) * acceleration * delta;
          vx += (-dy / distance) * acceleration *
            INTERACTION_CONFIG.absorb.orbitStrength * delta;
          vy += (dx / distance) * acceleration *
            INTERACTION_CONFIG.absorb.orbitStrength * delta;
          const maxSpeed = INTERACTION_CONFIG.forces.maximumSpeed;
          vx = clamp(vx * damping, -maxSpeed, maxSpeed);
          vy = clamp(vy * damping, -maxSpeed, maxSpeed);
          x += vx * delta;
          y += vy * delta;
          particles.opacity[index] = Math.max(0, particles.opacity[index] - delta * 1.25);
          if (
            distance <= Math.min(width, height) * INTERACTION_CONFIG.absorb.innerRadiusRatio / fieldScale ||
            particles.opacity[index] <= 0.03
          ) {
            particles.lifecycle[index] = 2;
            particles.absorbSince[index] = now;
            particles.opacity[index] = 0;
            vx = 0;
            vy = 0;
          }
          particles.x[index] = x;
          particles.y[index] = y;
          particles.vx[index] = vx;
          particles.vy[index] = vy;
          continue;
        }

        const angle =
          Math.sin(y * 0.004 + phaseTime + phase) *
          Math.cos(x * 0.003 - flowTime);
        vx += Math.cos(angle) * 0.11 * delta;
        vy += Math.sin(angle) * 0.11 * delta;
        let underAbsorbField = false;

        for (let handIndex = 0; !state.clearActive && handIndex < activeHands.length; handIndex += 1) {
          const hand = activeHands[handIndex];
          if (hand.forceMode === "none") continue;
          const target = forceTargets[handIndex];
          const dx = x - target.x;
          const dy = y - target.y;
          const distanceSquared = dx * dx + dy * dy;
          const absorbing = hand.interaction === "absorb";
          const innerRadius =
            Math.min(width, height) * INTERACTION_CONFIG.absorb.innerRadiusRatio / fieldScale;
          if (absorbing && distanceSquared <= innerRadius * innerRadius) {
            particles.lifecycle[index] = 1;
            particles.absorbX[index] = target.x;
            particles.absorbY[index] = target.y;
            underAbsorbField = true;
            break;
          }
          if (
            distanceSquared > forceRangeSquared ||
            (distanceSquared < minimumForceDistanceSquared && !absorbing)
          ) continue;

          const distance = Math.max(Math.sqrt(distanceSquared), 0.001);
          const falloff = Math.pow(1 - distance / forceRange, 2);
          const gestureStrength = absorbing
            ? INTERACTION_CONFIG.forces.absorbMultiplier
            : 1;
          const acceleration = forceStrength * falloff * gestureStrength;
          vx -= (dx / distance) * acceleration * delta;
          vy -= (dy / distance) * acceleration * delta;
          if (hand.interaction === "vortex") {
            const tangential = acceleration *
              INTERACTION_CONFIG.vortex.tangentialStrength *
              vortexBlends[handIndex] *
              INTERACTION_CONFIG.vortex.direction;
            vx += (-dy / distance) * tangential * delta;
            vy += (dx / distance) * tangential * delta;
          } else if (absorbing) {
            underAbsorbField = true;
            const tangential = acceleration * INTERACTION_CONFIG.absorb.orbitStrength;
            vx += (-dy / distance) * tangential * delta;
            vy += (dx / distance) * tangential * delta;
            const targetOpacity = 0.28 + 0.72 * clamp(distance / forceRange, 0, 1);
            particles.opacity[index] = Math.min(particles.opacity[index], targetOpacity);
          }
        }
        if (!underAbsorbField) {
          particles.opacity[index] = Math.min(
            1,
            particles.opacity[index] + delta / INTERACTION_CONFIG.absorb.respawnFadeSeconds,
          );
        }

        // PULSE aplica una onda radial temporal; no consulta ni recorre la red.
        for (const pulse of pulses) {
          const dx = x - pulse.x;
          const dy = y - pulse.y;
          const distance = Math.max(Math.hypot(dx, dy), 0.001);
          const age = now - pulse.startedAt;
          const radial = pulseRadialAcceleration(distance, age, maximumPulseRadius, pulseStrength);
          if (radial === 0) continue;
          const tangential = radial *
            INTERACTION_CONFIG.pulse.tangentialForce / INTERACTION_CONFIG.pulse.radialForce;
          vx += (dx / distance) * radial * delta;
          vy += (dy / distance) * radial * delta;
          vx += (-dy / distance) * tangential * delta;
          vy += (dx / distance) * tangential * delta;
        }

        if (state.mouseActive && activeHands.length === 0) {
          const dx = x - mouseTarget.x;
          const dy = y - mouseTarget.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < forceRangeSquared && distanceSquared > minimumForceDistanceSquared) {
            const distance = Math.sqrt(distanceSquared);
            const force = (forceStrength * (1 - distance / forceRange) * delta) / distance;
            const direction = state.mousePressed ? -1 : 1;
            vx -= dx * force * 0.001 * direction;
            vy -= dy * force * 0.001 * direction;
          }
        }

        const maxSpeed = INTERACTION_CONFIG.forces.maximumSpeed;
        vx = clamp(vx * damping, -maxSpeed, maxSpeed);
        vy = clamp(vy * damping, -maxSpeed, maxSpeed);
        x += vx * delta;
        y += vy * delta;

        if (x < -12) x = width + 12;
        else if (x > width + 12) x = -12;
        if (y < -12) y = height + 12;
        else if (y > height + 12) y = -12;

        particles.x[index] = x;
        particles.y[index] = y;
        particles.vx[index] = vx;
        particles.vy[index] = vy;

        // Las estelas muestrean posiciones transformadas y no alimentan la física.
        if (particles.lifecycle[index] !== 0 || index % particleTrailStride !== 0) continue;
        transformFieldPoint(x, y, fieldTransform, transformedPoint);
        const trailX = particles.trailX[index];
        const trailY = particles.trailY[index];
        const trailTime = particles.trailTime[index];
        if (
          !Number.isFinite(trailX) ||
          !Number.isFinite(trailY) ||
          !Number.isFinite(trailTime)
        ) {
          particles.trailX[index] = transformedPoint.x;
          particles.trailY[index] = transformedPoint.y;
          particles.trailTime[index] = now;
        } else {
          const dx = transformedPoint.x - trailX;
          const dy = transformedPoint.y - trailY;
          const distanceSquared = dx * dx + dy * dy;
          if (
            distanceSquared >= particleTrailDistanceSquared &&
            now - trailTime >= particleTrailInterval
          ) {
            if (
              distanceSquared <= maximumTrailDistanceSquared &&
              segmentMayBeVisible(trailX, trailY, transformedPoint.x, transformedPoint.y, width, height)
            ) {
              const sampleIntensity =
                particles.opacity[index] *
                (0.75 + 0.25 * Math.sin(shimmerTime + phase));
              particleHistory.add({
                x1: trailX, y1: trailY,
                x2: transformedPoint.x, y2: transformedPoint.y,
                time: now, intensity: sampleIntensity,
              });
            }
            particles.trailX[index] = transformedPoint.x;
            particles.trailY[index] = transformedPoint.y;
            particles.trailTime[index] = now;
          }
        }
      }

      const simulationEndedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;
      particleHistory.render(
        trailLayer, now, particleTrailAlpha, INTERACTION_CONFIG.trails.particleThickness,
      );
      // p5 POINTS usa su propio shader; dibujamos los puntos en la capa 2D.
      const particleContext = trailLayer.drawingContext as CanvasRenderingContext2D;
      particleContext.save();
      const particleScale = Math.hypot(fieldTransform.a, fieldTransform.b);
      let renderedParticles = 0;
      for (let index = 0; index < particleCount; index += 1) {
        if (particles.lifecycle[index] === 2 || particles.opacity[index] <= 0.01) continue;
        transformFieldPoint(particles.x[index], particles.y[index], fieldTransform, transformedPoint);
        const radius = Math.max(
          0.2,
          particles.size[index] * particleScale * particles.opacity[index] / 2,
        );
        if (
          transformedPoint.x + radius < 0 || transformedPoint.x - radius > width ||
          transformedPoint.y + radius < 0 || transformedPoint.y - radius > height
        ) continue;
        renderedParticles += 1;
        const phase = particles.phase[index];
        particleContext.fillStyle = particleColorAt(particles.color[index], now, mode);
        particleContext.globalAlpha = clamp(
          ((80 + Math.sin(shimmerTime + phase) * 45) * particles.opacity[index]) / 255,
          0,
          1,
        );
        particleContext.beginPath();
        particleContext.arc(
          transformedPoint.x, transformedPoint.y,
          radius, 0, Math.PI * 2,
        );
        particleContext.fill();
      }
      particleContext.restore();
      p.push();
      p.blendMode(p.ADD);
      p.image(trailLayer, -width / 2, -height / 2, width, height);
      p.blendMode(p.BLEND);
      p.pop();

      const constellationStartedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;
      if (!state.clearActive) {
        graph.rebuildSpatialIndex(
          particles.x,
          particles.y,
          particles.lifecycle,
          particleCount,
          width,
          height,
          Math.min(width, height) * INTERACTION_CONFIG.constellation.selectionRadiusRatio,
        );
        const sampledHandIds = new Set<string>();
        const samplingDistance =
          Math.min(width, height) * INTERACTION_CONFIG.constellation.samplingDistanceRatio / fieldScale;
        const selectionRadius =
          Math.min(width, height) * INTERACTION_CONFIG.constellation.selectionRadiusRatio / fieldScale;
        for (const cursor of state.cursors) {
          if (cursor.mode !== "TRACE") continue;
          sampledHandIds.add(cursor.handId);
          const current: Point2D = { x: 0, y: 0 };
          inverseTransformFieldPoint(
            cursor.position.x * width,
            cursor.position.y * height,
            fieldTransform,
            current,
          );
          const previous = lastTracePositions.get(cursor.handId);
          if (!previous) {
            lastTracePositions.set(cursor.handId, { ...current });
            const added = graph.discover(
              current.x, current.y, selectionRadius,
              particles.x, particles.y, particles.lifecycle, particleCount,
              INTERACTION_CONFIG.constellation.selectedStarCount,
              INTERACTION_CONFIG.constellation.neighborsPerStar,
              INTERACTION_CONFIG.constellation.minimumLength / fieldScale,
              selectionRadius * INTERACTION_CONFIG.constellation.maximumLengthRatio,
            );
            if (added > 0 && now - lastConstellationFeedbackAt >= 1.1) {
              lastConstellationFeedbackAt = now;
              onFeedback("CONSTELACIÓN AMPLIADA");
            }
            if (graph.isAtCapacity && !constellationCapacityNotified) {
              constellationCapacityNotified = true;
              onFeedback("LÍMITE DE CONSTELACIONES ALCANZADO");
            }
            continue;
          }
          const dx = current.x - previous.x;
          const dy = current.y - previous.y;
          const distance = Math.hypot(dx, dy);
          const steps = Math.min(64, Math.floor(distance / samplingDistance));
          if (steps === 0) continue;
          for (let step = 1; step <= steps; step += 1) {
            const amount = step / steps;
            const added = graph.discover(
              previous.x + dx * amount,
              previous.y + dy * amount,
              selectionRadius,
              particles.x,
              particles.y,
              particles.lifecycle,
              particleCount,
              INTERACTION_CONFIG.constellation.selectedStarCount,
              INTERACTION_CONFIG.constellation.neighborsPerStar,
              INTERACTION_CONFIG.constellation.minimumLength / fieldScale,
              selectionRadius * INTERACTION_CONFIG.constellation.maximumLengthRatio,
            );
            if (added > 0 && now - lastConstellationFeedbackAt >= 1.1) {
              lastConstellationFeedbackAt = now;
              onFeedback("CONSTELACIÓN AMPLIADA");
            }
            if (graph.isAtCapacity && !constellationCapacityNotified) {
              constellationCapacityNotified = true;
              onFeedback("LÍMITE DE CONSTELACIONES ALCANZADO");
            }
          }
          lastTracePositions.set(cursor.handId, { ...current });
        }
        for (const handId of lastTracePositions.keys()) {
          if (!sampledHandIds.has(handId)) lastTracePositions.delete(handId);
        }
      }

      drawConnectionBatch(
        p, graph.connections, particles, particleCount, fieldTransform, width, height, 1,
      );
      if (clearFadeStartedAt !== null) {
        const progress = clamp(
          (now - clearFadeStartedAt) / (INTERACTION_CONFIG.gestures.clearFadeMs / 1000),
          0,
          1,
        );
        drawConnectionBatch(
          p, fadingConnections, particles, particleCount, fieldTransform, width, height, 1 - progress,
        );
        if (progress >= 1) {
          fadingConnections = [];
          clearFadeStartedAt = null;
        }
      }
      const constellationEndedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;

      for (const cursor of state.cursors) {
        const x = cursor.position.x * width - width / 2;
        const y = cursor.position.y * height - height / 2;
        const brush = cursor.mode === "TRACE";
        const diameter = brush ? 20 : 14;
        p.push();
        p.resetShader();
        p.noFill();
        p.stroke(brush ? 154 : 242, brush ? 217 : 240, brush ? 108 : 245, 220);
        p.strokeWeight(1.2);
        p.ellipse(x, y, diameter, diameter);
        if (brush) {
          p.stroke(154, 217, 108, 130);
          p.strokeWeight(3);
          p.ellipse(x, y, diameter + 5, diameter + 5);
        } else {
          p.stroke(242, 240, 245, 150);
          p.line(x - 3, y, x + 3, y);
          p.line(x, y - 3, x, y + 3);
        }
        p.pop();
      }
      if (process.env.NODE_ENV !== "production") {
        completedFrames += 1;
        const finishedAt = performance.now();
        const interval = frameStartedAt - lastFrameStartedAt;
        if (lastFrameStartedAt && interval > 0 && interval < 1000) {
          frameIntervalMs = frameIntervalMs ? frameIntervalMs * 0.9 + interval * 0.1 : interval;
        }
        const smooth = (previous: number, current: number) =>
          previous ? previous * 0.9 + current * 0.1 : current;
        drawTimeMs = smooth(drawTimeMs, finishedAt - frameStartedAt);
        simulationTimeMs = smooth(simulationTimeMs, simulationEndedAt - simulationStartedAt);
        constellationTimeMs = smooth(
          constellationTimeMs,
          constellationEndedAt - constellationStartedAt,
        );
        visibleParticleCount = renderedParticles;
        lastFrameStartedAt = frameStartedAt;
        lastCompletedFrameAt = finishedAt;
      }
    };

    p.windowResized = () => {
      if (!instance || destroyed) return;
      const width = Math.max(container.clientWidth, window.innerWidth);
      const height = Math.max(container.clientHeight, window.innerHeight);
      resizeCanvases(width, height);
    };
  };

  const resizeObserver = new ResizeObserver(() => {
    if (!instance || destroyed) return;
    const width = Math.max(container.clientWidth, window.innerWidth);
    const height = Math.max(container.clientHeight, window.innerHeight);
    if (instance.width !== width || instance.height !== height) {
      resizeCanvases(width, height);
    }
  });
  resizeObserver.observe(container);

  // React llama a esta limpieza al desmontar: desconecta observadores y libera
  // el lienzo, las capas y los diagnósticos de desarrollo.
  const cleanup = () => {
    destroyed = true;
    resizeObserver.disconnect();
    gsap.killTweensOf(container);
    if (process.env.NODE_ENV !== "production" && window.__particleDiagnostics === diagnostics) {
      delete window.__particleDiagnostics;
    }
    if (process.env.NODE_ENV !== "production" && window.__particlePerformance === performanceSnapshot) {
      delete window.__particlePerformance;
    }
    instance?.remove();
    instance = null;
    particleTrailLayer = null;
  };

  try {
    new P5(sketch, container);
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}
