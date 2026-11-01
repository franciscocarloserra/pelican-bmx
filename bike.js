// Procedural BMX (merged per material) + pelican rider. Local frame: ground contact at y=0, front = -z, right = +x.
// Riding: static pose + two-bone IK (hands -> grips, ankles -> pedals). Crash: verlet bike + rider ragdoll.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeBody, stepBody } from './ragdoll.js';

export const WHEEL_R = 0.3;
const RIDER_GLB = 'data/pelican.glb', RIDER_SCALE = 1, HIP = [0, 0.82, 0.12], LEAN = 0.45;   // hip spot on the bike, forward lean (rad)
const BB = [0, 0.25, 0.08], CRANK = 0.17, PEDAL_X = 0.13, GEAR = 2.5;                           // crank turns wheel/GEAR
const GRIP = [0.27, 0.9, -0.38], ANKLE_UP = [0, 0.07, 0.03];
const KNEE_POLE = [0.2, 0.9, 0.6], ELBOW_POLE = [0.6, 1.1, 0.3];
const TOE_DOWN = 0.3, KICK = 3;   // toe pitch (rad); rider's extra upward speed when thrown (m/s)
const FLING_SPIN = 5, FLING_JITTER = 3, BIKE_SPIN = 4;      // crash tumble (rad/s at 10 m/s), per-joint flail (m/s); scaled by P.violence
const IMPACT_MIN = 3, TRICK_K = 12;                          // joint hit speed that bleeds (m/s); trick pose blend rate (1/s)
const STRAIGHT = 0.85, SPLAY_ARMS = 0.8, SPLAY_LEGS = 0.65, SPRAWL_V = 4;  // limp sprawl: min limb extension, min hand-hand / foot-foot spread (fraction of max), limbs flung out (m/s)
const SUPERMAN_FOOT = [0.12, 0.9, 0.85], WHIP_SPREAD = 0.25;  // feet target during the grab; feet out sideways during a tailwhip (m)
// air trick poses (bike space, x = right side): hands up (no-hander/cliffhanger/barspin), can-can left foot over to the right, cliffhanger feet on the bars
const HANDS_UP = [0.5, 1.35, 0.05], CANCAN_FOOT = [0.28, 0.55, -0.1], CLIFF_FOOT = [0.14, 0.95, -0.32], BAR_HOLD = {turndown: 2.3, xup: Math.PI};
// crash bike points (bike space, radius): axles, bar, seat, bar ends
const BIKE_PTS = [[0, 0.3, 0.5, 0.3], [0, 0.3, -0.5, 0.3], [0, 0.9, -0.4, 0.08], [0, 0.72, 0.25, 0.08], [-0.3, 0.9, -0.38, 0.04], [0.3, 0.9, -0.38, 0.04]];
// rider joints (bone, radius) and links: tree + torso bracing
const JOINTS = [['Hips', 0.15], ['Spine2', 0.15], ['Head', 0.12], ['LeftArm', 0.06], ['LeftForeArm', 0.05], ['LeftHand', 0.05], ['RightArm', 0.06], ['RightForeArm', 0.05], ['RightHand', 0.05],
  ['LeftUpLeg', 0.08], ['LeftLeg', 0.06], ['LeftFoot', 0.06], ['RightUpLeg', 0.08], ['RightLeg', 0.06], ['RightFoot', 0.06]];
const LINKS = [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [1, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [0, 12], [12, 13], [13, 14],
  [3, 6], [9, 12], [3, 0], [6, 0], [9, 1], [12, 1], [3, 12], [6, 9], [2, 3], [2, 6]];
const LIMBS = [[3, 4], [4, 5], [6, 7], [7, 8], [9, 10], [10, 11], [12, 13], [13, 14]];   // bone i aimed at joint j

const V = (...a) => new THREE.Vector3(...a);
let crashed = false, crankA = 0, chains = [], model, modelPos, modelQ, rider, bones = [], neck, bikeBody, riderBody;
const qRel = new THREE.Quaternion();
const rest = new Map();
let g, crank, whipG, barG, grabB = 0, whipB = 0, handsB = 0, canB = 0, cliffB = 0, barA = 0;
const HEAD = [0, 0.62, -0.38], WHIP_AXIS = V(0, 0.32, 0.12).normalize();

// ---- bike look: glossy clearcoat black + chrome + anodized red; env map is bike-only (scene.environment untouched) ----
const FRAME_COL = 0x050505, FRAME_ROUGH = 0.16, CLEARCOAT = 1, CLEARCOAT_ROUGH = 0.04, ENV_I = 1.2;   // frame paint
const CHROME_ROUGH = 0.12, ANOD_COL = 0xc8102e, RUBBER_COL = 0x161616;                                 // accents, tires/grips/seat
const SPOKES = 36, KNOBS = 44, TIRE_TUBE = 0.032, RIM_R = 0.232, SPOKE_R = 0.0016;                      // wheel detail
const TAU = Math.PI * 2, XA = V(1, 0, 0), UP = V(0, 1, 0), _M4 = new THREE.Matrix4(), ONE = V(1, 1, 1);
let ENV = null;
function envTex() {   // procedural studio equirect canvas, built once; three PMREMs it once on first use (WebGLCubeUVMaps -> PMREMGenerator)
  if (ENV) return ENV;
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; const x = c.getContext('2d');
  const gr = x.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#f4f7ff'); gr.addColorStop(0.45, '#9aa6b8'); gr.addColorStop(0.52, '#4a4844'); gr.addColorStop(1, '#141210');
  x.fillStyle = gr; x.fillRect(0, 0, 512, 256); x.fillStyle = '#fff'; x.filter = 'blur(3px)';
  for (const [u, v, w, h] of [[40, 30, 90, 22], [230, 18, 60, 60], [380, 40, 110, 16], [150, 90, 20, 30], [450, 95, 30, 20]]) x.fillRect(u, v, w, h);
  ENV = new THREE.CanvasTexture(c); ENV.mapping = THREE.EquirectangularReflectionMapping; ENV.colorSpace = THREE.SRGBColorSpace; return ENV;
}
const qx = a => new THREE.Quaternion().setFromAxisAngle(XA, a);
const xf = (geo, pos, q = new THREE.Quaternion(), s = ONE) => geo.applyMatrix4(_M4.compose(pos, q, s));
const tubeG = (a, b, r, seg = 12, r2 = r) => { const A = V(...a), B = V(...b), d = B.clone().sub(A), L = d.length();
  return xf(new THREE.CylinderGeometry(r2, r, L, seg), A.add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, d.divideScalar(L))); };
const boxG = (w, h, d, p, q) => xf(new THREE.BoxGeometry(w, h, d), p, q);
const ringG = (x, r, t, seg = 32) => new THREE.TorusGeometry(r, t, 6, seg).rotateY(Math.PI / 2).translate(x, 0, 0);
const teethG = (x, r, n, w = 0.004) => Array.from({length: n}, (_, i) => { const a = i / n * TAU; return boxG(w, 0.01, 0.007, V(x, r * Math.cos(a), r * Math.sin(a)), qx(a)); });
const mesh = (geos, mat, parent) => { const o = new THREE.Mesh(mergeGeometries(geos), mat); geos.forEach(q => q.dispose()); parent.add(o); return o; };
const mirror = f => [-1, 1].flatMap(f);

function wheelMesh(w, rear, M) {   // 2 draws per wheel: rubber (tire + tread) and chrome (rims, hub, spokes, cog)
  const tire = [new THREE.TorusGeometry(WHEEL_R - TIRE_TUBE - 0.006, TIRE_TUBE, 10, 48).rotateY(Math.PI / 2)];
  for (let i = 0; i < KNOBS; i++) { const a = i / KNOBS * TAU, q = qx(a), c = Math.cos(a), s = Math.sin(a);
    if (i % 2) tire.push(boxG(0.018, 0.012, 0.024, V(0, 0.297 * c, 0.297 * s), q));
    else for (const sx of [-1, 1]) tire.push(boxG(0.014, 0.012, 0.02, V(sx * 0.017, 0.291 * c, 0.291 * s), q)); }
  const ch = [ringG(-0.011, RIM_R + 0.01, 0.012, 48), ringG(0.011, RIM_R + 0.01, 0.012, 48), tubeG([-0.065, 0, 0], [0.065, 0, 0], 0.018, 12),
    ...mirror(sx => [tubeG([sx * 0.032, 0, 0], [sx * 0.038, 0, 0], 0.032, 16)])];
  for (let i = 0; i < SPOKES; i++) { const sx = i % 2 ? 1 : -1, a = i / SPOKES * TAU, h = a + (i % 4 < 2 ? 0.55 : -0.55);
    ch.push(tubeG([sx * 0.035, 0.028 * Math.cos(h), 0.028 * Math.sin(h)], [sx * 0.006, RIM_R * Math.cos(a), RIM_R * Math.sin(a)], SPOKE_R, 3)); }
  if (rear) ch.push(ringG(0.05, 0.03, 0.004, 20), ...teethG(0.05, 0.036, 12));
  mesh(tire, M.rubber, w); mesh(ch, M.chrome, w);
}

export function buildBike() {
  g = new THREE.Group();
  const env = envTex(), std = o => new THREE.MeshStandardMaterial({envMap: env, envMapIntensity: ENV_I, ...o});
  const M = {
    frame: new THREE.MeshPhysicalMaterial({color: FRAME_COL, metalness: 0.2, roughness: FRAME_ROUGH, clearcoat: CLEARCOAT, clearcoatRoughness: CLEARCOAT_ROUGH, envMap: env, envMapIntensity: ENV_I}),
    chrome: std({color: 0xe8e8ec, metalness: 1, roughness: CHROME_ROUGH}),
    anod: std({color: ANOD_COL, metalness: 0.9, roughness: 0.25}),
    rubber: std({color: RUBBER_COL, metalness: 0, roughness: 0.8, envMapIntensity: 0.4}),
  };
  // tailwhip: rear half (frame, crank, rear wheel) hangs from whipG, which spins about the head tube
  whipG = new THREE.Group(); whipG.position.set(...HEAD); g.add(whipG);
  const back = new THREE.Group(); back.position.set(-HEAD[0], -HEAD[1], -HEAD[2]); whipG.add(back);
  const wheels = [0.5, -0.5].map(z => {
    const w = new THREE.Group(); w.position.set(0, WHEEL_R, z); (z > 0 ? back : g).add(w);
    wheelMesh(w, z > 0, M); return w;
  });
  // rear frame (back): steering axis through HEAD at ~74 deg
  const HT = [0, 0.687, -0.361], HB = [0, 0.543, -0.402], ST = [0, 0.64, 0.22], R = 0.3, RZ = 0.5;
  mesh([
    tubeG(HB, HT, 0.026, 16), tubeG(BB, [0, 0.565, -0.395], 0.026, 14), tubeG(BB, ST, 0.022, 14), tubeG([0, 0.625, 0.215], [0, 0.67, -0.365], 0.022, 14),
    tubeG([0, 0.6, -0.33], [0, 0.535, -0.34], 0.012, 8),                                                      // head gusset
    tubeG([-0.042, BB[1], BB[2]], [0.042, BB[1], BB[2]], 0.03, 16),                                           // BB shell
    ...mirror(sx => [tubeG([sx * 0.035, BB[1], BB[2] + 0.02], [sx * 0.07, R, RZ], 0.014, 8, 0.011),         // chainstays
      tubeG([sx * 0.03, 0.615, 0.212], [sx * 0.07, R + 0.01, RZ], 0.012, 8, 0.01),                           // seatstays
      boxG(0.008, 0.05, 0.06, V(sx * 0.07, R, RZ))]),                                                         // dropouts
    tubeG([-0.04, 0.5, 0.315], [0.04, 0.5, 0.315], 0.008, 6), tubeG([-0.04, 0.27, 0.25], [0.04, 0.27, 0.25], 0.008, 6),   // bridges
    ...mirror(sx => [tubeG([0.05, BB[1] + sx * 0.085, BB[2]], [0.05, R + sx * 0.034, RZ], 0.004, 4)]),       // chain
  ], M.frame, back);
  mesh([
    tubeG(ST, [0, 0.695, 0.24], 0.016, 12), tubeG([0, 0.625, 0.215], [0, 0.645, 0.222], 0.025, 12),          // seatpost, clamp
    tubeG([0, 0.687, -0.361], [0, 0.7, -0.357], 0.03, 16), tubeG([0, 0.53, -0.405], [0, 0.543, -0.402], 0.03, 16),   // headset cups
    ...mirror(sx => [tubeG([sx * 0.075, R, RZ], [sx * 0.19, R, RZ], 0.019, 16)]),                            // rear pegs
  ], M.chrome, back);
  const seat = (p, s) => xf(new THREE.SphereGeometry(1, 18, 10), V(...p), undefined, V(...s));
  mesh([seat([0, 0.722, 0.275], [0.075, 0.03, 0.085]), seat([0, 0.718, 0.2], [0.04, 0.026, 0.09])], M.rubber, back);
  // front end (g): fork, stem, two-piece bars, grips, front pegs
  const FZ = -0.5;
  mesh([...mirror(sx => [tubeG([sx * 0.052, 0.53, -0.408], [sx * 0.055, R, FZ], 0.017, 10, 0.012), boxG(0.008, 0.045, 0.04, V(sx * 0.058, R, FZ))]),
    boxG(0.15, 0.026, 0.045, V(0, 0.525, -0.408))], M.frame, g);
  const BY = 0.735, BZ = -0.4, GY = GRIP[1], GZ = GRIP[2], BR = 0.011;
  // bars spin about the steering axis through HEAD (barspin / turndown / x-up): stem, bars and grips hang from barG
  barG = new THREE.Group(); barG.position.set(...HEAD); g.add(barG);
  const bars = new THREE.Group(); bars.position.set(-HEAD[0], -HEAD[1], -HEAD[2]); barG.add(bars);
  mesh(mirror(sx => [tubeG([sx * 0.075, R, FZ], [sx * 0.19, R, FZ], 0.019, 16)]), M.chrome, g);   // front pegs (stay on the axle)
  mesh([tubeG([0, 0.7, -0.357], [0, 0.75, -0.344], 0.016, 10),                                              // steerer
    tubeG([-0.09, BY, BZ], [0.09, BY, BZ], BR), tubeG([-0.16, 0.84, -0.387], [0.16, 0.84, -0.387], BR - 0.002),
    ...mirror(sx => [tubeG([sx * 0.09, BY, BZ], [sx * 0.2, GY, GZ], BR), tubeG([sx * 0.2, GY, GZ], [sx * 0.34, GY, GZ], BR),
      xf(new THREE.SphereGeometry(BR, 10, 6), V(sx * 0.09, BY, BZ)), xf(new THREE.SphereGeometry(BR, 10, 6), V(sx * 0.2, GY, GZ)),
      tubeG([sx * 0.335, GY, GZ], [sx * 0.345, GY, GZ], 0.02, 14)]),
  ], M.chrome, bars);
  mesh([boxG(0.05, 0.045, 0.075, V(0, 0.735, -0.372)), boxG(0.06, 0.03, 0.03, V(0, BY, BZ))], M.anod, bars);   // stem + bar clamp
  mesh(mirror(sx => [tubeG([sx * 0.205, GY, GZ], [sx * 0.335, GY, GZ], 0.019, 14), tubeG([sx * 0.2, GY, GZ], [sx * 0.207, GY, GZ], 0.027, 14)]), M.rubber, bars);
  // crank: arms along local ∓y at x=∓PEDAL_X, spun about x; sprocket on the right
  crank = new THREE.Group(); crank.position.set(...BB); back.add(crank);
  const PX = PEDAL_X + 0.04, pins = [];
  for (const sx of [-1, 1]) for (const dy of [-1, 1]) for (const ex of [-0.035, 0.035]) for (const ez of [-0.038, 0.038])
    pins.push(tubeG([sx * PX + ex, sx * CRANK + dy * 0.009, ez], [sx * PX + ex, sx * CRANK + dy * 0.015, ez], 0.003, 4));
  mesh([tubeG([-PEDAL_X - 0.01, 0, 0], [PEDAL_X + 0.01, 0, 0], 0.012, 10), ...pins,
    ...mirror(sx => [tubeG([sx * PEDAL_X, 0, 0], [sx * PEDAL_X, sx * CRANK, 0], 0.017, 10, 0.012),
      tubeG([sx * (PEDAL_X - 0.012), 0, 0], [sx * (PEDAL_X + 0.012), 0, 0], 0.022, 12),
      tubeG([sx * (PEDAL_X - 0.01), sx * CRANK, 0], [sx * (PEDAL_X + 0.012), sx * CRANK, 0], 0.016, 12)]),
  ], M.chrome, crank);
  mesh([ringG(0.05, 0.075, 0.007, 36), ...teethG(0.05, 0.085, 28), tubeG([0.046, 0, 0], [0.054, 0, 0], 0.026, 16),
    ...Array.from({length: 5}, (_, i) => { const a = i / 5 * TAU; return boxG(0.006, 0.055, 0.014, V(0.05, 0.048 * Math.cos(a), 0.048 * Math.sin(a)), qx(a)); })], M.anod, crank);
  mesh(mirror(sx => [boxG(0.08, 0.018, 0.09, V(sx * PX, sx * CRANK, 0))]), M.rubber, crank);

  rider = new THREE.Group(); g.add(rider);   // rider.position.y = crouch (IK keeps hands/feet on the bike)
  const loaded = () => { const l = document.getElementById('loading'); if (!l) return; l.classList.add('ready'); const t = l.querySelector(':scope > div'); if (t) t.textContent = 'click to send it'; };
  new GLTFLoader().load(RIDER_GLB, gl => {
    loaded();
    const o = gl.scene; o.scale.setScalar(RIDER_SCALE); o.rotation.y = Math.PI;
    const bone = n => o.getObjectByName('mixamorig' + n) || o.getObjectByName('mixamorig:' + n);
    // place hips on the bike and lean the spine, in rider space (o not parented yet)
    o.updateMatrixWorld(true);
    const hp = bone('Hips').getWorldPosition(V());
    o.position.add(V(...HIP).sub(hp)); o.updateMatrixWorld(true);
    const sp = bone('Spine'), wq = sp.getWorldQuaternion(new THREE.Quaternion()), pq = sp.parent.getWorldQuaternion(new THREE.Quaternion());
    sp.quaternion.copy(pq.invert().multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -LEAN).multiply(wq)));
    o.traverse(b => { if (b.isBone) rest.set(b, [b.position.clone(), b.quaternion.clone()]); });
    o.traverse(b => { if (b.isMesh) b.frustumCulled = false; });   // skinned bounds stay at the bind pose: ragdolled rider got culled
    rider.add(o); model = o; modelPos = o.position.clone(); modelQ = o.quaternion.clone();
    const side = (S, sx) => [
      {a: bone(S + 'Arm'), b: bone(S + 'ForeArm'), c: bone(S + 'Hand'), t: () => gripAt(sx, _tt).lerp(_sf.set(sx * HANDS_UP[0], HANDS_UP[1], HANDS_UP[2]), handsB), p: V(sx * ELBOW_POLE[0], ELBOW_POLE[1], ELBOW_POLE[2])},
      {a: bone(S + 'UpLeg'), b: bone(S + 'Leg'), c: bone(S + 'Foot'), t: () => {
        const t = pedal(sx, _tt).add(ANKLE_V).lerp(_sf.set(sx * SUPERMAN_FOOT[0], SUPERMAN_FOOT[1], SUPERMAN_FOOT[2]), grabB); t.x += sx * WHIP_SPREAD * whipB;
        if (sx < 0) t.lerp(_sf.set(...CANCAN_FOOT), canB);
        return t.lerp(_sf.set(sx * CLIFF_FOOT[0], CLIFF_FOOT[1], CLIFF_FOOT[2]), cliffB); }, p: V(sx * KNEE_POLE[0], KNEE_POLE[1], KNEE_POLE[2]), toe: bone(S + 'ToeBase')},
    ];
    chains = [...side('Left', -1), ...side('Right', 1)];
    if (chains.some(c => !c.a || !c.b || !c.c)) log('error', {msg: 'rider: missing IK bones'});
    bones = JOINTS.map(([n]) => bone(n)); neck = bone('Neck'); spine1 = bone('Spine1'); shoulders = [bone('LeftShoulder'), bone('RightShoulder')];
    if (bones.some(b => !b)) log('error', {msg: 'rider: missing ragdoll bones'});
    log('rider', {anims: gl.animations.map(c => c.name)});
  }, undefined, e => { loaded(); log('error', {msg: 'glb: ' + e.message}); });
  return {group: g, wheels, rider};
}

// grip position in bike space with the bars turned by barA
const gripAt = (sx, o = V()) => o.set(sx * GRIP[0], GRIP[1], GRIP[2]).sub(_hd.set(...HEAD)).applyAxisAngle(WHIP_AXIS, barA).add(_hd);
const _hd = V();
// pedal position in bike space for side sx (-1 left, +1 right), matching the crank mesh
const _tt = V(), _pp = V(), _sf = V(), ANKLE_V = V(...ANKLE_UP), _ds = V(), _dv = V();   // per-frame scratch
const pedal = (sx, o = V()) => o.set(sx * PEDAL_X, BB[1] + sx * CRANK * Math.cos(crankA), BB[2] + sx * CRANK * Math.sin(crankA));

// ---- two-bone IK in world space ----
const _a = V(), _b = V(), _c = V(), _d = V(), _p = V(), _e = V(), _f = V(), _t = V(), _q = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion();
function aim(bone, from, to) {   // rotate bone so world direction `from` turns into `to`
  if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12 || !Number.isFinite(to.x + to.y + to.z)) return;   // degenerate: keep pose (NaN would hide the mesh)
  _q.setFromUnitVectors(from.normalize(), to.normalize());
  bone.matrixWorld.decompose(_dv, _wq, _ds); bone.parent.matrixWorld.decompose(_dv, _pq, _ds);
  bone.quaternion.copy(_pq.invert().multiply(_q.multiply(_wq)));
  bone.updateMatrixWorld(true);
}
function twoBone({a, b, c}, T, P) {
  _a.setFromMatrixPosition(a.matrixWorld); _b.setFromMatrixPosition(b.matrixWorld); _c.setFromMatrixPosition(c.matrixWorld);
  const l1 = _a.distanceTo(_b), l2 = _b.distanceTo(_c);
  _d.subVectors(T, _a); const d = Math.min(Math.max(_d.length(), 1e-3), (l1 + l2) * 0.999); _d.normalize();
  const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))), sinA = Math.sqrt(1 - cosA * cosA);
  _p.subVectors(P, _a).addScaledVector(_d, -_p.subVectors(P, _a).dot(_d)).normalize();
  _e.copy(_a).addScaledVector(_d, l1 * cosA).addScaledVector(_p, l1 * sinA);
  aim(a, _f.subVectors(_b, _a), _t.subVectors(_e, _a));
  _b.setFromMatrixPosition(b.matrixWorld); _c.setFromMatrixPosition(c.matrixWorld);
  aim(b, _f.subVectors(_c, _b), _t.subVectors(T, _b));
}

// wheelSpin: wheel rotation this frame (rad); S = physics state; onImpact(point, normal, speed) when a ragdoll joint hits hard.
// Call after the bike group transform is set.
const _x = V(), _y = V(), _z = V(), _m = new THREE.Matrix4(), _lq = new THREE.Quaternion(), FWD = V(0, 0, -1);
export const crashBody = () => crashed ? riderBody : null;   // rider ragdoll while crashed (pts, dt0)
export const riderRig = () => model && !bones.some(b => !b) ? {model, bones, body: crashed ? riderBody : null} : null;   // gore.js
export function animate(dt, wheelSpin, S, P, onImpact) {
  const gravity = P.gravity;
  crankA += wheelSpin / GEAR; crank.rotation.x = crankA;
  const isCrashed = S.crashed > 0;
  if (isCrashed !== crashed) {
    crashed = isCrashed;
    if (crashed) startCrash(S, P.violence);
    else if (model) {                       // back on the bike: rest pose
      rider.add(model); model.position.copy(modelPos); model.quaternion.copy(modelQ);
      for (const [b, [p, q]] of rest) { b.position.copy(p); b.quaternion.copy(q); }
    }
  }
  if (crashed) {
    stepBody(bikeBody, dt, gravity); poseBike();
    if (riderBody) {
      stepBody(riderBody, dt, gravity); poseRider(); S.body.pos.copy(riderBody.pts[0].p);
      for (const q of riderBody.pts) { if (q.impact > IMPACT_MIN) onImpact(q.p, q.n, q.impact); q.impact = 0; }
    }
    else S.body.pos.copy(bikeBody.pts[0].p);
    return;
  }
  const kb = 1 - Math.exp(-TRICK_K * dt), pose = S.pose || '';
  const blend = (cur, on) => cur + ((on ? 1 : 0) - cur) * kb;
  grabB = blend(grabB, pose === 'superman'); whipB = blend(whipB, S.whip); canB = blend(canB, pose === 'cancan'); cliffB = blend(cliffB, pose === 'cliff');
  handsB = blend(handsB, pose === 'nohander' || pose === 'cliff' || S.bar > 0.3 && S.bar < 2 * Math.PI - 0.3);
  whipG.quaternion.setFromAxisAngle(WHIP_AXIS, S.whip);
  barA = S.bar ? S.bar : barA + ((BAR_HOLD[pose] || 0) - barA) * kb;   // spin: exact angle; holds: ease to the held angle and back
  barG.quaternion.setFromAxisAngle(WHIP_AXIS, barA);
  if (!model) return;
  for (const ch of chains) { ch.a.quaternion.copy(rest.get(ch.a)[1]); ch.b.quaternion.copy(rest.get(ch.b)[1]); ch.c.quaternion.copy(rest.get(ch.c)[1]); }
  upperBody(dt, wheelSpin, S);
  g.updateWorldMatrix(true, false); rider.updateWorldMatrix(false, true);   // only the rider subtree feeds IK

  for (const ch of chains) {
    twoBone(ch, g.localToWorld(ch.t()), g.localToWorld(_pp.copy(ch.p)));
    if (ch.toe && grabB < 0.3) {                           // foot flat-ish on the pedal, toes forward
      _a.setFromMatrixPosition(ch.c.matrixWorld); _b.setFromMatrixPosition(ch.toe.matrixWorld);
      _t.copy(FWD).applyAxisAngle(_x.set(1, 0, 0), -TOE_DOWN).transformDirection(g.matrixWorld);
      aim(ch.c, _f.subVectors(_b, _a), _t);
    }
  }
}

// ---- procedural upper body (idle + pedalling): additive on the rest pose before IK, so arms/legs follow via IK ----
const BREATH_HZ = 0.25, BREATH = 0.012, LOOK_YAW = 0.3, LOOK_PITCH = 0.08, LOOK_K = 60, LOOK_EVERY = [0.8, 3];  // rad, spring 1/s^2, s between saccades
const SHIFT = 0.03, SHIFT_K = 6, SHIFT_EVERY = [3, 7];                                                         // idle weight shift (rad, 1/s^2, s)
const PED_W = 15, ROCK = 0.06, TWIST = 0.04, SHOULDER = 0.05, BOB = 0.03, BOB_K = 40;                           // wheel rad/s = full pedalling; crank-synced amplitudes (rad)
const spr = () => ({x: 0, v: 0, t: 0}), sYaw = spr(), sPitch = spr(), sShift = spr(), sBob = spr();
const rnd = ([a, b]) => a + Math.random() * (b - a), _eu = new THREE.Euler(), _aq = new THREE.Quaternion();
let tA = 0, lookT = 0, shiftT = 0, ped = 0, spine1, shoulders = [];
function spring(s, k, dt) { const h = Math.min(dt, 0.033); s.v += (k * (s.t - s.x) - 2 * Math.sqrt(k) * s.v) * h; s.x += s.v * h; return s.x; }   // critically damped
function addRot(b, x, y, z) { if (b) b.quaternion.copy(rest.get(b)[1]).multiply(_aq.setFromEuler(_eu.set(x, y, z))); }
function upperBody(dt, wheelSpin, S) {
  tA += dt;
  ped += ((S.grounded && dt > 0 ? Math.min(1, Math.abs(wheelSpin / dt) / PED_W) : 0) - ped) * (1 - Math.exp(-4 * dt));
  const idle = 1 - ped, calm = 1 - Math.max(grabB, whipB);
  if ((lookT -= dt) < 0) { lookT = rnd(LOOK_EVERY); sYaw.t = (Math.random() * 2 - 1) * LOOK_YAW * (0.3 + 0.7 * idle); sPitch.t = (Math.random() * 2 - 1) * LOOK_PITCH; }
  if ((shiftT -= dt) < 0) { shiftT = rnd(SHIFT_EVERY); sShift.t = (Math.random() * 2 - 1) * SHIFT; }
  const c = Math.sin(crankA), br = Math.sin(tA * TAU * BREATH_HZ) * BREATH;
  sBob.t = Math.cos(2 * crankA) * BOB * ped * calm;                       // spring gives the head its lag
  const yaw = spring(sYaw, LOOK_K, dt), pitch = spring(sPitch, LOOK_K, dt), shift = spring(sShift, SHIFT_K, dt) * idle, bob = spring(sBob, BOB_K, dt);
  const rock = c * ROCK * ped * calm, tw = c * TWIST * ped * calm;
  addRot(spine1, br, tw * 0.5, rock * 0.5 + shift);
  addRot(bones[1], br * 0.6, tw * 0.5, rock * 0.5 + shift * 0.5);
  addRot(neck, -br, yaw * 0.4 - tw * 0.5, -rock * 0.6 - shift);           // keep the gaze steadier than the torso
  addRot(bones[2], pitch + bob, yaw * 0.6, -rock * 0.3);
  for (let i = 0; i < 2; i++) addRot(shoulders[i], 0, 0, (i ? -1 : 1) * (br * 0.8 + c * SHOULDER * ped * calm));   // alternate pull on the bars
}

// ---- crash: both bodies keep their momentum, then tumble on their own ----
function torsoQ(p, out) {                   // frame from hips->chest (y) and left->right hip (x)
  _y.subVectors(p[1].p, p[0].p).normalize(); _x.subVectors(p[12].p, p[9].p); _x.addScaledVector(_y, -_x.dot(_y)).normalize();
  _z.crossVectors(_x, _y); return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}
function fling(b, spin, jitter) {           // random tumble about the first point + per-point flail
  const w = V().randomDirection().multiplyScalar(spin), c = b.pts[0].p;
  for (const q of b.pts) q.prev.addScaledVector(V().crossVectors(w, V().subVectors(q.p, c)).addScaledVector(V().randomDirection(), jitter * Math.random()), -b.dt0);
}
function startCrash(S, vio) {
  whipG.quaternion.identity(); grabB = whipB = 0;
  g.updateMatrixWorld(true);
  const sp = 0.4 + S.vel.length() / 10;
  bikeBody = makeBody(BIKE_PTS.map(([x, y, z, r]) => ({p: g.localToWorld(V(x, y, z)), r})), S.vel,
    BIKE_PTS.flatMap((_, i) => BIKE_PTS.map((_, j) => [i, j]).slice(i + 1)));
  fling(bikeBody, BIKE_SPIN * vio * sp, 0);
  riderBody = null;
  if (!model || bones.some(b => !b)) return;
  model.updateMatrixWorld(true);
  riderBody = makeBody(JOINTS.map(([, r], i) => ({p: bones[i].getWorldPosition(V()), r})), V().copy(S.vel).add(V(0, KICK * vio, 0)), LINKS);
  fling(riderBody, FLING_SPIN * vio * sp, FLING_JITTER * vio);
  const P_ = riderBody.pts, dd = (i, j) => P_[i].p.distanceTo(P_[j].p), arm = dd(3, 4) + dd(4, 5), leg = dd(9, 10) + dd(10, 11);
  riderBody.links.push([3, 5, arm * STRAIGHT, 1], [6, 8, arm * STRAIGHT, 1], [9, 11, leg * STRAIGHT, 1], [12, 14, leg * STRAIGHT, 1],
    [5, 8, (2 * arm + dd(3, 6)) * SPLAY_ARMS, 1], [11, 14, (2 * leg + dd(9, 12)) * SPLAY_LEGS, 1]);
  for (const i of [5, 8, 11, 14]) P_[i].prev.addScaledVector(V().subVectors(P_[i].p, P_[0].p).normalize(), -SPRAWL_V * vio * riderBody.dt0);
  g.parent.attach(model);                   // keeps world transform; bones are driven from here on
  qRel.copy(torsoQ(riderBody.pts, _lq).invert()).multiply(bones[0].getWorldQuaternion(_wq));
}
function poseBike() {
  const p = bikeBody.pts;
  _c.addVectors(p[0].p, p[1].p).multiplyScalar(0.5);
  _z.subVectors(p[0].p, p[1].p).normalize();
  _y.addVectors(p[4].p, p[5].p).multiplyScalar(0.5).sub(_c); _y.addScaledVector(_z, -_y.dot(_z)).normalize();
  _x.crossVectors(_y, _z);
  g.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  g.position.copy(_c).addScaledVector(_y, -BIKE_PTS[0][1]);
}
function poseRider() {
  const p = riderBody.pts, hips = bones[0];
  if (!p.every(q => Number.isFinite(q.p.x + q.p.y + q.p.z))) { log('error', {msg: 'ragdoll NaN'}); return; }
  hips.parent.updateMatrixWorld(true);
  hips.quaternion.copy(hips.parent.getWorldQuaternion(_pq).invert().multiply(torsoQ(p, _lq).multiply(qRel)));
  hips.position.copy(hips.parent.worldToLocal(_a.copy(p[0].p)));
  hips.updateMatrixWorld(true);
  neck.getWorldPosition(_a); bones[2].getWorldPosition(_b); aim(neck, _f.subVectors(_b, _a), _t.subVectors(p[2].p, p[1].p));
  for (const [i, j] of LIMBS) { bones[i].getWorldPosition(_a); bones[j].getWorldPosition(_b); aim(bones[i], _f.subVectors(_b, _a), _t.subVectors(p[j].p, p[i].p)); }
}
