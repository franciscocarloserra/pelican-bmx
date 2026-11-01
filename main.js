// Wiring: renderer, chase camera, input, loop, HUD.
import * as THREE from 'three';
import { P, buildPanel, save } from './params.js';
import { buildLevel } from './level.js';
import { buildCity } from './city.js';
import { buildBike, animate, crashBody, WHEEL_R } from './bike.js';
import { S, R, BODY_R, init, step, respawn, GRINDS, floorClamp, FLOOR_Y, crash } from './physics.js';
import * as LEVEL from './level.js';   // optional exports (grindables) without breaking if absent
import { createTricks } from './tricks.js';
import { createFx } from './fx.js';
import { createTrails } from './trails.js';   // DBZ trails / aura / afterimages / landing flash
import { hud } from './hud.js';   // HUD text + juice (shake, hit-stop, FOV kick, speed lines)
import { gore } from './gore.js';   // GLB dismemberment (oob/glitch/edge)
import { createSky } from './sky.js';   // sky dome, sun, lens flare; sets fog/hemi/sun colours + tone mapping
import { createRender } from './render.js';   // grade, vignette/tunnel, follow shadows, surface grain, pixel-ratio cap + dynamic res

const BAIL_HUD = false, BAIL_SOUND = true, RESCAN = false, CRASH_FEATHERS_MAX = 60;   // stall bisection: hud.bail callout DOM, bail sfx, render.js 2 s shadow-flag rescan; crash feather cap
const PROF = true, PROF_MS = 40;   // perf probe: per-subsystem ms -> 'frameprof' when a frame > PROF_MS, 'crashprof' on every crash frame
const pt = PROF ? () => performance.now() : () => 0, prof = {}, cprof = {}; let profT = 0, crashF = false, workMs = 0; const lastProf = {};
const lap = k => { if (PROF) { const t = performance.now(); prof[k] = (prof[k] || 0) + t - profT; profT = t; } };   // charge time since the last lap to k
const OOB_MARGIN = 0.8;   // m inside the PARK edge (wall/fence) that already counts as out of bounds
const SUBSTEPS = 6, MAX_DT = 0.05, KILL_Y = -30, SLOW_MS = 50, SHAKE_AMP = 0.25, SHAKE_K = 5, SHAKE_HIT = 0.04, CROUCH = 0.25;
// camera tunables (P.camDist/camH/camLock/camK/camFix/sens are sliders)
const CAM_IDLE = 0.8, CAM_PITCH0 = 0.15, CAM_PITCH_MIN = -0.3, CAM_PITCH_MAX = 1.3, CAM_MOUSE = 0.003;   // s mouse idle before recentering; rest/min/max pitch (rad); rad per px
const CAM_DIP = 0.18, CAM_DIP_CLEAN = 1.6, CAM_DIP_K = 90, CAM_DIP_C = 12;   // landing camera dip: m per s of air (x clean landing), spring stiffness/damping
const CAM_LOOK_H = 0.7, CAM_Y_K = 14, CAM_PAD = 0.3, CAM_MIN_D = 0.5, CAM_OUT_K = 5, CAM_RESET = 'KeyC';   // look height (m); vertical follow (1/s, eats landing/transition jitter); wall pad, min dist (m); ease back out after a wall pull-in (1/s)
const TABLE_ROLL = 1.2, POSE_K = 14, MAN_PITCH = 0.4, MAN_PITCH_BAL = 0.2, SPARK_RATE = 14;   // grind/manual pose blend (1/s); manual nose-up + balance swing (rad); sparks per m/s per s
const BLEED_HZ = 1.6, BLEED_TAU = 6, BLEED_RATE = 120, BLEED_V = 3, SMEAR_MIN = 0.8, POOL_V = 0.6;   // neck spurts (Hz, decay s, drops/s, m/s), slide speed that smears, body speed that pools (m/s)
const FEATHER_RATE = 0.5, FEATHER_AIR = 2, FEATHER_H = 0.45, FEATHER_CRASH = 220, FEATHER_PUFF = 3, FEATHER_HIT = 2;   // trail feathers/s per m/s, air multiplier, emit height (m); bail burst, burst spread (m/s), feathers per m/s of ragdoll hit
const MUSIC_VOL = 0.05;   // soundtrack volume (0..1)
const $ = id => document.getElementById(id);

const renderer = new THREE.WebGLRenderer({antialias: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c8); scene.fog = new THREE.Fog(0x9fb4c8, 60, 200);
const camera = new THREE.PerspectiveCamera(P.fov, innerWidth / innerHeight, 0.05, 500);
scene.add(new THREE.HemisphereLight(0xeef4ff, 0x556655, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(30, 50, 20); scene.add(sun);
const grid = new THREE.GridHelper(300, 150, 0, 0); grid.material.opacity = 0.1; grid.material.transparent = true; grid.position.y = 0.01; scene.add(grid);

const tricks = createTricks(P, save);
const octree = buildLevel(scene);
buildCity(scene, octree);
const sky = createSky({scene, renderer, camera, sun, octree});   // overrides the fog/background/light values above (constants in sky.js)
const fx = createFx(scene, octree, () => P.gravity);
gore.init(scene, fx);
let shake = 0, idle = 0;
init(octree, P, (type, d) => {   // last arg: grind edges getter (level.js `grindables`)
  const e0 = pt(); if (type === 'crash') { crashF = true; cprof.why = d; }
  if (type === 'crash') gore.onCrash(d);   // hard crashes tear limbs / split the rider
  if (type === 'crash' && P.gore > 0 && d !== 'out of bounds') { shake = 1; fx.splat(tmp.copy(S.pos).addScaledVector(S.up, 0.9), S.vel.clone().multiplyScalar(0.4), Math.round(40 * P.gore)); }
  if (type === 'crash' && d !== 'out of bounds') fx.feathers(tmp.copy(S.pos).addScaledVector(S.up, 0.9), S.vel.clone().multiplyScalar(0.3), Math.min(FEATHER_CRASH, CRASH_FEATHERS_MAX), FEATHER_PUFF);
  const e1 = pt(); tricks[type]?.(d); const e2 = pt();
  if (type === 'land' && !d.soft) dipV -= Math.min(1.2, d.airT) * CAM_DIP * (d.clean ? CAM_DIP_CLEAN : 1) * CAM_DIP_K / CAM_DIP_C;   // camera dips into the landing
  hud.event(type, d, S); const e3 = pt(); trails?.event(type, d, S);
  if (PROF && type === 'crash') Object.assign(cprof, {BAIL_HUD, BAIL_SOUND, RESCAN, fx: e1 - e0, tricks: e2 - e1, hud: e3 - e2, trails: pt() - e3});
}, () => LEVEL.grindables || []);
const onImpact = (p, n, sp) => {      // ragdoll joint hit: blood spray off the surface + pool, camera shake
  if (gore.hidesRider()) return;
  shake = Math.min(1, shake + sp * SHAKE_HIT);
  fx.feathers(p, tmp.copy(n).multiplyScalar(sp * 0.2), Math.min(4, Math.round(sp * FEATHER_HIT)), FEATHER_PUFF * 0.6);
  if (P.gore > 0) fx.splat(p, tmp.copy(n).multiplyScalar(sp * 0.3), Math.round(sp * 6 * P.gore), n, Math.min(0.8, 0.07 * sp) * P.gore);
};
let bleedT = 0;
const bv = new THREE.Vector3(), bp = new THREE.Vector3();
function bleed(dt, b) {   // pulsing spurts from the neck, smears where joints slide, pool under a still torso
  const p = b.pts, h = b.dt0;
  bleedT += dt;
  const pulse = Math.max(0, Math.sin(bleedT * BLEED_HZ * 6.283)) ** 2 * Math.exp(-bleedT / BLEED_TAU);
  const cnt = Math.floor(pulse * BLEED_RATE * P.gore * dt + Math.random());
  if (cnt && pulse > 0.05) fx.splat(p[2].p, bv.subVectors(p[2].p, p[1].p).normalize().multiplyScalar(BLEED_V * pulse).addScaledVector(p[2].v, 1 / h), cnt);
  for (const q of p) if (q.hit) {
    bv.copy(q.v).divideScalar(h).addScaledVector(q.n, -bv.dot(q.n));
    if (bv.length() > SMEAR_MIN) fx.smear(bp.copy(q.p).addScaledVector(q.n, -q.r), q.n, bv, dt, q.r * 1.2 * Math.min(1, P.gore));
  }
  const still = p[0].v.length() / h < POOL_V, torso = p[0].hit ? p[0] : p[1].hit ? p[1] : null;
  if (still && torso) fx.pool(bp.copy(torso.p).addScaledVector(torso.n, -torso.r), torso.n, dt * P.gore);
}
const bike = buildBike(); scene.add(bike.group);
const trails = createTrails(scene, bike.group, camera);
const render = createRender({scene, renderer, camera, sun, rider: bike.group}); render.auto = RESCAN; hud.bailHud = BAIL_HUD; hud.bailSound = BAIL_SOUND;
let warmed = false;   // one-shot after the GLB + gore pieces exist: shadow flags once, then precompile every program   // after level/city/bike so the first scan sees them (rescans every 2 s)

const apply = () => { camera.fov = P.fov; camera.updateProjectionMatrix(); };
apply();   // params panel removed (user): tune in params.js

// ---- input ----
const keys = new Set();
let mouseDX = 0, camYaw = 0, camPitch = CAM_PITCH0, camSnap = true;
addEventListener('keydown', e => { keys.add(e.code); if (e.code === 'KeyR') { respawn(true); camSnap = true; } if (e.code === CAM_RESET) camSnap = true; if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); });
addEventListener('keyup', e => keys.delete(e.code));
renderer.domElement.onclick = () => { renderer.domElement.requestPointerLock(); const m = $('music'); m.volume = MUSIC_VOL; if (m.paused) m.play().catch(e => log('error', {msg: 'music: ' + e.message})); };
document.addEventListener('pointerlockchange', () => { const on = !!document.pointerLockElement; $('panel').classList.toggle('hide', on); $('hint').classList.toggle('hide', on); if (!on) keys.clear(); });
addEventListener('mousemove', e => { if (!document.pointerLockElement) return;
  idle = 0; mouseDX += e.movementX * CAM_MOUSE * P.sens; camPitch = Math.max(CAM_PITCH_MIN, Math.min(CAM_PITCH_MAX, camPitch + e.movementY * CAM_MOUSE * P.sens)); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
const ARROWS = {KeyW: 'ArrowUp', KeyA: 'ArrowLeft', KeyS: 'ArrowDown', KeyD: 'ArrowRight'};   // arrows mirror WASD
const k = c => keys.has(c) || keys.has(ARROWS[c]) ? 1 : 0;

const tmp = new THREE.Vector3();
// ---- chase camera: always upright, heading locked behind the bike (air: behind the trajectory),
// mouse orbits and recenters after CAM_IDLE; look height smoothed; pulled in front of walls instantly
// and eased back out (no in/out flicker); CAM_RESET (or R) snaps it behind the rider.
const off = new THREE.Vector3(), look = new THREE.Vector3(), ray = new THREE.Ray();
let camHead = 0, lookY = 0, camD = 0, dip = 0, dipV = 0;
function updateCam(dt) {
  const at = S.crashed > 0 ? S.body.pos : S.pos, ride = S.grounded || S.grind;
  if (S.crashed <= 0) {
    if (ride) tmp.set(S.fwd.x, 0, S.fwd.z); else tmp.set(S.vel.x, 0, S.vel.z);
    if (tmp.lengthSq() > 0.09) {             // skip when nearly vertical (quarter wall) or stopped in the air
      const d = Math.atan2(-tmp.x, -tmp.z) - camHead;
      camHead += Math.atan2(Math.sin(d), Math.cos(d)) * (camSnap ? 1 : 1 - Math.exp(-(ride ? P.camLock : P.camK) * dt));
    }
  }
  camYaw += mouseDX; mouseDX = 0;
  if ((idle += dt) > CAM_IDLE) {           // mouse idle: swing back behind and to the default height
    const kf = 1 - Math.exp(-P.camFix * dt);
    camYaw -= Math.atan2(Math.sin(camYaw), Math.cos(camYaw)) * kf; camPitch += (CAM_PITCH0 - camPitch) * kf;
  }
  if (camSnap) { camYaw = 0; camPitch = CAM_PITCH0; lookY = at.y; camD = 0; }
  lookY += (at.y - lookY) * (1 - Math.exp(-CAM_Y_K * dt));
  dipV += (-CAM_DIP_K * dip - CAM_DIP_C * dipV) * dt; dip += dipV * dt;
  const h = camHead + camYaw, c = Math.cos(camPitch);
  look.set(at.x, lookY + CAM_LOOK_H, at.z);
  off.set(Math.sin(h) * c, Math.sin(camPitch), Math.cos(h) * c).multiplyScalar(P.camDist).add(tmp.set(0, P.camH - CAM_LOOK_H, 0));
  let dist = off.length();
  ray.set(look, off.divideScalar(dist));
  const hit = octree.rayIntersect(ray);
  if (hit && hit.distance < dist + CAM_PAD) dist = Math.max(CAM_MIN_D, hit.distance - CAM_PAD);
  camD = camSnap || dist < camD ? dist : camD + (dist - camD) * (1 - Math.exp(-CAM_OUT_K * dt));
  camSnap = false;
  camera.position.copy(look).addScaledVector(off, camD); camera.position.y += dip;
  camera.lookAt(look);
  if (shake > 0.01) { camera.position.addScaledVector(tmp.randomDirection(), shake * SHAKE_AMP * Math.random()); shake *= Math.exp(-SHAKE_K * dt); }
  camera.position.y = Math.max(camera.position.y, FLOOR_Y + 0.3);   // camera never under the floor
}

// grind / manual pose: yaw, pitch, roll about a wheel axle (rear peg, front peg or centre), blended
const pose = {yaw: 0, pitch: 0, roll: 0, pivot: 0};
function posePeg(dt) {
  const g = S.grind && GRINDS[S.grind.type], sd = S.grind ? S.grind.side : 0, kp = 1 - Math.exp(-POSE_K * dt);
  const tg = g ? {yaw: g.yaw * sd, pitch: g.pitch, roll: g.roll * sd + S.grind.bal * 0.25, pivot: g.pivot}   // + lean with the balance meter
    : S.manual ? {yaw: 0, pitch: MAN_PITCH + S.manual.bal * MAN_PITCH_BAL, roll: 0, pivot: 0.5} : {yaw: S.pose === 'tabletop' ? 0.25 : 0, pitch: 0, roll: S.pose === 'tabletop' ? TABLE_ROLL : S.pose === 'turndown' ? -0.35 : 0, pivot: 0};   // air: tabletop lays the bike flat
  for (const key in pose) pose[key] += (tg[key] - pose[key]) * kp;
  const b = bike.group;
  b.translateY(WHEEL_R); b.translateZ(pose.pivot);
  b.rotateY(pose.yaw); b.rotateX(pose.pitch); b.rotateZ(pose.roll);
  b.translateZ(-pose.pivot); b.translateY(-WHEEL_R);
}

// ---- loop ----
const basis = new THREE.Matrix4(), right = new THREE.Vector3(), back = new THREE.Vector3(), qCrash = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
const STAND_UP = 0.1, STAND_FWD = 0.08, STAND_K = 8, LEAN_K = 12;   // standing pose offsets (m), smoothing rates (1/s)
const LEAN_MIN_V = 1.5, LEAN_FULL_V = 4, CAD_MIN = 6, CAD_K = 6;   // lean fades to 0 below LEAN_MIN_V, full from LEAN_FULL_V (m/s); pedalling crank min rate (rad/s), cadence smoothing (1/s)
let cadence = 0;
let stand = 0, lean = 0;
let last = performance.now(), frames = 0, fpsT = last;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now(), raw = now - last; last = now;
  if (PROF && raw > PROF_MS && document.pointerLockElement) log('frameprof', {raw: Math.round(raw), work: +workMs.toFixed(1), gap: +(raw - workMs).toFixed(1), parts: lastProf});   // parts = the frame that took this long; gap = outside our loop (GC, GPU, browser)
  if (PROF) { for (const k in prof) prof[k] = 0; profT = performance.now(); }
  const playing = !!document.pointerLockElement, fdt = Math.min(raw / 1000, MAX_DT) * hud.timeScale();
  if (raw > SLOW_MS && playing) log('slowframe', {ms: Math.round(raw)});
  if (playing) {
    const I = {turn: k('KeyA') - k('KeyD'), pedal: k('KeyW'), brake: k('KeyS'), pitch: k('KeyS') - k('KeyW'), hop: k('Space'), sprint: k('ShiftLeft') || k('ShiftRight'), flip: k('KeyQ'), grab: k('KeyE'), manual: k('KeyF')};
    stand += ((I.sprint && I.pedal && S.grounded ? 1 : 0) - stand) * (1 - Math.exp(-STAND_K * fdt));
    const v = S.vel.length(), fade = Math.max(0, Math.min(1, (v - LEAN_MIN_V) / (LEAN_FULL_V - LEAN_MIN_V)));   // no lean flicker when slow
    const tl = S.grounded ? fade * Math.atan(v * I.turn * P.steer / P.gravity) : 0, lm = P.lean * Math.PI / 180;
    lean += (Math.max(-lm, Math.min(lm, tl)) - lean) * (1 - Math.exp(-LEAN_K * fdt));
    // crank: turns only while pedalling, at wheel speed (never backwards / jittering with tiny velocity flips), smoothed
    cadence += ((I.pedal && S.grounded && !S.manual ? Math.max(CAD_MIN, Math.max(0, S.vel.dot(S.fwd)) / WHEEL_R) : 0) - cadence) * (1 - Math.exp(-CAD_K * fdt));
    lap('pre');
    for (let i = 0; i < SUBSTEPS; i++) { step(fdt / SUBSTEPS, I); floorClamp(); }
    lap('phys');
    tricks.tick(fdt, S); lap('tricks');
  }
  if (![S.pos.x, S.pos.y, S.pos.z, S.vel.x, S.vel.y, S.vel.z].every(Number.isFinite)) { log('nan', {vel: S.vel.toArray()}); respawn(true); }
  const PK = LEVEL.PARK, oob = PK && (S.pos.x < PK.xMin + OOB_MARGIN || S.pos.x > PK.xMax - OOB_MARGIN || S.pos.z < PK.zMin + OOB_MARGIN || S.pos.z > PK.zMax - OOB_MARGIN);
  if (oob && !hud.oobActive()) { log('oob', {}); if (!S.crashed) crash('out of bounds'); gore.explode({kind: 'oob', dir: S.vel}); hud.oob(() => { respawn(true); gore.reset(); camSnap = true; }); }   // strict: touching the fence kills
  if (S.pos.y < KILL_Y && !hud.oobActive()) { log('fell', {}); hud.oob(() => { respawn(true); camSnap = true; }); }   // explosion, respawn after ~1 s

  right.crossVectors(S.fwd, S.up).normalize();
  basis.makeBasis(right, S.up, back.copy(S.fwd).negate());
  bike.group.quaternion.setFromRotationMatrix(basis);
  bike.group.position.copy(S.pos).addScaledVector(S.up, -R);
  if (S.crashed <= 0) bike.group.rotateZ(lean);   // roll about the contact line
  if (S.crashed <= 0) posePeg(fdt);
  bike.rider.position.y = -S.charge * CROUCH + stand * STAND_UP; bike.rider.position.z = -stand * STAND_FWD;
  const spin = (S.grounded ? -S.vel.dot(S.fwd) : 0) * fdt / WHEEL_R;
  for (const w of bike.wheels) w.rotation.x += spin;
  lap('misc');
  animate(fdt, -cadence * fdt, S, P, onImpact);   // (2nd arg = crank drive, same sign convention as the wheel spin)
  lap('anim');
  gore.update(fdt); lap('gore');
  if (!warmed && gore.isReady()) { warmed = true; const w0 = performance.now(); render.rescan(); renderer.compile(scene, camera); gore.warmDraw(); fx.warm(); log('warm', {ms: Math.round(performance.now() - w0)}); lap('warm'); }
  const cb = crashBody();
  if (cb && P.gore > 0 && playing && !gore.hidesRider()) bleed(fdt, cb); else if (!cb && bleedT) { fx.pool(null); bleedT = 0; }
  if (S.crashed <= 0) bike.group.updateMatrixWorld(true);
  for (let i = 0; i < 2; i++) fx.skid(i, S.grounded && S.crashed <= 0 && S.vel.lengthSq() > 1 ? bike.group.localToWorld(tmp.set(0, 0, i ? -0.5 : 0.5)) : null, S.gN);
  if (S.crashed <= 0 && playing) {          // feather trail shed behind the rider
    const sp = S.vel.length(), cnt = Math.floor(sp * FEATHER_RATE * (S.grounded ? 1 : FEATHER_AIR) * fdt + Math.random());
    if (cnt) fx.feathers(tmp.copy(S.pos).addScaledVector(S.up, FEATHER_H).addScaledVector(S.fwd, -0.3), back.copy(S.vel).multiplyScalar(0.2), cnt);
  }
  if (S.grind && playing) {                 // sparks at the peg on the edge
    const cnt = Math.floor(S.grind.s * SPARK_RATE * fdt + Math.random());
    if (cnt) fx.sparks(tmp.copy(S.pos).addScaledVector(S.up, -0.04).addScaledVector(S.grind.lat, -0.16), back.copy(S.vel).multiplyScalar(-0.15), cnt);
  }
  lap('misc'); fx.update(fdt); lap('fx'); trails.update(fdt, S); lap('trails');
  updateCam(fdt); lap('cam'); hud.cam(camera, P.fov, S); lap('hud');
  sky.update(fdt); lap('sky'); render.update(S); lap('render'); sky.render(); lap('draw');   // = renderer.render(scene, camera), or bloom composer if sky.js BLOOM

  frames++;
  if (now - fpsT > 500) {
    $('fps').textContent = Math.round(frames * 1000 / (now - fpsT)) + ' fps'; frames = 0; fpsT = now;
    $('spd').textContent = (S.vel.length() * 3.6).toFixed(0) + ' km/h';
  }
  if (PROF) {   // gap = time between frames not spent in this loop (GC, GPU stall, browser, other rAF/DOM work)
    lap('misc'); const r = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v]));
    workMs = performance.now() - now; Object.assign(lastProf, r(prof));
    if (crashF) { log('crashprof', {emit: r(cprof), frame: lastProf, work: +workMs.toFixed(1)}); crashF = false; for (const k in cprof) delete cprof[k]; }
  }
}
frame();
log('load', {prefs: P}); window.booted = true;
