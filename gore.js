// Dismemberment of the real pelican GLB. At first use the skinned mesh is split into 6 regions
// (torso, head, wings L/R, legs L/R) by dominant bone weight per triangle; each region becomes a plain
// Mesh sharing the original material. On explode the current pose is skinned on the CPU once and the pieces
// fly as rigid spheres (gravity, bounce, friction, physics.collide => level + hard floor).
//
// API (import { gore } from './gore.js'; also window.gore; main.js calls gore.init(scene, fx) + gore.update(fdt))
//   gore.explode({point, dir, power = 1, kind = 'oob', vel})   queued, applied in the next gore.update (after bike animate)
//     kind 'oob'    all pieces, big outward pop + spin
//     kind 'glitch' same + flicker / teleport jitter / scale snaps of the pieces for GLITCH_T s
//     kind 'edge'   1-3 limbs (head/wings/legs) nearest `point` tear off; the rest stays on the ragdoll
//     point: world Vector3 (default: hips), dir: world push direction (optional), vel: base velocity (default: ragdoll/S.vel)
//   gore.reset()       restore the skinned rider, hide pieces (main.js calls it on respawn; also automatic on crash end)
//   gore.hidesRider()  true while the whole rider is in pieces (main.js mutes ragdoll blood/feathers then)
// Physics agent: prefer `window.gore.explode(...)` from physics.js (importing gore.js there creates an import cycle).
import * as THREE from 'three';
import { collide, S, FLOOR_Y } from './physics.js';
import { P } from './params.js';
import { hud } from './hud.js';
import { riderRig } from './bike.js';

// ---- tunables ----
const REGIONS = ['torso', 'head', 'armL', 'armR', 'legL', 'legR'];
const ROOTS = {Neck: 1, LeftArm: 2, RightArm: 3, LeftUpLeg: 4, RightUpLeg: 5};          // bone (and its subtree) -> region
const RAG_CUT = [[], [2], [4, 5], [7, 8], [10, 11], [13, 14]];                           // ragdoll joints freed per region (bike.js JOINTS)
const RAG_NEAR = [0, 2, 4, 7, 10, 13];                                                    // ragdoll joint whose velocity a piece inherits
const KINDS = {   // outward speed, up kick, along-dir push (m/s); spin (rad/s); feathers; blood drop cap; hitstop (s, 0 = hud does it); shake
  oob:    {speed: 10, up: 5, push: 4, spin: 20, feathers: 60, blood: 70, stains: 6, hitstop: 0, shake: 0.4},
  glitch: {speed: 9, up: 4, push: 3, spin: 28, feathers: 50, blood: 50, stains: 5, hitstop: 0.1, shake: 0.6},
  edge:   {speed: 5, up: 2.5, push: 2, spin: 14, feathers: 20, blood: 30, stains: 3, hitstop: 0.09, shake: 0.5},
  big:    {speed: 8, up: 4.5, push: 3, spin: 22, feathers: 40, blood: 35, stains: 3, hitstop: 0.12, shake: 0.8},   // hard crash: full split, light blood
};
const SUB = 2, BOUNCE = 0.35, FRICTION = 0.55, SPIN_KEEP = 0.7, REST_V = 0.35, AIR_DRAG = 0.15;   // substeps; restitution; tangential keep on hit; spin kept per hit; sleep speed (m/s); 1/s
const R_K = 0.6, R_MIN = 0.05, R_MAX = 0.28;                                             // collision radius = R_K * rms vertex distance, clamped (m)
const POP_T = 0.32, POP_AMP = 0.45, POP_WOBBLE = 2.5;                                     // real-time scale pop on explode (s, overshoot, half-waves)
const SQ_KICK = 0.05, SQ_MAX = 0.45, SQ_K = 260, SQ_D = 14, STRETCH_K = 0.018, STRETCH_MAX = 0.35;   // squash per m/s impact, max; spring (1/s², 1/s); flight stretch per m/s, max
const FLASH_T = 0.16, FLASH_R = 1.6, RING_T = 0.3, RING_R = 3.2;                          // pop flash sphere / ground shock ring: life (s), end radius (m)
const GLITCH_T = 0.9, GLITCH_FLICK = 0.25, GLITCH_JUMP = 0.5, GLITCH_SNAP = 0.5;          // s; chance/frame to toggle, teleport offset (m), scale snap amount
const SPURT_T = 1.4, SPURT_HZ = 2.2, SPURT_RATE = 14, SPURT_V = 2.5, BURST = 4;           // stump spurts: s, Hz, drops/s at peak, m/s; drops per stump at the pop
const TRAIL_RATE = 4, TRAIL_V = 5, SPLAT_V = 3, STAIN_R = 0.18, REST_STAIN = 0.32;         // drops/s while faster than TRAIL_V; hit speed that stains; stain sizes (m)
const COLLAPSE = 1e-3, EDGE_MAX = 3, BAKE_VERTS = 6000;   // ...; vertices CPU-skinned per frame on explode (full split ~4 frames, during the hitstop)
const AUTO_EDGE_V = 8, AUTO_FULL_V = 16, AUTO_SKIP = ['out of bounds', 'glitch'];   // gore.onCrash: crash speed (m/s) that tears limbs / splits him fully (bad angle always tears)                                                      // bone scale that hides a torn limb on the skinned mesh; max limbs for 'edge'

// ---- state ----
const V = () => new THREE.Vector3();
const _a = V(), _b = V(), _c = V(), _n = V(), _v = V(), _ax = V(), Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4();
const acc = new Float32Array(16);
let job = null, scene, fx, ready = false, model = null, pending = null, wasCrashed = false, hidden = false, lastT = 0, popAge = 1e9, glitchT = 0, budget = 0, stains = 0, stainCap = 0, warm = 0;
const meshes = [], pieces = [], detached = new Set(), collapsed = [];   // collapsed: [bone, origScale]
let flash, ring;

function nm(b) { return b.name.replace(/^mixamorig:?/, ''); }

// split every SkinnedMesh of the rider into REGIONS (once)
function prep(m) {
  model = m;
  m.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  for (let r = 0; r < REGIONS.length; r++) {
    const holder = new THREE.Object3D(), inner = new THREE.Group();
    holder.add(inner); holder.visible = false; scene.add(holder);
    pieces.push({r, holder, inner, parts: [], root: null, active: false, pos: V(), prev: V(), vel: V(), w: V(), q: new THREE.Quaternion(), rad: 0.1,
      sq: 0, sqv: 0, axis: V().set(0, 1, 0), rest: false, hit: false, stumps: [], spurt: 0, trail: 0, landed: false, jump: V()});
  }
  for (const sm of meshes) {
    const sk = sm.skeleton, g = sm.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, nv = g.attributes.position.count, NR = REGIONS.length;
    const breg = sk.bones.map(b => { for (let o = b; o && o.isBone; o = o.parent) { const k = ROOTS[nm(o)]; if (k) return k; } return 0; });
    sk.bones.forEach(b => { const k = ROOTS[nm(b)]; if (k && !pieces[k].root) pieces[k].root = b; });
    const vw = new Float32Array(nv * NR);
    for (let v = 0; v < nv; v++) for (let k = 0; k < 4; k++) vw[v * NR + breg[si.getComponent(v, k)]] += sw.getComponent(v, k);
    const idx = g.index ? g.index.array : Uint32Array.from({length: nv}, (_, i) => i), lists = REGIONS.map(() => []);
    for (let t = 0; t < idx.length; t += 3) {
      let best = 0, bw = -1;
      for (let r = 0; r < NR; r++) { const s = vw[idx[t] * NR + r] + vw[idx[t + 1] * NR + r] + vw[idx[t + 2] * NR + r]; if (s > bw) { bw = s; best = r; } }
      lists[best].push(idx[t], idx[t + 1], idx[t + 2]);
    }
    lists.forEach((tri, r) => {
      if (!tri.length) return;
      const map = new Map(), src = [];
      const ix = tri.map(v => { let j = map.get(v); if (j === undefined) { j = src.length; map.set(v, j); src.push(v); } return j; });
      const n = src.length, geo = new THREE.BufferGeometry();
      geo.setIndex(new THREE.BufferAttribute(n > 65535 ? Uint32Array.from(ix) : Uint16Array.from(ix), 1));
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      for (const [name, at] of Object.entries(g.attributes)) {
        if (name === 'position' || name === 'normal' || name.startsWith('skin')) continue;
        const s = at.itemSize, arr = new Float32Array(n * s);
        for (let i = 0; i < n; i++) for (let k = 0; k < s; k++) arr[i * s + k] = at.getComponent(src[i], k);
        geo.setAttribute(name, new THREE.BufferAttribute(arr, s));
      }
      const mesh = new THREE.Mesh(geo, Array.isArray(sm.material) ? sm.material[0] : sm.material);
      mesh.frustumCulled = false; pieces[r].inner.add(mesh);
      // bind-pose data copied to flat arrays once, so the explode-time bake is a tight loop
      const si4 = new Uint16Array(n * 4), sw4 = new Float32Array(n * 4), bp = new Float32Array(n * 3), bn = new Float32Array(n * 3), pa = g.attributes.position, na = g.attributes.normal;
      for (let i = 0; i < n; i++) {
        const v = src[i];
        for (let k = 0; k < 4; k++) { si4[i * 4 + k] = si.getComponent(v, k); sw4[i * 4 + k] = sw.getComponent(v, k); }
        bp[i * 3] = pa.getX(v); bp[i * 3 + 1] = pa.getY(v); bp[i * 3 + 2] = pa.getZ(v);
        if (na) { bn[i * 3] = na.getX(v); bn[i * 3 + 1] = na.getY(v); bn[i * 3 + 2] = na.getZ(v); }
      }
      pieces[r].parts.push({sm, si4, sw4, bp, bn, geo, mats: new Float32Array(sk.bones.length * 16)});
    });
  }
  // pop flash + shock ring (shared, reused)
  const add = (geo, color, opacity) => { const o = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide}));
    o.visible = false; o.frustumCulled = false; scene.add(o); return o; };
  flash = add(new THREE.IcosahedronGeometry(1, 2), 0xfff0d0, 1);
  ring = add(new THREE.RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2), 0xffffff, 0.8);
  ready = true;
  m.updateMatrixWorld(true); for (const p of pieces) bake(p);   // JIT-warm the CPU skinning loop at load (cold first bake was 17 ms, warm 4 ms)
  warm = 3; for (const p of pieces) { p.holder.visible = true; p.holder.scale.setScalar(1e-6); } flash.visible = ring.visible = true; flash.scale.setScalar(1e-6); ring.scale.setScalar(1e-6);   // drawn invisibly a few frames: shaders compile now, not on the first explode
  log('gore', {pieces: pieces.map(p => p.parts.reduce((s, q) => s + (q.sw4.length >> 2), 0))});
}

// CPU-skin the current pose of region piece p into world space; returns centroid in p.pos (geometry relative to it)
function bake(p) {
  let cx = 0, cy = 0, cz = 0, cnt = 0;
  for (const part of p.parts) {
    const {sm, si4, sw4, bp, bn, geo, mats} = part, sk = sm.skeleton, n = sw4.length >> 2;
    _mA.multiplyMatrices(sm.matrixWorld, sm.bindMatrixInverse);
    for (let i = 0; i < sk.bones.length; i++) { _mB.multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]).multiply(sm.bindMatrix).premultiply(_mA); mats.set(_mB.elements, i * 16); }
    const P_ = geo.attributes.position.array, N_ = geo.attributes.normal.array;
    for (let k = 0; k < n; k++) {
      acc.fill(0);
      for (let j = 0; j < 4; j++) { const w = sw4[k * 4 + j]; if (!w) continue; const b = si4[k * 4 + j] * 16; for (let e = 0; e < 15; e++) acc[e] += w * mats[b + e]; }
      const x = bp[k * 3], y = bp[k * 3 + 1], z = bp[k * 3 + 2];
      const X = acc[0] * x + acc[4] * y + acc[8] * z + acc[12], Yv = acc[1] * x + acc[5] * y + acc[9] * z + acc[13], Z = acc[2] * x + acc[6] * y + acc[10] * z + acc[14];
      P_[k * 3] = X; P_[k * 3 + 1] = Yv; P_[k * 3 + 2] = Z; cx += X; cy += Yv; cz += Z; cnt++;
      {
        const a = bn[k * 3], b = bn[k * 3 + 1], c = bn[k * 3 + 2];
        let nx = acc[0] * a + acc[4] * b + acc[8] * c, ny = acc[1] * a + acc[5] * b + acc[9] * c, nz = acc[2] * a + acc[6] * b + acc[10] * c;
        const l = Math.hypot(nx, ny, nz) || 1; N_[k * 3] = nx / l; N_[k * 3 + 1] = ny / l; N_[k * 3 + 2] = nz / l;
      }
    }
  }
  if (!cnt) return false;
  p.pos.set(cx / cnt, cy / cnt, cz / cnt);
  let s2 = 0;
  for (const part of p.parts) {
    const A = part.geo.attributes.position.array;
    for (let i = 0; i < A.length; i += 3) { A[i] -= p.pos.x; A[i + 1] -= p.pos.y; A[i + 2] -= p.pos.z; s2 += A[i] * A[i] + A[i + 1] * A[i + 1] + A[i + 2] * A[i + 2]; }
    part.geo.attributes.position.needsUpdate = true; part.geo.attributes.normal.needsUpdate = true;
  }
  p.rad = Math.min(R_MAX, Math.max(R_MIN, R_K * Math.sqrt(s2 / cnt)));
  return true;
}

function blood(p, v, count, nrm, size) {
  const c = Math.min(budget, Math.round(count * P.gore));
  const st = nrm && size && stains < stainCap && P.gore > 0;
  if (c <= 0 && !st) return;
  budget -= Math.max(0, c);
  if (st) stains++;
  fx.splat(p, v, Math.max(0, c), st ? nrm : undefined, st ? size * Math.min(1.5, P.gore) : 0);
}

function* apply(req) {   // generator: the CPU bake is spread over frames (<= BAKE_VERTS per frame), pieces swap in when all are baked
  let t0 = performance.now(), ms = 0; const rig = riderRig();
  if (!rig) return;
  if (!ready) prep(rig.model);
  const kind = KINDS[req.kind] ? req.kind : 'oob', K = KINDS[kind], power = req.power ?? 1, body = rig.body;
  rig.model.updateMatrixWorld(true);
  const point = req.point ? V().copy(req.point) : rig.bones[0].getWorldPosition(V());
  if (!req.point && kind === 'edge') point.add(_a.randomDirection().multiplyScalar(0.6));   // no impact point: random side tears
  // which regions tear off
  let regs;
  if (kind === 'edge') {
    const cand = [1, 2, 3, 4, 5].filter(r => !detached.has(r) && pieces[r].root && pieces[r].parts.length);
    cand.sort((x, y) => pieces[x].root.getWorldPosition(_a).distanceToSquared(point) - pieces[y].root.getWorldPosition(_b).distanceToSquared(point));
    regs = cand.slice(0, Math.min(EDGE_MAX, 1 + Math.floor(Math.random() * (1 + 2 * Math.min(1, power)))));
  } else regs = [0, 1, 2, 3, 4, 5].filter(r => !detached.has(r) && pieces[r].parts.length);
  if (!regs.length) return;
  budget = K.blood; stains = 0; stainCap = K.stains; popAge = 0; glitchT = kind === 'glitch' ? GLITCH_T : 0;
  const all = regs.length + detached.size >= pieces.filter(p => p.parts.length).length;
  // stump points (world) of every tearing limb, before anything moves
  const stumpW = regs.filter(r => r).map(r => pieces[r].root.getWorldPosition(V()));
  // juice first (flash masks the swap; hitstop freezes the ragdoll while the bake runs)
  flash.position.copy(point); ring.position.set(point.x, Math.max(FLOOR_Y + 0.03, point.y - 0.6), point.z);
  flash.visible = ring.visible = true;
  fx.feathers(point, _v.set(0, 1.5, 0), K.feathers, 6 + 4 * power);
  if (K.hitstop) hud.hitstop(K.hitstop);
  if (K.shake) hud.shake(K.shake);
  const baked = [];
  let done = 0;
  for (const r of regs) {
    const n = pieces[r].parts.reduce((a, q) => a + (q.sw4.length >> 2), 0);
    if (done && done + n > BAKE_VERTS) { ms += performance.now() - t0; yield; t0 = performance.now(); done = 0; if (!riderRig()) return; rig.model.updateMatrixWorld(true); }
    if (bake(pieces[r])) baked.push(r);
    done += n;
  }
  for (const r of baked) {
    const p = pieces[r];
    detached.add(r);
    p.active = true; p.rest = false; p.landed = false; p.hit = false; p.sq = 0; p.sqv = 0; p.spurt = 0; p.trail = 0; p.q.identity(); p.jump.set(0, 0, 0);
    p.stumps = (r ? [stumpW[regs.filter(x => x).indexOf(r)]] : all ? stumpW : []).map(s => V().subVectors(s, p.pos));
    // velocity: inherited + radial blast + push along dir + up kick
    const j = body?.pts[RAG_NEAR[r]];
    if (req.vel) p.vel.copy(req.vel); else if (j) p.vel.copy(j.v).divideScalar(body.dt0 || 1 / 240); else p.vel.copy(S.vel);
    if (!Number.isFinite(p.vel.x + p.vel.y + p.vel.z) || p.vel.lengthSq() > 900) p.vel.set(0, 0, 0);
    _a.subVectors(p.pos, point); if (_a.lengthSq() < 1e-4) _a.randomDirection(); _a.normalize();
    p.vel.addScaledVector(_a, K.speed * power * (0.6 + 0.6 * Math.random())).addScaledVector(Y, K.up * power * (0.5 + Math.random()));
    if (req.dir) p.vel.addScaledVector(_b.copy(req.dir).normalize(), K.push * power);
    p.w.randomDirection().multiplyScalar(K.spin * power * (0.5 + Math.random()) * (r ? 1 : 0.4));
    p.axis.copy(p.vel).normalize();
    p.holder.visible = true; p.holder.position.copy(p.pos); p.inner.visible = true;
    // pop: a burst of drops from each stump
    for (const s of p.stumps) blood(_b.addVectors(p.pos, s), _v.copy(s).normalize().multiplyScalar(SPURT_V * 1.5).addScaledVector(p.vel, 0.5), BURST);
  }
  if (all) { for (const sm of meshes) sm.visible = false; hidden = true; }
  else for (const r of regs) {   // partial: shrink the torn limb on the skinned mesh, free its ragdoll joints
    const b = pieces[r].root; collapsed.push([b, b.scale.clone()]); b.scale.setScalar(COLLAPSE);
    if (body) { const cut = new Set(RAG_CUT[r]); body.links = body.links.filter(([i, k]) => !cut.has(i) && !cut.has(k)); }
  }
  log('gore', {kind, regs: regs.map(r => REGIONS[r]), ms: +(ms + performance.now() - t0).toFixed(1)});
}

function stepPiece(p, dt, g) {
  const h = dt / SUB;
  p.hit = false;
  for (let s = 0; s < SUB; s++) {
    p.vel.y -= g * h; p.vel.multiplyScalar(1 - AIR_DRAG * h);
    p.prev.copy(p.pos); p.pos.addScaledVector(p.vel, h);
    if (collide(p.pos, p.rad, p.prev, _n)) {
      const vn = p.vel.dot(_n);
      if (vn < 0) {
        const imp = -vn;
        p.vel.addScaledVector(_n, -(1 + BOUNCE) * vn);
        _v.copy(p.vel).addScaledVector(_n, -p.vel.dot(_n)); p.vel.addScaledVector(_v, FRICTION - 1);
        p.w.multiplyScalar(SPIN_KEEP);
        p.sqv -= Math.min(SQ_MAX, imp * SQ_KICK) * SQ_K * 0.08; p.axis.copy(_n);
        if (imp > SPLAT_V) {
          blood(_a.copy(p.pos).addScaledVector(_n, -p.rad), _v.copy(p.vel).multiplyScalar(0.25), 3, _n, STAIN_R * (p.landed ? 0.6 : 1));
          if (!p.landed) fx.feathers(p.pos, _v.set(0, 1, 0), 4, 2);
          p.landed = true;
        }
      }
      p.hit = true;
    }
    if (p.pos.y < FLOOR_Y + p.rad) { p.pos.y = FLOOR_Y + p.rad; if (p.vel.y < 0) p.vel.y = 0; p.hit = true; }
  }
  const sp = p.w.length();
  if (sp > 1e-5) p.q.premultiply(_q.setFromAxisAngle(_ax.copy(p.w).divideScalar(sp), sp * dt));
  if (p.hit && p.vel.lengthSq() < REST_V * REST_V) {   // asleep: leave a stain under it
    p.rest = true; p.vel.set(0, 0, 0); p.w.set(0, 0, 0);
    blood(_a.copy(p.pos).addScaledVector(Y, -p.rad), _v.set(0, 0, 0), 0, Y, REST_STAIN);
  }
}

function bleed(p, dt, age) {
  if (age > SPURT_T || !p.stumps.length || P.gore <= 0) return;
  const pulse = Math.max(0, Math.sin(age * SPURT_HZ * 6.283)) ** 2 * (1 - age / SPURT_T);
  p.spurt += pulse * SPURT_RATE * dt;
  if (p.spurt >= 1) {
    const n = Math.floor(p.spurt); p.spurt -= n;
    const s = p.stumps[Math.floor(Math.random() * p.stumps.length)];
    _b.copy(s).applyQuaternion(p.q);
    blood(_a.addVectors(p.pos, _b), _v.copy(_b).normalize().multiplyScalar(SPURT_V * (0.5 + pulse)).add(p.vel), n);
  }
  if (!p.rest && p.vel.lengthSq() > TRAIL_V * TRAIL_V && (p.trail += TRAIL_RATE * dt) >= 1) { p.trail -= 1; blood(p.pos, _v.copy(p.vel).multiplyScalar(0.3), 1); }
}

// stumps left on the (still skinned) rider after an 'edge' tear
function bleedBody(dt, age) {
  if (age > SPURT_T * 1.5 || P.gore <= 0) return;
  const pulse = Math.max(0, Math.sin(age * SPURT_HZ * 6.283)) ** 2;
  for (const [b] of collapsed) {
    if (Math.random() > pulse * SPURT_RATE * dt) continue;
    b.getWorldPosition(_a); b.parent.getWorldPosition(_b);
    blood(_a, _v.subVectors(_a, _b).normalize().multiplyScalar(SPURT_V), 1);
  }
}

function render(p, realAge, g) {
  const sp = p.vel.length();
  if (!p.hit && sp > 0.5) { p.axis.lerp(_v.copy(p.vel).divideScalar(sp), 0.3).normalize(); }
  const target = p.hit || p.rest ? 0 : Math.min(STRETCH_MAX, sp * STRETCH_K);
  p.sqv += (-SQ_K * (p.sq - target) - SQ_D * p.sqv) * g; p.sq = Math.max(-0.5, Math.min(0.6, p.sq + p.sqv * g));
  const k = realAge / POP_T, pop = k < 1 ? 1 + POP_AMP * Math.sin(k * Math.PI * POP_WOBBLE) * (1 - k) * (1 - k) : 1;
  const a = 1 + p.sq, b = 1 / Math.sqrt(Math.max(0.2, a));
  _q.setFromUnitVectors(Y, p.axis);
  p.holder.quaternion.copy(_q); p.holder.scale.set(b * pop, a * pop, b * pop);
  p.inner.quaternion.copy(_qi.copy(_q).invert()).multiply(p.q);
  p.holder.position.copy(p.pos);
  if (glitchT > 0) {
    if (Math.random() < GLITCH_FLICK) p.inner.visible = !p.inner.visible;
    if (Math.random() < GLITCH_FLICK) p.jump.randomDirection().multiplyScalar(GLITCH_JUMP * Math.random());
    if (Math.random() < GLITCH_FLICK) p.holder.scale.multiply(_v.set(1 + GLITCH_SNAP * (Math.random() - 0.5) * 2, 1 + GLITCH_SNAP * (Math.random() - 0.5) * 2, 1));
    p.holder.position.add(p.jump);
  } else p.inner.visible = true;
}

export const gore = {
  init(sc, f) { scene = sc; fx = f; window.gore = gore; },
  explode(req = {}) { if (!pending || req.kind !== 'edge' || pending.kind === 'edge') pending = req; },   // a full split is never downgraded to edge
  // main.js crash emit: hard crashes tear limbs off (bad angle or > AUTO_EDGE_V), big ones split him (> AUTO_FULL_V)
  onCrash(why) {
    if (AUTO_SKIP.includes(why) || P.violence <= 0) return;
    const v = S.vel.length();
    if (v >= AUTO_FULL_V) gore.explode({kind: 'big', dir: S.vel, power: Math.min(2, v / AUTO_FULL_V)});
    else if (v >= AUTO_EDGE_V || why === 'bad angle') { if (!pending) gore.explode({kind: 'edge', dir: S.vel, power: Math.min(2, Math.max(0.5, v / AUTO_EDGE_V))}); }
  },
  hidesRider() { return hidden; },
  isReady() { return ready; },
  // draw the (hidden) pieces + flash for a few frames with their final shadow flags: drivers compile lazily on first real draw
  warmDraw() { if (!ready) return; warm = 4; for (const p of pieces) if (!p.active) { p.holder.visible = true; p.holder.scale.setScalar(1e-6); } if (!detached.size) { flash.visible = ring.visible = true; flash.scale.setScalar(1e-6); ring.scale.setScalar(1e-6); } },
  reset() {
    pending = null; job = null; hidden = false; detached.clear(); glitchT = 0; popAge = 1e9;
    for (const sm of meshes) sm.visible = true;
    for (const [b, s] of collapsed) b.scale.copy(s);
    collapsed.length = 0;
    for (const p of pieces) { p.active = false; p.holder.visible = false; }
    if (flash) flash.visible = ring.visible = false;
  },
  update(dt) {
    const now = performance.now(), real = Math.min(0.1, (now - (lastT || now)) / 1000); lastT = now;
    const crashed = S.crashed > 0;
    if (wasCrashed && !crashed && (detached.size || pending)) gore.reset();   // back on the bike (R, respawn)
    wasCrashed = crashed;
    if (!ready) { const rig = riderRig(); if (rig) prep(rig.model); }   // split once the GLB is in
    if (warm && --warm === 0) { for (const p of pieces) if (!p.active) p.holder.visible = false; if (!detached.size) flash.visible = ring.visible = false; }
    if (job && job.next().done) job = null;
    if (pending && !job) { const r = pending; pending = null; job = apply(r); if (job.next().done) job = null; }
    const t0 = performance.now();
    if (!detached.size && !job) return;
    popAge += real; glitchT -= real;
    const g = P.gravity, ageBlood = popAge;
    for (const p of pieces) {
      if (!p.active) continue;
      if (!p.rest) stepPiece(p, dt, g);
      bleed(p, dt, ageBlood);
      render(p, popAge, Math.min(real, 1 / 30));
    }
    if (collapsed.length) bleedBody(dt, ageBlood);
    if (flash.visible) {
      const kf = popAge / FLASH_T, kr = popAge / RING_T;
      flash.visible = kf < 1; flash.scale.setScalar(0.2 + FLASH_R * Math.sqrt(Math.min(1, kf))); flash.material.opacity = Math.max(0, 1 - kf);
      ring.visible = kr < 1; ring.scale.setScalar(0.1 + RING_R * (1 - (1 - Math.min(1, kr)) ** 3)); ring.material.opacity = 0.8 * Math.max(0, 1 - kr);
    }
    const ms = performance.now() - t0; if (ms > 6) log('goreslow', {ms: +ms.toFixed(1)});
  },
};
