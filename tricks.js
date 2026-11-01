// Scoring: air tricks, grinds (each grind type / switch is its own trick) and manuals chain into one combo;
// multiplier = tricks in the chain. Touching the ground without a manual for GROUND_GRACE s banks it
// (points x multiplier), a bail loses it. Best combo persists in prefs. Also drives the balance meter and
// the special meter (THPS-style): tricks fill it by points, it drains slowly, empties on a bail; while full,
// Q+E + direction in the air does a special (physics SPECIALS), which drains it further.
// All text goes through the hud.js API (window.hud), optional-chained.
import { GRINDS, SPECIALS, AIR_TRICKS } from './physics.js';
import { hud as HUD } from './hud.js';   // text/juice API, see top of hud.js

const AIR_PTS = 100, SPIN_PTS = 150, FLIP_PTS = 500, MIN_AIR = 0.55;
const GRIND_BASE = 50, MIN_PART = 0.25, MANUAL_PTS = 150, MANUAL_RAMP = 80, MIN_MANUAL = 0.4;   // per grind; shortest grind part / manual that counts (s); manual pts/s
const GROUND_GRACE = 0.9;   // s on the ground (no manual) before the combo banks (time to hop/manual into the next trick)
const SPECIAL_PTS = 2500, SP_FILL = 1 / 1500, SP_DRAIN = 0.008, SP_FULL_DRAIN = 0.04, SP_USE = 0.05, SP_OFF = 0.5;   // pts per special; meter per point; drain/s (normal, while full); drain/s during a special; full until below this
const PERFECT_PTS = 400, PERFECT_SP = 0.15, TRANSFER_PTS = 300, TRANSFER_T = 1.5, LINK_PTS = 150;   // perfect landing bonus + special meter; grind-to-grind without touching ground (within s); trick after a manual link
const MULTI = ['', '', 'double ', 'triple '];
const $ = id => document.getElementById(id);   // only the balance meter (#bal) is ours

export function createTricks(P, save) {
  let mult = 0, pts = 0, groundT = 0, score = 0, sp = 0, spFull = false, liveKey = '', manLink = false, grindOffT = -1;   // manLink: last thing was a manual inside a combo; grindOffT: s since leaving a grind (air only)
  const hud = () => HUD.score?.(score, P.best);
  const reset = () => { mult = pts = 0; HUD.combo?.(0); };
  function add(name, p, extra = {}) {
    if (manLink && name !== 'manual') { manLink = false; mult++; pts += LINK_PTS; HUD.trick?.('manual link', LINK_PTS); }   // manual between tricks: extra multiplier
    mult++; pts += p; groundT = 0; sp = Math.min(1, sp + p * SP_FILL);
    HUD.trick?.(name, p); HUD.combo?.(mult, pts); log('trick', {names: [name], p, mult, ...extra});
  }
  function bank() {
    const total = pts * mult; score += total;
    const record = total > P.best;
    if (record) { P.best = total; save(); log('record', {total}); }
    HUD.bank?.(total, record); mult = pts = 0; manLink = false; hud();
  }
  function bal(b) {
    const el = $('bal'), mk = $('balMark'); if (!el || !mk) return;
    el.style.display = b === null ? 'none' : 'block';
    if (b !== null) { b = Math.max(-1, Math.min(1, b)); mk.style.left = (50 + b * 50) + '%'; mk.style.background = Math.abs(b) > 0.7 ? '#f44' : '#fff'; }
  }
  hud();
  return {
    takeoff() { groundT = 0; },
    // done: [{name, t?, special?}] from physics; spins repeat ("double tailwhip"), holds score by time
    land({airT, yaw, pitch, done = [], perfect}) {
      const n180 = Math.round(Math.abs(yaw) / Math.PI), nf = Math.round(Math.abs(pitch) / (2 * Math.PI)), names = [];
      let p = 0;
      if (nf) { names.push((nf > 1 ? MULTI[nf] ?? nf + 'x ' : '') + (pitch > 0 ? 'backflip' : 'frontflip')); p += nf * FLIP_PTS; }
      if (n180) { names.push(String(n180 * 180)); p += n180 * SPIN_PTS; }
      for (let i = 0; i < done.length; i++) {
        const d = done[i];
        if (d.special) { names.push(SPECIALS[d.name].label); p += SPECIAL_PTS; continue; }
        const def = AIR_TRICKS[d.name];
        if (def.hold) { names.push(def.label); p += def.base + Math.round(d.t * def.pts); continue; }
        let n = 1; while (done[i + 1]?.name === d.name) { n++; i++; }   // consecutive spins of the same trick
        names.push((n > 1 ? MULTI[n] ?? n + 'x ' : '') + def.label); p += n * def.pts;
      }
      if (!names.length && airT > MIN_AIR) names.push('air');
      if (!names.length) return;
      p += Math.round(airT * AIR_PTS);
      if (perfect) { names.push('perfect!'); p += PERFECT_PTS; sp = Math.min(1, sp + PERFECT_SP); }   // physics also pays out PERFECT_BOOST speed
      add(names.join(' '), p, {air_s: +airT.toFixed(2), done: done.map(d => d.name)});
    },
    grindPart({type, t}) { if (t >= MIN_PART) add(GRINDS[type].label, GRIND_BASE + Math.round(t * GRINDS[type].pts), {grind_s: +t.toFixed(2)}); },
    manualEnd({t}) { if (t >= MIN_MANUAL && mult) manLink = true; if (t >= MIN_MANUAL) add('manual', Math.round(t * (MANUAL_PTS + MANUAL_RAMP * t)), {manual_s: +t.toFixed(2)}); },   // longer manuals pay more per second
    grind({start}) { if (start && grindOffT >= 0 && grindOffT < TRANSFER_T) add('transfer', TRANSFER_PTS); grindOffT = -1; },
    grindEnd() { grindOffT = 0; },
    crash() { reset(); sp = 0; spFull = false; manLink = false; grindOffT = -1; },   // hud.event shows the bail
    oob() { reset(); sp = 0; spFull = false; },
    specialStart({name}) { HUD.callout?.(SPECIALS[name].label + '!', 'SPECIAL', SPECIAL_PTS); },
    tick(dt, S) {
      const live = S.grind || S.manual;
      const key = S.grind ? S.grind.type : S.manual ? 'manual' : '';
      if (key && key !== liveKey) HUD.callout?.(S.grind ? GRINDS[key].label : 'manual', '', 0);   // live label once per grind / switch / manual
      liveKey = key;
      if (live) groundT = 0;
      if (grindOffT >= 0) grindOffT = S.grounded ? -1 : grindOffT + dt;   // transfer window: air only
      bal(live ? live.bal : null);
      // special meter: full latches until it drains below SP_OFF; a running special burns it fast
      sp = Math.max(0, sp - (S.special ? SP_USE : spFull ? SP_FULL_DRAIN : SP_DRAIN) * dt);
      if (sp >= 1) spFull = true; else if (sp < SP_OFF) spFull = false;
      S.specialReady = spFull;
      HUD.special?.(sp, spFull);
      if (mult && S.grounded && !S.manual && (groundT += dt) > GROUND_GRACE) bank();
      HUD.meter?.(mult ? (S.grounded && !live ? 1 - groundT / GROUND_GRACE : 1) : 0);
    },
  };
}
