import * as THREE from "three";

export const SKY_COLOR = 0x87ceeb;
export const FOG_NEAR = 60;
export const FOG_FAR = 105;
const SUN_DISTANCE = 140;

export interface GameScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly sun: THREE.DirectionalLight;
  readonly ambient: THREE.AmbientLight;
  render: () => void;
  resize: (width: number, height: number) => void;
  /** Applies a sky state (see sky.ts) to the background, fog, and lights. */
  applySky: (state: {
    readonly skyColor: readonly [number, number, number];
    readonly sunIntensity: number;
    readonly ambientIntensity: number;
    readonly sunAngle: number;
  }) => void;
  dispose: () => void;
}

/** Sets up the Three.js scene, camera, renderer, sky, and lighting. No
 * voxel-specific knowledge lives here — ChunkMeshManager adds and removes
 * chunk meshes into `scene` as the world streams in around the player. */
export function createGameScene(parent: HTMLElement): GameScene {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    failIfMajorPerformanceCaveat: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  parent.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const background = new THREE.Color(SKY_COLOR);
  scene.background = background;
  const fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    FOG_FAR + 60,
  );

  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(60, 120, 40);
  scene.add(sun);
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  function render(): void {
    renderer.render(scene, camera);
  }

  function resize(width: number, height: number): void {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  function applySky(state: {
    readonly skyColor: readonly [number, number, number];
    readonly sunIntensity: number;
    readonly ambientIntensity: number;
    readonly sunAngle: number;
  }): void {
    background.setRGB(state.skyColor[0], state.skyColor[1], state.skyColor[2]);
    fog.color.copy(background);
    sun.intensity = state.sunIntensity;
    ambient.intensity = state.ambientIntensity;
    // The sun tracks the camera on x/z so its light direction stays stable
    // relative to the player as they roam the infinite world.
    const elevation = Math.sin(state.sunAngle);
    const alongArc = Math.cos(state.sunAngle);
    sun.position.set(
      camera.position.x + alongArc * SUN_DISTANCE,
      Math.max(elevation, 0.08) * SUN_DISTANCE,
      camera.position.z + 40,
    );
    sun.target.position.set(camera.position.x, 0, camera.position.z);
    sun.target.updateMatrixWorld();
  }

  function dispose(): void {
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { scene, camera, renderer, sun, ambient, render, resize, applySky, dispose };
}
