// DBZ-style trick juice, all pooled: white ribbon trails behind rider + rear wheel in the air, aura ring burst +
// camera-facing speed-line starburst on spins/flips/tricks, 3 fading afterimages (one SkeletonUtils clone each,
// transforms copied from the live bike+rider), and a ground flash ring + screen flash on landing.
// main.js: const trails = createTrails(scene, bike.group, camera); trails.event(type, d, S) in the emit; trails.update(fdt, S).
import * as THREE from 'three';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';

// ---- tunables ----
const TRAIL_DBZ = 4, TRAIL_A = 0.15, TRAIL_N = 48, TRAIL_W = [0.22, 0.12], TRAIL_H = [1.15, 0.3], TRAIL_BACK = [0.15, 0.5], TRAIL_FADE = 0.45, TRAIL_WOBBLE = 0.05;   // points; width (m) rider/wheel; height above contact, offset back (m); s a point lives after landing; feathery edge wobble
const SPIN_RATE = 5, AURA_T = 0.35, AURA_R = [0.4, 2.2], AURA_CD = 0.25, AURA_COLOR = 0xfff2a0;   // rad/s that counts as fast rotation; aura ring life (s), radius from/to (m), min gap (s)
const LINES = 36, LINES_T = 0.28, LINES_R = [0.9, 3.2];   // speed-line starburst: lines, life (s), inner/outer radius (m)
const GHOSTS = 3, GHOST_EVERY = 0.06, GHOST_T = 0.3, GHOST_A = 0.35, GHOST_COLOR = 0x9fd8ff;   // afterimages: copies, s between snapshots, life (s), start opacity, tint
const FLASH_T = 0.3, FLASH_R = [0.3, 2.5], FLASH_MIN_AIR = 0.5;   // landing ground ring life (s), radius (m); air time that earns a flash

export function createTrails(scene, bikeGroup, camera) {
  const V = () => new THREE.Vector3(), add = new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide});
  const tmp = V(), tmp2 = V(), side = V(), toCam = V(), up = new THREE.Vector3(0, 1, 0);

  // ribbons: ring buffer of points (+age), rebuilt as a strip each frame; vertex alpha fades along length and age
  const ribbons = TRAIL_W.map((w, ri) => {
    const pos = new Float32Array(TRAIL_N * 2 * 3), col = new Float32Array(TRAIL_N * 2 * 4), idx = [];
    for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry(); g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false}));
    m.frustumCulled = false; scene.add(m);
    return {w, ri, m, pos, col, pts: Array.from({length: TRAIL_N}, () => ({p: V(), age: 99})), head: 0};
  });

  // aura rings (pooled) and one starburst
  const rings = Array.from({length: 4}, () => { const r = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), add.clone()); r.material.color.set(AURA_COLOR); r.visible = false; r.userData.t = 0; scene.add(r); return r; });
  const lp = new Float32Array(LINES * 2 * 3), lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  const burst = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false}));
  burst.visible = false; burst.frustumCulled = false; burst.userData.t = 0; scene.add(burst);
  let ringNext = 0, auraCd = 0;
  function aura(at, flat, color, r0, r1, life) {
    const r = rings[ringNext]; ringNext = (ringNext + 1) % rings.length;
    r.position.copy(at); r.userData = {t: life, life, r0, r1};
    if (flat) r.quaternion.setFromUnitVectors(tmp.set(0, 0, 1), up); else r.quaternion.copy(camera.quaternion);
    r.material.color.set(color); r.visible = true;
  }
  function lines(at) {
    for (let i = 0; i < LINES; i++) {
      const a = Math.random() * 6.283, r0 = LINES_R[0] * (0.8 + Math.random() * 0.4), r1 = LINES_R[1] * (0.6 + Math.random() * 0.4);
      lp.set([Math.cos(a) * r0, Math.sin(a) * r0, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0], i * 6);
    }
    lineGeo.attributes.position.needsUpdate = true;
    burst.position.copy(at); burst.quaternion.copy(camera.quaternion); burst.userData.t = LINES_T; burst.visible = true;
  }

  // afterimages: built lazily once the rider GLB is in the bike group (node lists must match to copy transforms)
  let ghosts = null, ghostT = 0, ghostNext = 0, ghostPoll = 0, warm = 0;
  const src = [];
  function buildGhosts() {
    src.length = 0; bikeGroup.traverse(o => src.push(o));
    if (!src.some(o => o.isSkinnedMesh)) return null;
    return Array.from({length: GHOSTS}, () => {
      const g = skClone(bikeGroup), nodes = [], mat = new THREE.MeshBasicMaterial({color: GHOST_COLOR, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false});
      g.traverse(o => { nodes.push(o); if (o.isMesh) { o.material = mat; o.frustumCulled = false; } });
      g.visible = false; g.matrixAutoUpdate = true; scene.add(g);
      return {g, nodes, mat, t: 0};
    });
  }
  function snapshot() {
    src.length = 0; bikeGroup.traverse(o => src.push(o));
    const gh = ghosts[ghostNext]; if (gh.nodes.length !== src.length) return;   // rider detached (crash): skip
    ghostNext = (ghostNext + 1) % GHOSTS;
    for (let i = 0; i < src.length; i++) { const a = src[i], b = gh.nodes[i]; b.position.copy(a.position); b.quaternion.copy(a.quaternion); b.scale.copy(a.scale); b.visible = a.visible; }
    gh.g.visible = true; gh.t = GHOST_T;
  }

  let wasAir = false;
  return {
    event(type, d, S) {   // DBZ juice (aura + lines) on tricks only with a full special bar
      if (type === 'specialStart' || (type === 'trickStart' && (S.specialReady || S.special))) { aura(tmp.copy(S.pos).addScaledVector(S.up, 0.8), false, type === 'specialStart' ? 0xffd040 : AURA_COLOR, AURA_R[0], AURA_R[1] * (type === 'specialStart' ? 1.6 : 1), AURA_T); lines(tmp); }
      if (type === 'land' && !d.soft && d.airT > FLASH_MIN_AIR) {
        aura(tmp.copy(S.pos).addScaledVector(S.gN, -0.27), true, 0xffffff, FLASH_R[0], FLASH_R[1] * (d.clean ? 1.4 : 1), FLASH_T);
        if (d.clean) globalThis.hud?.flash?.();
      }
    },
    update(dt, S) {
      const dbz = !!(S.specialReady || S.special);
      const air = !S.grounded && !S.grind && !(S.crashed > 0);
      // ribbons
      camera.getWorldPosition(toCam);
      for (const R of ribbons) {
        for (const q of R.pts) q.age += dt;
        if (air) {
          const q = R.pts[R.head = (R.head + 1) % TRAIL_N];
          q.p.copy(S.pos).addScaledVector(S.up, TRAIL_H[R.ri] - 0.3).addScaledVector(S.fwd, -TRAIL_BACK[R.ri]); q.age = 0;
        }
        for (let k = 0; k < TRAIL_N; k++) {
          const q = R.pts[(R.head - k + TRAIL_N) % TRAIL_N], nq = R.pts[(R.head - k - 1 + TRAIL_N) % TRAIL_N];
          tmp2.subVectors(q.p, nq.p); side.crossVectors(tmp2, tmp.subVectors(toCam, q.p)); const sl = side.length();
          const f = 1 - k / TRAIL_N, a = q.age > 50 ? 0 : Math.max(0, 1 - q.age / TRAIL_FADE) * f * f * TRAIL_A * (dbz ? TRAIL_DBZ : 1);
          const w = R.w * f * (1 + TRAIL_WOBBLE / R.w * Math.sin(k * 1.7 + q.age * 20));   // feathery ragged edge
          if (sl > 1e-6) side.multiplyScalar(w / sl); else side.set(0, 0, 0);
          R.pos.set([q.p.x + side.x, q.p.y + side.y, q.p.z + side.z, q.p.x - side.x, q.p.y - side.y, q.p.z - side.z], k * 6);
          R.col.set([1, 1, 1, a, 1, 1, 1, a * 0.6], k * 8);
        }
        R.m.geometry.attributes.position.needsUpdate = true; R.m.geometry.attributes.color.needsUpdate = true;
      }
      if (air && !wasAir) for (const R of ribbons) for (const q of R.pts) { q.p.copy(S.pos); q.age = 99; }   // new air: start clean
      wasAir = air;
      // fast rotation: aura + speed lines (rate-limited) and afterimages
      // aura / speed lines / ghosts / intense (TRAIL_DBZ x) trails only while the special bar is full or a special runs
      const fast = dbz && air && (Math.abs(S.yawRate) > SPIN_RATE || Math.abs(S.pitchRate) > SPIN_RATE * 0.8 || S.whip || S.bar || S.special);
      if ((auraCd -= dt) <= 0 && fast) { auraCd = AURA_CD; aura(tmp.copy(S.pos).addScaledVector(S.up, 0.8), false, AURA_COLOR, AURA_R[0], AURA_R[1], AURA_T); lines(tmp); }
      // ghosts are built as soon as the rider GLB is loaded (polled), then drawn once at opacity 0 so shaders compile before the first trick
      if (!ghosts && (ghostPoll -= dt) <= 0) { ghostPoll = 0.5; ghosts = buildGhosts(); if (ghosts) { warm = 2; for (const gh of ghosts) { gh.g.visible = true; gh.mat.opacity = 0; } } }
      if (warm && --warm === 0) for (const gh of ghosts) if (gh.t <= 0) gh.g.visible = false;
      if (fast && ghosts && (ghostT -= dt) <= 0) { ghostT = GHOST_EVERY; snapshot(); }
      if (ghosts && !warm) for (const gh of ghosts) if (gh.g.visible) { gh.t -= dt; gh.mat.opacity = Math.max(0, gh.t / GHOST_T) * GHOST_A; if (gh.t <= 0) gh.g.visible = false; }
      for (const r of rings) if (r.visible) {
        const u = r.userData; u.t -= dt; const k = 1 - Math.max(0, u.t) / u.life;
        r.scale.setScalar(u.r0 + (u.r1 - u.r0) * Math.sqrt(k)); r.material.opacity = (1 - k) * 0.8; if (u.t <= 0) r.visible = false;
      }
      if (burst.visible) { const u = burst.userData; u.t -= dt; burst.material.opacity = Math.max(0, u.t / LINES_T); burst.scale.setScalar(1 + (1 - u.t / LINES_T) * 0.5); if (u.t <= 0) burst.visible = false; }
    },
  };
}
