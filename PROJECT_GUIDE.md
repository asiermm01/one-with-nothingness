# Guía técnica de ONE WITH NOTHINGNESS

## Visión general

La instalación muestra un campo de partículas que responde a las manos o al
ratón. La interfaz permite consultar los gestos y ajustar parámetros. TRACE
construye una red persistente entre estrellas; las estelas de movimiento siguen
siendo temporales e independientes de esa red.

Esta guía sigue el código fuente. Una buena ruta de lectura es
[Experience.tsx](./src/components/Experience.tsx) →
[hand-tracker.ts](./src/lib/interaction/hand-tracker.ts) →
[gesture-recognition.ts](./src/lib/interaction/gesture-recognition.ts) →
[particle-engine.ts](./src/lib/rendering/particle-engine.ts); los contratos
comunes están en [types.ts](./src/lib/interaction/types.ts).

## Tecnologías y entornos

- **Next.js / App Router** organiza la ruta y el layout, prepara el HTML y
  empaqueta los recursos. La configuración usa exportación estática: el
  resultado puede servirse sin un servidor Node en producción.
- **React** gestiona la interfaz, sus controles y el ciclo de vida de cámara y
  lienzo. `layout.tsx` es un componente de servidor; `page.tsx`, `Experience`
  y `ParticleCanvas` son componentes de cliente. Los componentes de cliente
  pueden participar en el prerrenderizado inicial y después se hidratan en el
  navegador; el motor p5 se importa allí con `ssr: false`.
- **TypeScript** comprueba los contratos antes de ejecutar: interfaces para
  observaciones y fotogramas, uniones para gestos válidos y genéricos para
  relacionar ajustes con sus valores. Los tipos no son validaciones en tiempo
  de ejecución; el código sigue comprobando datos externos.
- **Node.js y npm** ejecutan las herramientas de desarrollo, compilación y
  comprobación. `npm run dev` inicia Next; `npm run build` genera `out/` y
  ejecuta un script que prepara `index.html` y `_next/` en la raíz para Live
  Server. El seguimiento y la simulación no se ejecutan en Node.
- **ml5.js HandPose / TensorFlow.js** detectan puntos de las manos en el
  navegador. La primera carga del modelo necesita conexión; el procesamiento de
  imágenes se realiza localmente. La cámara requiere permiso y un contexto
  seguro, como localhost o HTTPS.
- **p5.js** administra el ciclo de dibujo y el lienzo WebGL. El fondo se
  calcula con shaders en la GPU; partículas y estelas también utilizan capas
  Canvas 2D que se componen en el lienzo. **GSAP** anima el panel y
  **CSS** define la presentación adaptable.

## Mapa de archivos

| Ruta | Responsabilidad |
| --- | --- |
| [layout.tsx](./src/app/layout.tsx), [page.tsx](./src/app/page.tsx) | Documento, metadatos y ruta inicial de Next.js. |
| [globals.css](./src/app/globals.css) | Estilos de la interfaz y adaptación a pantallas pequeñas. |
| [Experience.tsx](./src/components/Experience.tsx) | Coordina cámara, reconocedor, ajustes, controles y estado visible. |
| [ParticleCanvas.tsx](./src/components/ParticleCanvas.tsx) | Monta el motor visual y lo libera al desmontarse. |
| [hand-tracker.ts](./src/lib/interaction/hand-tracker.ts) | Permiso de cámara, vídeo, modelo, inferencia y limpieza. |
| [gesture-recognition.ts](./src/lib/interaction/gesture-recognition.ts) | Identidad, poses estables, prioridad, eventos y transformación persistente. |
| [field-transform.ts](./src/lib/interaction/field-transform.ts) | Matriz entre espacio del campo y pantalla, y su inversa. |
| [hand-status.ts](./src/lib/interaction/hand-status.ts) | Etiquetas visibles de las interacciones por mano. |
| [config.ts](./src/lib/interaction/config.ts), [types.ts](./src/lib/interaction/types.ts) | Valores, límites y contratos compartidos. |
| [constellation-graph.ts](./src/lib/rendering/constellation-graph.ts) | Grafo por índices de partícula, selección local, deduplicación y límite de grado. |
| [particle-engine.ts](./src/lib/rendering/particle-engine.ts) | Simulación, absorción y reaparición, fuerzas, red dinámica, estelas y composición. |
| [particle-colors.ts](./src/lib/rendering/particle-colors.ts) | Colores y transiciones independientes de las partículas. |
| [ml5.d.ts](./src/types/ml5.d.ts) | Declaración de tipos para la parte utilizada de ml5. |
| [prepare-live-server.mjs](./scripts/prepare-live-server.mjs) | Copia y prepara la exportación estática para Live Server. |
| [interaction.test.cjs](./scripts/interaction.test.cjs) | Pruebas de reconocimiento, transformación, límites y colores. |
| [next.config.ts](./next.config.ts), [package.json](./package.json) | Configuración de exportación, dependencias y comandos. |

`out/`, `.next/`, `index.html` y `_next/` son salidas generadas, no el lugar
para editar la lógica de la experiencia.

## De la cámara a la imagen

1. `Experience` crea `HandTracker` con el elemento de vídeo y dos callbacks.
   `start()` pide permiso mediante `getUserMedia`, espera a que el vídeo avance
   y carga de forma asíncrona HandPose y TensorFlow.js.
2. `HandTracker` copia cada imagen a un canvas auxiliar reutilizable. Ejecuta
   las detecciones secuencialmente y limita su frecuencia; un temporizador
   detecta si el modelo deja de responder.
3. La salida del modelo contiene puntos como muñeca y puntas de los dedos.
   El tracker descarta puntos inválidos, normaliza `x` e `y` por el tamaño del
   vídeo y envía `HandObservation[]` a `Experience`.
4. `GestureRecognizer.update()` filtra observaciones por confianza, asigna
   identidades usando lateralidad o proximidad a trayectorias recientes y
   suaviza posiciones. Calcula dedos extendidos, pinza y poses estables.
5. El reconocedor aplica prioridades y genera un `InteractionFrame`: manos,
   cursores, eventos de PULSE y CLEAR ALL, escala y rotación. `Experience` lo
   guarda en `interactionRef` y actualiza el texto de la interfaz cuando cambia.
6. `ParticleCanvas` pasa esa referencia y la de ajustes al motor. En cada
   `draw`, p5 convierte las posiciones al espacio del campo, actualiza las
   partículas, descubre conexiones por muestreo del cursor TRACE y dibuja cada
   enlace desde los índices de sus estrellas actuales. Las refs evitan renderizar
   React a la frecuencia de la cámara o del lienzo.
7. Al desconectar el seguimiento o desmontar la experiencia, se detienen los
   temporizadores y las pistas de cámara. Al desmontar el lienzo, el motor
   elimina su instancia p5 y sus observadores.

Sin manos activas, el ratón proporciona la posición de interacción y, al
arrastrar, una estela visual temporal.

## Gestos y espacio

La clasificación combina geometría normalizada respecto a la palma con
umbrales configurables. La histéresis usa límites diferentes para activar y
desactivar la extensión o la pinza; las poses que aplican fuerzas pasan por una
estabilización temporal.

- **CURSOR** usa un dedo extendido y solo mueve su marcador; **TRACE** usa
  índice y corazón. TRACE muestrea el recorrido del cursor en coordenadas del
  campo, consulta estrellas activas cercanas y conecta unas pocas vecinas.
  `ConstellationGraph` guarda pares de índices de partículas, limita duplicados
  y conexiones por estrella, y no modifica enlaces existentes. El render vuelve
  a leer las posiciones de esos índices en cada fotograma: gravedad, absorción
  y STRETCH deforman los extremos junto con sus estrellas.
- **PULSE** exige índice y meñique extendidos, con los demás dedos plegados.
  Un cambio de pose genera un evento único desde la punta suavizada del índice,
  convertida al campo al activarse. El motor aplica una onda radial sutil y
  temporal a las partículas, sin recorrer el grafo.
- **GRAVITY** usa un puño cerrado. Si la mano secundaria mantiene la palma
  abierta, selecciona **VORTEX** para el mismo centro primario: se interpola una
  fuerza tangencial adicional sin crear otro centro gravitatorio.
- **ABSORB** reconoce la pinza de pulgar e índice normalizada por el ancho de la
  palma y exige los otros tres dedos extendidos. Cada índice conserva su
  identidad al pasar por `ACTIVE`, `ABSORBING` y `ABSORBED`; tras una espera
  reaparece gradualmente y recupera automáticamente sus conexiones almacenadas.
- **STRETCH** requiere dos palmas abiertas y estables. Guarda la separación,
  el ángulo y la transformación al comenzar; calcula la nueva escala y el giro
  respecto a esa referencia, suaviza el resultado y limita la escala. Al
  terminar conserva la transformación. La diferencia angular acumulada
  permite varias vueltas.
- **CLEAR ALL** tiene prioridad y requiere ambos pulgares extendidos durante
  el tiempo configurado. Borra las conexiones, bloquea repeticiones hasta soltar
  y aplica una espera; el motor desvanece visualmente la red anterior.

La matriz de `field-transform.ts` escala y gira alrededor del centro. Partículas
y conexiones usan la misma transformación para llegar a pantalla. Su inversa
convierte las manos, el ratón y las muestras de TRACE desde pantalla al campo.
Los cursores y marcadores se dibujan en pantalla, independientes de esa matriz.

## Simulación, dibujo y memoria

Las partículas viven en arrays tipados de capacidad limitada. El índice es su
identidad estable y comparte posición, velocidad, opacidad y estado de ciclo de
vida. Cada fotograma integra el flujo suave y las fuerzas locales con
amortiguación y límites de velocidad; al cruzar el borde reaparecen por el lado
opuesto. ABSORB oculta temporalmente una estrella sin borrar su índice ni sus
conexiones. Al redimensionar se escalan sus posiciones en vez de regenerarlas.

La red persistente se limita por grado y capacidad; al alcanzar el límite se
evitan nuevas conexiones sin descartar las existentes. Su índice espacial
reutilizable acelera la selección local, que solo se ejecuta al avanzar TRACE.
La red no aplica fuerzas ni transmite PULSE. Las conexiones y partículas
comparten escala, giro y traslación. Las estelas temporales de movimiento se
guardan aparte en un búfer circular acotado: se muestrean por distancia e
intervalo y caducan tras unos tres segundos.

## Glosario

- **Componente de servidor / cliente:** separación de Next.js entre código
  renderizado en el servidor o durante la compilación y componentes que pueden
  usar interactividad y API del navegador.
- **Hidratación:** React conecta los eventos y el estado del cliente al HTML
  inicial generado por Next.js.
- **Estado, ref y efecto:** el estado actualiza la interfaz; una ref mutable
  guarda datos sin provocar un render; un efecto conecta recursos externos y
  devuelve su limpieza.
- **Promesa / `async` / `await`:** formas de coordinar operaciones que terminan
  más tarde, como permisos, importaciones y detección.
- **Inferencia y punto clave:** ejecutar el modelo sobre una imagen para estimar
  posiciones anatómicas identificadas por nombre.
- **Fotograma y `requestAnimationFrame`:** una imagen del ciclo visual y el
  mecanismo del navegador para programar trabajo ligado al repintado.
- **Matriz afín e inversa:** representación de una transformación espacial y
  operación que deshace esa transformación.
- **WebGL y shader:** API gráfica del navegador y programa que se ejecuta en
  la GPU para producir la imagen; aquí el shader genera el fondo.
- **Búfer circular:** almacenamiento de capacidad fija que reutiliza posiciones
  para limitar la memoria de las estelas.
