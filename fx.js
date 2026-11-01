// Effects: wheel skid marks and blood (drops fly, stretch with speed, then stain whatever they hit:
// elongated along the impact direction with satellite specks; sliding smears; a pool grows under a still body).
import * as THREE from 'three';
import { FLOOR_Y } from './physics.js';

const MAX_SKID = 4000, SKID_STEP = 0.12, SKID_W = 0.05, SKID_OPACITY = 0.35, LIFT = 0.012;
const MAX_DROPS = 1500, MAX_STAINS = 4000, DROP_R0 = 0.01, DROP_R1 = 0.04, DROP_SPREAD = 4, DROP_LIFE = 3, DROP_STRETCH = 0.08;
const STAIN_K = 2.5, STAIN_SPD = 0.05, STAIN_ELONG = 6, SATS = 5, SAT_R = 0.3, SAT_MIN_V = 3;   // stain size per drop radius, growth per m/s, max stretch, specks
const POOL_RATE = 0.15, POOL_MAX = 1.2, POOL_MOVE = 0.4;   // pool growth (m/s), max radius (m), body drift that starts a new pool (m)
const FEATHER_CHECK = 4;   // feathers test level collision every Nth frame (staggered), looking N frames ahead
const MAX_FEATHERS = 300, FEATHER_LIFE = 3, FEATHER_G = 0.08, FEATHER_DRAG = 3, FLUTTER = 1.2, FEATHER_SPIN = 6, FEATHER_SIZE = [0.025, 0.08];   // white feathers: gravity fraction, air drag (1/s), sway (m/s), tumble (rad/s), w×l (m)
const MAX_SPARKS = 240, SPARK_LIFE = 0.22, SPARK_SPREAD = 3, SPARK_W = 0.008, SPARK_STRETCH = 0.035, SPARK_COLOR = 0xffb050;   // grind sparks: pooled additive streaks, length = speed x stretch (s), no collision
const RED0 = new THREE.Color(0x2a0000), RED1 = new THREE.Color(0x8a0505);

export function createFx(scene, octree, gravity) {
  const mat = (color, opacity) => new THREE.MeshBasicMaterial({color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
  const wet = opacity => new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.15, metalness: 0.1, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
  const inst = (geo, material, max) => { const o = new THREE.InstancedMesh(geo, material, max); o.count = 0; o.frustumCulled = false; o.userData.i = 0; scene.add(o); return o; };
  const skids = inst(new THREE.PlaneGeometry(SKID_W, 1).rotateX(-Math.PI / 2), mat(0x111111, SKID_OPACITY), MAX_SKID);
  const stains = inst(new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2), wet(0.92), MAX_STAINS);
  const dropMesh = inst(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshStandardMaterial({roughness: 0.2}), MAX_DROPS);
  const fMesh = inst(new THREE.PlaneGeometry(FEATHER_SIZE[0], FEATHER_SIZE[1]), new THREE.MeshLambertMaterial({color: 0xffffff, side: THREE.DoubleSide}), MAX_FEATHERS);
  // sparks: fixed pool (ring), unit streak along +z centred on the head; additive + no tone mapping so they glow
  const sMesh = inst(new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5), new THREE.MeshBasicMaterial({color: SPARK_COLOR, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false}), MAX_SPARKS);
  const sparkPool = Array.from({length: MAX_SPARKS}, () => ({p: new THREE.Vector3(), v: new THREE.Vector3(), t: 0, t0: 1}));
  let sparkNext = 0;
  const pool = new THREE.Mesh(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2), wet(0.95));
  pool.material.color.copy(RED0).lerp(RED1, 0.3); pool.visible = true; pool.scale.setScalar(1e-6); scene.add(pool); let warm = 3;   // drawn invisibly for a few frames so its shader compiles at load, not on the first crash
  for (const o of [stains, dropMesh]) o.setColorAt(0, RED0);   // instanceColor exists before the first render (else a shader recompile on first blood)
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), x = new THREE.Vector3(), y = new THREE.Vector3(), d = new THREE.Vector3(), t = new THREE.Vector3(), s3 = new THREE.Vector3(),
    mid = new THREE.Vector3(), sc = new THREE.Vector3(), n = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1), ray = new THREE.Ray(), col = new THREE.Color();
  const red = () => col.copy(RED0).lerp(RED1, Math.random());
  const put = (o, mx, c) => { const i = o.userData.i; o.setMatrixAt(i, mx); if (c) { o.setColorAt(i, c); o.instanceColor.needsUpdate = true; }
    o.userData.i = (i + 1) % o.instanceMatrix.count; o.count = Math.min(o.count + 1, o.instanceMatrix.count); o.instanceMatrix.needsUpdate = true; };
  const last = [];
  let poolR = 0;
  // pooled particles (no per-spawn allocation); live ones are [0, n), dead ones swapped to the end
  const mk = (N, f) => Array.from({length: N}, f), V = () => new THREE.Vector3(), tt = V(), xx = V();
  const drops = mk(MAX_DROPS, () => ({p: V(), v: V(), t: 0, r: 0, c: new THREE.Color()})), feathers = mk(MAX_FEATHERS, () => ({p: V(), v: V(), q: new THREE.Quaternion(), w: V(), ph: 0, t: 0, rest: false}));
  let nD = 0, nF = 0, fTick = 0, warmF = 0;
  const Z0 = new THREE.Matrix4().makeScale(0, 0, 0);
  const swap = (a, i, j) => { const o = a[i]; a[i] = a[j]; a[j] = o; };
  // bounded segment test: octree.rayIntersect gathers triangles along the infinite ray (whole tree) -> was the crash hitch
  const tris = [], qs = new THREE.Sphere(), hp = V(), hit = {p: V(), n: V()};
  function seg(o, dir, len, r) {
    qs.center.copy(o).addScaledVector(dir, len * 0.5); qs.radius = len * 0.5 + r;
    tris.length = 0; octree.getSphereTriangles(qs, tris); if (!tris.length) return null;
    ray.set(o, dir); let best = len + r, bt = null;
    for (const tr of tris) if (ray.intersectTriangle(tr.a, tr.b, tr.c, false, hp)) { const dd = hp.distanceTo(o); if (dd <= best) { best = dd; bt = tr; hit.p.copy(hp); } }
    if (!bt) return null; bt.getNormal(hit.n); return hit;
  }

  // ellipse of radius s on the surface; long axis along v's tangential part, stretched by the impact angle (or by e if given)
  function stain(p, nrm, s, v, e, sats = true) {
    t.copy(v || d.randomDirection()).addScaledVector(nrm, -t.dot(nrm));
    if (t.lengthSq() < 1e-8) { t.set(Math.abs(nrm.x) > 0.9 ? 0 : 1, 0, Math.abs(nrm.x) > 0.9 ? 1 : 0); t.addScaledVector(nrm, -t.dot(nrm)); }
    const vt = t.length(); t.divideScalar(vt);
    const shift = e === undefined;
    if (shift) e = v ? Math.min(STAIN_ELONG, Math.hypot(vt, v.dot(nrm)) / Math.max(Math.abs(v.dot(nrm)), 1e-3)) : 0.6 + Math.random() * 0.8;
    x.crossVectors(nrm, t);
    mid.copy(p).addScaledVector(nrm, LIFT * (1 + Math.random())); if (shift) mid.addScaledVector(t, s * (e - 1) * 0.5);
    put(stains, m.makeBasis(x, nrm, t).scale(sc.set(s, 1, s * e)).setPosition(mid), red());
    if (sats && v && v.length() > SAT_MIN_V) {   // specks thrown ahead along the travel direction
      tt.copy(t); xx.copy(x); const k = Math.floor(Math.random() * SATS);
      for (let i = 0; i < k; i++)
        stain(s3.copy(p).addScaledVector(tt, s * e * (0.8 + Math.random() * 2)).addScaledVector(xx, s * (Math.random() - 0.5) * 2), nrm, s * SAT_R * Math.random(), v, undefined, false);
    }
  }
  return {
    // wheel i touching at p with surface normal nrm; p = null lifts the wheel (breaks the line)
    skid(i, p, nrm) {
      if (!p) { last[i] = null; return; }
      if (!last[i]) { last[i] = p.clone(); return; }
      const len = d.subVectors(p, last[i]).length();
      if (len < SKID_STEP) return;
      if (len < 1) {
        d.divideScalar(len); x.crossVectors(nrm, d).normalize(); y.crossVectors(d, x);
        m.makeBasis(x, y, d).scale(sc.set(1, 1, len)).setPosition(mid.addVectors(p, last[i]).multiplyScalar(0.5).addScaledVector(y, LIFT));
        put(skids, m);
      }
      last[i].copy(p);
    },
    // count drops from p with base velocity v, plus a splash stain on the surface if nrm is given
    splat(p, v, count, nrm, size = 0) {
      for (let k = 0; k < count && nD < MAX_DROPS; k++) {
        const o = drops[nD++]; o.p.copy(p); o.v.copy(v).add(d.randomDirection().multiplyScalar(DROP_SPREAD * Math.random()));
        o.t = DROP_LIFE; o.r = DROP_R0 + (DROP_R1 - DROP_R0) * Math.random() ** 2; o.c.copy(red());
      }
      if (nrm && size) stain(p, nrm, size, v);
    },
    // body part sliding at p (surface normal nrm, velocity v) for dt: streak of width w
    smear(p, nrm, v, dt, w) {
      const len = v.length() * dt;
      stain(mid.copy(p).addScaledVector(v, -dt * 0.5), nrm, w * (0.6 + Math.random() * 0.5), v, Math.max(1, len / w + 0.5), false);
    },
    // pool growing at p (normal nrm); p = null leaves it as a stain and resets
    pool(p, nrm, dt) {
      if (pool.visible && (!p || pool.position.distanceTo(p) > poolR + POOL_MOVE)) {
        stain(pool.position, n.copy(Y).applyQuaternion(pool.quaternion), poolR, null, 1, false); pool.visible = false;
      }
      if (!p) return;
      if (!pool.visible) { poolR = 0.05; pool.visible = true; pool.position.copy(p).addScaledVector(nrm, LIFT * 2); pool.quaternion.setFromUnitVectors(Y, nrm).multiply(q.setFromAxisAngle(Y, Math.random() * 6.3)); }
      poolR = Math.min(POOL_MAX, poolR + POOL_RATE * dt / (1 + poolR * 2));
      pool.scale.set(poolR, 1, poolR * 0.75);
    },
    // count white feathers from p drifting with velocity v
    feathers(p, v, count, spread = 0.4) {
      for (let k = 0; k < count && nF < MAX_FEATHERS; k++) {
        const o = feathers[nF++]; o.p.copy(p).add(d.randomDirection().multiplyScalar(0.15)); o.v.copy(v).add(d.randomDirection().multiplyScalar(spread * (0.3 + Math.random())));
        o.q.random(); o.w.randomDirection().multiplyScalar(FEATHER_SPIN); o.ph = Math.random() * 6.3; o.t = FEATHER_LIFE * (0.6 + Math.random() * 0.4); o.rest = false;
      }
    },
    // count sparks from p with base velocity v (grinding)
    sparks(p, v, count) {
      for (let k = 0; k < count; k++) {   // reuses the oldest slot when full (capped, no allocation)
        const o = sparkPool[sparkNext]; sparkNext = (sparkNext + 1) % MAX_SPARKS;
        o.p.copy(p); o.v.copy(v).add(t.randomDirection().multiplyScalar(SPARK_SPREAD * (0.4 + Math.random()))); if (o.v.y < 0) o.v.y *= -0.5;
        o.t = o.t0 = SPARK_LIFE * (0.5 + Math.random() * 0.5);
      }
    },
    // draw one zero-size drop/stain/feather for a few frames so the driver compiles those programs before the first crash
    warm() { warmF = 4; if (!stains.count) for (let i = 0; i < MAX_STAINS; i++) stains.setMatrixAt(i, Z0); for (const o of [dropMesh, stains, fMesh]) o.instanceMatrix.needsUpdate = true; },
    update(dt) {
      const t0 = performance.now();
      fTick++;
      if (warm && --warm === 0 && poolR === 0) { pool.visible = false; pool.scale.setScalar(1); }
      let si = 0;
      for (const o of sparkPool) {
        if (o.t <= 0 || (o.t -= dt) <= 0) continue;
        o.v.y -= gravity() * dt; o.p.addScaledVector(o.v, dt);
        if (o.p.y < FLOOR_Y + 0.01) { o.p.y = FLOOR_Y + 0.01; o.v.y *= -0.3; o.v.x *= 0.6; o.v.z *= 0.6; }   // bounce off the floor, never below
        const sp = o.v.length(), f = o.t / o.t0;   // streak along the velocity, thins out as it dies
        q.setFromUnitVectors(Z, d.copy(o.v).divideScalar(sp || 1));
        sMesh.setMatrixAt(si++, m.compose(o.p, q, sc.set(SPARK_W * f, SPARK_W * f, Math.max(0.02, sp * SPARK_STRETCH) * (0.5 + 0.5 * f))));
      }
      sMesh.count = si; if (si) sMesh.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < nF; i++) {
        const o = feathers[i];
        if ((o.t -= dt) <= 0) { swap(feathers, i--, --nF); continue; }
        if (!o.rest) {
          o.v.y -= gravity() * FEATHER_G * dt; o.v.multiplyScalar(Math.exp(-FEATHER_DRAG * dt)); o.ph += dt * 4;
          d.copy(o.v).add(t.set(Math.sin(o.ph), 0, Math.cos(o.ph * 0.7)).multiplyScalar(FLUTTER)).multiplyScalar(dt);
          const len = d.length();
          if (len > 1e-6) { const h = (fTick + i) % FEATHER_CHECK === 0 && seg(o.p, t.copy(d).divideScalar(len), len * FEATHER_CHECK, 0.01); if (h) { o.p.copy(h.p).addScaledVector(Y, 0.01); o.rest = true; } else o.p.add(d); }   // staggered: each feather tests FEATHER_CHECK frames of travel ahead
          if (o.p.y < FLOOR_Y + 0.01) { o.p.y = FLOOR_Y + 0.01; o.rest = true; }
          o.q.premultiply(q.setFromAxisAngle(t.copy(o.w).normalize(), FEATHER_SPIN * dt));
        }
        const sz = Math.min(1, o.t * 2);
        fMesh.setMatrixAt(i, m.compose(o.p, o.q, sc.set(sz, sz, sz)));
      }
      fMesh.count = nF; fMesh.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < nD; i++) {
        const o = drops[i];
        o.v.y -= gravity() * dt;
        const sp = o.v.length(), step = sp * dt;
        if (step > 1e-5) {
          const h = seg(o.p, d.copy(o.v).divideScalar(sp), step, o.r);
          if (h) {
            if (h.n.dot(d) > 0) h.n.negate();
            stain(h.p, h.n, o.r * STAIN_K * (1 + sp * STAIN_SPD), o.v); swap(drops, i--, --nD); continue;
          }
        }
        o.p.addScaledVector(o.v, dt);
        if ((o.t -= dt) <= 0 || o.p.y < FLOOR_Y - 1) { swap(drops, i--, --nD); continue; }
        q.setFromUnitVectors(Z, d.copy(o.v).divideScalar(sp || 1));
        dropMesh.setMatrixAt(i, m.compose(o.p, q, sc.set(o.r, o.r, o.r * (1 + sp * DROP_STRETCH)))); dropMesh.setColorAt(i, o.c);
      }
      dropMesh.count = nD;
      if (warmF > 0) { warmF--; for (const o of [dropMesh, fMesh]) if (!o.count) { o.setMatrixAt(0, Z0); o.count = 1; } if (!stains.count) { stains.setMatrixAt(0, Z0); stains.count = 1; stains.userData.i = 0; } if (!warmF && stains.count === 1 && stains.userData.i === 0) stains.count = 0; }
      dropMesh.instanceMatrix.needsUpdate = true; if (dropMesh.instanceColor) dropMesh.instanceColor.needsUpdate = true;
      const ms = performance.now() - t0; if (ms > 6) log('fxslow', {ms: +ms.toFixed(1), drops: nD, feathers: nF});
    },
  };
}
