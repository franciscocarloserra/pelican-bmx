// Park geometry + collision octree. Features are built in local coords (ride in toward -z from the
// foot at z=0; width along x) and baked into ONE merged vertex-colored mesh for riding/collision
// plus ONE merged deco mesh (coping, paint strips, flat-bar/hand rails, zone slabs) that is visual only:
// 2 draw calls for the whole park. Flat bars / handrails are deco + grindables only (no collider).
//
// TOP-DOWN MAP (meters, ~250 m square). x → east, z ↓ south; spawn faces north (-z). PARK slab x -120..130,
// z -125..125, 1 m wall + fence collider just outside it. Exact face coords: FEATURES; grind edges: grindables.
//
//  z-118 ┌──────────── TRANSITIONS ─────────────────────┬──── SPINE / HIP ──────────┬─ MEGARAMP ─┐
//        │ bowl ╭── NORTH WALL (lip 3.2) x -95..0, 4 m  │  ⌐ quarter HIP (60,-90)    │ tower h8   │
//  z-105 │corner  transfer gap at x -60..-56 ──╮ HP   │    faces S + E            │ x 94..116  │
//        │(-95,-97)                    x -30..-10│    │       ↔ transfer ↔  E BANK │ roll-in    │
//  z -72 │W        ╭BOWL╮ (-65,-72)   HP access  │    │  ∩ SPINE (50,-70..-50)  x78│ kicker r10 │
//        │E        ╰─┬──╯ ramp z-45   ramp x-20  │    │                           │ 11 m GAP   │
//  z -45 │S  ⌐ HIP (-35,-35) faces S+E            │    │  ▭ FUNBOX+bar (50,-35)    │ landing 18 │
//        │T morph / W BANK z -56..-25             │    │                           │ access ramp│
//  z  -5 ├─────────────── ◇ PYRAMID (0,-5) ── open plaza ─────────────────────────┴ mega Q z-8 ┤
//        │ STREET                         ▲ J3 big   kicker z 38 → landing 17..30                │
//  z  40 │ ▇ stairs platform (-82,45) + rail-down bank  ▲ J2 kicker z 66     RHYTHM: 3 tables z 40 │
//        │ ▮ curb x-50  ▬ ledge→rail x-35  ▭ pad x-50   ▲ J1 kicker z 92     east ledge z 70, pad   │
//  z  85 │ ⊿→━ kicker-to-rail x-100   ━ flat bar x-64   ▲ roll-in            ⊿→▭ kicker-to-box z 85 │
//  z 112 │   SW quarter x -110..-30       START deck h2 (z 110..115)      SE quarter x 30..110     │
//  z 125 └────────────────────────────────────────────────────────────────────────────────────────┘
//
// Flow lines:
//  1 jump line (spawn): roll-in → J1 → J2 → J3 (3.5 m gap) → pyramid (straight or off a hip corner) → plaza →
//    north wall (air the 4 m wall-gap transfer) / half-pipe (via its access ramp).
//  2 transitions: north wall carve west → bowl corner → west wall → morph → W bank → hip (S face, hip-transfer to
//    the E face) → bowl ramp → bowl.
//  3 street: SW quarter → stairs platform ramp → 4-stair (handrail / hubba) or rail-down-bank → curb → ledge→rail
//    → box rail → flat bar → kicker-to-rail → SW quarter.
//  4 spine/hip: funbox → spine transfer → hip (E face) ↔ E bank quarter-to-bank transfer → pyramid.
//  5 megaramp: access ramp up to the 8 m tower → roll-in → 11 m gap → landing → mega quarter → SE: rhythm tables
//    (each landing leads into the next kicker) → kicker-to-box → east ledge → SE quarter.
import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---- tunables ----
export const PARK = {xMin: -120, xMax: 130, zMin: -125, zMax: 125};   // riding area (concrete slab); keep scenery outside
export const PERIM = {h: 1, t: 0.4, fence: 3, color: 0x8f8b84};   // wall around PARK (outside it); invisible collider up to the fence top (fence drawn in city.js)
const GROUND_SIZE = 600;
const ARC_SEG = 32, CORNER_SEG = 16, KICK_SEG = 12, SPINE_SEG = 12, COPE_R = 0.06, STRIP_W = 0.2, RAIL_R = 0.035;
const GROUND = 0x6f7a5c, SLAB = 0x8b9198, CONC = 0xa2a8ad, CONC_WARM = 0xaba293, CONC_LIGHT = 0xc0c3c5,
  CONC_DARK = 0x8a9198, METAL = 0xd3d8df, PAINT = 0xe3b81f, PAINT_RED = 0xb8392e, SIDE_SHADE = 0.82;
const ZONES = [   // slightly different slab tone per zone (visual only): [x0, x1, z0, z1, color]
  [-118, 12, -123, -26, 0x959ba1],   // transitions
  [-118, -14, 2, 123, 0x7f868d],     // street
  [16, 88, -123, -14, 0x91948f],     // spine / hip
  [90, 128, -123, 4, 0x9a958c],      // megaramp
  [16, 128, 14, 123, 0x868c88],      // rhythm / east street
];
const START_DECK = {x: 0, z: 110, len: 5, w: 6, h: 2, rollIn: 6};         // deck front edge z, roll-in length toward -z
export const SPAWN = new THREE.Vector3(START_DECK.x, START_DECK.h, START_DECK.z + 1.5);   // + wheel radius in physics
const JUMP_X = 0, JUMPS = [   // jump line, northbound: kicker foot z, curved kicker radius/angle/width, gap, landing table + slope
  {z: 92, r: 5, ang: 30, w: 4, gap: 2, deck: 1.2, l: 7},    // lip h≈0.67 (r5/30° stays launchable at 18 m/s)
  {z: 66, r: 5, ang: 40, w: 4.5, gap: 2.5, deck: 1.5, l: 9},  // lip h≈1.17
  {z: 38, r: 6, ang: 42, w: 5, gap: 3.5, deck: 2, l: 11},      // lip h≈1.54
];
// spawn-area lines: east = kicker → kicker-to-rail → quarter; west = bank-to-bank → wallride wall; curved rail NE of spawn
const KLINE = {x: 14, k1: {z: 102, r: 4, ang: 30, w: 4, gap: 2, deck: 1, l: 3.5}, k2: {z: 86, r: 4, ang: 30, w: 3}, railGap: 1.2, railLen: 8, railH: 0.6,
  q: {r: 2.6, vert: 0.8, deck: 2}, qz: 66, qw: 12};
const B2B = {x: -16, z: 106, w: 6, h: 1.4, run: 3.4, deck: 1.2, gap: 2, landRun: 4.5};   // bank up (north), gap, bank down
const WALLRIDE = {x: -20, z0: 62, z1: 84, q: {r: 1.5, vert: 2.0, deck: 0.4}};          // tall thin wall, faces east, curved base
const CURVE_RAIL = {cx: 34, cz: 104, r: 12, a0: 0, a1: Math.PI / 2, seg: 20, h: 0.4, postEvery: 4};   // arc from (22,104) heading north to (34,92) heading east
// long / tall rails in the plaza between the pyramid and the north wall: polylines [x, y, z] (multi-segment ones are
// chained with prev/next); kicker = curved kicker whose lip feeds the rail start (ry: direction the kicker faces)
const RAILS = [
  {name: 'long30', pts: [[12, 0.5, -20], [12, 0.5, -50]]},                                              // 30 m, hop-on
  {name: 'tall12', pts: [[24, 1.2, -17.4], [24, 1.2, -32.4]], kicker: {x: 24, z: -12, ry: 0, r: 6, ang: 40, w: 3}},   // 15 m @1.2 m
  {name: 'tall15', pts: [[32, 1.5, -18.4], [32, 1.5, -36.4]], kicker: {x: 32, z: -12, ry: 0, r: 7, ang: 42, w: 3}},   // 18 m @1.5 m
  {name: 'kink28', pts: [[-11.5, 1.0, -60], [0, 1.0, -60], [8, 0.45, -60], [20, 0.45, -60]],                       // 31.5 m flat-down-flat
    kicker: {x: -16, z: -60, ry: -Math.PI / 2, r: 5, ang: 38, w: 3}},
];
const RAIL_POST_EVERY = 4;   // m between posts
const PYR = {x: 0, z: -5, top: 2.5, h: 1.0, run: 3.0};                    // top half-width, slope run
// transition zone (north-west)
const WALL = {r: 3.0, vert: 1.0, deck: 2.5}, NORTH_Z = -105, EAST_END = 0; // north wall foot line, east end x
const WALL_GAP = {x0: -60, x1: -56};                                      // transfer slot in the north wall
const CORNER = {x: -95, z: -97, r0: 8};                                   // bowl corner center + floor radius
const HP = {x0: -30, x1: -10, flat: 8}, HP_RAMP = {x: -20, w: 5, zFoot: -70};
const WEST_Z1 = -60, MORPH_L = 4, MORPH_SEG = 8;                          // west wall quarter: corner .. here, then a quarter→bank loft
const BANK_W = {h: 1.6, run: 3.5, deck: 2, back: 2.6, z1: -25};           // west bank z WEST_Z1+MORPH_L..z1
const BOWL = {x: -65, z: -72, r0: 5, r: 2.5, vert: 0.2, deck: 2.5, seg: 32, rampW: 4, rampZ: -45};   // round bowl; ramp foot z, rises north onto the deck
const HIP_T = {x: -35, z: -35, len: 10, q: {r: 2.6, vert: 0.2, deck: 2.2}};   // quarter hip: outer corner (x,z), faces south + east
// spine / hip zone (north-east)
const HIP_E = {x: 60, z: -90, len: 12, q: {r: 3.0, vert: 0.2, deck: 2.5}};
const SPINE = {x: 50, z0: -70, z1: -50, r: 3.2, ang: 55, crest: 0.6};     // roll-over spine crossed east-west, h≈1.36
const FUNBOX = {x: 50, z: -35, w: 6, len: 6, h: 0.8, run: 2.8, bar: 0.3}; // table ridden north-south, flat bar on top
const BANK_E = {x: 78, h: 1.6, run: 3.4, deck: 2, back: 2.6, z0: -110, z1: -20};
// megaramp (east, southbound)
const MEGA = {x: 100, w: 8, h: 8, tower: {x0: 94, x1: 116, z0: -118, z1: -110}, rollIn: 24, flat: 8,
  kr: 10, kang: 35, gap: 11, deck: 3, land: 18, parapet: 1, parapetT: 0.3, q: {r: 5, vert: 0.5, deck: 3}, qz: -8, qw: 14, access: {x: 112, w: 4, zFoot: -46}};
// street zone (south-west)
const STAIRS = {x0: -90, x1: -74, zTop: 40, zBack: 50, h: 1.2, steps: 4, tread: 0.45, sx0: -88, sx1: -76,
  rampL: 8, rampW: 10, rail: 0.85, railOver: 2, hubbaW: 0.6, hubbaH: 0.4, hubbaExt: 1.5, bankL: 6, bankRail: 0.45};
const CURB = {x: -50, z0: 40, z1: 58, w: 0.5, h: 0.4}, PAD = {x: -50, z0: 70, z1: 80, w: 3, h: 0.25};
const FLATBAR = {a: [-64, 72], b: [-64, 88], h: 0.35};
const LEDGE_RAIL = {x: -35, z0: 60, z1: 70, w: 0.6, h: 0.45, rail: 10};  // ledge that continues as a flat rail (to z1 + rail)
const BOXRAIL = {x: -40, z0: 88, z1: 98, w: 0.25, h: 0.4};
const KICK_RAIL = {x: -100, z: 88, r: 4, ang: 30, w: 2.5, gap: 1.2, len: 8, h: 0.6};   // kicker (northbound) into a flat bar
const SW_Q = {r: 2.6, vert: 0.2, deck: 2, z: 112, x0: -110, x1: -30};
// rhythm / east street (south-east)
const RHYTHM = {z: 40, x: 30, w: 5, n: 3, space: 4, r: 4.5, ang: 32, gap: 2, deck: 1, l: 3.5};   // eastbound tables back to back
const LEDGE_E = {z: 70, x0: 30, x1: 55, w: 0.6, h: 0.45}, PAD_E = {x: 70, z0: 60, z1: 70, w: 3, h: 0.25};
const FLATBAR_E = {a: [34, 85], b: [50, 85], h: 0.35};
const KICK_BOX = {x: 60, z: 85, r: 4, ang: 30, w: 3, gap: 2.5, len: 10, bw: 3, h: 0.6};   // eastbound kicker onto a box
const SE_Q = {r: 2.6, vert: 0.2, deck: 2, z: 112, x0: 30, x1: 110};

// ---- profiles: [u, y] points, u = distance from the foot toward -z ----
const arc = (r, a0, a1, n, u0 = 0, dir = 1) => Array.from({length: n + 1}, (_, i) => {
  const t = a0 + (a1 - a0) * i / n; return [u0 + dir * r * Math.sin(t), r * (1 - Math.cos(t))];
});
const quarterPts = (r, vert, deck) => [...arc(r, 0, Math.PI / 2, ARC_SEG), ...(vert > 0 ? [[r, r + vert]] : []), [r + deck, r + vert], [r + deck, 0]];
const deckPts = (l, h, deck) => [[0, 0], [l, h], ...(deck > 0 ? [[l + deck, h]] : []), [l + deck, 0]];   // wedge (+ flat top)
const bankPts = (b) => [[0, 0], [b.run, b.h], [b.run + b.deck, b.h], [b.run + b.deck + b.back, 0]];       // bank + deck + back slope
const spineU = (s) => s.r * Math.sin(s.ang * Math.PI / 180), spineH = (s) => s.r * (1 - Math.cos(s.ang * Math.PI / 180));
const spinePts = (s) => { const a = s.ang * Math.PI / 180, u1 = spineU(s);
  return [...arc(s.r, 0, a, SPINE_SEG), ...arc(s.r, a, 0, SPINE_SEG, 2 * u1 + s.crest, -1)]; };
const stairPts = (s) => { const p = [[0, 0]], dh = s.h / s.steps;
  for (let k = 0; k < s.steps; k++) p.push([k * s.tread, (k + 1) * dh], [(k + 1) * s.tread, (k + 1) * dh]);
  return [...p, [s.steps * s.tread, 0]]; };

// bank profile resampled to match quarterPts point-for-point (for lofting between the two)
const bankLike = (b, n) => [...Array.from({length: n + 1}, (_, i) => [b.run * i / n, b.h * i / n]), [b.run + 0.3, b.h], [b.run + b.deck, b.h], [b.run + b.deck, 0]];

// loft between two equal-length profiles across width w: A at local x=-w/2, B at +w/2 (smoothstep blend; open ends)
function loft(A, B, w, segs) {
  const out = [], P = (k, i) => { const t = k / segs, s = t * t * (3 - 2 * t);
    return [-w / 2 + w * t, A[i][1] + (B[i][1] - A[i][1]) * s, -(A[i][0] + (B[i][0] - A[i][0]) * s)]; };
  for (let k = 0; k < segs; k++) for (let i = 0; i < A.length - 1; i++) {
    const a = P(k, i), b = P(k + 1, i), c = P(k + 1, i + 1), d = P(k, i + 1);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)); return g;
}

// grind edges for physics: [{a: [x,y,z], b: [x,y,z], kind: 'rail'|'ledge'|'coping'}] in world coords, filled by buildLevel
export const grindables = [];
// key world coords of feature faces (for scenery/graffiti placement), filled by buildLevel
export const FEATURES = {};
function seg(kind, a, b, x = 0, z = 0, ry = 0, y = 0) {   // a, b in a feature's local coords (same transform as bake)
  const c = Math.cos(ry), s = Math.sin(ry), w = ([px, py, pz]) => [+(px * c + pz * s + x).toFixed(3), +(py + y).toFixed(3), +(-px * s + pz * c + z).toFixed(3)];
  grindables.push({a: w(a), b: w(b), kind});
}
const edge = (kind, len, u, h, x, z, ry) => seg(kind, [-len / 2, h, -u], [len / 2, h, -u], x, z, ry);   // matches rod(len, u, h)

const M = new THREE.Matrix4(), Y = new THREE.Vector3(0, 1, 0), qa = new THREE.Quaternion();
function prism(pts, w) {   // extrude a [u,y] profile across width w: (u, y, e) -> (e - w/2, y, -u)
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([u, y]) => new THREE.Vector2(u, y))), {depth: w, bevelEnabled: false});
  return g.applyMatrix4(M.set(0, 0, 1, -w / 2, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1));
}
const rod = (len, u, y) => new THREE.CylinderGeometry(COPE_R, COPE_R, len, 6).rotateZ(Math.PI / 2).translate(0, y, -u);   // coping along local x
const strip = (len, u, y, d = STRIP_W) => new THREE.BoxGeometry(len, 0.012, d).translate(0, y + 0.006, -u);         // paint on a flat top
function tube(a, b, r = RAIL_R) {   // cylinder between two world points
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length();
  return new THREE.CylinderGeometry(r, r, len, 6).applyQuaternion(qa.setFromUnitVectors(Y, d.divideScalar(len))).translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
}

// ---- baking: flat normals + per-face vertex colors; paint(centroid, normal) in local coords may override ----
const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), fn = new THREE.Vector3(), cen = new THREE.Vector3(), col = new THREE.Color();
function bake(list, geo, color, x = 0, z = 0, ry = 0, y = 0, paint = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g.clearGroups(); g.computeVertexNormals();
  const p = g.attributes.position, cols = new Float32Array(p.count * 3), base = new THREE.Color(color);
  for (let i = 0; i < p.count; i += 3) {
    va.fromBufferAttribute(p, i); vb.fromBufferAttribute(p, i + 1); vc.fromBufferAttribute(p, i + 2);
    fn.crossVectors(vb.clone().sub(va), vc.clone().sub(va)).normalize(); cen.copy(va).add(vb).add(vc).divideScalar(3);
    const pc = paint?.(cen, fn);
    if (pc != null) col.set(pc); else { col.copy(base); if (Math.abs(fn.y) < 0.5) col.multiplyScalar(SIDE_SHADE); }
    for (let j = 0; j < 3; j++) col.toArray(cols, (i + j) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  list.push(g.rotateY(ry).translate(x, y, z));
}

export function buildLevel(scene) {
  const solid = [], deco = [];
  const S = (...a) => bake(solid, ...a), D = (...a) => bake(deco, ...a);
  const H = WALL.r + WALL.vert, PI = Math.PI;
  grindables.length = 0;
  for (const k of Object.keys(FEATURES)) delete FEATURES[k];

  // ---- shared feature builders ----
  const quarter = (q, w, x, z, ry, color = CONC) => {   // quarter + coping + grind edge; q = {r, vert, deck}
    S(prism(quarterPts(q.r, q.vert, q.deck), w), color, x, z, ry);
    D(rod(w, q.r, q.r + q.vert), METAL, x, z, ry); edge('coping', w, q.r, q.r + q.vert, x, z, ry);
  };
  const box = (x0, x1, z0, z1, h, color, paint, kind = 'ledge') => {   // axis-aligned block; grind edges along its long sides
    S(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), color, (x0 + x1) / 2, (z0 + z1) / 2, 0, h / 2, paint);
    if (!kind) return;
    if (z1 - z0 >= x1 - x0) for (const x of [x0, x1]) seg(kind, [x, h, z0], [x, h, z1]);
    else for (const z of [z0, z1]) seg(kind, [x0, h, z], [x1, h, z]);
  };
  const post = (x, z, y0, y1) => D(tube([x, y0, z], [x, y1, z], 0.03), CONC_DARK);
  const flatBar = (a, b, h) => {   // visual bar on posts + grind rail (no collider)
    const A = [a[0], h, a[1]], B = [b[0], h, b[1]];
    D(tube(A, B), METAL); post(a[0], a[1], 0, h); post(b[0], b[1], 0, h);
    seg('rail', A, B);
  };
  const arcSegs = (cx, cz, rad, y, p0, p1, n, kind = 'coping') => {   // curved coping as straight chords (lathe angle convention)
    for (let i = 0; i < n; i++) { const a = p0 + (p1 - p0) * i / n, b = p0 + (p1 - p0) * (i + 1) / n;
      seg(kind, [rad * Math.sin(a), y, rad * Math.cos(a)], [rad * Math.sin(b), y, rad * Math.cos(b)], cx, cz); }
  };
  const kicker = (k, x, z, ry, color = CONC_WARM) => {   // curved kicker, painted lip; returns {u, h}
    const ka = k.ang * PI / 180, h = k.r * (1 - Math.cos(ka)), u = k.r * Math.sin(ka);
    S(prism([...arc(k.r, 0, ka, KICK_SEG), [u, 0]], k.w), color, x, z, ry, 0, (c, n) => Math.abs(n.x) < 0.9 && n.y > 0.1 && c.y > h - 0.18 ? PAINT : null);
    return {u, h};
  };
  const landing = (l, h, deck, w, x, z, ry) => {   // table + slope; foot at (x,z), rises toward local -z; knuckle paint + grind edge
    S(prism(deckPts(l, h, deck), w), CONC_WARM, x, z, ry);
    D(strip(w, l + deck - STRIP_W / 2, h), PAINT, x, z, ry); D(strip(w, l + STRIP_W / 2, h), PAINT, x, z, ry);
    edge('ledge', w, l + deck, h, x, z, ry);
  };
  // quarter hip: two quarters meeting at a convex corner (outer corner at (x,z)), faces south (+z) and east (+x)
  const hip = (o, color = CONC) => {
    const q = o.q, Rh = q.r + q.deck, qh = q.r + q.vert, cx = o.x - Rh, cz = o.z - Rh;
    quarter(q, o.len, cx - o.len / 2, o.z, 0, color);
    quarter(q, o.len, o.x, cz - o.len / 2, PI / 2, color);
    const prof = quarterPts(q.r, q.vert, q.deck).slice(0, -1).map(([u, y]) => new THREE.Vector2(Rh - u, y));
    S(new THREE.LatheGeometry(prof, CORNER_SEG, 0, PI / 2), color, cx, cz);
    D(new THREE.TorusGeometry(q.deck, COPE_R, 4, CORNER_SEG / 2, PI / 2).rotateX(PI / 2), METAL, cx, cz, 0, qh);
    arcSegs(cx, cz, q.deck, qh, 0, PI / 2, CORNER_SEG / 2);
    box(cx - o.len, cx, cz - o.len, cz, qh, color, null, null);   // closes the block behind both decks
    return {x0: cx - o.len, x1: o.x, z0: cz - o.len, z1: o.z, h: qh};
  };

  // ---- ground + slabs ----
  S(new THREE.BoxGeometry(GROUND_SIZE, 1, GROUND_SIZE), GROUND, 0, 0, 0, -0.5);
  D(new THREE.PlaneGeometry(PARK.xMax - PARK.xMin, PARK.zMax - PARK.zMin).rotateX(-PI / 2), SLAB, (PARK.xMin + PARK.xMax) / 2, (PARK.zMin + PARK.zMax) / 2, 0, 0.004);
  for (const [x0, x1, z0, z1, c] of ZONES) D(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-PI / 2), c, (x0 + x1) / 2, (z0 + z1) / 2, 0, 0.006);

  // ---------- jump line + pyramid ----------
  const sd = START_DECK, rollFoot = sd.z - sd.rollIn;
  S(prism(deckPts(sd.rollIn, sd.h, sd.len), sd.w), CONC_DARK, sd.x, rollFoot, PI);
  D(rod(sd.w, sd.rollIn, sd.h), METAL, sd.x, rollFoot, PI); edge('coping', sd.w, sd.rollIn, sd.h, sd.x, rollFoot, PI);
  const jumps = JUMPS.map(j => {
    const {u, h} = kicker(j, JUMP_X, j.z, 0), lw = j.w + 1, landFoot = j.z - u - j.gap - j.deck - j.l;
    landing(j.l, h, j.deck, lw, JUMP_X, landFoot, PI);
    return {kickerFoot: j.z, lip: j.z - u, lipH: +h.toFixed(2), landingFront: j.z - u - j.gap, landingFoot: landFoot, halfW: lw / 2};
  });
  const pt = PYR.top * Math.SQRT2, pb = (PYR.top + PYR.run) * Math.SQRT2;
  S(new THREE.CylinderGeometry(pt, pb, PYR.h, 4, 1, false, PI / 4).translate(0, PYR.h / 2, 0), CONC_LIGHT, PYR.x, PYR.z);
  for (let i = 0; i < 4; i++) { D(rod(2 * PYR.top, PYR.top, PYR.h), METAL, PYR.x, PYR.z, i * PI / 2); edge('coping', 2 * PYR.top, PYR.top, PYR.h, PYR.x, PYR.z, i * PI / 2); }

  // ---------- spawn-area lines ----------
  const kl = KLINE, k1 = kicker(kl.k1, kl.x, kl.k1.z, 0), k1Foot = kl.k1.z - k1.u - kl.k1.gap - kl.k1.deck - kl.k1.l;
  landing(kl.k1.l, k1.h, kl.k1.deck, kl.k1.w + 1, kl.x, k1Foot, PI);
  const k2 = kicker(kl.k2, kl.x, kl.k2.z, 0), krz = kl.k2.z - k2.u - kl.railGap;
  flatBar([kl.x, krz], [kl.x, krz - kl.railLen], kl.railH);
  quarter(kl.q, kl.qw, kl.x, kl.qz, 0);
  const b2 = B2B, b2Top = b2.z - b2.run - b2.deck, b2Land = b2Top - b2.gap - b2.deck - b2.landRun;
  S(prism(deckPts(b2.run, b2.h, b2.deck), b2.w), CONC_WARM, b2.x, b2.z);
  D(rod(b2.w, b2.run, b2.h), METAL, b2.x, b2.z); edge('ledge', b2.w, b2.run + b2.deck, b2.h, b2.x, b2.z, 0);
  landing(b2.landRun, b2.h, b2.deck, b2.w, b2.x, b2Land, PI);
  const wr = WALLRIDE, wrw = wr.z1 - wr.z0;
  S(prism(quarterPts(wr.q.r, wr.q.vert, wr.q.deck), wrw), CONC_LIGHT, wr.x, (wr.z0 + wr.z1) / 2, PI / 2, 0,
    (c, n) => Math.abs(n.z) > 0.9 && c.y > wr.q.r + 0.3 && c.z > -wr.q.r - 0.05 ? PAINT_RED : null);   // painted vertical riding face
  D(rod(wrw, wr.q.r, wr.q.r + wr.q.vert), METAL, wr.x, (wr.z0 + wr.z1) / 2, PI / 2); edge('coping', wrw, wr.q.r, wr.q.r + wr.q.vert, wr.x, (wr.z0 + wr.z1) / 2, PI / 2);
  {   // long curved rail: one smooth polyline; segments carry chain/prev/next indices so grinds can continue across joints
    const cr = CURVE_RAIL, P = i => { const a = cr.a0 + (cr.a1 - cr.a0) * i / cr.seg; return [cr.cx - cr.r * Math.cos(a), cr.h, cr.cz - cr.r * Math.sin(a)]; };
    const first = grindables.length;
    for (let i = 0; i < cr.seg; i++) {
      const A = P(i), B = P(i + 1); D(tube(A, B), METAL); seg('rail', A, B);
      Object.assign(grindables[grindables.length - 1], {chain: 'curveRail', prev: i ? first + i - 1 : -1, next: i < cr.seg - 1 ? first + i + 1 : -1});
      if (i % cr.postEvery === 0) post(A[0], A[2], 0, cr.h);
    }
    const E = P(cr.seg); post(E[0], E[2], 0, cr.h);
  }
  for (const r of RAILS) {   // long / tall rails (deco + grind only), optional feeder kicker
    if (r.kicker) kicker(r.kicker, r.kicker.x, r.kicker.z, r.kicker.ry);
    const first = grindables.length, n = r.pts.length - 1;
    for (let i = 0; i < n; i++) {
      const A = r.pts[i], B = r.pts[i + 1], len = Math.hypot(B[0] - A[0], B[2] - A[2]);
      D(tube(A, B, RAIL_R * 1.3), METAL); seg('rail', A, B);
      if (n > 1) Object.assign(grindables[grindables.length - 1], {chain: r.name, prev: i ? first + i - 1 : -1, next: i < n - 1 ? first + i + 1 : -1});
      for (let d = 0; d < len - 0.5; d += RAIL_POST_EVERY) { const t = d / len; post(A[0] + (B[0] - A[0]) * t, A[2] + (B[2] - A[2]) * t, 0, A[1] + (B[1] - A[1]) * t); }
    }
    const L = r.pts[n]; post(L[0], L[2], 0, L[1]);
  }

  // ---------- transition zone ----------
  for (const [a, b] of [[CORNER.x, WALL_GAP.x0], [WALL_GAP.x1, EAST_END]]) quarter(WALL, b - a, (a + b) / 2, NORTH_Z, 0);   // north wall, transfer slot
  const cOut = CORNER.r0 + WALL.r + WALL.deck;
  S(new THREE.LatheGeometry(quarterPts(WALL.r, WALL.vert, WALL.deck).map(([u, y]) => new THREE.Vector2(CORNER.r0 + u, y)), CORNER_SEG, PI, PI / 2), CONC, CORNER.x, CORNER.z);
  D(new THREE.TorusGeometry(CORNER.r0 + WALL.r, COPE_R, 4, CORNER_SEG, PI / 2).rotateX(PI / 2).rotateY(PI), METAL, CORNER.x, CORNER.z, 0, H);
  arcSegs(CORNER.x, CORNER.z, CORNER.r0 + WALL.r, H, PI, 1.5 * PI, CORNER_SEG);
  {   // fill the square behind the corner deck (closed solid)
    const sh = new THREE.Shape(); sh.moveTo(-cOut, 0); sh.lineTo(-cOut, cOut); sh.lineTo(0, cOut); sh.absarc(0, 0, cOut, PI / 2, PI, false);
    S(new THREE.ExtrudeGeometry(sh, {depth: H, bevelEnabled: false, curveSegments: 4}).rotateX(-PI / 2), CONC, CORNER.x, CORNER.z);
  }
  const ww = WEST_Z1 - CORNER.z, westFoot = CORNER.x - CORNER.r0;
  quarter(WALL, ww, westFoot, CORNER.z + ww / 2, PI / 2);
  // ry=π/2: local +x = north, so loft A (south end) = bank, B (north end) = quarter
  S(loft(bankLike(BANK_W, ARC_SEG), quarterPts(WALL.r, WALL.vert, WALL.deck), MORPH_L, MORPH_SEG), CONC, westFoot, WEST_Z1 + MORPH_L / 2, PI / 2);
  const bz0 = WEST_Z1 + MORPH_L, bw = BANK_W.z1 - bz0;
  S(prism(bankPts(BANK_W), bw), CONC_WARM, westFoot, bz0 + bw / 2, PI / 2);
  D(rod(bw, BANK_W.run, BANK_W.h), METAL, westFoot, bz0 + bw / 2, PI / 2); edge('coping', bw, BANK_W.run, BANK_W.h, westFoot, bz0 + bw / 2, PI / 2);
  const hw = HP.x1 - HP.x0, hpFoot = NORTH_Z + HP.flat, hpBack = hpFoot + WALL.r + WALL.deck;
  quarter(WALL, hw, HP.x0 + hw / 2, hpFoot, PI);
  S(prism(deckPts(HP_RAMP.zFoot - hpBack, H, 0), HP_RAMP.w), CONC_DARK, HP_RAMP.x, HP_RAMP.zFoot);
  const bH = BOWL.r + BOWL.vert, bOut = BOWL.r0 + BOWL.r + BOWL.deck, bLip = BOWL.r0 + BOWL.r;
  S(new THREE.LatheGeometry(quarterPts(BOWL.r, BOWL.vert, BOWL.deck).map(([u, y]) => new THREE.Vector2(BOWL.r0 + u, y)), BOWL.seg), CONC, BOWL.x, BOWL.z);
  D(new THREE.TorusGeometry(bLip, COPE_R, 4, BOWL.seg).rotateX(PI / 2), METAL, BOWL.x, BOWL.z, 0, bH);
  arcSegs(BOWL.x, BOWL.z, bLip, bH, 0, 2 * PI, BOWL.seg);
  S(prism(deckPts(BOWL.rampZ - (BOWL.z + bOut), bH, 0), BOWL.rampW), CONC_DARK, BOWL.x, BOWL.rampZ);   // tops out at the deck's outer edge
  const hipT = hip(HIP_T);

  // ---------- spine / hip zone ----------
  const hipE = hip(HIP_E, CONC_LIGHT);
  const su = spineU(SPINE), sh = spineH(SPINE), sl = SPINE.z1 - SPINE.z0, sFoot = SPINE.x - su - SPINE.crest / 2, sz = (SPINE.z0 + SPINE.z1) / 2;
  S(prism(spinePts(SPINE), sl), CONC_LIGHT, sFoot, sz, -PI / 2);
  for (const u of [su, su + SPINE.crest]) { D(rod(sl, u, sh), METAL, sFoot, sz, -PI / 2); edge('coping', sl, u, sh, sFoot, sz, -PI / 2); }
  const fb = FUNBOX, fbFoot = fb.z + fb.len / 2 + fb.run;
  S(prism([[0, 0], [fb.run, fb.h], [fb.run + fb.len, fb.h], [2 * fb.run + fb.len, 0]], fb.w), CONC_LIGHT, fb.x, fbFoot);
  for (const sx of [-1, 1]) seg('ledge', [fb.x + sx * fb.w / 2, fb.h, fb.z - fb.len / 2], [fb.x + sx * fb.w / 2, fb.h, fb.z + fb.len / 2]);
  for (const u of [fb.run, fb.run + fb.len]) D(rod(fb.w, u, fb.h), METAL, fb.x, fbFoot);
  { const A = [fb.x, fb.h + fb.bar, fb.z - fb.len / 2 + 0.5], B = [fb.x, fb.h + fb.bar, fb.z + fb.len / 2 - 0.5];
    D(tube(A, B), METAL); post(A[0], A[2], fb.h, A[1]); post(B[0], B[2], fb.h, B[1]); seg('rail', A, B); }
  const ew = BANK_E.z1 - BANK_E.z0;
  S(prism(bankPts(BANK_E), ew), CONC_WARM, BANK_E.x, BANK_E.z0 + ew / 2, -PI / 2);
  D(rod(ew, BANK_E.run, BANK_E.h), METAL, BANK_E.x, BANK_E.z0 + ew / 2, -PI / 2); edge('coping', ew, BANK_E.run, BANK_E.h, BANK_E.x, BANK_E.z0 + ew / 2, -PI / 2);

  // ---------- megaramp (southbound) ----------
  const mg = MEGA, tw = mg.tower, mRollFoot = tw.z1 + mg.rollIn, mKick = mRollFoot + mg.flat;
  box(tw.x0, tw.x1, tw.z0, tw.z1, mg.h, CONC_DARK, null, null);
  S(prism(deckPts(mg.rollIn, mg.h, 0), mg.w), CONC, mg.x, mRollFoot);
  D(rod(mg.w, mg.rollIn, mg.h), METAL, mg.x, mRollFoot); edge('coping', mg.w, mg.rollIn, mg.h, mg.x, mRollFoot, 0);
  const mk = kicker({r: mg.kr, ang: mg.kang, w: mg.w}, mg.x, mKick, PI);
  const mLip = mKick + mk.u, mFront = mLip + mg.gap, mFoot = mFront + mg.deck + mg.land;
  landing(mg.land, mk.h, mg.deck, mg.w + 2, mg.x, mFoot, 0);
  quarter(mg.q, mg.qw, mg.x, mg.qz, PI);
  S(prism(deckPts(mg.access.zFoot - tw.z1, mg.h, 0), mg.access.w), CONC_DARK, mg.access.x, mg.access.zFoot);
  {   // parapet round the tower top (keeps riders from launching over the perimeter fence); openings: roll-in, access ramp
    const pt = mg.parapetT, ph = mg.parapet, y = mg.h + ph / 2, wall = (x0, x1, z0, z1) => S(new THREE.BoxGeometry(x1 - x0, ph, z1 - z0), CONC, (x0 + x1) / 2, (z0 + z1) / 2, 0, y);
    wall(tw.x0, tw.x1, tw.z0, tw.z0 + pt); wall(tw.x0, tw.x0 + pt, tw.z0 + pt, tw.z1); wall(tw.x1 - pt, tw.x1, tw.z0 + pt, tw.z1);
    const cuts = [[mg.x - mg.w / 2, mg.x + mg.w / 2], [mg.access.x - mg.access.w / 2, mg.access.x + mg.access.w / 2]].sort((a, b) => a[0] - b[0]);
    let x = tw.x0 + pt; for (const [a, b] of cuts) { if (a > x) wall(x, a, tw.z1 - pt, tw.z1); x = b; } if (x < tw.x1 - pt) wall(x, tw.x1 - pt, tw.z1 - pt, tw.z1);
  }

  // ---------- street zone ----------
  const st = STAIRS, sRun = st.steps * st.tread, sFootZ = st.zTop - sRun, stx = (st.sx0 + st.sx1) / 2, zMid = (st.zTop + st.zBack) / 2;
  box(st.x0, st.x1, st.zTop, st.zBack, st.h, CONC_LIGHT, null, null);
  seg('ledge', [st.x0, st.h, st.zTop], [st.x0, st.h, st.zBack]);
  seg('ledge', [st.x0, st.h, st.zTop], [st.sx0 - st.hubbaW, st.h, st.zTop]); seg('ledge', [st.sx1, st.h, st.zTop], [st.x1, st.h, st.zTop]);
  S(prism(stairPts(st), st.sx1 - st.sx0), CONC_LIGHT, stx, sFootZ, PI, 0, (c, n) => Math.abs(n.z) > 0.5 && c.z > -0.01 && c.y < st.h / st.steps ? PAINT : null);   // yellow first riser
  S(prism(deckPts(st.rampL, st.h, 0), st.rampW), CONC_DARK, (st.x0 + st.x1) / 2, st.zBack + st.rampL);
  const hx = st.sx0 - st.hubbaW / 2, hh = st.hubbaH;   // hubba: sloped ledge west of the stairs, continuing onto the platform
  S(prism([[0, 0], [0, hh], [sRun, st.h + hh], [sRun + st.hubbaExt, st.h + hh], [sRun + st.hubbaExt, 0]], st.hubbaW), CONC_LIGHT, hx, sFootZ, PI, 0,
    (c, n) => Math.abs(n.x) > 0.5 ? PAINT : null);
  for (const sx of [-1, 1]) { const x = hx + sx * st.hubbaW / 2;
    seg('ledge', [x, hh, sFootZ], [x, st.h + hh, st.zTop]); seg('ledge', [x, st.h + hh, st.zTop], [x, st.h + hh, st.zTop + st.hubbaExt]); }
  { const nose = z => st.h / st.steps + (z - sFootZ) * st.h / st.steps / st.tread, zLo = sFootZ - 0.4, zHi = sFootZ + (st.steps - 1) * st.tread;   // handrail
    const A = [stx, nose(zLo) + st.rail, zLo], B = [stx, st.h + st.rail, zHi], C = [stx, st.h + st.rail, st.zTop + st.railOver];
    D(tube(A, B), METAL); D(tube(B, C), METAL); post(stx, A[2] + 0.2, 0, nose(A[2] + 0.2) + st.rail); post(stx, C[2], st.h, C[1]);
    seg('rail', A, B); seg('rail', B, C); }
  {   // rail-down bank on the platform's east side (rides east, down a 6 m bank beside a rail)
    S(prism(deckPts(st.bankL, st.h, 0), st.zBack - st.zTop), CONC_WARM, st.x1 + st.bankL, zMid, PI / 2);
    const A = [st.x1 - 2, st.h + st.bankRail, zMid], B = [st.x1, st.h + st.bankRail, zMid], C = [st.x1 + st.bankL + 0.4, st.bankRail - 0.08, zMid];
    D(tube(A, B), METAL); D(tube(B, C), METAL); post(A[0], zMid, st.h, A[1]); post(C[0] - 0.2, zMid, 0, C[1]);
    seg('rail', A, B); seg('rail', B, C);
  }
  box(CURB.x - CURB.w / 2, CURB.x + CURB.w / 2, CURB.z0, CURB.z1, CURB.h, CONC_LIGHT, (c, n) => Math.abs(n.y) < 0.5 ? PAINT : null);
  box(PAD.x - PAD.w / 2, PAD.x + PAD.w / 2, PAD.z0, PAD.z1, PAD.h, CONC_LIGHT);
  for (const s of [-1, 1]) D(strip(PAD.z1 - PAD.z0, s * (PAD.w / 2 - STRIP_W / 2), PAD.h), PAINT, PAD.x, (PAD.z0 + PAD.z1) / 2, PI / 2);
  flatBar(FLATBAR.a, FLATBAR.b, FLATBAR.h);
  const lr = LEDGE_RAIL;
  box(lr.x - lr.w / 2, lr.x + lr.w / 2, lr.z0, lr.z1, lr.h, CONC_LIGHT);
  for (const s of [-1, 1]) D(new THREE.BoxGeometry(0.05, 0.05, lr.z1 - lr.z0).translate(s * lr.w / 2, lr.h, 0), METAL, lr.x, (lr.z0 + lr.z1) / 2);
  { const A = [lr.x, lr.h, lr.z1], B = [lr.x, lr.h, lr.z1 + lr.rail]; D(tube(A, B), METAL); post(lr.x, B[2], 0, lr.h);
    seg('rail', [lr.x, lr.h, lr.z0], B); }   // centre line runs the whole ledge + rail
  S(new THREE.BoxGeometry(BOXRAIL.w, BOXRAIL.h, BOXRAIL.z1 - BOXRAIL.z0), PAINT_RED, BOXRAIL.x, (BOXRAIL.z0 + BOXRAIL.z1) / 2, 0, BOXRAIL.h / 2, (c, n) => n.y > 0.5 ? METAL : null);
  seg('rail', [BOXRAIL.x, BOXRAIL.h, BOXRAIL.z0], [BOXRAIL.x, BOXRAIL.h, BOXRAIL.z1]);
  { const kr = KICK_RAIL, k = kicker(kr, kr.x, kr.z, 0), z0 = kr.z - k.u - kr.gap; flatBar([kr.x, z0], [kr.x, z0 - kr.len], kr.h); }
  quarter(SW_Q, SW_Q.x1 - SW_Q.x0, (SW_Q.x0 + SW_Q.x1) / 2, SW_Q.z, PI);

  // ---------- rhythm section + east street ----------
  const rh = RHYTHM, rhythm = [];
  for (let i = 0, x = rh.x; i < rh.n; i++) {   // eastbound: kicker, gap, landing; next kicker right after the landing foot
    const k = kicker(rh, x, rh.z, -PI / 2), foot = x + k.u + rh.gap + rh.deck + rh.l;
    landing(rh.l, k.h, rh.deck, rh.w + 1, foot, rh.z, PI / 2);
    rhythm.push({kickerFoot: x, landingFoot: foot}); x = foot + rh.space;
  }
  box(LEDGE_E.x0, LEDGE_E.x1, LEDGE_E.z - LEDGE_E.w / 2, LEDGE_E.z + LEDGE_E.w / 2, LEDGE_E.h, CONC_LIGHT, (c, n) => Math.abs(n.y) < 0.5 ? PAINT_RED : null);
  box(PAD_E.x - PAD_E.w / 2, PAD_E.x + PAD_E.w / 2, PAD_E.z0, PAD_E.z1, PAD_E.h, CONC_LIGHT);
  for (const s of [-1, 1]) D(strip(PAD_E.z1 - PAD_E.z0, s * (PAD_E.w / 2 - STRIP_W / 2), PAD_E.h), PAINT, PAD_E.x, (PAD_E.z0 + PAD_E.z1) / 2, PI / 2);
  flatBar(FLATBAR_E.a, FLATBAR_E.b, FLATBAR_E.h);
  { const kb = KICK_BOX, k = kicker(kb, kb.x, kb.z, -PI / 2), x0 = kb.x + k.u + kb.gap;
    box(x0, x0 + kb.len, kb.z - kb.bw / 2, kb.z + kb.bw / 2, kb.h, CONC_LIGHT);
    for (const s of [-1, 1]) D(strip(kb.len, s * (kb.bw / 2 - STRIP_W / 2), kb.h), PAINT, x0 + kb.len / 2, kb.z); }
  quarter(SE_Q, SE_Q.x1 - SE_Q.x0, (SE_Q.x0 + SE_Q.x1) / 2, SE_Q.z, PI);

  // ---- world coords of feature faces for scenery / graffiti (city.js) ----
  const lastJ = jumps[jumps.length - 1];
  Object.assign(FEATURES, {
    startDeck: {x0: sd.x - sd.w / 2, x1: sd.x + sd.w / 2, zFront: sd.z, zBack: sd.z + sd.len, h: sd.h, rollInFoot: rollFoot},
    jumps, landing: {zFront: lastJ.landingFront, zFoot: lastJ.landingFoot, halfW: lastJ.halfW, h: lastJ.lipH},
    spawnLine: {x: kl.x, kicker1: kl.k1.z, landingFoot: k1Foot, kicker2: kl.k2.z, rail: {z0: krz, z1: krz - kl.railLen, h: kl.railH},
      quarter: {x0: kl.x - kl.qw / 2, x1: kl.x + kl.qw / 2, zFoot: kl.qz, zBack: kl.qz - kl.q.r - kl.q.deck, h: kl.q.r + kl.q.vert}},
    bankToBank: {x0: b2.x - b2.w / 2, x1: b2.x + b2.w / 2, zFoot: b2.z, zTop: b2Top, landFront: b2Top - b2.gap, landFoot: b2Land, h: b2.h},
    wallride: {xFoot: wr.x, xBack: wr.x - wr.q.r - wr.q.deck, z0: wr.z0, z1: wr.z1, h: wr.q.r + wr.q.vert},
    curveRail: CURVE_RAIL, rails: RAILS,
    pyramid: {x: PYR.x, z: PYR.z, halfBase: PYR.top + PYR.run, h: PYR.h},
    northWall: {x0: CORNER.x, x1: EAST_END, xEast: EAST_END, gap: WALL_GAP, zFoot: NORTH_Z, zBack: NORTH_Z - WALL.r - WALL.deck, h: H},
    halfPipe: {x0: HP.x0, x1: HP.x1, zFoot: hpFoot, zBack: hpBack, ramp: {x0: HP_RAMP.x - HP_RAMP.w / 2, x1: HP_RAMP.x + HP_RAMP.w / 2, zFoot: HP_RAMP.zFoot}},
    bowlCorner: {x: CORNER.x, z: CORNER.z, rOuter: cOut},
    bowl: {x: BOWL.x, z: BOWL.z, rOuter: bOut, h: bH, ramp: {x0: BOWL.x - BOWL.rampW / 2, x1: BOWL.x + BOWL.rampW / 2, zFoot: BOWL.rampZ}},
    westWall: {xFoot: westFoot, xBack: westFoot - WALL.r - WALL.deck, z0: CORNER.z, z1: WEST_Z1},
    westBank: {z0: bz0, z1: BANK_W.z1, xBack: westFoot - BANK_W.run - BANK_W.deck - BANK_W.back},
    hipWest: hipT, hipEast: hipE,
    spine: {x0: sFoot, x1: sFoot + 2 * su + SPINE.crest, z0: SPINE.z0, z1: SPINE.z1, h: sh},
    funbox: {x0: fb.x - fb.w / 2, x1: fb.x + fb.w / 2, z0: fb.z - fb.len / 2 - fb.run, z1: fb.z + fb.len / 2 + fb.run, h: fb.h},
    eastBank: {x0: BANK_E.x, xDeck: BANK_E.x + BANK_E.run, xBack: BANK_E.x + BANK_E.run + BANK_E.deck + BANK_E.back, z0: BANK_E.z0, z1: BANK_E.z1},
    megaramp: {tower: {...tw, h: mg.h}, x0: mg.x - mg.w / 2, x1: mg.x + mg.w / 2, rollInFoot: mRollFoot, kickerFoot: mKick, lip: mLip, lipH: +mk.h.toFixed(2),
      landingFront: mFront, landingFoot: mFoot, quarterFoot: mg.qz, quarterBack: mg.qz + mg.q.r + mg.q.deck, quarterHalfW: mg.qw / 2,
      access: {x0: mg.access.x - mg.access.w / 2, x1: mg.access.x + mg.access.w / 2, zFoot: mg.access.zFoot}},
    stairs: {x0: st.x0, x1: st.x1, zTop: st.zTop, zBack: st.zBack, zFoot: sFootZ, h: st.h, rampFoot: st.zBack + st.rampL, stairX0: st.sx0, stairX1: st.sx1, bankFoot: st.x1 + st.bankL},
    curb: CURB, pad: PAD, flatBar: FLATBAR, ledgeRail: LEDGE_RAIL, boxRail: BOXRAIL, kickRail: KICK_RAIL,
    swQuarter: {x0: SW_Q.x0, x1: SW_Q.x1, zFoot: SW_Q.z, zBack: SW_Q.z + SW_Q.r + SW_Q.deck},
    rhythm: {z: rh.z, halfW: (rh.w + 1) / 2, pairs: rhythm},
    eastLedge: LEDGE_E, eastPad: PAD_E, eastFlatBar: FLATBAR_E, kickBox: KICK_BOX,
    seQuarter: {x0: SE_Q.x0, x1: SE_Q.x1, zFoot: SE_Q.z, zBack: SE_Q.z + SE_Q.r + SE_Q.deck},
    zones: ZONES.map(([x0, x1, z0, z1]) => ({x0, x1, z0, z1})),
  });

  // perimeter: concrete wall just outside PARK + invisible collider for the chain-link fence above it
  const {xMin: x0, xMax: x1, zMin: z0, zMax: z1} = PARK, wt = PERIM.t, fh = PERIM.fence - PERIM.h, fence = [];
  for (const [w, d, x, z] of [[x1 - x0 + 2 * wt, wt, (x0 + x1) / 2, z0 - wt / 2], [x1 - x0 + 2 * wt, wt, (x0 + x1) / 2, z1 + wt / 2],
    [wt, z1 - z0, x0 - wt / 2, (z0 + z1) / 2], [wt, z1 - z0, x1 + wt / 2, (z0 + z1) / 2]]) {
    S(new THREE.BoxGeometry(w, PERIM.h, d), PERIM.color, x, z, 0, PERIM.h / 2);
    fence.push(new THREE.BoxGeometry(w, fh, d).translate(x, PERIM.h + fh / 2, z));
  }

  const mat = new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide});
  const level = new THREE.Mesh(mergeGeometries(solid), mat), decoMesh = new THREE.Mesh(mergeGeometries(deco), mat);
  const fenceCol = new THREE.Mesh(mergeGeometries(fence)); fenceCol.visible = false; level.add(fenceCol);   // collides via the octree only
  decoMesh.matrixAutoUpdate = false; level.matrixAutoUpdate = false;   // static
  scene.add(level, decoMesh);
  level.updateMatrixWorld(true); decoMesh.updateMatrix();
  return new Octree().fromGraphNode(level);
}
