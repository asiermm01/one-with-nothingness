# ONE WITH NOTHINGNESS

Instalación interactiva de partículas. La experiencia visual comienza directamente;
el seguimiento con cámara es opcional y también se puede interactuar con el ratón.

Para explorar la arquitectura y el recorrido de los datos, consulta la
[guía del proyecto](./PROJECT_GUIDE.md).

## Tecnologías y bibliotecas

- **Next.js 16 (App Router)**: estructura de la aplicación y generación estática
  para publicar la experiencia como archivos web.
- **React 19**: componentes de interfaz y gestión de la experiencia interactiva.
- **TypeScript 5**: desarrollo con tipado estático y comprobación de tipos estricta.
- **p5.js**: motor de dibujo y simulación visual de partículas en el navegador.
- **ml5.js HandPose**: detección de manos y puntos clave mediante la cámara web.
- **TensorFlow.js**: ejecución del modelo HandPose en el navegador.
- **GSAP**: transiciones y animaciones de la interfaz.
- **WebGL**: aceleración gráfica utilizada por el lienzo de la experiencia.
- **CSS**: estilos adaptables e identidad visual de la instalación.
- **Node.js y npm**: entorno de ejecución y gestión de dependencias y scripts.

## Run locally

Requires Node.js 20.15.1 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for development.
In the browser console, `window.__particleDiagnostics()` reports completed
frames, coordinate validity, trail counts and expiry, and WebGL/shader status.
It also reports smoothed FPS, frame interval, CPU draw/simulation/TRACE time,
visible and budgeted particle counts, scale, and rendering quality. CPU timings
do not include all asynchronous GPU work. This diagnostic is available only in
development.

## Open with VS Code Live Server

Live Server serves static files; it does not compile or run a Next.js project.
Build the static site first:

```bash
npm run build
```

The build creates a formatted `index.html` and its `_next` assets directly in
the project root. Open the project folder in VS Code and select **Go Live**;
the root `index.html` is served automatically. Re-run `npm run build` after
source changes to refresh these root files; building only the Next.js export
leaves the Live Server site unchanged.
Webcam access requires a secure context: localhost during development or HTTPS
in production.

## Interaction

- Move the pointer to disturb the field; press and drag to push nearby stars away.
- The live camera preview appears beneath the title while tracking is active;
  frames are processed locally in your browser. The two labels below the preview
  show the current command for each identified hand.
- Use the tracking control to disconnect or resume ml5 HandPose tracking.
- **CURSOR:** Extend exactly one finger to position a cursor without affecting
  particles or constellations.
- **TRACE:** Extend index and middle fingers, then move the cursor to discover
  nearby stars and form selective, persistent constellations. Their lines follow
  their stars through all particle forces and **STRETCH**.
- **PULSE:** Extend index and little fingers while folding the others. Each
  deliberate pose emits one subtle radial disturbance from the index fingertip;
  release before triggering another.
- **GRAVITY:** Close one hand into a fist to continuously attract nearby particles
  toward that hand.
- **VORTEX:** Keep GRAVITY in the primary hand and hold the secondary hand open.
  This adds a smooth orbiting force around the same center.
- **ABSORB:** Form an OK circle with thumb and index while extending the other
  three fingers. Nearby stars shrink away, then respawn while keeping their
  constellation relationships.
- **STRETCH:** Show two open palms; their separation scales the particle field,
  while their relative angle rotates it. Each gesture starts from the current
  view and leaves the resulting scale and rotation in place. Zoom is limited to
  0.3×–4×; rotation can continue through multiple turns. The reset control
  intentionally returns the view to its initial transformation.
- The field starts with 1,050 particles and has a configurable maximum budget
  of 1,800. Zoom changes the view without creating new particles. Constellation
  links have a per-star degree limit and are never discarded to make room.
- **CLEAR ALL:** Extend only the thumb on both hands and hold for the configured
  duration to fade out every persistent constellation. A cooldown prevents
  repeated clears until the pose is released.
- Open **GESTURES** beside the tracking controls for the in-app legend. Open
  **PARAMETERS** to tune gesture stability, cursor smoothing, pulse strength and cooldown,
  gravity strength (default 400), stretch sensitivity, and CLEAR ALL timing.
  Gravity strength also scales the existing VORTEX, ABSORB and pointer forces.
- Use the toolbar to pause, reset, capture a PNG, toggle fullscreen, or hide
  the interface. Press `H` to show the interface and `Escape` to restore it.

When the experience opens, the browser requests webcam permission. If permission
is denied or a camera is unavailable, pointer interaction remains available.
Hand landmarks and video frames are processed in the browser. The first model
load requires an internet connection to retrieve its runtime/model assets.
If the model does not detect a hand, the status changes to **NO HANDS DETECTED**
with a placement hint. If detections stop arriving, tracking reports an error
instead of searching indefinitely.

## Quality checks

```bash
npm run typecheck
npm run build
node --test scripts/interaction.test.cjs
```
