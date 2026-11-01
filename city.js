// Visual-only surroundings: sidewalk, street, buildings, lamps, bins, cones, trees, chain-link fence, graffiti.
// Nothing here is in the collision octree: it is flat on the ground, outside the park wall (level.js BOUNDS),
// or a decal on a surface that already collides (park slab + wall/fence collider are in level.js). Few draw calls: merged geometry + InstancedMesh.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARK, PERIM, FEATURES } from './level.js';
const BOUNDS = {x0: PARK.xMin, x1: PARK.xMax, z0: PARK.zMin, z1: PARK.zMax}, WALL_H = PERIM.h, WALL_T = PERIM.t, FENCE_H = PERIM.fence;

const PAVE_M = 3, SIDEWALK = 4, CURB_H = 0.12, ROAD = 9, BLOCK_GAP = 2;   // paving slab (m), street ring widths (m)
const LAMP_STEP = 16, LAMP_H = 6, LAMP_ARM = 1.6, POST_STEP = 3;         // lamp spacing/height, fence post spacing (m)
const BLD_W = [10, 22], BLD_D = [10, 18], BLD_H = [8, 34], BLD_FLOOR = 3.2, BLD_BAY = 3.5, SEED = 7;
const BLD_COLORS = [0xc9b8a0, 0xa89a8c, 0xb5674d, 0x8d8f93, 0xd8d0c0, 0x9c7b62, 0x7f8a8c];
const DECAL_OFF = 0.015, DECAL_LAYER = 0.008, DECAL_LAYERS = 4, DECAL_INSET = 0.01;   // m off the surface (+ per-decal layer so overlaps don't z-fight), atlas UV inset
const RAY_BACK = 1, CORNER_BACK = 0.3, PLANE_TOL = 0.02, ARC_TOL = 0.08, MAX_NY = 0.3, SHRINK = 0.7, TRIES = 3;   // decal placement raycasts (m)
// attempts per m of face length, decal width range (m), max in-plane tilt (rad)
const GRAF_KIND = {park: {dens: 0.4, w: [0.6, 2.2]}, wall: {dens: 0.16, w: [0.5, 1.4]}, ledge: {dens: 0.3, w: [0.3, 0.75]}, bld: {dens: 0.07, w: [1.4, 4.2]}}, GRAF_TILT = 0.2;
const GRAF_PICK = [0.3, 0.5, 0.2];   // sheet weights (graffiti2 = keyed tags, layers best)
// atlases built from the Gemini sheets: [file, cols, rows, tile aspect w/h]; graffiti2 is keyed (alpha)
const GOOD_TILES = [[1, 2, 3, 8, 9, 11, 12, 15, 17, 21, 22], [0, 1, 3, 5, 6, 8, 10, 11, 13, 15, 17, 18, 20, 21, 22], [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]];   // tiles that read well large
const GRAF = [['data/graffiti1.webp', 5, 5, 204 / 114], ['data/graffiti2.webp', 5, 5, 204 / 114], ['data/graffiti3.webp', 5, 3, 192 / 188]];

let seed = SEED;
const rnd = (a = 0, b = 1) => { seed = (seed * 16807) % 2147483647; return a + (b - a) * (seed - 1) / 2147483646; };
const lambert = o => new THREE.MeshLambertMaterial(o);

function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const tint = (g, color) => {   // per-vertex color so differently tinted pieces share one merged mesh
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(a, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g;
};
const worldUV = (g, m) => {    // planar uv from world x/z (top faces) so paving joints line up across pieces
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / m, p.getZ(i) / m);
  return g;
};
const slab = (x0, z0, x1, z1, y, color, h = 0) => tint(worldUV((h ? new THREE.BoxGeometry(x1 - x0, h, z1 - z0) : new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2))
  .translate((x0 + x1) / 2, h ? h / 2 : y, (z0 + z1) / 2), PAVE_M), color);   // h > 0: raised box (sidewalk with curb faces)
// 4 non-overlapping strips framing rect r, d wide
const ring = (r, d, f) => [f(r.x0 - d, r.z0 - d, r.x1 + d, r.z0), f(r.x0 - d, r.z1, r.x1 + d, r.z1 + d), f(r.x0 - d, r.z0, r.x0, r.z1), f(r.x1, r.z0, r.x1 + d, r.z1)];
// decal candidate faces: at(s 0..1) -> [x, z, nx, nz]; y1 = top of the face; tol = how flat the face is
const line = (a, b, n, y1, kind) => ({len: Math.hypot(b[0] - a[0], b[1] - a[1]), y1, kind, tol: PLANE_TOL, at: s => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, n[0], n[1]]});
const arc = (cx, cz, r, p0, p1, y1, kind = 'park') => ({len: r * Math.abs(p1 - p0), y1, kind, tol: ARC_TOL, at: s => { const p = p0 + (p1 - p0) * s; return [cx + r * Math.sin(p), cz + r * Math.cos(p), Math.sin(p), Math.cos(p)]; }});
const grow = (r, d) => ({x0: r.x0 - d, x1: r.x1 + d, z0: r.z0 - d, z1: r.z1 + d});
function instanced(geo, mat, list) {   // list of [x, y, z, ry, scale]
  const m = new THREE.InstancedMesh(geo, mat, list.length), o = new THREE.Object3D();
  list.forEach(([x, y, z, ry = 0, s = 1], i) => { o.position.set(x, y, z); o.rotation.set(0, ry, 0); o.scale.setScalar(s); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
  return m;
}

export function buildCity(scene, octree) {
  const city = new THREE.Group(), B = BOUNDS, inner = grow(B, WALL_T), walk = grow(inner, SIDEWALK), road = grow(walk, ROAD);

  // ---- ground: raised sidewalk around the park wall (joint texture), asphalt ring ----
  const pave = canvasTex(64, (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); g.fillStyle = '#c4c4c4'; g.fillRect(0, 0, s, 2); g.fillRect(0, 0, 2, s);
    for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(0,0,0,${rnd(0.02, 0.06)})`; g.fillRect(rnd(0, s), rnd(0, s), 2, 2); } });
  const paving = [...ring(inner, SIDEWALK, (a, b, c, d) => slab(a, b, c, d, 0, 0xbab6ae, CURB_H))];
  city.add(new THREE.Mesh(mergeGeometries(paving), lambert({map: pave, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1})));
  const asphalt = ring(walk, ROAD, (a, b, c, d) => slab(a, b, c, d, 0.005, 0x47494d));
  for (const [len, horiz, at] of [[walk.x1 - walk.x0, true, walk.z0 - ROAD / 2], [walk.x1 - walk.x0, true, walk.z1 + ROAD / 2], [walk.z1 - walk.z0, false, walk.x0 - ROAD / 2], [walk.z1 - walk.z0, false, walk.x1 + ROAD / 2]])
    for (let s = 1; s < len; s += 4) {   // dashed centre line
      const p = (horiz ? walk.x0 : walk.z0) + s;
      asphalt.push(horiz ? slab(p, at - 0.08, p + 2, at + 0.08, 0.01, 0xd8d4c8) : slab(at - 0.08, p, at + 0.08, p + 2, 0.01, 0xd8d4c8));
    }
  city.add(new THREE.Mesh(mergeGeometries(asphalt), lambert({vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1})));

  // ---- chain-link fence on the park wall (collider is in level.js) + posts ----
  const chain = canvasTex(64, (g, s) => { g.strokeStyle = 'rgba(70,74,78,0.9)'; g.lineWidth = 2;
    for (let i = -s; i <= s; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.moveTo(i + s, 0); g.lineTo(i, s); g.stroke(); } });
  const fh = FENCE_H - WALL_H, fy = WALL_H + fh / 2, panels = [], posts = [];
  const panel = (len, x, z, ry) => { const g = new THREE.PlaneGeometry(len, fh).rotateY(ry).translate(x, fy, z), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 1, uv.getY(i) * fh); return g; };
  const mx = (B.x0 + B.x1) / 2, mz = (B.z0 + B.z1) / 2, W2 = WALL_T / 2;
  panels.push(panel(B.x1 - B.x0, mx, B.z0 - W2, 0), panel(B.x1 - B.x0, mx, B.z1 + W2, 0), panel(B.z1 - B.z0, B.x0 - W2, mz, Math.PI / 2), panel(B.z1 - B.z0, B.x1 + W2, mz, Math.PI / 2));
  city.add(new THREE.Mesh(mergeGeometries(panels), lambert({map: chain, transparent: true, depthWrite: false, side: THREE.DoubleSide})));
  for (let x = B.x0; x <= B.x1; x += POST_STEP) posts.push([x, fy, B.z0 - W2], [x, fy, B.z1 + W2]);
  for (let z = B.z0 + POST_STEP; z < B.z1; z += POST_STEP) posts.push([B.x0 - W2, fy, z], [B.x1 + W2, fy, z]);
  city.add(instanced(new THREE.BoxGeometry(0.06, fh, 0.06), lambert({color: 0x55595e}), posts));

  // ---- buildings around the street: one merged mesh, window texture, per-building tint ----
  const win = canvasTex(64, (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); g.fillStyle = '#3c4654'; g.fillRect(14, 12, 36, 34);
    g.fillStyle = '#56657a'; g.fillRect(14, 12, 36, 6); g.fillStyle = '#d9d9d9'; g.fillRect(10, 46, 44, 4); });
  const blds = [], bldFaces = [], out = grow(road, BLOCK_GAP);
  const sides = [   // walk each edge of the outer rect; n = facade normal (toward the park)
    {len: out.x1 - out.x0, at: s => [out.x0 + s, out.z0], n: [0, 1]}, {len: out.x1 - out.x0, at: s => [out.x0 + s, out.z1], n: [0, -1]},
    {len: out.z1 - out.z0, at: s => [out.x0, out.z0 + s], n: [1, 0]}, {len: out.z1 - out.z0, at: s => [out.x1, out.z0 + s], n: [-1, 0]}];
  for (const sd of sides) for (let s = rnd(0, 4); s < sd.len;) {
    const w = rnd(...BLD_W), d = rnd(...BLD_D), h = Math.round(rnd(...BLD_H) / BLD_FLOOR) * BLD_FLOOR, [px, pz] = sd.at(s + w / 2);
    const [nx, nz] = sd.n, cx = px - nx * d / 2, cz = pz - nz * d / 2, bx = nz ? w : d, bz = nz ? d : w;
    const g = new THREE.BoxGeometry(bx, h, bz), uv = g.attributes.uv;
    for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {   // faces px nx py ny pz nz: uv in floors/bays, roofs on a plain wall texel
      const i = f * 4 + k;
      if (f === 2 || f === 3) uv.setXY(i, 0.02, 0.02); else uv.setXY(i, uv.getX(i) * (f < 2 ? bz : bx) / BLD_BAY, uv.getY(i) * h / BLD_FLOOR);
    }
    blds.push(tint(g.translate(cx, h / 2, cz), BLD_COLORS[Math.floor(rnd(0, BLD_COLORS.length))]));
    bldFaces.push(line([px - nz * w / 2, pz - nx * w / 2], [px + nz * w / 2, pz + nx * w / 2], [nx, nz], 4.5, 'bld'));   // ground floor facing the park
    s += w + rnd(0, 3);
  }
  const bldMesh = new THREE.Mesh(mergeGeometries(blds), lambert({map: win, vertexColors: true})); city.add(bldMesh);

  // ---- street furniture on the sidewalk: lamps (arm over the wall), bins, trees; cones on the road ----
  const lamps = [], bins = [], trees = [], cones = [], lampOff = WALL_T + 0.8;
  for (const sd of [{len: B.x1 - B.x0, at: s => [B.x0 + s, B.z0 - lampOff], ry: Math.PI}, {len: B.x1 - B.x0, at: s => [B.x0 + s, B.z1 + lampOff], ry: 0},
    {len: B.z1 - B.z0, at: s => [B.x0 - lampOff, B.z0 + s], ry: -Math.PI / 2}, {len: B.z1 - B.z0, at: s => [B.x1 + lampOff, B.z0 + s], ry: Math.PI / 2}]) {
    let k = 0;
    for (let s = LAMP_STEP / 2; s < sd.len; s += LAMP_STEP, k++) {
      const [x, z] = sd.at(s), t = sd.at(s + LAMP_STEP / 2), out2 = [Math.sin(sd.ry) * 1.6, Math.cos(sd.ry) * 1.6];   // out2: further from the wall
      lamps.push([x, CURB_H, z, sd.ry]);
      if (k % 2) bins.push([x + out2[0] * 0.4 + (sd.ry % Math.PI ? 0 : 0.8), CURB_H + 0.45, z + out2[1] * 0.4 + (sd.ry % Math.PI ? 0.8 : 0)]);
      else if (s + LAMP_STEP / 2 < sd.len) trees.push([t[0] + out2[0], CURB_H, t[1] + out2[1], rnd(0, 6), rnd(0.8, 1.2)]);
    }
  }
  // lamp: pole + arm (local -z points over the park), basic-material head
  const lampGeo = mergeGeometries([new THREE.CylinderGeometry(0.07, 0.1, LAMP_H, 6).translate(0, LAMP_H / 2, 0), new THREE.BoxGeometry(0.08, 0.08, LAMP_ARM).translate(0, LAMP_H, -LAMP_ARM / 2)]);
  city.add(instanced(lampGeo, lambert({color: 0x3d4146}), lamps));
  city.add(instanced(new THREE.BoxGeometry(0.28, 0.1, 0.55).translate(0, LAMP_H - 0.08, -LAMP_ARM + 0.1), new THREE.MeshBasicMaterial({color: 0xfff1c4}), lamps));
  city.add(instanced(new THREE.CylinderGeometry(0.3, 0.26, 0.9, 8), lambert({color: 0x2f5a3c}), bins));
  city.add(instanced(new THREE.CylinderGeometry(0.12, 0.16, 2.4, 5).translate(0, 1.2, 0), lambert({color: 0x5a4632}), trees));
  city.add(instanced(new THREE.IcosahedronGeometry(1.7, 0).translate(0, 3.6, 0), lambert({color: 0x4f7a3e, flatShading: true}), trees));
  for (const [cx, cz, n] of [[B.x1 + WALL_T + SIDEWALK + 1, -30, 5], [-20, B.z0 - WALL_T - SIDEWALK - 1, 4], [B.x0 - WALL_T - SIDEWALK - 1, 15, 3]])
    for (let i = 0; i < n; i++) cones.push([cx + (Math.abs(cz) < 40 ? 0 : i * 1.5), 0.25, cz + (Math.abs(cz) < 40 ? i * 1.5 : 0), rnd(0, 6)]);
  city.add(instanced(new THREE.ConeGeometry(0.17, 0.5, 8), lambert({color: 0xff6a1a}), cones));

  // ---- graffiti: candidate spots on known faces (FEATURES, wall, facades), each confirmed by raycasts against the real
  // geometry: centre ray must hit a near-vertical face at the expected distance, and all 4 corners must hit the same plane ----
  const F = FEATURES, PI = Math.PI, faces = [], ph = PERIM.h;
  const L = (a, b, n, y1, kind = 'park') => faces.push(line(a, b, n, y1, kind));
  if (F.startDeck) { const f = F.startDeck; L([f.x0, f.zBack], [f.x1, f.zBack], [0, 1], f.h); L([f.x0, f.zFront], [f.x0, f.zBack], [-1, 0], f.h); L([f.x1, f.zFront], [f.x1, f.zBack], [1, 0], f.h); }
  if (F.landing) { const f = F.landing; L([-f.halfW, f.zFront], [f.halfW, f.zFront], [0, 1], f.h); L([-f.halfW, f.zFoot], [-f.halfW, f.zFront], [-1, 0], f.h); L([f.halfW, f.zFoot], [f.halfW, f.zFront], [1, 0], f.h); }
  if (F.northWall) { const f = F.northWall, x0 = F.bowlCorner ? F.bowlCorner.x : f.xEast - 40; L([x0, f.zBack], [f.xEast, f.zBack], [0, -1], f.h); L([f.xEast, f.zBack], [f.xEast, f.zBack + 6], [1, 0], f.h); }
  if (F.halfPipe) { const f = F.halfPipe, r = f.ramp;
    L([f.x0, f.zBack], [r.x0, f.zBack], [0, 1], 3.2); L([r.x1, f.zBack], [f.x1, f.zBack], [0, 1], 3.2);
    L([f.x0, f.zFoot], [f.x0, f.zBack], [-1, 0], 3.2); L([f.x1, f.zFoot], [f.x1, f.zBack], [1, 0], 3.2);
    L([r.x0, f.zBack], [r.x0, r.zFoot], [-1, 0], 3.2); L([r.x1, f.zBack], [r.x1, r.zFoot], [1, 0], 3.2); }
  if (F.bowlCorner) { const f = F.bowlCorner; faces.push(arc(f.x, f.z, f.rOuter, PI, 1.5 * PI, 3.2)); }
  if (F.westWall) { const f = F.westWall; L([f.xBack, f.z0], [f.xBack, f.z1], [-1, 0], 3.2); }
  if (F.westBank) { const f = F.westBank; L([f.xBack, f.z0], [f.xBack + 9, f.z0], [0, -1], 1.6); L([f.xBack, f.z1], [f.xBack + 9, f.z1], [0, 1], 1.6); }
  if (F.swQuarter) { const f = F.swQuarter; L([f.x0, f.zBack], [f.x1, f.zBack], [0, 1], 2.8); L([f.x0, f.zBack - 5], [f.x0, f.zBack], [-1, 0], 2.8); L([f.x1, f.zBack - 5], [f.x1, f.zBack], [1, 0], 2.8); }
  if (F.spine) { const f = F.spine; L([f.x0, f.z0], [f.x1, f.z0], [0, -1], f.h); L([f.x0, f.z1], [f.x1, f.z1], [0, 1], f.h); }
  if (F.eastBank) { const f = F.eastBank; L([f.x0, f.z0], [f.xBack, f.z0], [0, -1], 1.6); L([f.x0, f.z1], [f.xBack, f.z1], [0, 1], 1.6); }
  if (F.eastLedge) { const f = F.eastLedge; L([f.x0, f.z - f.w / 2], [f.x1, f.z - f.w / 2], [0, -1], 0.5, 'ledge'); L([f.x0, f.z + f.w / 2], [f.x1, f.z + f.w / 2], [0, 1], 0.5, 'ledge'); }
  L([B.x0, B.z0], [B.x1, B.z0], [0, 1], ph, 'wall'); L([B.x0, B.z1], [B.x1, B.z1], [0, -1], ph, 'wall');   // perimeter wall, inner faces
  L([B.x0, B.z0], [B.x0, B.z1], [1, 0], ph, 'wall'); L([B.x1, B.z0], [B.x1, B.z1], [-1, 0], ph, 'wall');

  // ray backends: park = octree triangles along the ray (both sides; octree.rayIntersect culls backfaces), city = buildings mesh
  const ray = new THREE.Ray(), tris = [], hp = new THREE.Vector3(), tn = new THREE.Vector3(), rc = new THREE.Raycaster();
  const castPark = (o, d, far) => {
    ray.set(o, d); tris.length = 0; octree.getRayTriangles(ray, tris);
    let best = null;
    for (const t of tris) if (ray.intersectTriangle(t.a, t.b, t.c, false, hp)) {
      const dist = hp.distanceTo(o);
      if (dist <= far && (!best || dist < best.d)) { t.getNormal(tn); best = {d: dist, n: tn.clone(), p: hp.clone()}; }
    }
    return best;
  };
  const castBld = (o, d, far) => { rc.set(o, d); rc.far = far; const h = rc.intersectObject(bldMesh, false)[0];
    return h && {d: h.distance, n: h.face.normal.clone(), p: h.point}; };
  const quads = GRAF.map(() => []), O = new THREE.Vector3(), D = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), rt = new THREE.Vector3(), up = new THREE.Vector3(), cn = new THREE.Vector3(), mtx = new THREE.Matrix4();
  let placed = 0, rejected = 0; const byKind = {};
  function tryDecal(face, s, cast) {
    const k = GRAF_KIND[face.kind], r = rnd(), sh = r < GRAF_PICK[0] ? 0 : r < GRAF_PICK[0] + GRAF_PICK[1] ? 1 : 2, asp = GRAF[sh][3];
    const [x, z, nx, nz] = face.at(s), tilt = rnd() < 0.3 ? 0 : rnd(-GRAF_TILT, GRAF_TILT), tol = face.tol;
    let w = rnd(...k.w) * (sh === 2 ? 0.65 : 1);
    for (let i = 0; i < TRIES; i++, w *= SHRINK) {
      const h = w / asp, span = Math.abs(Math.sin(tilt)) * w + Math.cos(tilt) * h, room = face.y1 - span - 0.1;   // vertical extent incl. tilt
      if (room < 0.05) continue;
      const y = 0.05 + span / 2 + rnd(0, room);
      O.set(x + nx * RAY_BACK, y, z + nz * RAY_BACK); D.set(-nx, 0, -nz);
      const c = cast(O, D, RAY_BACK + 0.5);
      if (!c || Math.abs(c.d - RAY_BACK) > tol + 0.05) break;          // face missing/occluded here: other sizes won't help
      if (c.n.dot(D) > 0) c.n.negate();
      if (Math.abs(c.n.y) > MAX_NY) break;
      const n = c.n, p = c.p;
      rt.crossVectors(Y, n).normalize(); up.crossVectors(n, rt);
      const cs = Math.cos(tilt), sn = Math.sin(tilt), R = rt.clone().multiplyScalar(cs).addScaledVector(up, sn), U = up.clone().multiplyScalar(cs).addScaledVector(rt, -sn);
      let ok = true;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        cn.copy(p).addScaledVector(R, a * w / 2).addScaledVector(U, b * h / 2);
        if (cn.y < 0.03 || cn.y > face.y1) { ok = false; break; }
        O.copy(cn).addScaledVector(n, CORNER_BACK); D.copy(n).negate();
        const q = cast(O, D, CORNER_BACK + tol + 0.05);
        if (!q || Math.abs(q.d - CORNER_BACK) > tol || Math.abs(q.n.dot(n)) < 0.98) { ok = false; break; }
      }
      if (!ok) continue;
      const tiles = GOOD_TILES[sh], t = tiles[Math.floor(rnd(0, tiles.length))], [, C, Rw] = GRAF[sh], col = t % C, row = Math.floor(t / C), e = DECAL_INSET;
      const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv;
      for (let j = 0; j < uv.count; j++) uv.setXY(j, (col + e + uv.getX(j) * (1 - 2 * e)) / C, 1 - (row + e + (1 - uv.getY(j)) * (1 - 2 * e)) / Rw);
      const off = DECAL_OFF + (placed % DECAL_LAYERS) * DECAL_LAYER + (tol > PLANE_TOL ? ARC_TOL / 2 : 0);
      quads[sh].push(g.applyMatrix4(mtx.makeBasis(R, U, n).setPosition(p.x + n.x * off, p.y + n.y * off, p.z + n.z * off)));
      placed++; byKind[face.kind] = (byKind[face.kind] || 0) + 1; return;
    }
    rejected++;
  }
  for (const f of faces) for (let i = 0, m = Math.max(1, Math.round(f.len * GRAF_KIND[f.kind].dens)); i < m; i++) tryDecal(f, (i + rnd(0.1, 0.9)) / m, castPark);   // staggered along the face
  for (const f of bldFaces) for (let i = 0, m = Math.max(1, Math.round(f.len * GRAF_KIND.bld.dens)); i < m; i++) tryDecal(f, (i + rnd(0.1, 0.9)) / m, castBld);
  log('graffiti', {placed, rejected, byKind});
  const loader = new THREE.TextureLoader();
  GRAF.forEach(([file], i) => {
    if (!quads[i].length) return;
    const map = loader.load(file, undefined, undefined, () => log('error', {msg: 'graffiti load failed: ' + file}));
    map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
    const keyed = file.endsWith('.png');
    city.add(new THREE.Mesh(mergeGeometries(quads[i]), lambert({map, transparent: keyed, depthWrite: !keyed, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2})));
  });

  scene.add(city);
}
