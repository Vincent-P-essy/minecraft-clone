import * as THREE from "three";

/** Layer that shadow casters live on, so the light's camera sees the
 * terrain and nothing else (no sky, no water, no particles). */
export const SHADOW_LAYER = 1;

/** One orthographic shadow map that follows the player. The map is
 * snapped to its own texel grid in light space, so walking doesn't make
 * shadow edges crawl, and its matrix is expressed relative to the camera
 * so it stays precise however far from the origin the player roams. */
export class ShadowPass {
  readonly target: THREE.WebGLRenderTarget;
  readonly texture: THREE.DepthTexture;
  readonly camera: THREE.OrthographicCamera;
  /** Camera-relative world position -> shadow-map texture coordinates. */
  readonly matrix = new THREE.Matrix4();
  readonly size: number;
  private readonly extent: number;

  private readonly center = new THREE.Vector3();
  private readonly lightSpace = new THREE.Matrix4();
  private readonly lightSpaceInverse = new THREE.Matrix4();
  private readonly scratch = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly origin = new THREE.Vector3();
  private readonly lightDir = new THREE.Vector3(0, 1, 0);

  constructor(size: number, extent: number) {
    this.size = size;
    this.extent = extent;
    const depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
    depthTexture.compareFunction = THREE.LessEqualCompare;
    depthTexture.magFilter = THREE.LinearFilter;
    depthTexture.minFilter = THREE.LinearFilter;
    this.texture = depthTexture;
    this.target = new THREE.WebGLRenderTarget(size, size, {
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 1, extent * 6);
    this.camera.layers.set(SHADOW_LAYER);
    this.camera.matrixAutoUpdate = false;
  }

  get texelSize(): number {
    return 1 / this.size;
  }

  /** Aims the light camera. `lightDir` points from the world toward the light. */
  update(lightDir: THREE.Vector3, viewer: THREE.Camera): void {
    // Hold the direction steady between small steps so the whole map
    // doesn't shimmer as the sun creeps across the sky.
    if (this.lightDir.angleTo(lightDir) > 0.0035) this.lightDir.copy(lightDir).normalize();
    const dir = this.lightDir;

    // Cover a little more of what's ahead than what's behind.
    viewer.getWorldDirection(this.scratch);
    this.scratch.y = 0;
    if (this.scratch.lengthSq() > 1e-6) this.scratch.normalize();
    this.center.copy(viewer.position).addScaledVector(this.scratch, this.extent * 0.35);

    // Snap the center to whole texels in light space.
    this.lightSpace.lookAt(this.origin, this.scratch.copy(dir).negate(), this.up);
    this.lightSpaceInverse.copy(this.lightSpace).invert();
    const texel = (this.extent * 2) / this.size;
    this.center.applyMatrix4(this.lightSpaceInverse);
    this.center.x = Math.round(this.center.x / texel) * texel;
    this.center.y = Math.round(this.center.y / texel) * texel;
    this.center.applyMatrix4(this.lightSpace);

    const distance = this.extent * 3;
    this.camera.position.copy(this.center).addScaledVector(dir, distance);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.center);
    this.camera.updateMatrix();
    this.camera.updateMatrixWorld(true);

    // rel -> world -> light clip -> [0, 1]
    this.matrix
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse)
      .multiply(
        new THREE.Matrix4().makeTranslation(
          viewer.position.x,
          viewer.position.y,
          viewer.position.z,
        ),
      );
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, depthMaterial: THREE.Material): void {
    const previousOverride = scene.overrideMaterial;
    scene.overrideMaterial = depthMaterial;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.overrideMaterial = previousOverride;
  }

  dispose(): void {
    this.texture.dispose();
    this.target.dispose();
  }
}
