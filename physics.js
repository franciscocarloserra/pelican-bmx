// Rider physics: 3 spheres along the bike (rear wheel, middle, front wheel) vs octree triangles.
// Grounded = rides the averaged contact normal gN; air = free yaw/pitch with inertia, nose
// auto-follows the trajectory when not flipping; landing checks bike-vs-surface angle and slip.
// Crash splits bike and rider into two tumbling spheres. Events via emit: takeoff, land, crash.
import * as THREE from 'three';
import { SPAWN } from './level.js';

export const FLOOR_Y = 0;   // ground plane top (level.js ground box); hard floor for rider, ragdoll, camera
// rider hard floor, called by main.js after every physics substep
export function floorClamp() { if (S.pos.y < FLOOR_Y + R) { S.pos.y = FLOOR_Y + R; if (S.vel.y < 0) S.vel.y = 0; } }
export const R = 0.3, BODY_R = 0.15, START = SPAWN.clone().setY(SPAWN.y + R);   // top of the start deck, facing -z (roll-in)
const OFFS = [0.5, 0, -0.5];     // collision spheres along fwd: front wheel, middle, rear wheel (m)
const ITERS = 3, HOP_CD = 0.15, WALL_CRASH = 9, CRASH_S = 2.6, MIN_SLIP_V = 1.5, SOFT_AIR = 0.35, SOFT_DROP = 1.0, D2R = Math.PI / 180;
const EDGE_V = 8, EDGE_R = 1.2, CLIP_DEPTH = 0.22, CLIP_STEPS = 4;   // bail speed (m/s) and distance to a grind edge (m) that dismember; penetration (m) for this many passes in a row = glitch
const BODY_UP = 0.9, FIX_LOOK = 0.5, FIX_MIN_AIR = 0.2, FIX_YAW_MAX = 45;   // FIX_YAW_MAX: heading error (deg) auto fix still straightens; more = landing sideways bails   // autoenderezado: starts this many seconds before impact, never right after leaving the ground
const TRANS_IN = 0.2, REJOIN_T = 0.15, WHEEL_PUSH = 0.5, MAX_MOVE = 0.12, MAX_SPLIT = 4, NEAR_R = 1.2, COL_CACHE = 1.5;   // ...; broadphase radius around the bike, ragdoll/chunk triangle cache radius (m)   // ... ; m per collision pass at speed, max extra splits   // m/s into a nearby surface that keeps you grounded on concave transitions; airs shorter than this (s) re-land without losing speed
const STEER_FULL_V = 2.5, STEER_MIN = 0.2;   // full steer rate from this speed (m/s); fraction left at a standstill
const HOP_MIN = 0.6, COYOTE = 0.15;   // hop strength with a tap (fraction of full); s after leaving the ground a release still hops
const WHIP_TOL = 0.6, MIN_HOLD = 0.15;   // rad short of a full spin trick that still counts on landing; shortest hold trick that counts (s)
// soft landing (never bails, auto-levels): air time < SOFT_AIR s or dropped < SOFT_DROP m below the highest point of the air
const HOOK_K = 10, LOOK_DOWN_AIR = 0.8;   // pose hooks: smoothing (1/s), how far the look dips toward the landing in the air
const VERT_GN_Y = 0.5, VERT_IN = 0.3;   // takeoff surface steeper than this (normal y) = vert air: horizontal speed away from the ramp is held at VERT_IN m/s back toward it
const PERFECT_TOL = 8, PERFECT_BOOST = 3, HOP_SPIN = 1.3;   // perfect landing window (deg) and its speed boost (m/s); A/D at the pop starts the spin at this x air spin rate
const LAND_BOOST = 1.5, CLEAN_TOL = 20, CLEAN_AIR = 0.6;   // m/s added on a clean landing; max rotation error (deg); air time that counts as 'did something'
const LAND_ALIGN = 0.6, LAND_SETTLE = 0.15;   // landing: fraction of sideways slide turned into the bike heading at touchdown; m it drops to sit all wheels down
// ---- grinds (tolerances; snap radius/angle and balance difficulty are sliders: grindSnap, grindAng, grindBal) ----
const PEG_H = 0.04, GRIND_SIDE = 0.16, SNAP_EASE = 25;   // wheel axle above the grind edge; bike centre line beside it (m); 1/s the lock-on jump eases out
const SNAP_ABOVE = 0.35, SNAP_BELOW = 0.15, SNAP_VUP = 2, SNAP_UP = 0.6, SNAP_END = 0.3, SNAP_ALONG = 0.3;   // peg height window vs edge (m), max upward speed (m/s), min up.y (upright-ish), min edge left ahead (m)
const GRIND_MIN_V = 1.5, GRIND_FRIC = 1.2, GRIND_CD = 0.35;   // slower = fall off (m/s); drag (m/s²); s before re-snapping the edge you left
const POP_END = 2.2, GRIND_HOP = 0.85, EXIT_SIDE = 1;         // m/s up when rolling off the end; hop strength factor; sideways m/s away from the edge on exit
const BAL_GROW = 1.6, BAL_WOB = 0.8, BAL_LEAN = 2.4, BAL_START = 0.15, SWITCH_KICK = 0.2;   // grind balance: drift growth (1/s), wobble, A/D correction (1/s), start / switch jolt
const MAN_MIN_V = 2, MAN_GROW = 1.2, MAN_WOB = 0.4, MAN_LEAN = 2.4, MAN_START = 0.08;      // manual balance, same idea with W/S
// grind types: pose = yaw toward the edge / nose-up pitch / roll toward the edge (rad), pivot z (bike local: +0.5 rear peg, -0.5 front); diff scales balance drift
export const GRINDS = {
  double:  {label: 'double peg', yaw: 0,     pitch: 0,     roll: 0.08, pivot: 0,    diff: 0.6, pts: 120},
  feeble:  {label: 'feeble',     yaw: 0.35,  pitch: -0.08, roll: 0.15, pivot: 0.5,  diff: 1.0, pts: 180},
  smith:   {label: 'smith',      yaw: -0.3,  pitch: -0.12, roll: -0.1, pivot: 0.5,  diff: 1.1, pts: 200},
  icepick: {label: 'icepick',    yaw: 0,     pitch: 0.55,  roll: 0.05, pivot: 0.5,  diff: 1.6, pts: 260},
  crooked: {label: 'crooked',    yaw: 0.2,   pitch: -0.3,  roll: 0.1,  pivot: -0.5, diff: 1.3, pts: 220},
};
// E + direction picks the grind: none = double, S = icepick (nose up), W = crooked (nose down), A/D toward the edge = feeble, away = smith
// specials (meter full, set by tricks.js as S.specialReady): Q+E together in the air + direction; must finish before landing
export const SPECIALS = {
  tsunami:     {label: 'tsunami',     t: 0.55, grab: true,  whip: true,  spin: 0},    // none/W: superman + tailwhip
  cliffhanger: {label: 'cliffhanger', t: 0.5,  grab: true,  whip: false, spin: 0},    // S
  tornado:     {label: 'tornado',     t: 0.6,  grab: false, whip: true,  spin: 1},    // A/D: whip during one full extra 360 that way (turns)
};
const SPECIAL_MIN_AIR = 0.08;
// air tricks: Q (bike) / E (body) + direction held at the press (none, up = W, down = S, side = A/D).
// spin: must finish its turns before landing (key held = keeps repeating); hold: base + pts/s while held, let go before landing
export const AIR_TRICKS = {
  tailwhip: {label: 'tailwhip',  key: 'flip', dir: 'none', spin: 0,   pts: 350},   // spin rate = P.whip
  barspin:  {label: 'barspin',   key: 'flip', dir: 'up',   spin: 2.5, pts: 250},
  turndown: {label: 'turndown',  key: 'flip', dir: 'down', hold: true, base: 100, pts: 300},
  xup:      {label: 'x-up',      key: 'flip', dir: 'side', hold: true, base: 100, pts: 250},
  superman: {label: 'superman',  key: 'grab', dir: 'none', hold: true, base: 0,   pts: 400},
  nohander: {label: 'no-hander', key: 'grab', dir: 'up',   hold: true, base: 100, pts: 350},
  tabletop: {label: 'tabletop',  key: 'grab', dir: 'down', hold: true, base: 150, pts: 350},
  cancan:   {label: 'can-can',   key: 'grab', dir: 'side', hold: true, base: 100, pts: 300},
};
const dirOf = I => I.pitch < 0 ? 'up' : I.pitch > 0 ? 'down' : I.turn ? 'side' : 'none';
const pickTrick = (key, I) => Object.keys(AIR_TRICKS).find(k => AIR_TRICKS[k].key === key && AIR_TRICKS[k].dir === dirOf(I));
const pickSpecial = I => I.turn ? 'tornado' : I.pitch > 0 ? 'cliffhanger' : 'tsunami';
const pickGrind = (I, side) => I.pitch > 0 ? 'icepick' : I.pitch < 0 ? 'crooked' : I.turn ? (I.turn * side > 0 ? 'feeble' : 'smith') : 'double';

const V = (...a) => new THREE.Vector3(...a);
export const S = {pos: V(), vel: V(), fwd: V(), up: V(), gN: V(), grounded: false, crashed: 0, charge: 0, hopCd: 0,
  airT: 0, yawAcc: 0, pitchAcc: 0, yawRate: 0, pitchRate: 0, peakY: 0, body: {pos: V()},
  trick: null, done: [],           // active air trick {name, t, a, key}; finished this air [{name, t}] (specials: {name, special})
  whip: 0, bar: 0, pose: '', grab: false,
  lookAt: V(0, 0, -1), lean: 0, landImpact: 0, landT: 9,   // rider-pose hooks (bike.js): where to look (unit, velocity / landing spot in air), bike lean (rad, + = left), last touchdown m/s down, s since it   // visuals for bike.js: frame / bar spin angle, hold pose name, feet off
  grind: null,    // {a, d, len, t, s, lat, up, side, type, part, time, bal, ph, seed, seg, held} while grinding
  manual: null,   // {bal, t, ph} while manualing
  special: null, specials: [], specialReady: false};   // {name, t, dir} during a special; finished ones this air
const WUP = V(0, 1, 0), safePos = START.clone(), safeFwd = V(0, 0, -1);
const ray = new THREE.Ray(), qf = new THREE.Quaternion(), nF = V(), vp = V(), fp = V();
const prevP = V(), prevF = V(), pcen = V();
const tmp = V(), tmp2 = V(), right = V(), off = V(), nSum = V(), q = new THREE.Quaternion();
const rot = (v, axis, a) => v.applyQuaternion(q.setFromAxisAngle(axis, a));
let octree, P, emit, getGrind = () => [], cdSeg = null, cdT = 0, manLock = false, specLock = false, keyQ = false, keyE = false, soft = false;

// grindables(): [{a: [x,y,z], b: [x,y,z], kind}] top grind edges (a getter, so the level can fill it late)
export function init(o, p, e, grindables) { octree = o; P = p; emit = e; if (grindables) getGrind = grindables; respawn(true); }

export function respawn(toStart, at) {   // at: respawn where the rider landed, facing the bike's flattened heading
  if (toStart) { safePos.copy(START); safeFwd.set(0, 0, -1); }
  else if (at) {
    safePos.copy(at); safePos.y += R - BODY_R + 0.05;
    tmp.set(S.fwd.x, 0, S.fwd.z); if (tmp.lengthSq() > 1e-4) safeFwd.copy(tmp.normalize());
  }
  manLock = false; specLock = false;
  S.pos.copy(safePos); S.vel.set(0, 0, 0); S.fwd.copy(safeFwd); S.up.set(0, 1, 0); S.gN.set(0, 1, 0);
  Object.assign(S, {grounded: false, crashed: 0, charge: 0, airT: 0, yawAcc: 0, pitchAcc: 0, yawRate: 0, pitchRate: 0, trick: null, done: [], whip: 0, bar: 0, pose: '', grab: false, grind: null, manual: null, special: null});
}

// ---- sphere vs triangles: closest point per triangle, so normals always point out of the surface ----
// pc = sphere center last substep: tells which side of each face is "out". If the center crossed a
// face's plane inside its footprint (fast hit / deep push), it goes back out the side it came from.
const tris = [], cp = V(), c = V(), dv = V(), tn = V(), pj = V(), qs = new THREE.Sphere(V(), R);
// broadphase: one octree query per riding step (near = triangles around the whole bike), reused by every sphere/probe
const nearTris = [], nearS = new THREE.Sphere(V(), 0);
let near = null;
function gatherNear(center, r) { nearS.center.copy(center); nearS.radius = r; nearTris.length = 0; octree.getSphereTriangles(nearS, nearTris); near = nearTris; }
function query(center, r) { if (near) return near; qs.center.copy(center); qs.radius = r; tris.length = 0; octree.getSphereTriangles(qs, tris); return tris; }
// no-alloc raycast (three's Octree.rayIntersect allocates per call): nearest hit distance within maxD, triangle in rayTri
const rayTris = [], rayP = V(); let rayTri = null;
export function raycast(r, maxD = Infinity) {
  rayTris.length = 0; octree.getRayTriangles(r, rayTris); rayTri = null; let best = maxD;
  for (const t of rayTris) if (r.intersectTriangle(t.a, t.b, t.c, false, rayP)) { const d = rayP.distanceTo(r.origin); if (d < best) { best = d; rayTri = t; } }
  return rayTri ? best : -1;
}
function resolve(p, o, r, hit, pc) {      // push p (sphere center = p + o) out; hit(n, depth) per contact
  c.copy(p).add(o);
  for (const t of query(c, r)) {
    t.getNormal(tn); if (tn.dot(dv.subVectors(pc, t.a)) < 0) tn.negate();
    const dist = tn.dot(dv.subVectors(c, t.a));
    let push;
    if (dist < 0 && t.containsPoint(pj.copy(c).addScaledVector(tn, -dist))) { dv.copy(tn); push = r - dist; }
    else {
      t.closestPointToPoint(c, cp); dv.subVectors(c, cp); const d = dv.length();
      if (d >= r || d < 1e-6) continue;   // (behind the plane but off the face = touching its edge: push off the edge; ridges/crests need this)
      dv.divideScalar(d); push = r - d;
    }
    push *= pushK; p.addScaledVector(dv, push); c.addScaledVector(dv, push);
    hit(dv, push);
  }
}
const deep = {n: V(), depth: 0};
function deepest(center, r) {             // deepest penetration at center, or null
  deep.depth = 0;
  for (const t of query(center, r)) {
    t.closestPointToPoint(center, cp); dv.subVectors(center, cp); const d = dv.length();
    if (d < r && d > 1e-6 && r - d > deep.depth) { deep.depth = r - d; deep.n.copy(dv).divideScalar(d); }
  }
  return deep.depth > 0 ? deep : null;
}

function slipOk(n) {
  tmp.copy(S.vel).addScaledVector(n, -S.vel.dot(n));
  if (tmp.length() < MIN_SLIP_V) return true;
  tmp2.copy(S.fwd).addScaledVector(n, -S.fwd.dot(n)).normalize();
  return Math.abs(tmp.normalize().dot(tmp2)) > Math.cos(P.slipTol * D2R);   // abs: landing backwards (fakie, e.g. dropping back into a quarter) is fine
}

const ce = V(), cq = V();
function nearEdge(p, r) {   // closest grind edge point within r of p, or null
  let best = null, bd = r * r;
  for (const g of getGrind()) {
    sa.fromArray(g.a); su.fromArray(g.b).sub(sa); const l2 = su.lengthSq(); if (l2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, cq.subVectors(p, sa).dot(su) / l2)); cq.copy(sa).addScaledVector(su, t);
    const d = cq.distanceToSquared(p); if (d < bd) { bd = d; best = ce.copy(cq); }
  }
  return best;
}
export function crash(why) {
  S.crashed = CRASH_S; S.grounded = false; S.charge = 0; S.trick = null; S.whip = 0; S.bar = 0; S.pose = ''; S.grab = false; S.grind = null; S.manual = null; S.special = null;
  S.body.pos.copy(S.pos).addScaledVector(S.up, BODY_UP);
  // hard bail next to a sharp edge (rail/ledge/coping): tear 1-3 limbs off there (gore.js, via window: no import cycle)
  const v = S.vel.length(), e = v > EDGE_V && why !== 'out of bounds' && why !== 'glitch' && nearEdge(S.pos, EDGE_R);
  if (e) globalThis.gore?.explode?.({kind: 'edge', point: e.clone(), dir: S.vel.clone(), power: Math.min(2, v / EDGE_V)});
  log('crash', {why, v: +S.vel.length().toFixed(1), air_s: +S.airT.toFixed(2), pos: S.pos.toArray().map(v => +v.toFixed(1))});
  emit('crash', why);
}

// one loose sphere (crash ragdoll particle): push out, n = last contact normal; true if touching
const ZERO = V();
// (ragdoll joints / gore chunks: a cached triangle list around the body, refreshed only when a sphere leaves it; no closures)
const colTris = [], colS = new THREE.Sphere(V(), 0);
let colN = null, colHit = false;
const colCb = hn => { colN.copy(hn); colHit = true; };
export function collide(p, r, prev, n) {
  if (p.distanceTo(colS.center) + r > colS.radius) { colS.center.copy(p); colS.radius = r + COL_CACHE; colTris.length = 0; octree.getSphereTriangles(colS, colTris); }
  const saved = near; near = colTris; colN = n; colHit = false;
  for (let i = 0; i < 2; i++) resolve(p, ZERO, r, colCb, prev);
  near = saved; let hit = colHit;
  if (p.y < FLOOR_Y + r) { p.y = FLOOR_Y + r; n.set(0, 1, 0); hit = true; }   // hard floor: nothing below the ground plane
  return hit;
}

// contact classification state for the riding collision pass
const vertN = V();
let vertAir = false, hopSpin = 0, vyPre = 0, landBoost = 0, contact = false, bad = null, canLand = false, cosLand = 0, pushK = 1, deepHit = false, clipN = 0;
function onHit(n, depth) {
  const {vel, up, gN} = S, d = vel.dot(n);
  if (S.grounded) {
    // riding contact: position push only; velocity is redirected (not cut) along gN after the pass, so
    // curved transitions keep their speed instead of acting like a string of small inelastic hits
    if (n.dot(gN) > 0.3) { if (canLand) { contact = true; nSum.add(n); return; } }
    else if (-d > WALL_CRASH) bad = 'wall';
  } else if (canLand) {
    // small hops (soft) always land on anything floor-like and auto-level; real airs need angle + heading
    if ((soft && (n.dot(up) > 0.3 || n.y > 0.5)) || (n.dot(up) > cosLand && slipOk(n))) { contact = true; nSum.add(n); }
    else if ((!soft && n.y > 0.3) || -d > WALL_CRASH) bad = -d > WALL_CRASH && n.y < 0.5 ? 'wall' : n.dot(up) > cosLand ? 'slipped out' : 'bad angle';
  }
  if (d < 0) vel.addScaledVector(n, -d);
  if (depth > CLIP_DEPTH) deepHit = true;
  if (depth > R * 0.6) log('stuck', {depth: +depth.toFixed(3), pos: S.pos.toArray().map(v => +v.toFixed(2))});
}

// in the air, near impact: turn up toward the landing surface and the nose toward the velocity,
// stronger the closer the hit; only if already within fixMax (bigger mistakes still bail)
function autoFix(dt) {
  const {pos, vel, fwd, up} = S, sp = vel.length();
  if (sp < 0.5) return;
  ray.set(pos, tmp.copy(vel).divideScalar(sp));
  const dist = raycast(ray, sp * FIX_LOOK);
  if (dist < 0) return;
  rayTri.getNormal(nF); if (nF.dot(ray.direction) > 0) nF.negate();
  const k = 1 - Math.exp(-P.autoFix * dt * (3 - 2 * dist / sp / FIX_LOOK)), max = P.fixMax * D2R;
  if (up.angleTo(nF) < max) { qf.identity().slerp(q.setFromUnitVectors(up, nF), k); up.applyQuaternion(qf); fwd.applyQuaternion(qf); }
  vp.copy(vel).addScaledVector(up, -vel.dot(up)); fp.copy(fwd).addScaledVector(up, -fwd.dot(up));
  if (vp.length() < MIN_SLIP_V || fp.lengthSq() < 1e-6) return;
  vp.normalize(); fp.normalize();
  const a = Math.atan2(tmp.crossVectors(fp, vp).dot(up), fp.dot(vp));
  if (Math.abs(a) < Math.min(max, FIX_YAW_MAX * D2R)) rot(fwd, up, a * k);
}

function takeoff() {
  Object.assign(S, {airT: 0, yawAcc: 0, pitchAcc: 0, yawRate: hopSpin * P.airYaw * HOP_SPIN, pitchRate: 0, peakY: S.pos.y, trick: null, done: [], special: null, whip: 0, bar: 0, pose: '', grab: false});
  hopSpin = 0; endManual(); emit('takeoff');
  // leaving a near-vertical wall (quarter vert / steep transition): vert air, comes straight back into the ramp
  vertAir = Math.abs(S.gN.y) < VERT_GN_Y && vertN.set(S.gN.x, 0, S.gN.z).lengthSq() > 1e-4;
  if (vertAir) vertN.normalize();
}
function landing() {     // false = bailed. Unfinished trick: bail, unless it was a soft landing (then it's just dropped)
  const tr = S.trick, def = tr && AIR_TRICKS[tr.name];
  if (tr && def.spin !== undefined && 2 * Math.PI - tr.a <= WHIP_TOL) { S.done.push({name: tr.name}); S.trick = null; }   // close enough
  else if (tr && def.hold && tr.t >= MIN_HOLD && soft) { S.done.push({name: tr.name, t: tr.t}); S.trick = null; }
  if (!soft && (S.special || S.trick)) { crash(S.special ? 'special' : def.hold ? 'still holding ' + def.label : def.label); return false; }
  Object.assign(S, {trick: null, special: null, whip: 0, bar: 0, pose: '', grab: false});
  // clean landing (rotation ends near a whole 180 / flip, something was done): small speed boost, flagged for the HUD/camera
  const ey = Math.abs(S.yawAcc - Math.round(S.yawAcc / Math.PI) * Math.PI), ep = Math.abs(S.pitchAcc - Math.round(S.pitchAcc / (2 * Math.PI)) * 2 * Math.PI);
  const did = S.done.length || Math.abs(S.yawAcc) > 2.5 || Math.abs(S.pitchAcc) > 5 || S.airT > CLEAN_AIR;
  const clean = !soft && did && ey < CLEAN_TOL * D2R && ep < CLEAN_TOL * D2R, perfect = clean && ey < PERFECT_TOL * D2R && ep < PERFECT_TOL * D2R;
  landBoost = perfect ? PERFECT_BOOST : clean ? LAND_BOOST : 0;
  S.landImpact = Math.max(0, -vyPre); S.landT = 0; vertAir = false;
  emit('land', {airT: S.airT, yaw: S.yawAcc, pitch: S.pitchAcc, done: S.done, soft, clean, perfect});
  S.done = [];
  return true;
}
function endManual(fail = false) { if (S.manual) { emit('manualEnd', {t: S.manual.t, fail}); S.manual = null; } }

// Q/E air tricks + specials; also sets the bike.js visuals (whip, bar, pose, grab)
function airTricks(dt, I, qP, eP) {
  if (!S.special && (qP || eP) && I.flip && I.grab && S.specialReady && S.airT > SPECIAL_MIN_AIR) {   // Q+E together: special
    S.special = {name: pickSpecial(I), t: 0, dir: Math.sign(I.turn) || 1}; S.trick = null; specLock = true; emit('specialStart', {name: S.special.name});
  } else if (!S.special && !S.trick && (qP || eP) && !specLock) {
    const name = pickTrick(qP ? 'flip' : 'grab', I);
    S.trick = {name, t: 0, a: 0, key: AIR_TRICKS[name].key}; emit('trickStart', {name});
  }
  if (specLock && !I.flip && !I.grab) specLock = false;
  S.whip = 0; S.bar = 0; S.pose = '';
  if (S.special) {                          // scripted: whip/pose visuals, optional spin; done after its time
    const sp = S.special, def = SPECIALS[sp.name];
    sp.t += dt; S.pose = def.grab ? (sp.name === 'cliffhanger' ? 'cliff' : 'superman') : '';
    if (def.whip) S.whip = (sp.t * P.whip * 2.5 * 2 * Math.PI) % (2 * Math.PI);
    if (def.spin) S.yawRate = sp.dir * def.spin * 2 * Math.PI / def.t + I.turn * P.airYaw;
    if (sp.t >= def.t) { S.done.push({name: sp.name, special: true}); S.special = null; if (def.spin) S.yawRate = I.turn * P.airYaw; emit('specialDone', {name: sp.name}); }
  } else if (S.trick) {
    const tr = S.trick, def = AIR_TRICKS[tr.name];
    tr.t += dt;
    if (def.hold) {
      S.pose = tr.name;
      if (!I[tr.key]) { if (tr.t >= MIN_HOLD) S.done.push({name: tr.name, t: tr.t}); S.trick = null; }
    } else {
      tr.a += (def.spin || P.whip) * 2 * Math.PI * dt;
      if (tr.a >= 2 * Math.PI) { S.done.push({name: tr.name}); if (I[tr.key]) tr.a -= 2 * Math.PI; else S.trick = null; }
      if (tr.name === 'tailwhip') S.whip = tr.a; else S.bar = tr.a;
    }
  }
  S.grab = S.pose === 'superman' || S.pose === 'cancan' || S.pose === 'cliff';
}
const wobble = (o, dt) => Math.sin((o.ph += dt) * 1.7 + o.seed) + 0.6 * Math.sin(o.ph * 4.3 + 2 * o.seed);

// in the air near a grind edge, peg height within the window, moving along it: lock on
const sa = V(), sb = V(), su = V(), sl = V(), sv = V(), sq = V();
function trySnap(I, startG) {
  const segs = getGrind();
  if (!segs.length || S.up.y < SNAP_UP || (S.trick && !AIR_TRICKS[S.trick.name].hold) || S.special) return false;
  const {pos, vel} = S, cosA = Math.cos(P.grindAng * D2R);
  let best = null, bestE = Infinity;
  for (const seg of segs) {
    if (seg === cdSeg && cdT > 0) continue;
    sa.fromArray(seg.a); su.fromArray(seg.b).sub(sa); const len = su.length(); su.divideScalar(len);
    if (Math.abs(su.y) > 0.8) continue;
    sl.crossVectors(su, WUP).normalize(); sv.crossVectors(sl, su);           // lateral (horizontal) and edge-normal "up"
    tmp.copy(pos).addScaledVector(WUP, -PEG_H).sub(sa);
    const tRaw = tmp.dot(su), t = Math.max(0, Math.min(len, tRaw));
    if (tRaw < -SNAP_ALONG || tRaw > len + SNAP_ALONG) continue;              // beyond the ends: no far snap
    tmp.addScaledVector(su, -t);                                            // peg relative to the closest edge point
    const latD = tmp.dot(sl), vD = tmp.dot(sv), vUp = vel.dot(sv), va = vel.dot(su);
    if (Math.abs(latD) > P.grindSnap || vD > SNAP_ABOVE || vD < -SNAP_BELOW || vUp > SNAP_VUP) continue;
    tmp2.copy(vel).addScaledVector(sv, -vUp);
    if (Math.abs(va) < GRIND_MIN_V || Math.abs(va) < cosA * tmp2.length() || (va > 0 ? len - t : t) < SNAP_END) continue;
    const e = tmp.length();                                                 // nearest edge wins (true 3D distance)
    if (e < bestE) { bestE = e; best = {seg, t, len, latD, va}; }
  }
  if (!best) return false;
  if (startG) takeoff(); else if (!landing()) return true;
  const {seg, t, len, latD, va} = best, dir = Math.sign(va);
  sa.fromArray(seg.a); sb.fromArray(seg.b);
  const d = V().subVectors(sb, sa).normalize().multiplyScalar(dir), a = dir > 0 ? sa.clone() : sb.clone();
  const lat = su.subVectors(sb, sa).normalize().cross(WUP).normalize().multiplyScalar(latD >= 0 ? 1 : -1).clone();   // unit, edge -> bike side
  // ledge/coping top on that side (surface just under the peg spot): hang off the other side instead
  ray.set(sq.copy(sa).addScaledVector(d, t * dir).addScaledVector(lat, GRIND_SIDE + 0.1).addScaledVector(WUP, 0.1), tmp.set(0, -1, 0));
  const top = raycast(ray, 0.2); if (top >= 0) lat.negate();
  const eUp = V().crossVectors(sl.crossVectors(d, WUP).normalize(), d).normalize();
  const side = lat.dot(tmp.crossVectors(d, eUp)) > 0 ? 1 : -1;               // +1: edge on the bike's left
  const g = S.grind = {seg, dir, a, d, len, t: dir > 0 ? t : len - t, s: Math.abs(va), lat, up: eUp, side, time: 0, part: 0,
    bal: (Math.random() < 0.5 ? -1 : 1) * BAL_START, ph: 0, seed: Math.random() * 6.3, held: !!I.grab, type: 'double'};
  if (I.grab) g.type = pickGrind(I, side);
  S.grab = false; S.grounded = false; S.charge = 0; S.manual = null;
  emit('grind', {type: g.type, kind: seg.kind, start: true});
  const old = S.pos.clone(); placeGrind(); g.off = old.sub(S.pos);   // ease the sideways/vertical snap over a few frames
  return true;
}
function placeGrind(dt = 0) {
  const g = S.grind;
  S.pos.copy(g.a).addScaledVector(g.d, g.t).addScaledVector(g.lat, GRIND_SIDE).addScaledVector(g.up, PEG_H);
  if (g.off) S.pos.add(g.off.multiplyScalar(Math.exp(-SNAP_EASE * dt)));
  S.vel.copy(g.d).multiplyScalar(g.s); S.fwd.copy(g.d); S.up.copy(g.up); S.gN.copy(g.up);
  return S.pos;
}
function exitGrind(pop, why) {
  const g = S.grind;
  emit('grindPart', {type: g.type, t: g.part}); emit('grindEnd', {why, t: g.time});
  S.grind = null; cdSeg = g.seg; cdT = GRIND_CD; S.hopCd = HOP_CD; S.charge = 0;
  S.vel.copy(g.d).multiplyScalar(g.s).addScaledVector(WUP, pop).addScaledVector(g.lat, EXIT_SIDE);
  takeoff();
}
// linked edges (level `next`/`prev` = grindables indices, -1 = none): carry on onto the next segment, same side and type
function chainGrind(g) {
  const segs = getGrind(), i = g.dir > 0 ? g.seg.next : g.seg.prev, ns = i >= 0 ? segs[i] : null;
  if (!ns) return false;
  const over = g.t - g.len;
  sa.fromArray(g.dir > 0 ? ns.a : ns.b); sb.fromArray(g.dir > 0 ? ns.b : ns.a);
  g.seg = ns; g.a.copy(sa); g.d.subVectors(sb, sa); g.len = g.d.length(); g.d.divideScalar(g.len); g.t = Math.min(over, g.len);
  sl.crossVectors(g.d, WUP).normalize(); if (sl.dot(g.lat) < 0) sl.negate(); g.lat.copy(sl);   // keep the side
  g.up.crossVectors(tmp.crossVectors(g.d, WUP).normalize(), g.d).normalize();
  return true;
}
function grindStep(dt, I) {
  const g = S.grind, ty = GRINDS[g.type];
  g.s += (-P.gravity * g.d.y - GRIND_FRIC) * dt; g.t += g.s * dt; g.time += dt; g.part += dt;
  // balance: drift grows away from centre plus a wobble; A/D pushes it back (D = right, A = left)
  g.bal += (P.grindBal * ty.diff * (BAL_GROW * g.bal + BAL_WOB * wobble(g, dt)) - I.turn * BAL_LEAN) * dt;   // (inverted: A/D push the meter the other way)
  if (Math.abs(g.bal) >= 1) { S.grind = null; cdSeg = g.seg; cdT = GRIND_CD; return crash('lost balance'); }
  if (I.grab && !g.held) {                    // E + direction: switch grind (counts as a new trick in the combo)
    const nt = pickGrind(I, g.side);
    if (nt !== g.type) { emit('grindPart', {type: g.type, t: g.part}); g.type = nt; g.part = 0; g.bal += (g.bal >= 0 ? 1 : -1) * SWITCH_KICK; emit('grind', {type: nt, kind: g.seg.kind}); }
  }
  g.held = !!I.grab;
  if (I.hop) S.charge = Math.min(1, S.charge + dt / P.charge);
  else if (S.charge > 0) return exitGrind(P.hop * (HOP_MIN + (1 - HOP_MIN) * S.charge) * GRIND_HOP, 'hop');
  if (g.t > g.len && !chainGrind(g)) return exitGrind(POP_END, 'end');
  if (g.s < GRIND_MIN_V) return exitGrind(0, 'slow');
  placeGrind(dt);
}

// fast: split the step so nothing moves more than MAX_MOVE per collision pass (capped, so drops can't explode the cost)
export function step(dt, I) {
  const n = Math.min(MAX_SPLIT, Math.ceil(S.vel.length() * dt / MAX_MOVE) || 1);
  for (let i = 0; i < n; i++) { stepOnce(dt / n, I); near = null; }
  poseHooks(dt, I);
}
const hkF = V(0, 0, -1);
function poseHooks(dt, I) {
  const sp = S.vel.length(), k = 1 - Math.exp(-HOOK_K * dt);
  // look: velocity heading (slow: bike forward); in the air tilted down toward where it will land
  if (sp > 1) tmp.copy(S.vel).divideScalar(sp); else tmp.copy(S.fwd);
  if (!S.grounded && !S.grind) tmp.y -= LOOK_DOWN_AIR * Math.min(1, S.airT * 1.5);
  S.lookAt.lerp(tmp.normalize(), k).normalize();
  // lean: yaw rate x speed like a real turn (riding only), faded when slow
  const yr = S.grounded ? tmp2.crossVectors(hkF, S.fwd).dot(S.up) / Math.max(dt, 1e-4) : 0; hkF.copy(S.fwd);
  const target = S.grounded && sp > 1.5 ? Math.atan(sp * yr / P.gravity) * Math.min(1, (sp - 1.5) / 2.5) : 0;
  S.lean += (Math.max(-0.8, Math.min(0.8, target)) - S.lean) * k;
  S.landT += dt;
}
// I = {turn: -1..1, pedal, brake, pitch: -1..1, hop, sprint, flip, grab (E: superman / grind pick), manual (F)}
function stepOnce(dt, I) {
  const {pos, vel, fwd, up, gN} = S;
  if (S.crashed > 0) {
    if ((S.crashed -= dt) <= 0) respawn(false, S.body.pos);
    return;
  }
  cdT -= dt;
  const qP = I.flip && !keyQ, eP = I.grab && !keyE; keyQ = !!I.flip; keyE = !!I.grab;   // press edges
  if (S.grind) return grindStep(dt, I);
  const startG = S.grounded;
  S.hopCd -= dt;
  if (S.grounded) {
    // F: manual (no pedalling or braking; W/S keep the balance meter centred, falling out just drops the front wheel)
    if (!I.manual) manLock = false;
    const man = I.manual && !manLock && vel.length() > MAN_MIN_V;
    if (man && !S.manual) S.manual = {bal: (Math.random() < 0.5 ? -1 : 1) * MAN_START, t: 0, ph: 0, seed: Math.random() * 6.3};
    if (!man) endManual();
    if (S.manual) {
      const m = S.manual; m.t += dt;
      m.bal += (P.manBal * (MAN_GROW * m.bal + MAN_WOB * wobble(m, dt)) - I.pitch * MAN_LEAN) * dt;   // (inverted)
      if (Math.abs(m.bal) >= 1) { endManual(true); manLock = true; return crash(m.bal > 0 ? 'looped out' : 'nose dive'); }
    }
    const steerK = Math.max(STEER_MIN, Math.min(1, vel.length() / STEER_FULL_V));   // slow: steer fades (no spinning in place)
    rot(fwd, gN, I.turn * P.steer * steerK * dt); fwd.addScaledVector(gN, -fwd.dot(gN)).normalize();
    vel.y -= P.gravity * dt; vel.addScaledVector(gN, -vel.dot(gN));                        // gravity along surface
    const along = vel.dot(fwd), sp = vel.length();
    if (sp > 1e-4) vel.lerp(tmp.copy(fwd).multiplyScalar(Math.sign(along || 1) * sp), Math.min(1, P.grip * dt));
    const boost = I.sprint ? P.sprint : 1;
    if (I.pedal && !S.manual && along < P.pedalMax * boost) vel.addScaledVector(fwd, P.pedal * boost * dt);
    const brake = I.brake && !S.manual;
    vel.multiplyScalar(1 - (P.roll + (brake ? P.brake : 0)) * dt);
    if (brake) { const v = vel.length(); if (v > 1e-6) vel.multiplyScalar(Math.max(0, v - P.brakeD * dt) / v); }   // + constant decel: actually stops
    if (I.hop) S.charge = Math.min(1, S.charge + dt / P.charge);
    else if (S.charge > 0) { vel.addScaledVector(gN, P.hop * (HOP_MIN + (1 - HOP_MIN) * S.charge)); S.charge = 0; S.hopCd = HOP_CD; S.grounded = false; hopSpin = I.turn; }   // A/D held at the pop: spin starts at once (flat 180s)
  } else {
    if (!I.hop && S.charge > 0 && S.airT < COYOTE) vel.addScaledVector(up, Math.max(0, P.hop * (HOP_MIN + (1 - HOP_MIN) * S.charge) - Math.max(0, vel.dot(up)) * 0.5));   // late release: still pops
    if (!I.hop) S.charge = 0;
    const k = 1 - Math.exp(-P.airK * dt);
    const pIn = S.special ? 0 : I.pitch;     // a special holds the flip direction key: don't flip with it
    S.yawRate += (I.turn * P.airYaw - S.yawRate) * k; S.pitchRate += (pIn * P.airPitch - S.pitchRate) * k;
    rot(fwd, up, S.yawRate * dt);
    right.crossVectors(fwd, up).normalize(); rot(fwd, right, S.pitchRate * dt); rot(up, right, S.pitchRate * dt);
    S.yawAcc += S.yawRate * dt; S.pitchAcc += S.pitchRate * dt; S.airT += dt;
    // not flipping and roughly upright: nose drifts toward the trajectory (or tail, if going backwards)
    if (!pIn && up.y > 0.2 && P.airAlign > 0) {
      tmp.copy(vel).addScaledVector(right, -vel.dot(right));
      if (tmp.lengthSq() > 1) {
        tmp.normalize().multiplyScalar(fwd.dot(tmp) >= 0 ? 1 : -1);
        const a = Math.atan2(tmp.dot(up), tmp.dot(fwd)) * (1 - Math.exp(-P.airAlign * dt));
        rot(fwd, right, a); rot(up, right, a);
      }
    }
    if (vertAir) { const d = vel.dot(vertN); if (d < VERT_IN) vel.addScaledVector(vertN, VERT_IN - d); }   // no drifting over the lip onto the deck
    airTricks(dt, I, qP, eP);
    S.peakY = Math.max(S.peakY, pos.y);
    if (P.autoFix > 0 && S.airT > FIX_MIN_AIR) autoFix(dt);
    vel.y -= P.gravity * dt;
  }
  prevP.copy(pos); prevF.copy(fwd);
  pos.addScaledVector(vel, dt);
  soft = S.airT < SOFT_AIR || S.peakY - pos.y < SOFT_DROP; vyPre = vel.y;   // (before contacts cut it: touchdown speed for S.landImpact)
  if (!S.grounded && trySnap(I, startG)) return;

  const spPre = vel.length(), yPre = pos.y;
  gatherNear(pos, NEAR_R);
  canLand = S.hopCd <= 0; cosLand = Math.cos(P.landTol * D2R); contact = false; bad = null; nSum.set(0, 0, 0);
  for (let i = 0; i < ITERS; i++) for (const o of OFFS) {
    pushK = S.grounded && o ? WHEEL_PUSH : 1;   // riding: a wheel hitting a crease tilts the bike (moves the middle ~half), not lifts it whole
    resolve(pos, off.copy(fwd).multiplyScalar(o), R, onHit, pcen.copy(prevP).addScaledVector(prevF, o));
  }
  pushK = 1;
  // clipped into geometry several passes in a row (tunnelled / squeezed): glitch bail, gore.js glitch explosion
  clipN = deepHit ? clipN + 1 : 0; deepHit = false;
  if (clipN >= CLIP_STEPS) { clipN = 0; log('clip', {pos: pos.toArray().map(v => +v.toFixed(2))}); crash('glitch'); globalThis.gore?.explode?.({kind: 'glitch', dir: vel.clone()}); return; }
  if (bad === 'wall' || (bad && !contact)) return crash(bad);   // a hard wall hit bails even with the wheels on the ground
  if (contact) gN.copy(nSum).normalize();
  // riding with no contact: stick only if gravity + stick can bend the path that much (fast over a lip = launch)
  if (!contact && S.grounded && canLand) {
    tmp.copy(pos).addScaledVector(gN, -P.snap);
    const h = deepest(tmp, R);
    if (h && h.n.dot(gN) > 0.5) {
      const gap = P.snap - h.depth, allowed = 0.5 * dt * dt * (P.gravity * Math.max(0, gN.y) + P.stick) + 1e-5;
      if (gap <= allowed) { pos.copy(tmp).addScaledVector(h.n, h.depth); gN.copy(h.n); contact = true; depen(); }
    }
  }
  // concave transitions (quarter/bowl foot): a wheel can lose touch for a substep while the surface curves
  // toward it; stay grounded if any sphere is within snap of a rideable surface we're moving into
  if (!contact && S.grounded && canLand) for (const o of OFFS) {
    const h = deepest(tmp.copy(pos).addScaledVector(fwd, o), R + P.snap);
    if (h && h.n.dot(gN) > 0.5 && vel.dot(h.n) < -TRANS_IN) { contact = true; break; }
  }
  if (contact) {
    const sp = vel.length(), vn = vel.dot(gN);
    vel.addScaledVector(gN, -vn);
    // riding (or re-touching after a transition hiccup): turned by the surface, not slowed; energy-matched to the push
    // (energy-matched: the surface pushing us up/down pays/returns speed, as gravity along the true tangent would)
    if ((startG || S.airT < REJOIN_T) && vel.lengthSq() > 1e-8) vel.setLength(Math.sqrt(Math.max(0, spPre * spPre - 2 * P.gravity * (pos.y - yPre))));
  }
  S.grounded = contact;
  if (startG && !contact) takeoff();
  const landed = !startG && contact;
  if (landed) {
    if (!landing()) return;
    if (soft) {                               // small hop: auto-level, and if it landed way sideways face the travel direction
      up.copy(gN); tmp.copy(fwd).addScaledVector(gN, -fwd.dot(gN)).normalize(); tmp2.copy(vel).addScaledVector(gN, -vel.dot(gN));
      if (tmp2.length() > MIN_SLIP_V && Math.abs(tmp.dot(tmp2.normalize())) < Math.cos(P.slipTol * D2R)) fwd.copy(tmp2).multiplyScalar(tmp.dot(tmp2) >= 0 ? 1 : -1);
    }
    // crisp touchdown: most of the sideways slide becomes speed along the heading (no slide-out)
    tmp.copy(fwd).addScaledVector(gN, -fwd.dot(gN)).normalize();
    const along = vel.dot(tmp);
    vel.lerp(tmp.multiplyScalar(Math.sign(along || 1) * vel.length()), LAND_ALIGN);
    if (landBoost && vel.length() < P.pedalMax * P.sprint) vel.addScaledVector(tmp.normalize(), landBoost);   // clean landing pays out speed
  }
  if (contact && gN.y > 0.95) { safePos.copy(pos); safeFwd.copy(fwd); }

  if (contact) up.lerp(gN, 1 - Math.exp(-P.upK * dt)).normalize();
  fwd.addScaledVector(contact ? gN : up, -fwd.dot(contact ? gN : up)).normalize();   // riding: spheres follow the surface, up only smooths the look
  if (contact) up.addScaledVector(fwd, -up.dot(fwd)).normalize();   // pitch exactly along the wheels (only roll is smoothed): wheels never dip into a ridge
  if (landed) { settle(); depen(); }
  near = null;
}
// position-only pass after a snap/settle moved the body: wheels at a ridge or valley must not end up inside the other face
const noHit = () => {};
function depen() { for (let i = 0; i < 2; i++) for (const o of OFFS) resolve(S.pos, off.copy(S.fwd).multiplyScalar(o), R, noHit, pcen.copy(S.pos).add(off)); }   // side = where the sphere is now (fwd may have just turned)

// just landed nose- or tail-first: flattening fwd lifts the touching wheel's sphere off the ground, so drop
// until the closest sphere touches (else it hovers, loses contact and re-lands for a few frames = bounce)
function settle() {
  const {pos, fwd, gN} = S;
  let gap = LAND_SETTLE;
  for (const o of OFFS) {
    const h = deepest(tmp.copy(pos).addScaledVector(fwd, o), R + LAND_SETTLE);
    if (h && h.n.dot(gN) > 0.5) gap = Math.min(gap, LAND_SETTLE - h.depth);
  }
  if (gap > 0 && gap < LAND_SETTLE) pos.addScaledVector(gN, -gap);
}
