// Verlet particle bodies for crashes: points + distance links, collide via physics.collide.
// Bike = 4 rigid points (tumbles and lies down by itself); rider = 15 joints driving the bones.
import * as THREE from 'three';
import { collide } from './physics.js';

const ITERS = 8, SUB = 4, DAMP = 0.998, MU = 0.6, COLLIDE_EVERY = 2;   // constraint passes, substeps/frame, air damping, sliding friction coefficient, collide every Nth pass

// pts: [{p: Vector3, r}], vel: initial velocity, links: [[i, j], ...] (rest = current distance).
// Extra links [i, j, L, 1] pushed later are minimum distances (only push apart).
export function makeBody(pts, vel, links, dt0 = 1 / 240) {
  for (const q of pts) { q.prev = q.p.clone().addScaledVector(vel, -dt0); q.n = new THREE.Vector3(); q.v = new THREE.Vector3(); q.hit = false; q.impact = 0; }
  return {pts, dt0, links: links.map(([i, j]) => [i, j, pts[i].p.distanceTo(pts[j].p)])};
}

const v = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
export function stepBody(b, dt, gravity) {
  const h = Math.min(dt, 0.05) / SUB;
  for (let s = 0; s < SUB; s++) {
    for (const q of b.pts) {   // integrate (velocity rescaled if the step changed)
      v.subVectors(q.p, q.prev).multiplyScalar(DAMP * h / b.dt0);
      q.v.copy(v); q.prev.copy(q.p); q.p.add(v); q.p.y -= gravity * h * h; q.hit = false;
    }
    b.dt0 = h;
    for (let k = 0; k < ITERS; k++) {
      for (const [i, j, L, min] of b.links) {
        const A = b.pts[i].p, B = b.pts[j].p; d.subVectors(B, A); const l = d.length() || 1e-6;
        if (min && l >= L) continue;
        const c = (l - L) / l * 0.5; A.addScaledVector(d, c); B.addScaledVector(d, -c);
      }
      if (k % COLLIDE_EVERY === COLLIDE_EVERY - 1) for (const q of b.pts) if (collide(q.p, q.r, q.prev, n)) { q.hit = true; q.n.copy(n); }   // collisions on every Nth pass (incl. the last): halves octree queries
    }
    for (const q of b.pts) if (q.hit) {   // inelastic hit + Coulomb friction (displacement units)
      const n = q.n; q.impact = Math.max(q.impact, -q.v.dot(n) / h); v.subVectors(q.p, q.prev); const vn = Math.max(0, v.dot(n));
      v.addScaledVector(n, -v.dot(n)); const vt = v.length();
      if (vt > 1e-9) v.multiplyScalar(Math.max(0, vt - MU * gravity * h * h) / vt);
      q.prev.subVectors(q.p, v.addScaledVector(n, vn));
    }
  }
}
