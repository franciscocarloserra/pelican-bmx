// Rendering polish on a tight budget (no extra full-screen render targets by default):
// - ACES + colour grade folded into the tone-mapping function (CustomToneMapping chunk) -> zero extra passes
// - vignette + speed/crash "tunnel vision" as one multiply-blended overlay quad
// - soft PCF sun shadows from a tight ortho frustum that follows the player (texel-snapped: no shimmer)
// - procedural surface grain/stains on large untextured-or-tinted Lambert surfaces (world-space value noise)
// - pixel-ratio cap + slow dynamic resolution when frames run long
// - arcade grade (vivid saturation, split tone), fresnel rim on the rider, fake contact AO at the base of vertical faces
// main.js: const render = createRender({scene, renderer, camera, sun, rider: bike.group}); per frame: render.update(S) before sky.render().
import * as THREE from 'three';
import { sunDir } from './sky.js';

// ---- resolution ----
const PR_MAX = 1.25, PR_MIN = 0.6, PR_STEP = 0.125, DYN_RES = true;           // pixel-ratio cap/floor; dynamic res step
const DYN_WINDOW = 1, DYN_SLOW_MS = 21, DYN_FAST_MS = 15;                       // s per decision; drop above / raise below avg frame ms
// ---- grade (applied after ACES, display-linear) ----
const GRADE = true, EXPOSURE = 0.78, SATURATION = 1.32, CONTRAST = 1.1, PIVOT = 0.18;   // arcade: vivid
const SHADOW_TINT = [0.88, 0.97, 1.14], HIGHLIGHT_TINT = [1.03, 1.0, 0.94], SPLIT_PIVOT = 0.35;   // teal-blue shadows / warm highlights (rgb gains)
// ---- rider pop (fresnel rim on everything under `rider`, patched before the warm-up compile) ----
const RIM = true, RIM_COLOR = [0.5, 0.9, 1.0], RIM_I = 0.35, RIM_EXP = 3;      // linear rgb, intensity, falloff
// ---- fake contact AO: vertical faces darken toward the ground plane (in the surface-grain shader) ----
const AO = true, AO_Y0 = 0, AO_H = 0.7, AO_MIN = 0.55;                          // ground y, fade height (m), darkest multiplier
// ---- vignette / tunnel vision ----
const VIGNETTE = true, VIG_AMT = 0.35, VIG_R0 = 0.45, VIG_R1 = 1.05;           // darkening at the corners; radius start/end (0 centre, 1 corner)
const TUNNEL_AMT = 0.35, TUNNEL_R = 0.22, TUNNEL_V0 = 9, TUNNEL_V1 = 20, TUNNEL_CRASH = 0.6, TUNNEL_K = 4;   // extra amount, radius pull-in; speed range (m/s); crash boost; smoothing 1/s
// ---- shadows ----
const SHADOWS = true, SHADOW_MAP = 512, SHADOW_EXT = 14, SHADOW_DIST = 60, SHADOW_RADIUS = 3, SHADOW_BIAS = -0.0004, SHADOW_NBIAS = 0.03;   // map px, half-size (m), light distance (m), PCF blur
// ---- surface grain ----
const SURFACE = true, SURF_MIN_R = 4, SURF_AMT = 0.14, SURF_STAIN = 0.12, SURF_FREQ = 1.7, SURF_STAIN_FREQ = 0.09;   // min mesh radius (m); fine grain, large stains; cycles/m
const SCAN_EVERY = 2, MAX_INST = 400, CAST_MAX_R = 5, INFO_FRAME = 180;                                           // s between scene rescans (new meshes); skip big InstancedMeshes (fx)

const GRADE_GLSL = `vec3 CustomToneMapping( vec3 color ) {
  color = ACESFilmicToneMapping( color );
  float l = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = mix( vec3( l ), color, ${SATURATION.toFixed(3)} );
  color = max( ( color - ${PIVOT.toFixed(3)} ) * ${CONTRAST.toFixed(3)} + ${PIVOT.toFixed(3)}, 0.0 );
  float s = smoothstep( 0.0, ${(SPLIT_PIVOT * 2).toFixed(3)}, l );
  color *= mix( vec3( ${SHADOW_TINT.map(v => v.toFixed(3))} ), vec3( ${HIGHLIGHT_TINT.map(v => v.toFixed(3))} ), s );
  return clamp( color, 0.0, 1.0 );
}`;
const SURF_PARS = `varying vec3 vSurfW; varying vec3 vSurfN;
float sHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y); }`;
const SURF_FRAG = `{ vec2 sp = vec2(vSurfW.x + vSurfW.y * 0.6, vSurfW.z - vSurfW.y * 0.8);   // floors and both wall orientations get 2D variation
  float g = sNoise(sp * ${(SURF_FREQ * 2.2).toFixed(3)});   // 2 lookups total (was 4)
  float st = sNoise(sp * ${SURF_STAIN_FREQ.toFixed(3)});
  diffuseColor.rgb *= 1.0 + (g - 0.5) * ${SURF_AMT.toFixed(3)} - smoothstep(0.45, 0.8, st) * ${SURF_STAIN.toFixed(3)};
  ${AO ? `float ao = mix(${AO_MIN.toFixed(3)}, 1.0, smoothstep(${AO_Y0.toFixed(3)}, ${(AO_Y0 + AO_H).toFixed(3)}, vSurfW.y));
  diffuseColor.rgb *= mix(1.0, ao, 1.0 - abs(normalize(vSurfN).y));` : ''} }`;
const RIM_FRAG = `totalEmissiveRadiance += vec3(${RIM_COLOR.map(v => (v * RIM_I).toFixed(3))}) * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), ${RIM_EXP.toFixed(1)});`;
const VIG_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const VIG_FS = `varying vec2 vUv; uniform float uAspect, uAmt, uR0, uR1;
void main() { vec2 d = (vUv - 0.5) * 2.0; d.x *= uAspect; float v = 1.0 - uAmt * smoothstep(uR0, uR1, length(d) / sqrt(uAspect * uAspect + 1.0));   // r: 0 centre, 1 corner
  gl_FragColor = vec4(vec3(v), 1.0); }`;

export function createRender({scene, renderer, camera, sun, rider}) {
  let pr = Math.min(devicePixelRatio, PR_MAX);
  renderer.setPixelRatio(pr);

  if (GRADE) {
    const chunk = THREE.ShaderChunk.tonemapping_pars_fragment, re = /vec3 CustomToneMapping\( vec3 color \) \{ return color; \}/;
    if (re.test(chunk)) { THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(re, GRADE_GLSL); renderer.toneMapping = THREE.CustomToneMapping; }
    else { renderer.toneMapping = THREE.ACESFilmicToneMapping; window.log?.('error', {msg: 'render: CustomToneMapping stub not found, plain ACES'}); }
    renderer.toneMappingExposure = EXPOSURE;
  }

  // vignette / tunnel overlay: dst *= src
  const VU = {uAspect: {value: 1}, uAmt: {value: VIG_AMT}, uR0: {value: VIG_R0}, uR1: {value: VIG_R1}};
  const vig = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: VU, vertexShader: VIG_VS, fragmentShader: VIG_FS, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
  }));
  vig.frustumCulled = false; vig.renderOrder = 2e6; vig.userData.noShadow = true;
  if (VIGNETTE) scene.add(vig);

  // shadows
  const lightBasis = new THREE.Matrix4(), lightInv = new THREE.Matrix4(), snap = new THREE.Vector3(), texel = SHADOW_EXT * 2 / SHADOW_MAP;
  if (SHADOWS && sun) {
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;   // PCF honours shadow.radius; cheaper than PCFSoft
    sun.castShadow = true;
    const s = sun.shadow, c = s.camera;
    s.mapSize.set(SHADOW_MAP, SHADOW_MAP); s.radius = SHADOW_RADIUS; s.bias = SHADOW_BIAS; s.normalBias = SHADOW_NBIAS;
    c.left = c.bottom = -SHADOW_EXT; c.right = c.top = SHADOW_EXT; c.near = 1; c.far = SHADOW_DIST * 2; c.updateProjectionMatrix();
    if (!sun.target.parent) scene.add(sun.target);
    lightBasis.lookAt(sunDir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)); lightInv.copy(lightBasis).invert();
  }

  // scene scan: shadow flags + surface grain patch (once per material)
  const patched = new WeakSet();
  const patch = m => {
    if (patched.has(m)) return; patched.add(m);
    m.onBeforeCompile = sh => {
      sh.vertexShader = 'varying vec3 vSurfW; varying vec3 vSurfN;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  { vec4 w = vec4(transformed, 1.0); vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    w = instanceMatrix * w; wn = mat3(instanceMatrix) * wn;
  #endif
    vSurfW = (modelMatrix * w).xyz; vSurfN = mat3(modelMatrix) * wn; }`);
      sh.fragmentShader = SURF_PARS + '\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' + SURF_FRAG);
    };
    m.customProgramCacheKey = () => 'surfgrain';
    m.needsUpdate = true;
  };
  const rimPatch = o => {   // fresnel rim so the rider pops off the background; only untouched lit materials
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || patched.has(m) || m.isMeshBasicMaterial || m.isShaderMaterial || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) continue;
      if (!(m.isMeshLambertMaterial || m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial)) continue;
      patched.add(m);
      m.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + RIM_FRAG); };
      m.customProgramCacheKey = () => 'rim'; m.needsUpdate = true;
    }
  };
  const scan = () => (RIM && rider?.traverse(rimPatch), scene.traverse(o => {
    if (!o.isMesh || o.userData.noShadow || o.parent?.name === 'sky' || o.isLensflare) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.isShaderMaterial || m.transparent || m.depthWrite === false || (o.isInstancedMesh && o.count > MAX_INST)) return;
    if (SHADOWS && !o.userData.shadowSet) { if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();   // big static / instanced meshes receive only
      o.castShadow = !m.isMeshBasicMaterial && !o.isInstancedMesh && o.geometry.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis() < CAST_MAX_R; o.receiveShadow = !m.isMeshBasicMaterial; o.userData.shadowSet = true; }
    if (SURFACE && m.isMeshLambertMaterial && !o.isSkinnedMesh && m.onBeforeCompile === THREE.Material.prototype.onBeforeCompile) {
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      if (o.geometry.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis() >= SURF_MIN_R) patch(m);
    }
  }));
  scene.updateMatrixWorld(); scan();

  let scanT = 0, nFrame = 0, tunnel = 0, last = performance.now(), acc = 0, cnt = 0, dynT = 0;
  const api = {
    auto: true,   // periodic rescan; main.js RESCAN=false: flags are set once (rescan() at warm-up), no runtime shadow-flag flips -> no shader recompiles at crash time
    rescan() { scene.updateMatrixWorld(); scan(); },
    update(S) {
      const now = performance.now(), ms = now - last; last = now;
      if (++nFrame === INFO_FRAME) { const i = renderer.info, sz = renderer.getDrawingBufferSize(new THREE.Vector2());   // last frame's totals (one-shot)
        let cast = 0; scene.traverse(o => { if (o.castShadow) cast++; });
        window.log?.('renderinfo', {calls: i.render.calls, tris: i.render.triangles, programs: i.programs?.length, geos: i.memory.geometries, tex: i.memory.textures, cast, pr, px: [sz.x, sz.y]}); }
      const dt = Math.min(ms / 1000, 0.1);
      if (api.auto && (scanT += dt) > SCAN_EVERY) { scanT = 0; scan(); }

      if (DYN_RES && ms < 250) {   // ignore tab switches / hitches
        acc += ms; cnt++;
        if ((dynT += dt) > DYN_WINDOW) {
          const avg = acc / cnt, cap = Math.min(devicePixelRatio, PR_MAX);
          const np = avg > DYN_SLOW_MS ? Math.max(PR_MIN, pr - PR_STEP) : avg < DYN_FAST_MS ? Math.min(cap, pr + PR_STEP) : pr;
          if (np !== pr) { pr = np; renderer.setPixelRatio(pr); window.log?.('dynres', {pr, avgMs: Math.round(avg)}); }
          acc = cnt = dynT = 0;
        }
      }

      if (VIGNETTE) {
        const sp = S.vel.length(), tg = THREE.MathUtils.smoothstep(sp, TUNNEL_V0, TUNNEL_V1) + (S.crashed > 0 ? TUNNEL_CRASH : 0);
        tunnel += (Math.min(1, tg) - tunnel) * (1 - Math.exp(-TUNNEL_K * dt));
        VU.uAspect.value = camera.aspect; VU.uAmt.value = VIG_AMT + TUNNEL_AMT * tunnel; VU.uR0.value = VIG_R0 - TUNNEL_R * tunnel;
      }

      if (SHADOWS && sun) {   // follow the player, snapped to shadow texels in light space
        const at = S.crashed > 0 && S.body ? S.body.pos : S.pos;
        snap.copy(at).applyMatrix4(lightInv);
        snap.x = Math.round(snap.x / texel) * texel; snap.y = Math.round(snap.y / texel) * texel;
        snap.applyMatrix4(lightBasis);
        sun.target.position.copy(snap); sun.position.copy(snap).addScaledVector(sunDir, SHADOW_DIST);
      }
    },
  };
  return api;
}
