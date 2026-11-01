// Tunable params -> sliders, persisted in data/prefs.json via serve.py
// [key, label, min, max, step, default, group, tip]
export const PARAMS = [
  ['gravity', 'gravity', 2, 30, 0.1, 18, 'physics', 'm/s²'],
  ['pedal', 'pedal', 0, 30, 0.1, 14, 'physics', 'W acceleration (m/s²)'],
  ['pedalMax', 'pedal max', 1, 30, 0.1, 18, 'physics', 'W stops accelerating above this (m/s)'],
  ['sprint', 'standing', 1, 3, 0.05, 1.6, 'physics', 'Shift: multiplies pedal and pedal max'],
  ['roll', 'rolling', 0, 1, 0.005, 0.008, 'physics', 'speed lost per second (fraction)'],
  ['brake', 'brake', 0, 10, 0.1, 3, 'physics', 'S, fraction per second'],
  ['brakeD', 'brake bite', 0, 30, 0.5, 8, 'physics', 'S, extra constant decel (m/s²) so braking actually stops'],
  ['grip', 'grip', 0, 30, 0.5, 28, 'physics', 'how fast velocity follows the wheels'],
  ['steer', 'steer', 0, 6, 0.05, 2.8, 'control', 'A/D rad/s on the ground'],
  ['lean', 'lean', 0, 60, 1, 35, 'control', 'max side lean when turning, degrees (visual)'],
  ['hop', 'bunny hop', 0, 10, 0.1, 7.4, 'control', 'Space impulse at full charge (m/s)'],
  ['charge', 'charge', 0.05, 2, 0.05, 0.2, 'control', 'seconds to fully charge the hop'],
  ['snap', 'snap', 0, 0.5, 0.01, 0.12, 'control', 'max distance to look for ground (m)'],
  ['stick', 'stick', 0, 50, 0.5, 10, 'control', 'extra m/s² keeping you down on rollers; high = never takes off'],
  ['upK', 'align', 1, 40, 0.5, 20, 'control', 'how fast the bike follows the ground normal'],
  ['airYaw', 'air spin', 0, 15, 0.1, 7.5, 'air', 'A/D rad/s'],
  ['airPitch', 'flip', 0, 15, 0.1, 6, 'air', 'W/S rad/s'],
  ['airK', 'response', 1, 30, 0.5, 20, 'air', 'how fast rotation follows the key (inertia)'],
  ['airAlign', 'auto level', 0, 15, 0.1, 5, 'air', 'no W/S in the air: nose follows the trajectory (0 = off)'],
  ['autoFix', 'auto fix', 0, 30, 0.5, 8, 'air', 'before landing, straightens the bike to the ground and trajectory (0 = off)'],
  ['fixMax', 'fix max', 0, 150, 1, 80, 'air', 'max degrees corrected; more crooked = you eat it'],
  ['whip', 'tailwhip', 0.5, 4, 0.05, 2, 'air', 'Q: frame turns per second'],
  ['landTol', 'land tol', 5, 90, 1, 55, 'air', 'max degrees between bike and ground on landing'],
  ['slipTol', 'slip tol', 5, 90, 1, 70, 'air', 'max degrees between bike and travel direction on landing'],
  ['grindSnap', 'grind snap', 0.1, 1, 0.05, 0.45, 'grind', 'max sideways distance to an edge that still locks on (m)'],
  ['grindAng', 'grind angle', 5, 80, 1, 35, 'grind', 'max degrees between travel and the edge to lock on'],
  ['grindBal', 'grind balance', 0, 3, 0.05, 1, 'grind', 'balance drift multiplier in grinds (0 = never falls)'],
  ['manBal', 'manual balance', 0, 3, 0.05, 1, 'grind', 'balance drift multiplier in manuals (0 = never falls)'],
  ['violence', 'violence', 0, 3, 0.05, 1, 'crashes', 'how hard the pelican gets thrown and spun'],
  ['gore', 'gore', 0, 3, 0.05, 1, 'crashes', 'blood per hit (0 = off)'],
  ['camDist', 'distance', 1, 12, 0.1, 4.5, 'camera', 'm behind the bike'],
  ['camH', 'height', 0, 5, 0.1, 1.2, 'camera', 'm above the bike'],
  ['camLock', 'lock', 1, 40, 0.5, 14, 'camera', 'how fast it gets behind the bike when turning (high = stuck)'],
  ['camK', 'smoothing', 1, 30, 0.5, 8, 'camera', 'in the air: how fast it gets behind the trajectory'],
  ['camFix', 'recenter', 0, 10, 0.1, 3, 'camera', 'how fast it swings back after the mouse stops (0 = off)'],
  ['fov', 'fov', 40, 110, 1, 70, 'camera', 'vertical degrees'],
  ['sens', 'sensitivity', 0.2, 5, 0.05, 1, 'camera', 'mouse'],
];
// Feel targets for the defaults above, measured on flat ground with /tmp/bmxsim/metrics.mjs (was = previous tune).
// Re-measure after retuning; data/prefs.json overrides these defaults, keep it in sync.
export const FEEL = {
  hopHang_s: 0.81,     // was 0.99  full-charge bunny hop air time
  hopHeight_m: 1.53,   // was 1.51  full-charge hop (tap: 0.64, was 0.61)
  turnR10_m: 2.96,     // was 3.63  full steer at 10 m/s
  slip_deg: 5.3,       // was 10.9  velocity lagging the heading while turning
  steerLag_s: 0.07,    // was 0.16  until the path turns at 90% of the steer rate
  toPedalMax_s: 1.26,  // was 1.98  0 -> pedal max (to 10 m/s: 0.71, was 1.11)
  brake10to1_s: 0.41,  // was 0.76  (1.9 m, was 3.0 m)
  air180_s: 0.47,      // was 0.61  holding A/D right after takeoff
  climb_pct: 92,       // was ~60   quarter height reached vs v²/2g at 5-9 m/s (bank 91, was ~50); crease/flicker no longer eats speed
  landBounces: 0,      // was ~110  re-landings after a nose-first hop landing (hover + relaunch bug)
};
export const DEF = Object.fromEntries(PARAMS.map(p => [p[0], p[5]]));
export const P = {...DEF, best: 0, ...(await fetch('/prefs').then(r => r.json()).catch(() => ({})))};

const $ = id => document.getElementById(id);
let saveT;
export function save() { clearTimeout(saveT); saveT = setTimeout(() => fetch('/prefs', {method: 'POST', body: JSON.stringify(P)}).then(() => flash('saved')), 300); }
export function flash(s) { $('msg').textContent = s; clearTimeout(flash.t); flash.t = setTimeout(() => $('msg').textContent = '', 1200); }

export function buildPanel(apply) {
  const panel = $('panel');
  let grp;
  for (const [k, label, min, max, step, , g, tip] of PARAMS) {
    if (g !== grp) { grp = g; panel.insertAdjacentHTML('beforeend', `<h3>${g}</h3>`); }
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label title="${tip}">${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${P[k]}"><span>${P[k]}</span>`;
    const [lab, inp, val] = row.children;
    const set = v => { const from = P[k]; P[k] = +v; inp.value = v; val.textContent = v; apply(); log('pref', {k, from, to: P[k]}); save(); };
    inp.onchange = () => set(inp.value);
    inp.oninput = () => { P[k] = +inp.value; val.textContent = inp.value; apply(); };
    lab.ondblclick = () => set(DEF[k]);
    panel.append(row);
  }
  panel.insertAdjacentHTML('beforeend', '<p><button id="resetAll">reset all</button></p>');
  $('resetAll').onclick = () => { log('pref', {k: '*', from: {...P}, to: DEF}); Object.assign(P, DEF); save(); setTimeout(() => location.reload(), 400); };
  $('legBtn').onclick = () => { const l = $('legend'); l.style.display = l.style.display === 'block' ? 'none' : 'block'; };
}
