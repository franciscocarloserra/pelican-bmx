// HUD + juice: outlined/textured trick text (no shadows), combo stack + draining meter, ticking score,
// landing grades, bail text, camera shake / hit-stop / FOV kick / punch, speed lines, score particles, sparkles.
// Cartoon sticker/cutout lettering: each word (or each letter, ransom-note style, for big tricks) on a torn paper chip
// with white sticker border + black outline; per-letter squash/stretch pop-in, jiggle while the combo is live,
// spin out on bank, splat on bail. CSS is injected by this module. DOM only, pooled nodes, WAAPI transform/opacity.
//
// API  (import { hud } from './hud.js'; also window.hud)
//   hud.trick(name, points)       trick/grind callout (color tier by points) + line in the combo stack
//   hud.combo(mult, pts)          multiplier + running points (mult 0 = clear); milestones pop "COMBO xN"
//   hud.meter(frac)               combo window left 0..1 (drains on the ground), 0 hides
//   hud.bank(total, record)       combo cashed: big "+total" / NEW RECORD, particles fly to the score
//   hud.score(score, best)        top-left rolling-digit score target
//   hud.special(frac, full)       THPS special bar 0..1 (call every frame; flashes on gain, flames + "SPECIAL!" when full flips on)
//   hud.land(grade, impact)       'PERFECT'|'CLEAN'|'SKETCHY'|null, impact 0..1.5: stamp, shake, hit-stop, punch, sparkle
//   hud.bail(impact, why)         BAIL text, stack falls, big shake + hit-stop
//   hud.callout(text, sub, pts)   generic big center text; pts = number (tier) or 'bail'
//   hud.pts(n)                    tiny "+n" pop by the combo total + bar flash + blip (use for small gains, e.g. grind ticks)
//   hud.oob(onDone)               OUT OF BOUNDS: red flash, blood on the lens, heavy shake + hit-stop, slam text;
//                                 calls onDone (respawn) after OOB_MS; returns false if one is already running (hud.oobActive())
//   hud.glitch(onDone)            GLITCHER (rider clipped into geometry): RGB split + slice tearing on the canvas (SVG filter),
//                                 block noise, scanlines, flicker, inverted frames, corrupted GLITCHER text, harsh shake/hit-stop,
//                                 glitch sfx; calls onDone after GLITCH_MS; false if one is running (hud.glitchActive())
//   hud.shake(amt 0..1)  hud.hitstop(sec)  hud.punch(m)  hud.fovKick(deg)
// main.js wiring: fdt *= hud.timeScale(); hud.event(type, d, S) in the physics emit (after tricks);
//   hud.cam(camera, P.fov, S) after updateCam. hud.event already does land grades/juice, bail, pop, grind shake:
//   don't call hud.land/hud.bail for those again (set hud.autoGrade = false to grade landings yourself).
// Fallback: text written to the legacy #trick element without an API call is shown as a callout.

export const FX = {text: true, shake: true, hitstop: true, fov: true, punch: true, speedLines: false, particles: true, sparkle: true, flash: true, meter: true, blood: false, sound: true, omen: true, logo: true, glitch: true, glitchSvg: false, glitchInvert: true, hideStatusBar: true};   // glitchSvg: canvas SVG tear/RGB filter (heavy, off); glitchInvert: one difference-blend layer
const SHAKE_AMP = 0.16, SHAKE_ROLL = 0.035, SHAKE_DECAY = 2.8, SHAKE_FREQ = 24;           // m, rad at trauma 1 (offset ∝ trauma²), trauma lost per s, Hz
const SHAKE_LAND = 0.5, SHAKE_BAIL = 0.95, SHAKE_GRIND = 0.18;                            // trauma per unit impact
const HITSTOP_SCALE = 0.06, HITSTOP_LAND = 0.07, HITSTOP_MIN_IMPACT = 0.75, HITSTOP_BAIL = 0.13, HITSTOP_MAX = 0.25, HITSTOP_EASE = 0.08;   // time scale during stop, s per impact, s
const FOV_SPEED = 10, FOV_V0 = 8, FOV_V1 = 22, FOV_K = 3, FOV_POP = 5, FOV_GRIND = 2.5, FOV_LAND = -3, FOV_DECAY = 6;   // deg at V1 (m/s), smoothing 1/s, kicks deg, decay 1/s
const PUNCH_LAND = 0.35, PUNCH_PITCH = 0.12, PUNCH_DECAY = 9;                             // m forward on trick land, rad nod per m, 1/s
const SPEEDLINE_V0 = 12, SPEEDLINE_V1 = 22, SPEEDLINE_MAX = 0.55;                         // m/s fade in range, max opacity
const IMPACT_V = 9, BAIL_V = 10, GRADE_MIN_AIR = 0.45, PERFECT_DEG = 12, CLEAN_DEG = 30;  // fall speed = impact 1, bail speed = 1, rotation leftover for grades
const CALL_MS = 1500, BIG_MS = 1400, GRADE_MS = 1100, LIST_MAX = 5, COMBO_MILESTONES = [3, 5, 8, 10, 15, 20, 25, 30, 40, 50];
const PARTICLES = 24, PART_PER_K = 3, PART_MIN = 5, PART_MAX = 18, PART_TRICK = 3, PART_MS = 650, SPARKLES = 14, COUNT_K = 9;   // per 1000 pts, ms flight, counter speed 1/s
const OOB_MS = 950, OOB_HITSTOP = 0.18, OOB_FOV = 14, BLOOD_SPLATS = 5, BLOOD_MS = 1900, FLOATERS = 6;   // respawn delay, lens splats, fade (ms)
const GLITCH_MS = 1000, GLITCH_TICK = 45, GLITCH_HITSTOP = 0.12, GLITCH_FOV = -8, GLITCH_SLICES = 10, GLITCH_TEAR = 160, GLITCH_RGB = 14;   // ms, re-randomize every ms, px max tear / channel offset
const STAGGER = 28, CALL_LIVE_MS = 6000, RANSOM_PTS = 1500, RANSOM_MULT = 6, SIZE_PER_MULT = 0.07, SIZE_MAX_MULT = 10, MULT_GROW = 0.05;   // ms per letter, callout max life, ransom-note thresholds, callout/multiplier growth per combo step
const TRICK_SHAKE = 0.12, COMBO_SHAKE = 0.1, STAMP_SHAKE = 0.3, STAMP_HITSTOP = 0.035, SPECIAL_SHAKE = 0.3;   // trauma per trick (x pts/1000), per combo step (x mult/5), grade stamp, special full
const PAPERS = [['#fffbe6', '#ffffff', '#ece6d3'], ['#fffbe6', '#ffe14d', '#c8fbff'], ['#ffe14d', '#ff9b3d', '#5ef2ff', '#9dff5a'], ['#ff7ad9', '#ff5a3d', '#ffe14d', '#9dff5a', '#5ef2ff']];   // chip paper by combo heat
const RANSOM_FONTS = ['HudDisplay', 'Impact,sans-serif', 'Georgia,serif', '"Courier New",monospace', '"Arial Black",sans-serif', '"Times New Roman",serif'];
const STAMP_PAPER = {PERFECT: '#ffe14d', CLEAN: '#c8fbff', SKETCHY: '#e0d6c4'};
const OMEN_PTS = 3000, OMEN_MS = 560, CHROMA_MS = 260;   // bank total that triggers the looming slam, loom+crash duration, chromatic shudder
const DRONE_VOL = 0.5, DRONE_FULL = 12, WHOOSH_VOL = 0.8, AIR_VOL = 0.35, RING_VOL = 0.12, SWISH_VOL = 1, WHOOSH_RATE = 8, HISS_VOL = 0.25, DROP_VOL = 1;   // drone level at DRONE_FULL x combo; whoosh at rotation rate (rad/s); grind hiss; landing sub-drop
const SOUND_VOL = 0.05;   // WebAudio blips (FX.sound toggles)
const TIERS = [[0, '#ffffff', '#8d9bb0'], [300, '#5ef2ff', '#1677d6'], [800, '#9dff5a', '#1d9a3a'], [2000, '#ffe14d', '#ff7a00'], [5000, '#ff7ad9', '#9c1590'], [12000, '#ff5a3d', '#8a0000']];
const GRADES = {PERFECT: ['#fff6a8', '#ffb000'], CLEAN: ['#c8fbff', '#22a6e0'], SKETCHY: ['#ffc58a', '#9a4a12']}, BAIL_C = ['#ff8a7a', '#a00000'];

const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString('en-US');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const rnd = (a, b) => a + Math.random() * (b - a);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const tierOf = p => { let t = TIERS[0]; for (const x of TIERS) if (p >= x[0]) t = x; return [t[1], t[2]]; };

let e = null, rects = null, apiT = -1e9, lastTrickT = -1e9, bankT = -1e9, now = performance.now(), lastT = now;
let trauma = 0, hitT = 0, hitEase = 1, punchV = 0, fovSpd = 0, fovKickV = 0, spd = 0, vyAir = 0;
let comboMult = 0, totalT = 0, totalS = 0, scoreT = 0, scoreS = 0, meterT = 0, meterS = -1, speedO = -1, lowOn = false;
let spT = 0, spS = -1, spQ = -1, spFullT = false, spFullS = false, spFlashT = 0, odoN = -1;
let rotY = 0, rotP = 0, au = null, drLvl = -1, whLvl = -1, hsLvl = -1;
let glEnd = 0, glNext = 0, glOn = false, canvasEl = null, pi = 0, si = 0, fi = 0, oobT = 0, ac = null, noiseBuf = null;

function audio() {   // one graph: voices + one-shots -> bus gain -> limiter -> out
  if (au || !FX.sound) return au;
  try {
    ac = new AudioContext();
    const bus = ac.createGain(), lim = ac.createDynamicsCompressor();
    bus.gain.value = SOUND_VOL; Object.assign(lim, {}); lim.threshold.value = -8; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = .002; lim.release.value = .12;
    bus.connect(lim).connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 6); }
    const shaper = ac.createWaveShaper(); shaper.curve = curve; shaper.connect(bus);
    const voice = (src, filt, f, q) => { const fl = ac.createBiquadFilter(), g = ac.createGain(); fl.type = filt; fl.frequency.value = f; fl.Q.value = q; g.gain.value = 0; src.connect(fl).connect(g).connect(bus); return {f: fl, g}; };
    const loop = () => { const n = ac.createBufferSource(); n.buffer = noiseBuf; n.loop = true; n.start(); return n; };
    const dr = ac.createGain(); [[55, 'sawtooth'], [55.6, 'sawtooth'], [27.5, 'sine'], [82.4, 'triangle']].forEach(([f, ty]) => { const o = ac.createOscillator(); o.type = ty; o.frequency.value = f; o.connect(dr); o.start(); });
    au = {bus, shaper, drone: voice(dr, 'lowpass', 90, 4), whoosh: voice(loop(), 'bandpass', 700, 1.4), air: voice(loop(), 'highpass', 2500, .5), hiss: voice(loop(), 'bandpass', 4200, .8), ring: voice(loop(), 'bandpass', 2350, 40)};
  } catch { au = null; }
  return au;
}
const setLvl = (v, lvl, freq) => { const t = ac.currentTime; v.g.gain.setTargetAtTime(lvl, t, .08); if (freq) v.f.frequency.setTargetAtTime(freq, t, .1); };
function sfx(kind, k = 0) {   // layered synth one-shots (oscillators are one-shot by design; graph/buffers shared)
  if (!FX.sound || !audio()) return;
  try {
    if (ac.state === 'suspended') ac.resume();
    const t = ac.currentTime, out = au.bus;
    const tone = (f, t0, dur, type = 'square', f1 = f, vol = 1, dest = out) => {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = type;
      o.frequency.setValueAtTime(f, t + t0); o.frequency.exponentialRampToValueAtTime(f1, t + t0 + dur);
      g.gain.setValueAtTime(1e-4, t + t0); g.gain.exponentialRampToValueAtTime(vol, t + t0 + .005); g.gain.exponentialRampToValueAtTime(1e-4, t + t0 + dur);
      o.connect(g).connect(dest); o.start(t + t0); o.stop(t + t0 + dur + .02);
    };
    const noise = (dur, freq, vol = 2, t0 = 0, type = 'lowpass', f1 = 60) => {
      const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = noiseBuf; f.type = type;
      f.frequency.setValueAtTime(freq, t + t0); f.frequency.exponentialRampToValueAtTime(f1, t + t0 + dur);
      g.gain.setValueAtTime(vol, t + t0); g.gain.exponentialRampToValueAtTime(1e-4, t + t0 + dur); s.connect(f).connect(g).connect(out); s.start(t + t0, Math.random() * .5); s.stop(t + t0 + dur);
    };
    const f0 = 520 * 2 ** (Math.min(k, 24) / 12);   // pitch climbs with the multiplier
    if (kind === 'pt') { tone(f0, 0, .08, 'square', f0 * 1.5, .7); tone(f0 * 1.5, .05, .1, 'triangle', f0 * 2, .6); tone(f0 / 2, 0, .14, 'sine', f0 / 2, .8); noise(.03, 6000, .8); }
    else if (kind === 'pop') { noise(.05, 2500, 1.5, 0, 'bandpass', 600); tone(160, 0, .09, 'sine', 320, .9); tone(900, .01, .05, 'triangle', 1500, .25); }
    else if (kind === 'land') { noise(.07, 1800, 1.6); tone(220, 0, .06, 'square', 90, .3); }
    else if (kind === 'grindOn') { tone(2350, 0, .25, 'triangle', 2200, .35); tone(3520, 0, .18, 'sine', 3400, .2); noise(.12, 7000, 1.4, 0, 'highpass', 3000); tone(120, 0, .1, 'sine', 70, .8); }
    else if (kind === 'grindOff') { noise(.1, 5000, 1, 0, 'highpass', 1500); tone(1800, 0, .12, 'triangle', 900, .25); }
    else if (kind === 'manual') { tone(300, 0, .07, 'triangle', 450, .5); tone(450, .07, .1, 'triangle', 675, .5); }
    else if (kind === 'special') { tone(110, 0, .6, 'sawtooth', 880, .5); tone(220, .05, .55, 'square', 1760, .25); noise(.5, 800, 1.2, 0, 'bandpass', 8000); tone(55, .45, .5, 'sine', 30, 1.2, au.shaper); }
    else if (kind === 'ui') { tone(880, 0, .05, 'triangle', 1320, .4); tone(1320, .04, .06, 'triangle', 1760, .3); }
    else if (kind === 'swish') { noise(.22, 900 + 2500 * k, SWISH_VOL * (.5 + k), 0, 'bandpass', 300); noise(.15, 6000, .5 * (.5 + k), .02, 'highpass', 2500); }
    else if (kind === 'tick') tone(f0 * 1.5, 0, .035, 'triangle');
    else if (kind === 'bank') { [0, 4, 7, 12, 16].forEach((n, i) => { tone(f0 * 2 ** (n / 12), i * .05, .14, 'square', f0 * 2 ** (n / 12), .6); tone(f0 * 2 ** (n / 12 + 1), i * .05 + .01, .12, 'sine', f0 * 2 ** (n / 12 + 1), .35); }); tone(80, 0, .45, 'sine', 40, 1, au.shaper); noise(.3, 9000, .6, .2, 'highpass', 4000); }
    else if (kind === 'perfect') { tone(1320, 0, .25, 'sine', 1760); tone(1980, .06, .2, 'sine'); }
    else if (kind === 'bail') { noise(.45, 2400, 2.2); tone(140, 0, .35, 'sine', 35, 1.2, au.shaper); tone(400, 0, .3, 'sawtooth', 60, .3); noise(.08, 600, 2, .12); noise(.08, 500, 1.6, .26); }
    else if (kind === 'stamp') { noise(.09, 1400, 2); tone(95, 0, .14, 'sine', 45); }
    else if (kind === 'boom') { tone(72, 0, .7, 'sine', 26, 1.4, au.shaper); tone(36, 0, .9, 'sine', 22, 1.2); noise(.3, 400, 2.5); noise(.08, 3000, 1.2); }
    else if (kind === 'drop') { tone(110, 0, .35, 'sine', 32, DROP_VOL * clamp(k, .3, 1.5), au.shaper); noise(.06, 900, k); }
    else if (kind === 'rise') { const a = 180 + 900 * clamp(k, 0, 1); tone(a * .8, 0, .16, 'sawtooth', a, .5); tone(a * 1.5, .02, .14, 'square', a * 2, .25); }
    else if (kind === 'glitch') {
      for (let i = 0; i < 16; i++) tone(rnd(60, 3200), rnd(0, .75), rnd(.015, .06), Math.random() < .5 ? 'square' : 'sawtooth', rnd(40, 4000));
      noise(.12, 9000, 2.5); tone(55, 0, .5, 'square', 30, 1, au.shaper);
    }
    else if (kind === 'oob') { noise(.9, 5000, 3); tone(110, 0, .7, 'sine', 28, 1.4, au.shaper); tone(70, .02, .6, 'sawtooth', 25); }
  } catch {}
}
function drone(mult) {
  if (!au) return;
  const l = Math.min(1, mult / DRONE_FULL);
  setLvl(au.drone, l * DRONE_VOL, 90 + 1100 * l * l);
}
function omen(big = 1) {   // red/black flash + chromatic shudder + boom
  if (!FX.omen || !E()) return;
  e.omenK.animate([{opacity: .7 * big}, {opacity: 0}], {duration: 180, easing: 'ease-out'});
  e.omenR.animate([{opacity: 0}, {opacity: .8 * big, offset: .25}, {opacity: 0}], {duration: 520, easing: 'ease-out'});
  const j = 14 * big;
  e.chR.animate([{transform: `translateX(${-j}px)`, opacity: .55}, {transform: `translateX(${j}px)`, opacity: .4, offset: .3}, {transform: `translateX(${-j / 2}px)`, opacity: .3, offset: .6}, {transform: 'none', opacity: 0}], {duration: CHROMA_MS});
  e.chC.animate([{transform: `translateX(${j}px)`, opacity: .55}, {transform: `translateX(${-j}px)`, opacity: .4, offset: .3}, {transform: `translateX(${j / 2}px)`, opacity: .3, offset: .6}, {transform: 'none', opacity: 0}], {duration: CHROMA_MS});
  if (!canvasEl) canvasEl = document.querySelector('body > canvas');
  canvasEl?.animate([{transform: `translateX(${j}px)`}, {transform: `translateX(${-j}px)`}, {transform: `translate(${j / 2}px,3px)`}, {transform: 'none'}], {duration: CHROMA_MS, easing: 'steps(4)'});
  hud.shake(.5 * big); hud.hitstop(.05 * big); sfx('boom');
}
function floater(text, c) {
  const f = e.floats[fi = (fi + 1) % FLOATERS], [x, y] = R().row;
  T(f, text); colors(f, c);
  play(f, [{transform: `translate(${x + rnd(-30, 50)}px,${y - 20}px) scale(.4)`, opacity: 0}, {transform: `translate(${x + rnd(40, 90)}px,${y - 45}px) scale(1.15)`, opacity: 1, offset: .2},
    {transform: `translate(${x + rnd(60, 110)}px,${y - 90}px) scale(.9)`, opacity: 0}], {duration: 650});
}
const GL_CH = '#@%&$!?/<>[]{}=+*01';
function corrupt(s) {   // duplicated / swapped / dropped letters
  let o = '';
  for (const ch of s) { const r = Math.random(); o += r < .14 ? ch + ch : r < .22 ? GL_CH[Math.random() * GL_CH.length | 0] : r < .25 ? '' : ch; }
  return o || s;
}
function buildGlitch() {
  const g = e.gl = {root: document.createElement('div'), slices: []};
  g.root.id = 'hxGl'; g.root.hidden = true;
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
  svg.innerHTML = `<filter id="hxGlF" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0 0.035" numOctaves="1" seed="1" result="t"/>
<feComponentTransfer in="t" result="m"><feFuncR type="discrete" tableValues="0.5 0.5 0.15 0.5 0.85 0.5 0.5 0.3 0.5 0.95 0.5"/><feFuncG type="linear" slope="0" intercept="0.5"/></feComponentTransfer>
<feDisplacementMap in="SourceGraphic" in2="m" scale="120" xChannelSelector="R" yChannelSelector="G" result="d"/>
<feColorMatrix in="d" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/><feOffset in="r" dx="-10" result="ro"/>
<feColorMatrix in="d" values="0 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0" result="gb"/><feOffset in="gb" dx="10" result="gbo"/>
<feBlend in="ro" in2="gbo" mode="screen"/></filter>`;
  e.root.append(svg);
  g.turb = svg.querySelector('feTurbulence'); g.disp = svg.querySelector('feDisplacementMap'); [g.offR, g.offB] = svg.querySelectorAll('feOffset');
  const cv = document.createElement('canvas'); cv.width = 32; cv.height = 18; const cx = cv.getContext('2d');   // block noise texture, made once
  for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) { cx.fillStyle = Math.random() < .55 ? 'transparent' : `hsl(${rnd(0, 360)},100%,${rnd(30, 70)}%)`; cx.fillRect(x, y, 1, 1); }
  g.noise = document.createElement('div'); g.noise.className = 'hxGlN'; g.noise.style.backgroundImage = `url(${cv.toDataURL()})`;
  g.scan = document.createElement('div'); g.scan.className = 'hxGlS';
  g.inv = document.createElement('div'); g.inv.className = 'hxGlI';
  g.root.append(g.noise, g.scan, g.inv);
  for (let i = 0; i < GLITCH_SLICES; i++) { const d = document.createElement('div'); d.className = 'hxGlB'; g.root.append(d); g.slices.push(d); }
  g.tw = document.createElement('div'); g.tw.className = 'hxGlT';
  g.txt = [tx(), tx(), tx()];   // red copy, cyan copy, main
  colors(g.txt[0], ['#ff2a2a', '#ff0040']); colors(g.txt[1], ['#00fff0', '#0060ff']); colors(g.txt[2], ['#ffffff', '#c6ff3d']);
  g.txt[0].classList.add('ch'); g.txt[1].classList.add('ch');
  g.tw.append(...g.txt); g.root.append(g.tw);
  e.root.append(g.root);
}
function glitchTick(t) {   // re-randomize every GLITCH_TICK ms
  const g = e.gl, k = (glEnd - t) / GLITCH_MS;   // 1 -> 0
  if (!canvasEl) canvasEl = document.querySelector('body > canvas');
  if (canvasEl) {
    const r = Math.random(), heavy = FX.glitchSvg && r < .7;
    canvasEl.style.filter = heavy ? 'url(#hxGlF)' + (r < .35 ? ` hue-rotate(${rnd(60, 300) | 0}deg)` : '') : '';
    canvasEl.style.transform = Math.random() < .5 ? `translate(${rnd(-30, 30) * k | 0}px,${rnd(-8, 8) | 0}px) skewX(${rnd(-4, 4) * k}deg)` : '';
    if (heavy) {
      g.turb.setAttribute('seed', String(Math.random() * 999 | 0)); g.turb.setAttribute('baseFrequency', `0 ${rnd(.01, .08).toFixed(3)}`);
      g.disp.setAttribute('scale', String(rnd(.3, 1) * GLITCH_TEAR * (.4 + k) | 0));
      const o = rnd(.4, 1) * GLITCH_RGB; g.offR.setAttribute('dx', String(-o | 0)); g.offB.setAttribute('dx', String(o | 0)); g.offB.setAttribute('dy', String(rnd(-3, 3) | 0));
    }
  }
  for (const d of g.slices) {
    if (Math.random() < .4) { d.style.opacity = '0'; continue; }
    d.style.opacity = '1';
    d.style.transform = `translate(${rnd(-80, 80) | 0}px,${rnd(0, innerHeight) | 0}px) scaleY(${rnd(.3, 8).toFixed(1)})`;
  }
  g.noise.style.opacity = String(rnd(0, .55) * (k + .3));
  g.noise.style.transform = `translate(${rnd(-30, 30) | 0}%,${rnd(-30, 30) | 0}%) scale(${rnd(1.6, 4).toFixed(2)})`;   // transform only (no background repaint)
  g.inv.style.opacity = FX.glitchInvert && Math.random() < .15 ? '1' : '0';
  g.scan.style.transform = `translateY(${rnd(0, 3) | 0}px)`; g.root.style.opacity = Math.random() < .12 ? '.25' : '1';
  if (FX.text) {
    const [a, b, m] = g.txt, j = () => (rnd(-1, 1) * 18 | 0) + 'px';
    T(a, corrupt('GLITCHER')); T(b, Math.random() < .5 ? 'GLITCHER' : corrupt('GLITCHER')); T(m, corrupt('GLITCHER'));
    a.style.transform = `translate(${j()},${rnd(-6, 6) | 0}px)`; a.style.opacity = Math.random() < .3 ? '0' : '.85';
    b.style.transform = `translate(${j()},${rnd(-6, 6) | 0}px)`; b.style.opacity = Math.random() < .3 ? '0' : '.85';
    m.style.transform = `translate(${rnd(-8, 8) | 0}px,0) skewX(${rnd(-12, 12) | 0}deg) scale(${(t - glEnd + GLITCH_MS < 90 ? 1.8 : rnd(.95, 1.15)).toFixed(2)},${rnd(.85, 1.3).toFixed(2)})`;
    m.style.opacity = Math.random() < .1 ? '0' : '1';
  }
}
function glitchEnd() {
  glOn = false; e.gl.root.hidden = true;
  if (canvasEl) { canvasEl.style.filter = ''; canvasEl.style.transform = ''; }
}
function meterFlash() { if (FX.meter) e.mflash.animate([{opacity: 1}, {opacity: 0}], {duration: 260, easing: 'ease-out'}); }

function T(el, s) { if (el._t === s) return; el._t = s; el.children[0].textContent = s; el.children[1].textContent = s; }
function colors(el, c) { if (el._c === c) return; el._c = c; el.style.setProperty('--c', c[0]); el.style.setProperty('--c2', c[1]); }
let liveA = 0;
const MAX_ANIMS = 110;   // cap on concurrent cosmetic Web Animations (particles, sparkles, letter/chip pops)
function fxA(el, frames, opt) {   // budgeted animate: returns null (element just appears static) when over the cap
  if (liveA >= MAX_ANIMS) return null;
  const a = el.animate(frames, opt); liveA++;
  let done = false; const end = () => { if (!done) { done = true; liveA--; } }; a.onfinish = end; a.oncancel = end;
  return a;
}
function play(el, frames, opt) { el._a?.cancel(); el._a = el.animate(frames, {fill: 'forwards', easing: 'ease-out', ...opt}); return el._a; }
const tx = () => { const s = document.createElement('span'); s.className = 'tx'; s.append(document.createElement('b'), document.createElement('b')); return s; };
const popFrames = r => [
  {transform: `scale(2.6) rotate(${r * 3}deg)`, opacity: 0},
  {transform: `scale(.82) rotate(${-r}deg)`, opacity: 1, offset: .1},
  {transform: `scale(1.12) rotate(${r * .6}deg)`, offset: .17},
  {transform: `scale(.97) rotate(${-r * .3}deg)`, offset: .24},
  {transform: `scale(1) rotate(${r * .4}deg)`, offset: .45},
  {transform: `scale(1.03) rotate(${-r * .2}deg)`, offset: .66},
  {transform: `scale(1) rotate(${r * .3}deg)`, opacity: 1, offset: .86},
  {transform: `scale(.6) translateY(-24px) rotate(${r}deg)`, opacity: 0}];
const bailFrames = [
  {transform: 'scale(3) rotate(12deg)', opacity: 0},
  {transform: 'scale(1) rotate(-4deg)', opacity: 1, offset: .08},
  {transform: 'translateX(-12px) rotate(-7deg)', offset: .12},
  {transform: 'translateX(10px) rotate(-1deg)', offset: .16},
  {transform: 'translateX(-6px) rotate(-5deg)', offset: .2},
  {transform: 'translateX(0) rotate(-4deg)', offset: .26},
  {transform: 'translateY(0) rotate(-4deg)', opacity: 1, offset: .8},
  {transform: 'translateY(70px) rotate(-14deg)', opacity: 0}];
const punchEl = el => el.animate([{transform: 'scale(1.5) rotate(-6deg)'}, {transform: 'scale(.9) rotate(3deg)', offset: .4}, {transform: 'scale(1)'}], {duration: 260, easing: 'ease-out'});

const CSS = `
#hxCall,#hxBig,#hxScore{display:none!important}
#hx .hxLine{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:.1em .02em;max-width:92vw;will-change:transform,opacity}
#hxCallW .hxLine{font-size:calc(clamp(26px,4.2vw,60px) * var(--k,1))}
#hxBigW .hxLine{font-size:clamp(38px,6.6vw,104px)}
#hx .ck{position:relative;display:inline-flex;align-items:center;isolation:isolate;padding:.12em .2em .08em;margin:0 .06em;--paper:#fffbe6;--jag:none}
#hx .ck.gap{margin-left:.4em}
#hx .ck::before{content:'';position:absolute;inset:-.13em;background:#000;clip-path:var(--jag);z-index:-2}
#hx .ck::after{content:'';position:absolute;inset:-.06em;background:#fff;clip-path:var(--jag);z-index:-1}
#hx .ck>.pp{position:absolute;inset:.03em;z-index:0;clip-path:var(--jag);background:radial-gradient(rgba(0,0,0,.1) 28%,transparent 34%) 0 0/4px 4px,linear-gradient(170deg,rgba(255,255,255,.55),transparent 40%,rgba(0,0,0,.14)),var(--paper)}
#hx .ck>.tx{opacity:1}
#hx .ck.rn .tx{text-transform:none}
#hx .ck .tx>b{padding:0 .04em}
#hx .ck .tx>b:first-child{-webkit-text-stroke:.2em #000}
#hx .live .ck{animation:hxJig .42s ease-in-out infinite alternate}
@keyframes hxJig{from{transform:rotate(-2.5deg) scale(1)}to{transform:rotate(2.5deg) scale(1.05)}}
#hx .hxStamp{opacity:0;font-size:clamp(20px,2.6vw,36px);margin-top:.35em}
#hx .hxStamp>.tx{opacity:1}#hx #hxGrade{font-size:1em;margin:0}
#hxTL{position:absolute;left:16px;top:14px;display:flex;flex-direction:column;align-items:flex-start;gap:8px}
#hxTL .top{display:flex;align-items:center;gap:18px}
#hx #hxOdo{font-size:40px;rotate:-2deg}
#hx #hxOdo .lbl{font-size:.36em;margin-right:.35em;align-self:flex-start}
#hx .dg{display:inline-block;height:1.1em;overflow:hidden;position:relative;z-index:1;margin:0 -.115em}
#hx .dg.g{margin-left:.04em}
#hx .dg>.tx{display:block;opacity:1;line-height:1.1em;white-space:pre;transition:transform .32s cubic-bezier(.3,1.5,.5,1)}
#hx .dg .tx>b{padding:0 .1em}
#hx .dg .tx>b:first-child{-webkit-text-stroke:.18em #000}
#hx #hxBest{opacity:1;font-size:14px;margin:0 0 0 6px}
#hxSpecW{display:flex;align-items:center;gap:10px}
#hx #hxSpecW .lbl{font-size:15px;opacity:1}
#hxSpec{position:relative;width:170px;height:14px;transform:skewX(-20deg);background:#1a1a1a;border:3px solid #000;outline:2px solid #fff}
#hxSpec>.f{position:absolute;inset:0;transform-origin:0 50%;transform:scaleX(0);background:linear-gradient(90deg,#ff3d00,#ff9b00 60%,#ffe14d);will-change:transform}
#hxSpec>.s{position:absolute;inset:0;overflow:hidden;visibility:hidden}
#hxSpec>.s>i{position:absolute;top:0;bottom:0;left:-32px;right:0;background:repeating-linear-gradient(90deg,rgba(255,255,255,.6) 0 6px,transparent 6px 16px);animation:hxStr .3s linear infinite paused}
@keyframes hxStr{to{transform:translateX(16px)}}
#hxSpec>b{position:absolute;inset:0;background:#fff;opacity:0}
#hxSpecW.full #hxSpec{animation:hxPulse .28s ease-in-out infinite alternate}
@keyframes hxPulse{from{transform:skewX(-20deg) scale(1)}to{transform:skewX(-20deg) scale(1.08,1.3)}}
#hxSpecW.full #hxSpec>.s{visibility:visible}#hxSpecW.full #hxSpec>.s>i{animation-play-state:running}
#hxSpecW.full .lbl{animation:hxJig .18s infinite alternate}
.hxFl{position:absolute;bottom:55%;width:14px;height:22px;margin-left:-7px;border-radius:50% 50% 45% 45%/65% 65% 35% 35%;background:linear-gradient(#fff6a8,#ffb000 45%,#ff3d00);border:2px solid #000;visibility:hidden;transform-origin:50% 100%;animation:hxFlame .38s ease-out infinite paused}
#hxSpecW.full .hxFl{visibility:visible;animation-play-state:running}
@keyframes hxFlame{0%{transform:translateY(0) scale(.6);opacity:1}60%{transform:translateY(-8px) scale(1,1.3);opacity:1}100%{transform:translateY(-18px) scale(.3,.5);opacity:0}}
#hx #hxCombo{position:static;align-items:flex-start}
#hx #hxList{align-items:flex-start}
#hx #hxList .tx{background:#fffbe6;clip-path:var(--jag);padding:.08em .35em;margin:2px 0}
#hx #hxMult{transform-origin:20% 70%}
#hxRed{background:radial-gradient(ellipse at 50% 50%,transparent 42%,rgba(170,0,0,.4) 75%,rgba(90,0,0,.7) 100%)!important}
#hx .hxGlB{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;mix-blend-mode:normal!important}
#hx .hxGlB:nth-child(3n){background:rgba(255,0,80,.55)}#hx .hxGlB:nth-child(3n+1){background:rgba(0,255,240,.5)}#hx .hxGlB:nth-child(3n+2){background:rgba(255,255,255,.35)}
#hx .hxGlN{mix-blend-mode:normal}
#hx .hxGlI{position:absolute;inset:0;background:#fff;mix-blend-mode:difference;opacity:0}
#hint{visibility:hidden!important}   /* main.js still toggles .hide on it; #hxHint mirrors that */
#hxHint{position:absolute;left:0;right:0;top:38%;display:flex;flex-direction:column;align-items:center;gap:8px;isolation:isolate}
#hxHint::before{content:'';position:absolute;left:50%;top:50%;width:min(900px,80vw);height:300px;margin:-150px 0 0 max(-450px,-40vw);z-index:-1;background:radial-gradient(closest-side,rgba(255,120,0,.45),rgba(255,30,0,.18) 60%,transparent);animation:hxGlow 1.3s ease-in-out infinite alternate}
#hx #hxHint .tx{opacity:1}
#hxHint .cta{font-size:clamp(40px,6.5vw,92px);animation:hxCta 1.4s ease-in-out infinite}
#hxHint .tag{font-size:clamp(18px,2.4vw,34px);animation:hxJig .22s ease-in-out infinite alternate}
@keyframes hxCta{0%,100%{transform:scale(.95) rotate(-2deg)}30%{transform:scale(1.1) rotate(1deg) translateY(-6px)}45%{transform:scale(1.02) rotate(-1deg)}60%{transform:scale(1.06) rotate(.5deg)}}
#hx .tx,#hx .hxLine,.hxP,.hxS,.hxB,#hx .hxGlB,#hx .hxGlS{will-change:auto}   /* layers promote only while animating */
#hxSpec>.s::before{content:'';position:absolute;top:0;bottom:0;left:0;width:200%;background:linear-gradient(90deg,#f03,#f90,#fe0,#3f3,#0ef,#36f,#c3f,#f03,#f90,#fe0,#3f3,#0ef,#36f,#c3f,#f03);animation:hxRb .6s linear infinite paused}
#hxSpecW.full #hxSpec>.s::before{animation-play-state:running}
@keyframes hxRb{to{transform:translateX(-50%)}}
#hx .hxOm{position:absolute;inset:0;opacity:0;pointer-events:none}
#hx .hxOmK{background:#000}
#hx .hxOmR{background:radial-gradient(ellipse at 50% 50%,rgba(120,0,0,.15) 0,rgba(150,0,0,.55) 60%,rgba(40,0,0,.9) 100%)}
#hx .hxChR{background:linear-gradient(90deg,rgba(255,0,40,.5),transparent 18%,transparent 82%,rgba(255,0,40,.25))}
#hx .hxChC{background:linear-gradient(90deg,rgba(0,255,255,.25),transparent 18%,transparent 82%,rgba(0,255,255,.5))}
#hx .ck.dk .tx>b:first-child{-webkit-text-stroke-color:#000}
#hx .hxLine{gap:.08em 0}
#hx #hxRow{gap:0}#hx #hxRow .tx,#hx #hxPts,#hx .hxF{letter-spacing:-.04em}#hx #hxRow .tx>b,#hx #hxPts>b,#hx .hxF>b{padding:.03em .07em}   /* tight numbers */
#hx #hxMult{margin-left:-.02em}
#hx .hxLine .ck{padding:0;margin:0 .14em}   /* normal word gap ~.28em */
#hx .hxLine .ck.rn{margin:0 -.01em}#hx .hxLine .ck.rn.gap{margin-left:.3em}
#hx .hxLine .tx{letter-spacing:0;margin:0 -.07em}
#hx .hxLine .tx>b{padding:0 .06em}   /* net advance ~ -.02em: tight for the heavy italic */
#hx .hxLine .ck::before,#hx .hxLine .ck::after,#hx .hxLine .ck>.pp{display:none}   /* trick letters: no paper/sticker backing */
#hxLogo{position:absolute;top:10px;right:12px;width:min(150px,16vw);opacity:0;transition:opacity .6s;rotate:3deg}
#hxLogo.on{opacity:.92}
#loading{background:#0d0d0d!important;isolation:isolate}
#loading .hxGraf{position:absolute;inset:0;z-index:-2;overflow:hidden;filter:saturate(.3) contrast(1.3) brightness(.42)}   /* static, rendered once */
#loading .hxGraf>img{position:absolute;left:0;top:0;width:auto;max-width:none;transform-origin:50% 50%}
#loading .hxLogoW{position:relative;display:inline-block;line-height:0}
#loading .hxLogoW{isolation:isolate;animation:hxMenace 7s ease-in-out infinite}
#loading .hxLogoW>img{animation:hxFlick 3.7s steps(1) infinite}
#loading .hxLogoW::before{content:'';position:absolute;inset:-30% -12%;z-index:-1;background:radial-gradient(closest-side,rgba(110,0,0,.8),rgba(35,0,0,.5) 55%,transparent 100%);animation:hxGlow 2.6s ease-in-out infinite alternate}
@keyframes hxMenace{0%,100%{transform:scale(1)}45%{transform:scale(1.06)}61%{transform:scale(1.05)}61.6%{transform:translate(-16px,5px) scale(1.1) rotate(-1.5deg)}62.2%{transform:translate(13px,-4px) scale(1.02) rotate(1deg)}62.8%{transform:translate(-6px,2px) scale(1.07)}63.6%{transform:scale(1.045)}88%{transform:scale(1.01)}88.5%{transform:translateX(10px) skewX(-7deg)}89%{transform:translateX(-4px)}89.5%{transform:scale(1.008)}}
@keyframes hxFlick{0%{opacity:1}31%{opacity:.8}32%{opacity:1}61.6%{opacity:.45}62.4%{opacity:1}63%{opacity:.7}63.6%{opacity:1}88.5%{opacity:.6}89%{opacity:1}}
@keyframes hxGlow{from{opacity:.4;transform:scale(.9)}to{opacity:1;transform:scale(1.1)}}
#loading .hxLogoW>.m{position:absolute;inset:0;overflow:hidden;-webkit-mask:url(data/logo.webp) center/100% 100% no-repeat;mask:url(data/logo.webp) center/100% 100% no-repeat}
#loading .hxLogoW>.b{background:linear-gradient(180deg,#fff 0%,#c9d0d8 30%,#f4f7fa 47%,#6c7682 52%,#aab3bd 70%,#fff 100%);mix-blend-mode:multiply;opacity:.85}
#loading .hxLogoW>.s>i{position:absolute;top:-20%;bottom:-20%;left:0;width:35%;background:linear-gradient(100deg,transparent 20%,rgba(255,255,255,.95) 50%,transparent 80%);transform:translateX(-150%) skewX(-15deg);animation:hxSweep 2.2s ease-in-out infinite}
@keyframes hxSweep{0%{transform:translateX(-150%) skewX(-15deg)}60%,100%{transform:translateX(400%) skewX(-15deg)}}
#loading::after{content:'';position:absolute;inset:0;z-index:-1;background:var(--grit) 0 0/140px 140px,radial-gradient(rgba(0,0,0,.35) 30%,transparent 36%) 0 0/5px 5px,radial-gradient(ellipse at 50% 45%,transparent 35%,rgba(0,0,0,.85) 100%);--grit:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1.6 0 0 0 -.7'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E")}
#loading>div{font:900 italic 22px HudDisplay,Impact,sans-serif;letter-spacing:.08em;color:#fff;-webkit-text-stroke:1px #000;text-transform:uppercase}
`;
const JAGS = [];
function jag() {   // torn-paper polygon: ragged top/bottom, slightly ragged sides
  const p = [], n = 9, a = 9, b = 2.5, f = x => x.toFixed(1) + '%';
  for (let i = 0; i <= n; i++) p.push(f(i / n * 100) + ' ' + f(rnd(0, a)));
  for (let i = 1; i < 4; i++) p.push(f(100 - rnd(0, b)) + ' ' + f(i * 25));
  for (let i = n; i >= 0; i--) p.push(f(i / n * 100) + ' ' + f(100 - rnd(0, a)));
  for (let i = 3; i > 0; i--) p.push(f(rnd(0, b)) + ' ' + f(i * 25));
  return `polygon(${p.join(',')})`;
}
for (let i = 0; i < 16; i++) JAGS.push(jag());
const pick = a => a[Math.random() * a.length | 0];
(function buildLoading() {   // loading screen: messy edge-to-edge graffiti collage + chrome logo with a moving specular sweep
  const ld = document.getElementById('loading'); if (!ld || ld.classList.contains('done')) return;
  const g = document.createElement('div'); g.className = 'hxGraf';
  const W = innerWidth, H = innerHeight, cols = 6, rows = 5, srcs = ['data/graffiti1.webp', 'data/graffiti2.webp', 'data/graffiti3.webp'];
  for (let k = 0; k < 2; k++) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {   // two jittered grid passes = full overlap
    const im = document.createElement('img'); im.src = srcs[(r * cols + c + k) % 3]; im.alt = '';
    im.style.height = (rnd(.35, .75) * H | 0) + 'px';
    const x = (c + rnd(-.4, .4)) / (cols - 1) * W, y = (r + rnd(-.4, .4)) / (rows - 1) * H;
    im.style.transform = `translate(-50%,-50%) translate(${x | 0}px,${y | 0}px) rotate(${rnd(-35, 35) | 0}deg) scale(${rnd(.8, 1.6).toFixed(2)})${Math.random() < .3 ? ' scaleX(-1)' : ''}`;
    g.append(im);
  }
  ld.prepend(g);
  const logo = ld.querySelector(':scope > img');
  if (logo) {
    const w = document.createElement('span'); w.className = 'hxLogoW'; logo.before(w); w.append(logo);
  }
  new MutationObserver((_, o) => { if (ld.classList.contains('done')) { o.disconnect(); setTimeout(() => { g.remove(); ld.querySelector('.hxLogoW .s i')?.remove(); }, 800); } }).observe(ld, {attributes: true, attributeFilter: ['class']});
})();
const chip = () => { const c = document.createElement('span'), pp = document.createElement('span'); c.className = 'ck'; pp.className = 'pp'; c.append(pp); c.style.setProperty('--jag', pick(JAGS)); return c; };

class Line {   // pooled sticker line: word chips (or one chip per letter in ransom mode) holding per-letter .tx spans
  constructor(parent, nChips, nLetters) {
    this.el = document.createElement('div'); this.el.className = 'hxLine'; this.chips = []; this.lt = []; this.used = [];
    for (let i = 0; i < nChips; i++) { const c = chip(); c.hidden = true; this.el.append(c); this.chips.push(c); }
    for (let i = 0; i < nLetters; i++) { const l = tx(); l.classList.add('L'); this.lt.push(l); }
    parent.prepend(this.el);
  }
  set(text, c, ransom = false, heat = 0) {
    const units = [];
    if (ransom) { let gap = false; for (const ch of String(text).toUpperCase()) { if (ch === ' ') { gap = true; continue; } units.push({s: Math.random() < .3 ? ch.toLowerCase() : ch, gap}); gap = false; } }
    else for (const w of String(text).toUpperCase().split(/\s+/)) if (w) units.push({s: w});
    const nc = this.chips.length;
    if (units.length > nc) { units[nc - 1].s += units.slice(nc).map(u => (ransom ? '' : ' ') + u.s).join(''); units.length = nc; }
    let li = 0; this.used = [];
    this.chips.forEach((ch, i) => {
      const u = units[i];
      while (ch.childNodes.length > 1) ch.lastChild.remove();
      if (!u) { ch.hidden = true; return; }
      ch.hidden = false; ch.classList.toggle('gap', !!u.gap); ch.classList.toggle('rn', ransom);
      ch.style.setProperty('--jag', pick(JAGS)); ch.style.setProperty('--paper', pick(PAPERS[heat]));
      ch.style.rotate = (rnd(-1, 1) * (ransom ? 11 : 4)).toFixed(1) + 'deg';
      ch.style.translate = `0 ${(rnd(-1, 1) * (ransom ? .12 : .05)).toFixed(2)}em`;
      ch.style.fontFamily = ransom ? pick(RANSOM_FONTS) : ''; ch.style.fontSize = ransom ? rnd(.8, 1.2).toFixed(2) + 'em' : '';
      ch.style.animationDelay = (-rnd(0, 1)).toFixed(2) + 's'; ch._i = li;
      for (const s of u.s) {
        const l = this.lt[li++]; if (!l) break;
        l._a?.cancel(); T(l, s); colors(l, c);
        l.style.rotate = rnd(-9, 9).toFixed(1) + 'deg'; l.style.translate = `0 ${rnd(-.07, .07).toFixed(2)}em`;
        ch.append(l); this.used.push(l);
      }
    });
    return this;
  }
  recolor(c) { for (const l of this.used) colors(l, c); }
  pop(slam = false, loom = false) {
    this.exitA?.cancel(); this.exitA = null; this.loomA?.cancel();
    if (loom) {   // hangs huge and dark, then crashes in (caller fires omen() at OMEN_MS * .8)
      this.loomA = this.el.animate([{transform: 'scale(2.6)', opacity: 0}, {transform: 'scale(2.2) rotate(-2deg)', opacity: .35, offset: .7},
        {transform: 'scale(.82,.7) rotate(1deg)', opacity: 1, offset: .82}, {transform: 'scale(1.1,1.05)', offset: .9}, {transform: 'none', opacity: 1}], {duration: OMEN_MS, easing: 'ease-in'});
      return this;
    }
    const st = slam ? STAGGER * .7 : STAGGER;
    for (const ch of this.chips) if (!ch.hidden) fxA(ch, [{transform: 'scale(0) rotate(-25deg)'}, {transform: 'scale(1.25)', offset: .5}, {transform: 'scale(.92)', offset: .75}, {transform: 'none'}],
      {duration: 320, delay: ch._i * st, easing: 'ease-out', fill: 'backwards'});
    this.used.forEach((l, i) => { l._a = fxA(l, slam
      ? [{transform: 'scale(3.5) rotate(25deg)', opacity: 0}, {transform: 'scale(.8,1.3)', opacity: 1, offset: .4}, {transform: 'scale(1.15,.9)', offset: .65}, {transform: 'none', opacity: 1}]
      : [{transform: 'translateY(-1.2em) scale(.3,1.9)', opacity: 0}, {transform: 'translateY(.1em) scale(1.45,.6)', opacity: 1, offset: .38},
         {transform: 'translateY(-.15em) scale(.85,1.2)', offset: .58}, {transform: 'translateY(0) scale(1.08,.93)', offset: .78}, {transform: 'none', opacity: 1}],
      {duration: slam ? 300 : 460, delay: i * st, easing: 'ease-out', fill: 'backwards'}); });
    return this;
  }
  out(kind = 'fade', delay = 0) {
    this.exitA?.cancel();
    const fr = kind === 'spin' ? [{transform: 'none', opacity: 1}, {transform: `rotate(${pick([-1, 1]) * 400}deg) scale(0)`, opacity: 0}]
      : kind === 'flip' ? [{transform: 'none', opacity: 1}, {transform: 'perspective(500px) rotateX(100deg) translateY(-20px) scale(.8)', opacity: 0}]
      : kind === 'splat' ? [{transform: 'none', opacity: 1}, {transform: 'translateY(.4em) scale(1.6,.15)', opacity: 1, offset: .22}, {transform: 'translateY(3em) scale(1.9,.08)', opacity: 0}]
      : [{transform: 'none', opacity: 1}, {transform: 'translateY(-20px) scale(.7)', opacity: 0}];
    this.exitA = this.el.animate(fr, {duration: kind === 'splat' ? 750 : 460, delay, easing: kind === 'splat' ? 'cubic-bezier(.5,0,1,.5)' : 'ease-in', fill: 'forwards'});
    return this;
  }
}
function buildTL() {   // top-left: sticker score with rolling digits + special bar, then BEST and the combo block
  const tl = document.createElement('div'); tl.id = 'hxTL';
  const top = document.createElement('div'); top.className = 'top';
  const odo = e.odo = chip(); odo.id = 'hxOdo';
  const lbl = tx(); lbl.classList.add('lbl'); T(lbl, 'SCORE'); colors(lbl, ['#ffffff', '#9aa7b8']); odo.append(lbl);
  e.slots = [];
  for (let i = 0; i < 9; i++) { const d = document.createElement('span'); d.className = 'dg'; const st = tx(); T(st, '0\n1\n2\n3\n4\n5\n6\n7\n8\n9'); colors(st, ['#ffe14d', '#ff7a00']); d.append(st); d.hidden = i < 8; odo.append(d); e.slots.push(d); }
  const sw = e.specW = document.createElement('div'); sw.id = 'hxSpecW';
  const sl = tx(); sl.classList.add('lbl'); T(sl, 'SPECIAL'); colors(sl, ['#ffe14d', '#ff3d00']);
  const sp = e.spec = document.createElement('div'); sp.id = 'hxSpec';
  sp.innerHTML = '<i class="f"></i><div class="s"><i></i></div><b></b>';
  for (let i = 0; i < 6; i++) { const f = document.createElement('i'); f.className = 'hxFl'; f.style.left = (8 + i * 17) + '%'; f.style.animationDelay = (-i * .13).toFixed(2) + 's'; sp.append(f); }
  e.specFill = sp.querySelector('.f'); e.specFlash = sp.querySelector('b');
  sw.append(sp, sl); top.append(odo, sw);
  tl.append(top, e.best, e.combo); e.root.append(tl);
}
const TAGLINES = ['SEND IT', 'NO BRAKES', 'BREAK YOUR NECK', 'FULL SEND', 'BONK EVERYTHING', 'HOLD MY BEER', 'GRAVITY IS OPTIONAL', "MOM ISN'T WATCHING", 'PEGS OUT', 'BAIL OR BUST'];
function buildHint() {   // "click to play" call to action: big CTA, rotating cheeky tagline, glow, sparks on hover
  const old = $('hint'); if (!old) return;
  const h = document.createElement('div'); h.id = 'hxHint';
  const cta = tx(); cta.classList.add('cta'); T(cta, 'CLICK TO PLAY'); colors(cta, ['#ffe14d', '#ff5a00']);
  const tag = tx(); tag.classList.add('tag'); T(tag, TAGLINES[0]); colors(tag, ['#ff7ad9', '#c4004f']);
  h.append(cta, tag); e.root.append(h);
  let ti = 0, rect = null, lastSp = 0;
  const sync = () => { h.hidden = old.classList.contains('hide'); rect = null; };
  sync(); new MutationObserver(sync).observe(old, {attributes: true, attributeFilter: ['class']});
  addEventListener('resize', () => { rect = null; });
  setInterval(() => {
    if (h.hidden) return;
    T(tag, TAGLINES[ti = (ti + 1) % TAGLINES.length]);
    tag.animate([{transform: 'scale(2) rotate(-12deg)', opacity: 0}, {transform: 'scale(.85) rotate(4deg)', opacity: 1, offset: .5}, {transform: 'none', opacity: 1}], {duration: 300, easing: 'ease-out'});
  }, 1600);
  addEventListener('mousemove', ev => {
    if (h.hidden || document.pointerLockElement) return;
    rect ??= cta.getBoundingClientRect();   // cached until shown again / resized
    const t = performance.now();
    if (t - lastSp > 70 && ev.clientX > rect.left && ev.clientX < rect.right && ev.clientY > rect.top - 20 && ev.clientY < rect.bottom + 60) { lastSp = t; sparkle([ev.clientX, ev.clientY], 4); }
  });
}
function setOdo(n) {
  const s = String(Math.min(999999999, Math.max(0, Math.round(n)))), L = s.length;
  if (+s === odoN) return; odoN = +s;
  e.slots.forEach((d, j) => {
    const p = 8 - j, h = p >= L; if (d._h !== h) { d._h = h; d.hidden = h; }
    if (h) return;
    const g = p % 3 === 2 && p < L - 1; if (d._g !== g) { d._g = g; d.classList.toggle('g', g); }
    const v = +s[L - 1 - p]; if (d._v !== v) { d._v = v; d.firstChild.style.transform = `translateY(${-v * 1.1}em)`; }
  });
}
function E() {
  if (e) return e;
  if (!$('hx')) return null;
  e = {root: $('hx'), speed: $('hxSpeed'), flash: $('hxFlash'), scoreW: $('hxScore'), scoreN: $('hxScoreN'), best: $('hxBest'),
    callW: $('hxCallW'), bigW: $('hxBigW'), call: $('hxCall'), pts: $('hxPts'), grade: $('hxGrade'), big: $('hxBig'), bigSub: $('hxBigSub'),
    combo: $('hxCombo'), list: $('hxList'), row: $('hxRow'), total: $('hxTotal'), mult: $('hxMult'), meter: $('hxMeter'), bar: $('hxMeter').firstElementChild, parts: [], sparks: []};
  for (let i = 0; i < LIST_MAX; i++) { const s = tx(); s.hidden = true; e.list.append(s); }
  for (let i = 0; i < PARTICLES; i++) { const d = document.createElement('i'); d.className = 'hxP'; e.root.append(d); e.parts.push(d); }
  for (let i = 0; i < SPARKLES; i++) { const d = document.createElement('i'); d.className = 'hxS'; e.root.append(d); e.sparks.push(d); }
  e.red = document.createElement('div'); e.red.id = 'hxRed'; e.root.prepend(e.red);
  e.blood = []; for (let i = 0; i < BLOOD_SPLATS; i++) {
    const b = document.createElement('div'); b.className = 'hxB'; const r = () => Math.round(rnd(38, 62));
    b.style.borderRadius = `${r()}% ${r()}% ${r()}% ${r()}% / ${r()}% ${r()}% ${r()}% ${r()}%`;
    const d = document.createElement('i'); d.style.left = rnd(30, 60) + '%'; b.append(d); e.root.insertBefore(b, e.scoreW); e.blood.push(b);   // under the text
  }
  e.floats = []; for (let i = 0; i < FLOATERS; i++) { const f = tx(); f.classList.add('hxF'); e.root.append(f); e.floats.push(f); }
  e.mflash = document.createElement('b'); e.meter.append(e.mflash);
  const st = document.createElement('style'); st.textContent = CSS + (FX.hideStatusBar ? '#bar{display:none!important}' : ''); document.head.append(st);
  e.callLine = new Line(e.callW, 10, 48); e.bigLine = new Line(e.bigW, 24, 32);
  e.stamp = chip(); e.stamp.classList.add('hxStamp'); e.grade.before(e.stamp); e.stamp.append(e.grade);
  buildTL();
  buildGlitch();
  document.addEventListener('pointerlockchange', () => sfx('ui'));
  buildHint();
  const lay = c => { const d = document.createElement('div'); d.className = 'hxOm ' + c; e.root.insertBefore(d, e.scoreW); return d; };
  e.omenK = lay('hxOmK'); e.omenR = lay('hxOmR'); e.chR = lay('hxChR'); e.chC = lay('hxChC');
  if (FX.logo) {   // small logo top-right once loading is done
    const lg = document.createElement('img'); lg.id = 'hxLogo'; lg.src = 'data/logo.webp'; lg.alt = ''; e.root.append(lg);
    const ld = $('loading'), show = () => lg.classList.toggle('on', !ld || ld.classList.contains('done'));
    show(); if (ld) new MutationObserver(show).observe(ld, {attributes: true, attributeFilter: ['class']});
  }
  T(e.scoreN, '0'); T(e.best, 'BEST 0'); T(e.mult, 'x0'); T(e.total, '0');
  addEventListener('resize', () => { rects = null; });
  const legacy = $('trick');   // fallback for code that still only writes the old #trick text
  let prev = '';   // fires once per new text (live labels rewritten every frame show once)
  if (legacy) new MutationObserver(() => {
    const s = legacy.textContent;
    if (s && s !== prev && performance.now() - apiT > 60) { apiT = performance.now(); showCall(s, 0); }
    prev = s;
  }).observe(legacy, {childList: true, characterData: true, subtree: true});
  return e;
}
function R() {   // cached screen anchors (refreshed on resize only)
  if (rects) return rects;
  const c = (el, fx = .5, fy = .5) => { const r = el.getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; };
  return rects = {call: [innerWidth / 2, e.callW.getBoundingClientRect().top + 50], score: c(e.odo), row: c(e.row), grade: c(e.stamp), spec: c(e.spec)};
}

function particles(n, from, to, spread = 60) {
  if (!FX.particles || !E()) return;
  for (let k = 0; k < n; k++) {
    const p = e.parts[pi = (pi + 1) % PARTICLES], x0 = from[0] + rnd(-spread, spread), y0 = from[1] + rnd(-20, 20);
    const mx = (x0 + to[0]) / 2 + rnd(-120, 120), my = Math.min(y0, to[1]) - rnd(30, 140), r = rnd(-200, 200);
    p.getAnimations?.().forEach(a => a.cancel());
    fxA(p, [
      {transform: `translate(${x0}px,${y0}px) scale(.2) rotate(45deg)`, opacity: 0},
      {transform: `translate(${mx}px,${my}px) scale(1.3) rotate(${45 + r * .5}deg)`, opacity: 1, offset: .35},
      {transform: `translate(${to[0]}px,${to[1]}px) scale(.6) rotate(${45 + r}deg)`, opacity: 1, offset: .95},
      {transform: `translate(${to[0]}px,${to[1]}px) scale(.2) rotate(${45 + r}deg)`, opacity: 0}],
    {duration: PART_MS * rnd(.85, 1.15), delay: k * 28, easing: 'ease-in', fill: 'backwards'});
  }
}
function sparkle(at, n = SPARKLES) {
  if (!FX.sparkle || !E()) return;
  for (let k = 0; k < n; k++) {
    const s = e.sparks[si = (si + 1) % SPARKLES], a = k / n * 6.283 + rnd(-.3, .3), d = rnd(50, 150), sc = rnd(.5, 1.4);
    const x1 = at[0] + Math.cos(a) * d, y1 = at[1] + Math.sin(a) * d * .6;
    s.getAnimations?.().forEach(x => x.cancel());
    fxA(s, [
      {transform: `translate(${at[0]}px,${at[1]}px) scale(0) rotate(0deg)`, opacity: 1},
      {transform: `translate(${x1}px,${y1}px) scale(${sc}) rotate(90deg)`, opacity: 1, offset: .55},
      {transform: `translate(${x1}px,${y1 + 20}px) scale(0) rotate(180deg)`, opacity: 0}],
    {duration: rnd(450, 750), delay: rnd(0, 80), easing: 'ease-out', fill: 'backwards'});
  }
}
function pushList(text, c) {
  const s = e.list.firstElementChild;   // hidden items sit at the front, oldest visible next
  s._a?.cancel(); s.hidden = false; T(s, text); colors(s, c); s.style.setProperty('--jag', pick(JAGS)); s.style.rotate = rnd(-3, 3).toFixed(1) + 'deg'; e.list.append(s);
  s._a = s.animate([{transform: 'translateX(-40px) scale(1.4)'}, {transform: 'translateX(4px) scale(.95)', offset: .6}, {transform: 'none'}], {duration: 240, easing: 'ease-out'});
}
function clearList(fall) {
  if (!E()) return;
  let k = 0;
  for (const s of e.list.children) {
    if (s.hidden) continue;
    s._a?.cancel();
    const a = s._a = s.animate(fall
      ? [{transform: 'none', opacity: 1}, {transform: `translate(${rnd(-60, 60)}px,160px) rotate(${rnd(-50, 50)}deg)`, opacity: 0}]
      : [{transform: 'none', opacity: 1}, {transform: `rotate(${pick([-1, 1]) * 360}deg) scale(0)`, opacity: 0}],
    {duration: fall ? 650 : 380, delay: k++ * 40, easing: fall ? 'cubic-bezier(.5,0,1,.6)' : 'ease-in', fill: 'forwards'});
    if (fall) colors(s, BAIL_C);
    a.onfinish = () => { s.hidden = true; a.cancel(); };
  }
}
function showCall(name, pts) {
  const m = comboMult + 1, c = tierOf(pts * m), r = rnd(-6, 6), heat = Math.min(3, m / 3 | 0);
  e.callW.style.setProperty('--k', (1 + Math.min(m - 1, SIZE_MAX_MULT) * SIZE_PER_MULT).toFixed(2));
  e.callLine.set(name, c, pts >= RANSOM_PTS || m >= RANSOM_MULT, heat).pop().out('flip', CALL_LIVE_MS);
  T(e.pts, pts ? '+' + fmt(pts) : ''); colors(e.pts, c); play(e.pts, popFrames(-r * .6), {duration: CALL_MS, delay: 70});
  return c;
}
function setCombo(on) { e.combo.classList.toggle('on', on); }
function gradeOf(d) {
  const ay = Math.abs(d.yaw || 0), ap = Math.abs(d.pitch || 0);
  const err = Math.max(Math.abs(ay - Math.round(ay / Math.PI) * Math.PI), Math.abs(ap - Math.round(ap / (2 * Math.PI)) * 2 * Math.PI)) * 180 / Math.PI;
  const trick = now - lastTrickT < 100;   // tricks.land runs right before hud.event in the same emit
  return err > CLEAN_DEG ? 'SKETCHY' : !trick ? null : err > PERFECT_DEG ? 'CLEAN' : 'PERFECT';
}

export const hud = {
  FX, autoGrade: true,
  trick(name, pts = 0) {
    apiT = lastTrickT = now = performance.now();
    if (!FX.text || !E()) return;
    const c = showCall(name, pts);
    pushList(String(name).toUpperCase() + (pts ? ' +' + fmt(pts) : ''), c);
    if (pts) floater('+' + fmt(pts), c);
    meterFlash(); punchEl(e.total); sfx('pt', comboMult + 1); hud.shake(TRICK_SHAKE * clamp(pts / 1000, .2, 1.2));
    if (pts) particles(PART_TRICK, R().call, R().row, 40);
  },
  combo(mult, pts = 0) {
    apiT = performance.now();
    if (!E()) return;
    if (!mult) { drone(0); if (comboMult) { clearList(false); e.callLine.out('spin'); } e.callLine.el.classList.remove('live'); comboMult = 0; setCombo(false); return; }
    if (!comboMult) totalS = 0;   // new chain counts up from zero
    const c = tierOf(pts * mult);
    T(e.mult, 'x' + mult); colors(e.mult, c); colors(e.total, tierOf(pts));
    e.callLine.el.classList.add('live');
    if (mult !== comboMult) {
      e.mult.style.scale = (1 + Math.min(mult, 15) * MULT_GROW).toFixed(2);
      e.mult.animate([{transform: 'scale(2.6) rotate(-16deg)'}, {transform: 'scale(.8) rotate(7deg)', offset: .35}, {transform: 'scale(1.18) rotate(-3deg)', offset: .6}, {transform: 'none'}], {duration: 400, easing: 'ease-out'});
      if (mult > 1) hud.shake(COMBO_SHAKE * Math.min(mult, 10) / 5);
    }
    if (mult !== comboMult) { if (mult > comboMult && COMBO_MILESTONES.includes(mult)) hud.callout('COMBO x' + mult, '', Math.max(pts * mult, OMEN_PTS)); }
    e.combo.classList.toggle('multi', mult > 1);
    comboMult = mult; totalT = pts; setCombo(true); drone(mult);
  },
  pts(n) {
    if (!E()) return;
    if (FX.text) floater('+' + fmt(n), tierOf(n));
    meterFlash(); sfx('tick', comboMult);
  },
  oob(onDone) {
    const t = performance.now();
    if (t < oobT) return false;
    apiT = t; oobT = t + OOB_MS;
    trauma = 0; hud.shake(1); hud.hitstop(OOB_HITSTOP); hud.fovKick(OOB_FOV); sfx('oob');
    setTimeout(() => onDone?.(), OOB_MS);
    if (!E()) return true;
    if (FX.flash) { e.red.animate([{opacity: .75}, {opacity: .5, offset: .2}, {opacity: 0}], {duration: OOB_MS + 200, easing: 'ease-out'}); hud.flash(); }
    if (FX.blood) for (const b of e.blood) {
      const x = rnd(0, innerWidth), y = rnd(0, innerHeight * .8), sc = rnd(.3, .8), r = rnd(0, 360), dl = rnd(0, 140);
      b.getAnimations().forEach(a => a.cancel());
      b.animate([{transform: `translate(${x}px,${y}px) rotate(${r}deg) scale(.15)`, opacity: 1}, {transform: `translate(${x}px,${y}px) rotate(${r}deg) scale(${sc * 1.18})`, offset: .05},
        {transform: `translate(${x}px,${y}px) rotate(${r}deg) scale(${sc})`, opacity: 1, offset: .1}, {transform: `translate(${x}px,${y + 14}px) rotate(${r}deg) scale(${sc})`, opacity: .95, offset: .6},
        {transform: `translate(${x}px,${y + 40}px) rotate(${r}deg) scale(${sc})`, opacity: 0}], {duration: BLOOD_MS, delay: dl, easing: 'ease-out', fill: 'backwards'});
      b.firstChild.animate([{transform: 'rotate(' + -r + 'deg) scaleY(0)'}, {transform: 'rotate(' + -r + 'deg) scaleY(0)', offset: .08}, {transform: 'rotate(' + -r + 'deg) scaleY(1)'}], {duration: BLOOD_MS, delay: dl, easing: 'ease-in'});
    }
    if (FX.text) {
      e.bigLine.set('OUT OF BOUNDS', BAIL_C, true, 3).pop(true).out('splat', OOB_MS - 200);
      e.callLine.recolor(BAIL_C); e.callLine.el.classList.remove('live'); e.callLine.out('splat');
      T(e.bigSub, ''); e.bigSub._a?.cancel();
    }
    return true;
  },
  glitch(onDone) {
    const t = performance.now();
    if (t < glEnd) return false;
    apiT = t; glEnd = t + GLITCH_MS; glNext = 0;
    trauma = 0; hud.shake(1); hud.hitstop(GLITCH_HITSTOP); hud.fovKick(GLITCH_FOV); sfx('glitch');
    setTimeout(() => onDone?.(), GLITCH_MS);
    if (FX.glitch && E()) { glOn = true; e.gl.root.hidden = false; glitchTick(t); }
    return true;
  },
  glitchActive() { return performance.now() < glEnd; },
  oobActive() { return performance.now() < oobT; },
  special(f, full) { spT = clamp(+f || 0, 0, 1); spFullT = !!full; },
  meter(f) { meterT = FX.meter ? clamp(f, 0, 1) : 0; },
  bank(total, record = false) {
    apiT = bankT = performance.now();
    if (!E()) return;
    if (FX.text) hud.callout(record ? 'NEW RECORD' : '+' + fmt(total), record ? '+' + fmt(total) : comboMult > 1 ? 'COMBO x' + comboMult : '', total);
    particles(clamp(Math.round(PART_MIN + total / 1000 * PART_PER_K), PART_MIN, PART_MAX), R().row, R().score, 80);
    sfx('bank', comboMult);
    if (record) { sparkle([innerWidth / 2, innerHeight * .3]); hud.flash(); }
    e.callLine.el.classList.remove('live'); e.callLine.out('spin', 120);
    drone(0); clearList(false); comboMult = 0; meterT = 0; setTimeout(() => { if (!comboMult) setCombo(false); }, 300);
  },
  score(score, best) {
    if (!E()) return;
    const apply = () => { scoreT = score; T(e.best, 'BEST ' + fmt(best)); };
    if (performance.now() - bankT < 60 && FX.particles) setTimeout(() => { apply(); punchEl(e.odo); sfx('tick', 12); }, PART_MS * .9); else apply();
  },
  land(grade, impact = .5) {
    now = performance.now();
    hud.shake(impact * SHAKE_LAND);
    if (impact > HITSTOP_MIN_IMPACT) hud.hitstop(HITSTOP_LAND * impact);
    hud.punch(PUNCH_LAND * clamp(impact, .3, 1.2) * (now - lastTrickT < 150 ? 1 : .35));
    hud.fovKick(FOV_LAND * clamp(impact, 0, 1));
    if (impact > .15) sfx('drop', impact); sfx('land');
    if (!grade || !FX.text || !E()) return;
    T(e.grade, grade); colors(e.grade, GRADES[grade] || GRADES.CLEAN);
    e.stamp.style.setProperty('--jag', pick(JAGS)); e.stamp.style.setProperty('--paper', STAMP_PAPER[grade] || '#fffbe6');
    const rr = rnd(-12, -4).toFixed(1);
    play(e.stamp, [{transform: `scale(4.5) rotate(${rr * 3}deg)`, opacity: 0}, {transform: `scale(.82,.9) rotate(${rr}deg)`, opacity: 1, offset: .1},
      {transform: `scale(1.14,1.05) rotate(${rr}deg)`, offset: .16}, {transform: `scale(1) rotate(${rr}deg)`, offset: .22},
      {transform: `scale(1) rotate(${rr}deg)`, opacity: 1, offset: .82}, {transform: `scale(1.3) rotate(${rr}deg)`, opacity: 0}], {duration: GRADE_MS, delay: 120});
    setTimeout(() => { hud.shake(STAMP_SHAKE); hud.hitstop(STAMP_HITSTOP); sfx('stamp'); }, 120 + GRADE_MS * .1);
    if (grade === 'PERFECT') { setTimeout(() => sparkle(R().grade), 160); hud.flash(); sfx('perfect'); }
  },
  bail(impact = 1, why = '') {
    apiT = performance.now();
    const k = clamp(impact, .4, 1.3);
    hud.shake(SHAKE_BAIL * k); hud.hitstop(HITSTOP_BAIL * k);
    if (!E()) return;
    if (hud.bailSound !== false) sfx('bail');   // main.js BAIL_SOUND / BAIL_HUD bisection toggles
    if (FX.text && hud.bailHud !== false) { hud.callout('BAIL', why, 'bail'); e.callLine.recolor(BAIL_C); e.callLine.el.classList.remove('live'); e.callLine.out('splat'); }
    drone(0); clearList(true); comboMult = 0; meterT = 0; setCombo(false);
  },
  callout(text, sub = '', pts = 0) {
    apiT = performance.now();
    if (!FX.text || !E()) return;
    const bail = pts === 'bail', c = bail ? BAIL_C : tierOf(pts), r = rnd(-5, 5);
    const big = !bail && typeof pts === 'number' && pts >= OMEN_PTS && FX.omen;
    e.bigLine.set(text, big ? ['#ff2a1a', '#3a0000'] : c, true, bail ? 0 : Math.min(3, (pts / 2500) | 0));
    if (big) { for (const ch of e.bigLine.chips) ch.style.setProperty('--paper', pick(['#0d0d0d', '#1c0000', '#161616', '#2a0505'])); e.bigLine.pop(false, true); setTimeout(() => omen(Math.min(1.3, .6 + pts / 20000)), OMEN_MS * .8); }
    else e.bigLine.pop(bail);
    e.bigLine.out(bail ? 'splat' : 'spin', BIG_MS + (big ? OMEN_MS : 0));
    T(e.bigSub, String(sub).toUpperCase()); colors(e.bigSub, bail ? ['#ffffff', '#9aa0a8'] : c); play(e.bigSub, popFrames(-r), {duration: BIG_MS, delay: 90});
  },
  flash() { if (FX.flash && E()) e.flash.animate([{opacity: .5}, {opacity: 0}], {duration: 240, easing: 'ease-out'}); },
  shake(a) { if (FX.shake) trauma = clamp(trauma + a, 0, 1); },
  hitstop(sec) { if (FX.hitstop) { hitT = Math.min(HITSTOP_MAX, Math.max(hitT, sec)); hitEase = 0; } },
  punch(m) { if (FX.punch) punchV = Math.max(punchV, m); },
  fovKick(deg) { fovKickV += deg; },
  speed(v) { spd = v; },
  timeScale() { return !FX.hitstop ? 1 : hitT > 0 ? HITSTOP_SCALE : HITSTOP_SCALE + (1 - HITSTOP_SCALE) * hitEase; },
  // physics emit hook: auto juice for takeoff/land/crash/grind
  event(type, d, S) {
    now = performance.now();
    if (type === 'takeoff') { vyAir = 0; hud.fovKick(FOV_POP); sfx('pop'); }
    else if (type === 'land') hud.land(hud.autoGrade && d && d.airT >= GRADE_MIN_AIR ? gradeOf(d) : null, clamp(-vyAir / IMPACT_V, 0, 1.5));
    else if (type === 'crash') { const v = S?.vel; hud.bail(clamp(Math.max(v ? Math.hypot(v.x, v.y, v.z) : 0, -vyAir) / BAIL_V, 0, 1.5), typeof d === 'string' ? d : ''); }
    else if (type === 'grind') { hud.shake(SHAKE_GRIND); hud.fovKick(FOV_GRIND); sfx('grindOn'); }
    else if (type === 'grindEnd') sfx('grindOff');
    else if (type === 'manualEnd') { if (d?.fail) hud.shake(SHAKE_GRIND); else sfx('manual'); }
    else if (type === 'specialStart') sfx('special');
  },
  // once per frame after the chase camera is placed: shake/punch/FOV + DOM tweens (real time, ignores hit-stop)
  cam(camera, baseFov, S) {
    const t = now = performance.now(), dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
    if (S) { const v = S.vel; spd = Math.hypot(v.x, v.y, v.z); if (!S.grounded && !(S.crashed > 0)) vyAir = v.y; }
    if (!au && FX.sound && document.pointerLockElement) audio();
    if (au && S) {
      const w = S.grounded || S.crashed > 0 ? 0 : Math.min(1, (Math.abs(S.yawRate || 0) + Math.abs(S.pitchRate || 0)) / WHOOSH_RATE);
      const h = S.grind && !(S.crashed > 0) ? Math.min(1, .4 + spd / 15) : 0;
      if (Math.abs(w - whLvl) > .02) { whLvl = w; setLvl(au.whoosh, w * WHOOSH_VOL, 400 + 1400 * w); setLvl(au.air, w * w * AIR_VOL, 2000 + 3000 * w); }
      if (Math.abs(h - hsLvl) > .02) { hsLvl = h; setLvl(au.hiss, h * HISS_VOL, 3000 + 3000 * h); setLvl(au.ring, h * RING_VOL, 2200 + 400 * h); }
      if (!S.grounded && !(S.crashed > 0)) {   // swish burst per completed half spin / full flip
        const ny = Math.floor(Math.abs(S.yawAcc || 0) / Math.PI), np = Math.floor(Math.abs(S.pitchAcc || 0) / (2 * Math.PI));
        if (ny > rotY || np > rotP) sfx('swish', w);
        rotY = ny; rotP = np;
      } else rotY = rotP = 0;
    }
    if (hitT > 0) hitT -= dt; else if (hitEase < 1) hitEase = Math.min(1, hitEase + dt / HITSTOP_EASE);
    if (camera) {
      if (trauma > 0) {
        trauma = Math.max(0, trauma - SHAKE_DECAY * dt);
        const a = trauma * trauma * SHAKE_AMP, w = t / 1000 * SHAKE_FREQ;
        camera.position.x += a * (Math.sin(w * 1.13 + 1.3) + .5 * Math.sin(w * 2.71));
        camera.position.y += a * (Math.sin(w * 1.37 + 4.1) + .5 * Math.sin(w * 3.07 + 2));
        camera.position.z += a * (Math.sin(w * .91 + 2.6) + .5 * Math.sin(w * 2.29 + 5));
        camera.rotateZ(trauma * trauma * SHAKE_ROLL * Math.sin(w * .77 + .5));
      }
      if (punchV > 1e-3) { camera.translateZ(-punchV); camera.rotateX(-punchV * PUNCH_PITCH); punchV *= Math.exp(-PUNCH_DECAY * dt); }
      fovSpd += ((FX.fov ? FOV_SPEED * smooth(FOV_V0, FOV_V1, spd) : 0) - fovSpd) * (1 - Math.exp(-FOV_K * dt));
      fovKickV *= Math.exp(-FOV_DECAY * dt);
      const f = baseFov + fovSpd + (FX.fov ? fovKickV : 0);
      if (Math.abs(camera.fov - f) > 0.02) { camera.fov = f; camera.updateProjectionMatrix(); }
    }
    if (!E()) return;
    if (glOn) { if (t >= glEnd) glitchEnd(); else if (t >= glNext) { glNext = t + GLITCH_TICK; glitchTick(t); } }
    const so = FX.speedLines ? Math.round(SPEEDLINE_MAX * smooth(SPEEDLINE_V0, SPEEDLINE_V1, spd) * 50) / 50 : 0;
    if (so !== speedO) { speedO = so; e.speed.style.opacity = so; e.speed.classList.toggle('off', so === 0); }
    const ms = Math.round(meterT * 200) / 200;
    if (ms !== meterS) { meterS = ms; e.bar.style.transform = `scaleX(${ms})`; e.meter.classList.toggle('hidden', ms === 0); }
    const low = ms > 0 && ms < 0.3; if (low !== lowOn) { lowOn = low; e.meter.classList.toggle('low', low); }
    const k = 1 - Math.exp(-COUNT_K * dt);
    if (scoreS !== scoreT) { scoreS = Math.abs(scoreT - scoreS) < 1 ? scoreT : scoreS + (scoreT - scoreS) * k; setOdo(scoreS); }
    if (spT !== spS) {
      if (spT > spS + .002 && spS >= 0 && t - spFlashT > 120 && FX.meter) { spFlashT = t; sfx('rise', spT); e.specFlash.animate([{opacity: .9}, {opacity: 0}], {duration: 220, easing: 'ease-out'}); }
      spS = spT; const q = Math.round(spS * 400) / 400; if (q !== spQ) { spQ = q; e.specFill.style.transform = `scaleX(${q})`; }
    }
    if (spFullT !== spFullS) {
      spFullS = spFullT; e.specW.classList.toggle('full', spFullT);
      if (spFullT) { hud.callout('SPECIAL!', 'Q + E', 99999); hud.shake(SPECIAL_SHAKE); sfx('bank', 12); sparkle(R().spec); }
    }
    if (totalS !== totalT) { totalS = Math.abs(totalT - totalS) < 1 ? totalT : totalS + (totalT - totalS) * k; T(e.total, fmt(totalS)); }
  },
};
window.hud = hud;
