// Shared blob contact shadows: ONE instanced ground quad, sliced between the vehicle / ped / player renderers. Track C.
//
// Every grounded entity gets a soft dark ellipse on the floor. The whole city costs a single draw call because
// all three renderers write into fixed slices of the same InstancedMesh (each slice zeroes its unused tail).
import * as THREE from 'three';
import { BUDGET } from '../core/Budget';
import { clamp } from '../core/math';
import { BLOCK, CURB_H, GRID_COLS, GRID_ROWS, PITCH, ROAD_W, SIDEWALK_W } from '../city/CityConfig';

export const SHADOW_TUNING = {
  /**
   * Slots: every vehicle + every ped + the STATIC slices (CityRendererProps' parked cars and street furniture) + the
   * player + margin. The slices are reserved once at construction and clamped to what is left, so this must cover all
   * of them or the LAST renderer to build silently gets fewer blobs than it asks for - and it gets them with no error
   * anywhere, which is the one failure in this file a screenshot cannot show.
   *
   * The old spare of 48 was sized for the parked-car slice (44) plus the player, i.e. 3 slots of real margin, and it
   * only survived round 13's street-furniture slice (24 more) because VehicleRenderer asks for 96 rather than
   * BUDGET.MAX_VEHICLES (128). Read off the running mesh: 44 + 1 + 96 + 96 = 237 reserved of 272 before the furniture
   * slice existed, 261 of 272 with it. Raise the vehicle slice to the budget it is named after and the furniture
   * slice - the last to build - would silently have got ZERO. 96 of margin covers that worst case (293) with room for
   * one more static slice; the cost is two CPU-side buffers 48 slots longer (~24 KB) and nothing at all on the GPU,
   * because `mesh.count` is the reserved cursor, not the capacity.
   */
  capacity: BUDGET.MAX_VEHICLES + BUDGET.MAX_PEDS + 96,
  /**
   * How far the FULLY OPAQUE part of a blob reaches past the caster's own footprint, in metres, and how wide the
   * penumbra that fades it out is. Both are WORLD widths and both are honoured on all four sides of any blob
   * whatever its aspect, which is the whole point of the procedural mask below.
   *
   * The old mask was a radial ramp in a 64 x 64 texture, opaque only inside `core` (0.72) of its radius. Two things
   * followed from that, and both of them are the "nothing that moves is grounded" read:
   *
   *  - the opaque part was a fixed FRACTION of the quad, so it could only be pushed onto visible ground by making
   *    the quad huge. A sedan's blob was 3.44 x 7.06 m for a 1.8 x 4.4 m car, and the extra was all ramp: a 2 m wide
   *    grey wash with no edge anywhere near the sills. Measured on lot asphalt at noon (a parked sedan at 965.5,
   *    507.5, camera 3.5 m away), hiding the blob mesh moved the ground 0.25 m outboard of the sill by 40/255 - but
   *    over a metre and a half of falloff, which reads as haze, not as contact.
   *  - a radial ramp on a 1:2.5 quad is an ELLIPSE, so the same texel is 0.4 m of falloff across the car and 1.0 m
   *    along it, and the opaque core pinches to nothing at the bumpers. The corners of the footprint - exactly where
   *    a car meets the road - got the least occlusion of anywhere on the blob.
   *
   * The mask is now a rounded RECTANGLE whose corner radius and falloff width are these metres, computed in the
   * fragment shader from the instance's own world scale (see blobMaskPatch). `spill` puts real, undiluted occlusion
   * on ground the camera can see past the silhouette; `penumbra` is the soft edge that keeps it from reading as a
   * decal. Keep the sum modest: it is the radius of the visible dark pool around every car, ped and player in the
   * city, and on pale paving a wide one reads as a halo rather than as a shadow.
   */
  spill: 0.26,
  penumbra: 0.34,
  /**
   * Floor on a blob's half-extent. Nothing in the city is small enough to need it today (the narrowest caster is a
   * ped at 0.22 m), but a caster that asks for a 5 cm blob should still get a visible pool rather than a dot.
   */
  minHalf: 0.5,
  /**
   * Occlusion of the core, i.e. how much light the multiply operator takes off the floor under a caster (see the
   * material below). Real cast shadows overlap the blobs by day so the day term stays the smaller of the two; at
   * night the moon shadow is almost nothing and the blob is the ONLY thing holding a car or a figure on the road.
   *
   * These are not the old alpha-over numbers and cannot be compared with them: 0.3 of an alpha-over toward a
   * near-black was worth 5.5/255 on lit pavement and 0.5/255 on lot asphalt. 0.5 of a multiply takes half the light.
   */
  dayOpacity: 0.5,
  nightOpacity: 0.62,
} as const;

/**
 * Half-extent of the blob quad for a caster whose own footprint half-extent on that axis is `half`: the footprint,
 * plus the opaque spill, plus the penumbra that fades it out. Used by every caster (vehicles, parked props, the
 * crowd, the player) so one set of metres in SHADOW_TUNING describes the contact term everywhere.
 *
 * It is deliberately NOT divided by anything. The old `shadowExtent` divided by the mask's opaque fraction, which is
 * how a 1.8 m car ended up with a 3.44 m blob; the mask now derives its own falloff from this extent instead.
 */
export function contactExtent(half: number): number {
  return Math.max(half + SHADOW_TUNING.spill + SHADOW_TUNING.penumbra, SHADOW_TUNING.minHalf);
}

/**
 * Height of the walkable surface under a world point: block interiors and their sidewalks are raised to CURB_H,
 * the carriageway is at 0. O(1) grid math — a blob placed at road height would sink under the kerb otherwise.
 *
 * The cell index is taken with the sidewalk apron folded IN (`+ SIDEWALK_W`), not from the block origin: a block's
 * raised surface runs [bx - SIDEWALK_W, bx + BLOCK + SIDEWALK_W], so a point on the apron on the LOW-x / LOW-z side
 * used to floor into the PREVIOUS cell, whose rect test then failed and answered 0 — the pavement on two of every
 * block's four faces read as carriageway. Shifting the index by the apron width maps every face of block c to cell c
 * and still leaves the carriageway (which is ROAD_W - 2 * SIDEWALK_W = 14 m wide between two aprons) outside the rect.
 */
export function groundYAt(x: number, z: number): number {
  const col = Math.floor((x - ROAD_W + SIDEWALK_W) / PITCH);
  const row = Math.floor((z - ROAD_W + SIDEWALK_W) / PITCH);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return 0;
  const bx = ROAD_W + col * PITCH, bz = ROAD_W + row * PITCH;
  const inX = x >= bx - SIDEWALK_W && x <= bx + BLOCK + SIDEWALK_W;
  const inZ = z >= bz - SIDEWALK_W && z <= bz + BLOCK + SIDEWALK_W;
  return inX && inZ ? CURB_H : 0;
}

const mat4 = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const zero = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/**
 * The blob mask, in the shader instead of in a texture.
 *
 * The occlusion has to be a rounded rectangle whose corner radius and falloff are fixed WORLD widths, on a quad whose
 * aspect is different for every instance (a sedan is 1:2, a ped is 1:1, a stretched dusk ped blob is 1:1.6). One
 * shared texture cannot express that - a radial ramp stretched to the quad is an ellipse whose falloff is as
 * anisotropic as the quad - so the mask is evaluated per fragment from the instance's own scale, which the vertex
 * stage already has in `instanceMatrix`. Columns 0 and 2 of a compose(pos, yaw, (sx, 1, sz)) matrix have lengths sx
 * and sz, i.e. the blob's world width and length; nothing extra is uploaded per instance for the shape.
 *
 * `vBlobFade` is the penumbra as a FRACTION of the half-extent on each axis, so the fragment stage can work in the
 * quad's own [-1, 1] space and still get a constant world falloff on both axes.
 *
 * The distance field is the standard rounded-box one: distance outside the core rect, in penumbra units. It is 0 on
 * and inside the core (undiluted occlusion out to `spill` past the footprint), 1 at the rim, and its level sets are
 * rounded rectangles, so a car's corners get the same contact darkening as its flanks. Round casters blend to the
 * radial form of the same field (see `round` on `add`).
 *
 * Two per-instance scalars ride on instanceColor, whose RGB this material throws away anyway (the multiply blend
 * below multiplies the source colour by zero): .r is the caster's fade, .g its roundness. No extra buffer, and no
 * value that anything else in the pipeline can read.
 */
function blobMaskPatch(shader: THREE.WebGLProgramParametersWithUniforms, penumbra: { value: number }): void {
  shader.uniforms.uBlobPenumbra = penumbra;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', [
      '#include <common>',
      'uniform float uBlobPenumbra;',
      'varying vec2 vBlobQ;',
      'varying vec2 vBlobFade;',
    ].join('\n'))
    .replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      'vBlobQ = position.xz * 2.0;',
      '#ifdef USE_INSTANCING',
      '  vec2 blobHalf = vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 2 ].xyz ) ) * 0.5;',
      '#else',
      '  vec2 blobHalf = vec2( 1.0 );',
      '#endif',
      'vBlobFade = clamp( vec2( uBlobPenumbra ) / max( blobHalf, vec2( 1e-3 ) ), vec2( 0.03 ), vec2( 1.0 ) );',
    ].join('\n'));
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', [
      '#include <common>',
      'varying vec2 vBlobQ;',
      'varying vec2 vBlobFade;',
      // USE_COLOR, not USE_INSTANCING_COLOR: three r185 emits USE_INSTANCING_COLOR in the VERTEX prefix only
      // (WebGLProgram), while the FRAGMENT prefix answers an instanceColor attribute with USE_COLOR - which is also
      // the define `color_pars_fragment` declares `varying vec4 vColor` under. Guarding the fragment half on the
      // vertex-only define silently preprocessed both per-instance scalars away: every figure blob rendered as the
      // rounded RECTANGLE this shape term exists to avoid, and the spawn / cull fade never reached the occlusion.
      '#ifdef USE_COLOR',
      '  #define vBlobRound vColor.g',
      '#else',
      '  #define vBlobRound 0.0',
      '#endif',
    ].join('\n'))
    .replace('#include <alphatest_fragment>', [
      '{',
      '  vec2 blobCore = max( vec2( 1.0 ) - vBlobFade, vec2( 0.0 ) );',
      '  vec2 blobOut = max( abs( vBlobQ ) - blobCore, vec2( 0.0 ) ) / vBlobFade;',
      '  float blobBox = length( blobOut );',
      // Round casters (a figure) take the same field on the RADIUS instead of per axis, so their pool is an ellipse
      // rather than a rounded square: the corners of a rounded square under a pair of shoes are the one place the
      // blob stops looking like occlusion and starts looking like a decal.
      '  float blobFadeR = ( vBlobFade.x + vBlobFade.y ) * 0.5;',
      '  float blobEll = ( length( vBlobQ ) - ( 1.0 - blobFadeR ) ) / blobFadeR;',
      '  float blobD = clamp( mix( blobBox, blobEll, vBlobRound ), 0.0, 1.0 );',
      '  diffuseColor.a *= 1.0 - ( blobD * blobD * ( 3.0 - 2.0 * blobD ) );',
      '  #ifdef USE_COLOR',
      '    diffuseColor.a *= vColor.r;', // per-instance spawn / cull fade, see ContactShadows.add (USE_COLOR: see above)
      '  #endif',
      '  if ( diffuseColor.a <= 0.0 ) discard;',
      '}',
      '#include <alphatest_fragment>',
    ].join('\n'));
}

/** The single shared mesh; owns the slice allocator and the day/night opacity. */
class ShadowField {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly scene: THREE.Scene;
  /** Penumbra width in metres, shared by reference into the shader (see blobMaskPatch). */
  private readonly penumbra = { value: SHADOW_TUNING.penumbra };
  private cursor = 0;
  private refs = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // MULTIPLY, not alpha-over. The blob used to be a near-black quad lerped over the floor at 30 %, which is a
    // no-op on anything already dark: on lit lot asphalt it moved the mean by 0.5/255 (peak 22), inside the +-15/255
    // swing of the asphalt's own macro texture, and on the 19:00 pavement by 0.23/255 - the shoes met the paving with
    // literally no darkening. dst *= (1 - srcAlpha) instead makes the mask's alpha the OCCLUSION: it takes a fixed
    // FRACTION of whatever light the floor had, so it reads the same on white paving, grey road and black asphalt,
    // and it can never lighten anything (the old operator did, wherever the ground was darker than 0x0f0f12).
    // The RGB of the source is multiplied by zero and never reaches the framebuffer, so this material has no colour.
    // The alpha channel is kept on the destination (blendSrcAlpha/DstAlpha) so the blob does not punch holes in the
    // composer's alpha on the HDR path.
    this.material = new THREE.MeshBasicMaterial({
      transparent: true, opacity: SHADOW_TUNING.dayOpacity,
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, blendEquationAlpha: THREE.AddEquation,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    this.material.onBeforeCompile = (shader) => blobMaskPatch(shader, this.penumbra);
    this.material.customProgramCacheKey = () => 'contactBlobMask2';
    this.material.name = 'contactBlob'; // Renderer.sceneBreakdown() and the render probes attribute the mesh by this.
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, this.material, SHADOW_TUNING.capacity);
    // Per-instance fade rides on instanceColor (see blobMaskPatch): the mask reads .r as an alpha multiplier, and the
    // multiply blend throws the source RGB away, so nothing else in the pipeline sees these values.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SHADOW_TUNING.capacity * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Ground-transparent ladder: road paint and skid marks are renderOrder 1, the additive lamp pools 2, neon 3,
    // markers 4, particles 5-6. The blob has to land BETWEEN the paint and the additives. At -1 it drew FIRST among
    // the transparents, and since the paint writes no depth either, three then painted every lane line and lot bay
    // line back over the multiply at full brightness - the one thing in the frame the darkest pool could not darken.
    // It matters because `LOT_BAYS.bayPitch` is 3 m: a bay line sits 1.5 m from a parked car's centre, inside the
    // opaque core of its blob, and every one of the up to 44 parked-car blobs has one running through it.
    // Measured by toggling this line alone at hour 19 in the lot (a pure sort change - no shader, no material state,
    // so a runtime A/B is valid here): 0.52 % of the frame moves by more than 8/255, and the bay line crossing a
    // car's blob loses ~2 % of its brightness (mean of its brightest 200 px 158.0 -> 154.9).
    // 1.5 keeps it under every additive (a light pool must add on top of the shaded floor, not under it).
    this.mesh.renderOrder = 1.5;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < SHADOW_TUNING.capacity; i++) this.mesh.setMatrixAt(i, zero);
    scene.add(this.mesh);
  }

  retain(): void { this.refs++; }

  /** Hands out a contiguous block of instance slots; the mesh always draws every reserved slot. */
  reserve(n: number): number {
    const start = this.cursor;
    const room = Math.min(n, SHADOW_TUNING.capacity - start);
    this.cursor += Math.max(0, room);
    if (this.cursor > this.mesh.count) this.mesh.count = this.cursor;
    return start;
  }

  reservedRoom(start: number, want: number): number {
    return Math.max(0, Math.min(want, SHADOW_TUNING.capacity - start));
  }

  setNight(f: number): void {
    const t = clamp(f, 0, 1);
    this.material.opacity = SHADOW_TUNING.dayOpacity + (SHADOW_TUNING.nightOpacity - SHADOW_TUNING.dayOpacity) * t;
  }

  /** The instanceColor buffer, whose .r channel is the per-instance fade (see blobMaskPatch). Never null here. */
  get fades(): THREE.InstancedBufferAttribute {
    return this.mesh.instanceColor as THREE.InstancedBufferAttribute;
  }

  flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fades.needsUpdate = true;
  }

  release(): void {
    this.refs--;
    if (this.refs > 0) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
    fields.delete(this.scene);
  }
}

const fields = new WeakMap<THREE.Scene, ShadowField>();

function fieldFor(scene: THREE.Scene): ShadowField {
  let f = fields.get(scene);
  if (!f) {
    f = new ShadowField(scene);
    fields.set(scene, f);
  }
  return f;
}

/**
 * A renderer's private window into the shared blob mesh.
 * Per frame: `begin()`, one `add()` per visible entity, `end()` (zeroes the leftovers).
 */
export class ContactShadows {
  private readonly field: ShadowField;
  private readonly start: number;
  private readonly cap: number;
  private used = 0;

  constructor(scene: THREE.Scene, capacity: number) {
    this.field = fieldFor(scene);
    this.field.retain();
    this.start = this.field.reserve(capacity);
    this.cap = this.field.reservedRoom(this.start, capacity);
  }

  /** Instances actually written on the last frame (tests / debug). */
  get count(): number { return this.used; }
  get capacity(): number { return this.cap; }

  begin(): void {
    this.used = 0;
  }

  /**
   * Rounded-rectangle pool of half-extents (rx, rz) centred at (x, y, z), aligned to yaw. `rx` / `rz` are the OUTER
   * half-extents - use `contactExtent` to derive them from a caster's footprint - and the mask is undiluted out to
   * SHADOW_TUNING.penumbra inside the rim.
   *
   * `fade` (0..1) both shrinks the pool and scales its occlusion, so a caster easing in at spawn or out at the crowd
   * cull distance does not leave a full-strength shadow behind. Shrink alone used to do it, which meant a ped at the
   * cull edge still printed a solid (if small) disc at full darkness.
   *
   * `round` (0..1) picks the shape: 0 is the rounded rectangle a car's footprint wants, 1 the ellipse a standing
   * figure wants. A figure given the rectangle stands in a visible rounded square, which reads as a decal.
   */
  add(x: number, y: number, z: number, rx: number, rz: number, yaw: number, fade: number, round = 0): void {
    if (this.used >= this.cap) return;
    const f = fade <= 0 ? 0 : fade > 1 ? 1 : fade;
    const r = round <= 0 ? 0 : round > 1 ? 1 : round;
    pos.set(x, y, z);
    euler.set(0, yaw, 0);
    quat.setFromEuler(euler);
    scl.set(rx * 2 * f, 1, rz * 2 * f);
    mat4.compose(pos, quat, scl);
    const i = this.start + this.used;
    this.field.mesh.setMatrixAt(i, mat4);
    this.field.fades.setXYZ(i, f, r, 0);
    this.used++;
  }

  end(): void {
    for (let i = this.used; i < this.cap; i++) this.field.mesh.setMatrixAt(this.start + i, zero);
    this.field.flush();
  }

  /** 0 = day (crisp blobs), 1 = night (soft, mostly lit by street lamps). Shared by every slice. */
  setNightFactor(f: number): void {
    this.field.setNight(f);
  }

  dispose(): void {
    this.begin();
    this.end();
    this.field.release();
  }
}
