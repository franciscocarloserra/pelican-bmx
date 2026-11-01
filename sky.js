// Stylized sky: gradient dome + fbm clouds + HDR sun disc/halo (one ShaderMaterial, drawn after opaques so covered
// pixels are depth-rejected), Lensflare with canvas-drawn textures (GPU self-occluding), a screen glare veil faded by a
// throttled raycast toward the sun, and fog / hemisphere / directional light matched to the sky.
// main.js: const sky = createSky({scene, renderer, camera, sun, octree}); per frame: sky.update(dt); sky.render();
import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

// ---- sun ----
export const SUN_ELEV = 21, SUN_AZIM = 28;                   // deg above horizon; deg from -z toward +x (ahead-right from the start deck)
const SUN_COLOR = 0xffdcae, SUN_LIGHT = 2.1;                 // directional light colour / intensity (aligned to the sun)
const SUN_DISC = 0xfff3dc, SUN_DISC_I = 30, SUN_SIZE = 1.1;  // HDR disc colour, intensity, angular radius (deg)
const HALO_COLOR = 0xffb76e, HALO_TIGHT = 2.0, HALO_TIGHT_EXP = 260, HALO_WIDE = 0.5, HALO_WIDE_EXP = 8;   // sky glow around the sun
// ---- gradient ----
const ZENITH = 0x1846d6, MID = 0x3fb2ff, HORIZON = 0xffc6b0, BELOW = 0xe8a8a0, HORIZON_BAND = 0.32;   // arcade: deep blue -> cyan -> peach-pink horizon (= fog)
const HORIZON_WARM = 0xff9a4a, WARM_I = 0.65, WARM_EXP = 4;  // orange haze on the sun side of the horizon
// ---- clouds (shader fbm on a virtual plane) ----
const CLOUDS = true, CLOUD_SCALE = 0.8, CLOUD_COVER = 0.5, CLOUD_SOFT = 0.2, CLOUD_OPACITY = 0.92, CLOUD_WIND = [0.010, 0.004];   // uv/s
const CLOUD_LIT = 0xfff8f0, CLOUD_SHADE = 0x9d8ee0, CLOUD_RIM = 0xffb070, CLOUD_RIM_I = 1.6;   // lavender undersides, orange rims
// ---- fog / ambient ----
const FOG_COLOR = HORIZON, FOG_NEAR = 70, FOG_FAR = 240;
const HEMI_SKY = 0x9ccfff, HEMI_GROUND = 0xb07a58, HEMI_I = 0.85;   // cyan sky fill / warm bounce
// ---- renderer ----
const TONE_MAP = true, EXPOSURE = 0.95;                      // ACES filmic (render.js GRADE replaces it with ACES + colour grade)
const BLOOM = false, BLOOM_STRENGTH = 0.45, BLOOM_RADIUS = 0.6, BLOOM_THRESHOLD = 0.95;   // UnrealBloomPass at half res (off: costly on iGPU)
// ---- lens flare / glare ----
const FLARE = true, FLARE_I = 1.0, FLARE_SCALE = 1.0, FLARE_DIST = 400, DOME_R = 450;   // dome/flare distances must stay < camera far (500)
const GLARE = true, GLARE_I = 0.5, GLARE_COLOR = 0xffd6a0, GLARE_FALLOFF = 2.6, GLARE_STREAK = 0.3, GLARE_EDGE = 0.3;   // veil; fades over EDGE ndc past the screen
const OCC_EVERY = 6, OCC_FADE = 8, OCC_REBUILD = 2, OCC_MAX_INST = 400;   // raycast every N frames (only when the sun is on screen), fade 1/s, occluder list refresh (s), skip big InstancedMeshes

const D2R = Math.PI / 180;
export const sunDir = new THREE.Vector3(Math.sin(SUN_AZIM * D2R) * Math.cos(SUN_ELEV * D2R), Math.sin(SUN_ELEV * D2R), -Math.cos(SUN_AZIM * D2R) * Math.cos(SUN_ELEV * D2R));
const col = (h, k = 1) => new THREE.Color(h).multiplyScalar(k);

const SKY_VS = `varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = `varying vec3 vDir;
uniform vec3 uSun, uZen, uMid, uHor, uBelow, uWarm, uDisc, uHalo, uCLit, uCShade, uCRim;
uniform float uTime, uBand, uWarmI, uWarmExp, uSunCos0, uSunCos1, uHt, uHtExp, uHw, uHwExp, uCScale, uCCover, uCSoft, uCOp, uCRimI;
uniform vec2 uWind;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p, int n) { float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { if (i >= n) break; v += a * noise(p); p = m * p; a *= 0.5; } return v; }
void main() {
  vec3 d = normalize(vDir);
  float y = d.y, t = clamp(y, 0.0, 1.0), mu = dot(d, uSun), mup = max(mu, 0.0);
  vec3 c = mix(uHor, uMid, smoothstep(0.0, uBand, t));
  c = mix(c, uZen, smoothstep(uBand * 0.6, 1.0, t));
  c = mix(c, uBelow, smoothstep(0.0, -0.3, y));
  c = mix(c, uWarm, uWarmI * pow(mu * 0.5 + 0.5, uWarmExp) * (1.0 - smoothstep(0.0, 0.5, abs(y))));
  c += uHalo * (uHt * pow(mup, uHtExp) + uHw * pow(mup, uHwExp));
  float cov = 0.0;
#ifdef CLOUDS
  if (y > 0.005) {
    vec2 uv = d.xz / (y + 0.08) * uCScale + uWind * uTime;
    float n = fbm(uv, 4);
    cov = smoothstep(uCCover, uCCover + uCSoft, n) * smoothstep(0.0, 0.15, y);
    if (cov > 0.0) {
      float n2 = fbm(uv + normalize(uSun.xz + 1e-4) * 0.09, 2);   // density toward the sun -> self shadow
      vec3 cc = mix(uCShade, uCLit, clamp((n - n2) * 5.0 + 0.55, 0.0, 1.0));
      cc += uCRim * uCRimI * pow(mup, 6.0) * (1.0 - smoothstep(uCCover, uCCover + uCSoft * 2.0, n));   // silver lining on thin edges
      c = mix(c, cc, cov * uCOp);
    }
  }
#endif
  c += uDisc * smoothstep(uSunCos0, uSunCos1, mu) * (1.0 - cov * 0.85);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const GLARE_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const GLARE_FS = `varying vec2 vUv; uniform vec2 uPos; uniform vec3 uCol; uniform float uAspect, uI, uFall, uStreak;
void main() { vec2 d = vUv * 2.0 - 1.0 - uPos; d.x *= uAspect; float r = length(d);
  float g = 0.7 * exp(-r * uFall) + 0.5 * exp(-r * r * 40.0) + uStreak * exp(-abs(d.y) * 70.0) * exp(-abs(d.x) * 1.3);
  gl_FragColor = vec4(uCol * g * uI, 1.0); }`;

// ---- canvas flare textures ----
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function tex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.globalCompositeOperation = 'lighter'; draw(g, size / 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const radial = (g, h, stops) => { const gr = g.createRadialGradient(h, h, 0, h, h, h); for (const [o, s] of stops) gr.addColorStop(o, s); g.fillStyle = gr; g.fillRect(0, 0, h * 2, h * 2); };
function flareTextures() {
  const glow = tex(256, (g, h) => radial(g, h, [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,244,220,.85)'], [0.35, 'rgba(255,200,140,.25)'], [1, 'rgba(255,160,80,0)']]));
  const burst = tex(512, (g, h) => {
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * Math.PI * 2 + rnd() * 0.05, len = h * (0.25 + 0.7 * rnd() ** 2);
      const gr = g.createLinearGradient(h, h, h + Math.cos(a) * len, h + Math.sin(a) * len);
      gr.addColorStop(0, 'rgba(255,245,225,.55)'); gr.addColorStop(1, 'rgba(255,220,180,0)');
      g.strokeStyle = gr; g.lineWidth = 1 + rnd() * 2.5;
      g.beginPath(); g.moveTo(h, h); g.lineTo(h + Math.cos(a) * len, h + Math.sin(a) * len); g.stroke();
    }
    radial(g, h, [[0, 'rgba(255,255,255,.6)'], [0.08, 'rgba(255,240,210,.3)'], [0.25, 'rgba(255,220,180,0)']]);
  });
  const streak = tex(512, (g, h) => { g.translate(0, h * (1 - 0.03)); g.scale(1, 0.03); radial(g, h, [[0, 'rgba(255,255,255,.9)'], [0.3, 'rgba(255,215,170,.35)'], [1, 'rgba(255,180,120,0)']]); });
  const ring = tex(256, (g, h) => [['255,90,90', 0], ['90,255,120', 0.025], ['110,140,255', 0.05]].forEach(([rgb, o]) =>
    radial(g, h, [[0, `rgba(${rgb},0)`], [0.72 + o, `rgba(${rgb},0)`], [0.82 + o, `rgba(${rgb},.45)`], [0.86 + o, `rgba(${rgb},.12)`], [0.94 + o, `rgba(${rgb},0)`]])));
  const hex = tex(128, (g, h) => {
    g.filter = 'blur(1.5px)'; g.beginPath();
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + Math.PI / 6; g[i ? 'lineTo' : 'moveTo'](h + Math.cos(a) * h * 0.85, h + Math.sin(a) * h * 0.85); }
    g.closePath();
    const gr = g.createRadialGradient(h, h, 0, h, h, h); gr.addColorStop(0, 'rgba(255,255,255,.22)'); gr.addColorStop(1, 'rgba(255,255,255,.4)');
    g.fillStyle = gr; g.fill(); g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 2; g.stroke();
  });
  return {glow, burst, streak, ring, hex};
}

export function createSky({scene, renderer, camera, sun, octree}) {
  // renderer / fog / lights
  if (TONE_MAP) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = EXPOSURE; }
  scene.background = new THREE.Color(FOG_COLOR);
  if (scene.fog?.isFog) { scene.fog.color.set(FOG_COLOR); scene.fog.near = FOG_NEAR; scene.fog.far = FOG_FAR; } else scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);
  const hemi = scene.children.find(o => o.isHemisphereLight);
  if (hemi) { hemi.color.set(HEMI_SKY); hemi.groundColor.set(HEMI_GROUND); hemi.intensity = HEMI_I; }
  if (sun) {   // keep distance to the target so any shadow-camera setup still frames the same volume
    const dist = sun.position.distanceTo(sun.target.position) || 60;
    sun.color.set(SUN_COLOR); sun.intensity = SUN_LIGHT; sun.position.copy(sun.target.position).addScaledVector(sunDir, dist);
  }

  // dome
  const U = {
    uSun: {value: sunDir}, uZen: {value: col(ZENITH)}, uMid: {value: col(MID)}, uHor: {value: col(HORIZON)}, uBelow: {value: col(BELOW)},
    uWarm: {value: col(HORIZON_WARM)}, uDisc: {value: col(SUN_DISC, SUN_DISC_I)}, uHalo: {value: col(HALO_COLOR)},
    uCLit: {value: col(CLOUD_LIT)}, uCShade: {value: col(CLOUD_SHADE)}, uCRim: {value: col(CLOUD_RIM)},
    uTime: {value: 0}, uBand: {value: HORIZON_BAND}, uWarmI: {value: WARM_I}, uWarmExp: {value: WARM_EXP},
    uSunCos0: {value: Math.cos(SUN_SIZE * D2R)}, uSunCos1: {value: Math.cos(SUN_SIZE * 0.8 * D2R)},
    uHt: {value: HALO_TIGHT}, uHtExp: {value: HALO_TIGHT_EXP}, uHw: {value: HALO_WIDE}, uHwExp: {value: HALO_WIDE_EXP},
    uCScale: {value: CLOUD_SCALE}, uCCover: {value: CLOUD_COVER}, uCSoft: {value: CLOUD_SOFT}, uCOp: {value: CLOUD_OPACITY}, uCRimI: {value: CLOUD_RIM_I},
    uWind: {value: new THREE.Vector2(...CLOUD_WIND)},
  };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 32, 16), new THREE.ShaderMaterial({
    uniforms: U, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false, defines: CLOUDS ? {CLOUDS: 1} : {},
  }));
  dome.renderOrder = 1; dome.frustumCulled = false;   // after opaques -> early-z skips covered pixels
  const root = new THREE.Group(); root.name = 'sky'; root.add(dome); scene.add(root);

  // lens flare (Lensflare does its own per-pixel occlusion test on the GPU)
  const flareAt = new THREE.Object3D(); root.add(flareAt);
  if (FLARE) {
    const T = flareTextures(), lf = new Lensflare(), px = FLARE_SCALE * renderer.getPixelRatio() * Math.min(1.4, innerHeight / 900);
    for (const [t, s, d, c, k] of [
      [T.glow, 650, 0, 0xffe4bc, 1], [T.burst, 520, 0, 0xfff0d8, 0.8], [T.streak, 1500, 0, 0xffc890, 0.7],
      [T.hex, 70, 0.55, 0x9fd0ff, 0.35], [T.hex, 110, 0.68, 0xffd59a, 0.3], [T.ring, 170, 0.8, 0xffffff, 0.35],
      [T.hex, 60, 0.95, 0xff9f7a, 0.35], [T.hex, 150, 1.1, 0x9fb8ff, 0.25], [T.ring, 380, 1.35, 0xffffff, 0.18], [T.glow, 90, 1.6, 0xffc070, 0.3],
    ]) lf.addElement(new LensflareElement(t, s * px, d, col(c, k * FLARE_I)));
    flareAt.add(lf);
  }

  // screen glare veil (one fullscreen additive quad, cheap fragment)
  const GU = {uPos: {value: new THREE.Vector2()}, uCol: {value: col(GLARE_COLOR)}, uAspect: {value: 1}, uI: {value: 0}, uFall: {value: GLARE_FALLOFF}, uStreak: {value: GLARE_STREAK}};
  const glare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: GU, vertexShader: GLARE_VS, fragmentShader: GLARE_FS, blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
  }));
  glare.frustumCulled = false; glare.renderOrder = 1e6; glare.visible = false; if (GLARE) root.add(glare);

  // occlusion: octree first (cheap), then opaque scene meshes; only while the sun is on screen
  const rc = new THREE.Raycaster(), ray = new THREE.Ray(), ndc = new THREE.Vector3();
  rc.far = FLARE_DIST;
  let occ = [], occT = 1e9, vis = 1, visT = 1, n = 0;
  const rebuild = () => { occ = []; scene.traverse(o => {
    if (!o.isMesh || o.parent === root || o.isLensflare || !o.visible) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.transparent || m.depthWrite === false || (o.isInstancedMesh && o.count > OCC_MAX_INST)) return;
    occ.push(o);
  }); };

  // optional bloom (lazy-loaded so the default path fetches nothing extra)
  let composer = null;
  if (BLOOM) Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'), import('three/addons/postprocessing/OutputPass.js'),
  ]).then(([{EffectComposer}, {RenderPass}, {UnrealBloomPass}, {OutputPass}]) => {
    const c = new EffectComposer(renderer), bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    const ss = bloom.setSize.bind(bloom); bloom.setSize = (w, h) => ss(w / 2, h / 2);   // half-res bloom chain
    c.addPass(new RenderPass(scene, camera)); c.addPass(bloom); c.addPass(new OutputPass());
    c.setSize(innerWidth, innerHeight); addEventListener('resize', () => c.setSize(innerWidth, innerHeight));
    composer = c;
  }).catch(e => window.log?.('error', {msg: 'sky bloom: ' + e.message}));

  return {
    sunDir,
    update(dt) {
      U.uTime.value += dt;
      dome.position.copy(camera.position);
      flareAt.position.copy(camera.position).addScaledVector(sunDir, FLARE_DIST);
      if (!GLARE) return;
      ndc.copy(flareAt.position).project(camera);
      const inFront = camera.getWorldDirection(ray.direction).dot(sunDir) > 0;
      const edge = Math.max(Math.abs(ndc.x), Math.abs(ndc.y)), onScreen = inFront && edge < 1 + GLARE_EDGE;
      if (onScreen && ++n % OCC_EVERY === 0) {
        if ((occT += dt * OCC_EVERY) > OCC_REBUILD) { rebuild(); occT = 0; }
        ray.origin.copy(camera.position); ray.direction.copy(sunDir);
        const h = octree?.rayIntersect(ray);
        rc.set(camera.position, sunDir);
        visT = h && h.distance < FLARE_DIST ? 0 : rc.intersectObjects(occ, false).length ? 0 : 1;
      }
      vis += (visT - vis) * (1 - Math.exp(-OCC_FADE * dt));
      const s = onScreen ? vis * (1 - THREE.MathUtils.smoothstep(edge, 0.85, 1 + GLARE_EDGE)) : 0;
      glare.visible = s > 0.003;
      GU.uI.value = s * GLARE_I; GU.uPos.value.set(ndc.x, ndc.y); GU.uAspect.value = camera.aspect;
    },
    render() { if (composer) composer.render(); else renderer.render(scene, camera); },
  };
}
