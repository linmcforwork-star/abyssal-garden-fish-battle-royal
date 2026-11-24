// ============================================================================
// game: you are a small fish. Eat the fish smaller than you, grow, keep away from the bigger ones.
// ============================================================================
// Runs after main.js inside the same function, so it sees the renderer's state (F, collide, the rock distance field,
// the menu). gameFrame(dt) replaces the free camera's movement in frame().
const ZH = /^zh/i.test(navigator.language || '');
const TXT = ZH ? {
  play: '开始', again: '再来一次', resume: '继续',
  dead: (s, t) => `被吃掉了！存活 ${s}，等级 ${t}`, won: (s) => `你成为了深渊之王！用时 ${s}`, best: (s) => `最佳纪录 ${s}`,
  hint: '绿色的鱼比你小，可以吃 · 红色的鱼比你大，快躲开 · 躲到岩石后面能甩掉追兵',
  touch: '按住屏幕向前游 · 滑动转向 · 第二根手指冲刺',
  lv: '等级',
} : {
  play: 'Dive in', again: 'Play again', resume: 'Resume',
  dead: (s, t) => `Eaten! You survived ${s} and reached level ${t}`, won: (s) => `You rule the abyss! Time ${s}`, best: (s) => `Best ${s}`,
  hint: 'Green fish are smaller: eat them · Red fish are bigger: flee · Hide behind rock to lose a chaser',
  touch: 'Hold to swim forward · slide to steer · second finger to dash',
  lv: 'Level',
};
// tiers: 0 is food only; you start at 1 and win at the end of 5
const SIZE = [0.5, 0.75, 1.15, 1.75, 2.6, 3.8];
const NEED = [0, 4, 5, 6, 7, 8]; // fish to eat at each of your tiers to grow
const NMAX = 44, NWANT = 36;
const speed = (t) => 5.2 + 0.6 * t;
const fmt = (s) => `${s / 60 | 0}:${String(s % 60 | 0).padStart(2, '0')}`;

// player: position, heading, stamina, exhausted
const P = new Float64Array(8);
const S = { tier: 1, eaten: 0, time: 0, state: 0, deadT: 0 }; // state: 0 not started, 1 playing, 2 eaten, 3 won
let best = 0; try { best = +localStorage.abyssBiteBest || 0; } catch {}
// other fish: position, velocity, tier (-1 = free slot), mode (0 wander, 1 chase, 2 flee, 3 tired), timer, wander yaw
const NP = new Float64Array(NMAX * 3), NV = new Float64Array(NMAX * 3), NT = new Int8Array(NMAX).fill(-1);
const NM = new Uint8Array(NMAX), NTM = new Float64Array(NMAX), NY_ = new Float64Array(NMAX), NS = new Float64Array(NMAX);

// ---------------------------------------------------------------- rock distance anywhere (metres, > 0 in rock; clamped to ±1 m)
function sdAt(x, y, z) {
  x = (x - OX) / VS - CO; y = (y - OY) / VS; z = (z - OZ) / VS - CO;
  if (!(x > 1 && z > 1 && y > 5 && x < CN * 4 - 2 && z < CN * 4 - 2 && y < NY - 6)) return -1;
  const ix = x | 0, iy = y | 0, iz = z | 0, u = x - ix, v = y - iy, a = cv(ix, iy, iz), b = cv(ix, iy + 1, iz), c = cv(ix, iy, iz + 1), d = cv(ix, iy + 1, iz + 1);
  const p = a + (cv(ix + 1, iy, iz) - a) * u, q = b + (cv(ix + 1, iy + 1, iz) - b) * u, r = c + (cv(ix + 1, iy, iz + 1) - c) * u, s = d + (cv(ix + 1, iy + 1, iz + 1) - d) * u;
  const e = p + (q - p) * v; return (e + (r + (s - r) * v - e) * (z - iz)) / 127;
}
// unit gradient (pointing into the rock) in GR; returns its length before normalising
const GR = new Float64Array(3);
function gradAt(x, y, z) {
  const h = 0.375, gx = sdAt(x + h, y, z) - sdAt(x - h, y, z), gy = sdAt(x, y + h, z) - sdAt(x, y - h, z), gz = sdAt(x, y, z + h) - sdAt(x, y, z - h);
  const l = sqrt(gx * gx + gy * gy + gz * gz); if (l < 1e-6) { GR[0] = 0; GR[1] = 1; GR[2] = 0; return 0; }
  GR[0] = gx / l; GR[1] = gy / l; GR[2] = gz / l; return l;
}
// clear water between two points?
function sees(ax, ay, az, bx, by, bz) {
  for (let k = 1; k < 8; k++) { const t = k / 8; if (sdAt(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t) > 0) return false; }
  return true;
}

// ---------------------------------------------------------------- sound effects (into the ambience's master, so M mutes them)
function blip(f0, f1, dur, vol, type = 'sine', at = 0) {
  if (!AC || !OUT) return;
  const t = AC.currentTime + 0.01 + at, o = new OscillatorNode(AC, { type, frequency: f0 }), g = new GainNode(AC, { gain: 0 });
  o.connect(g); g.connect(OUT);
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.setTargetAtTime(0, t + 0.02, dur / 4);
  o.start(t); o.stop(t + dur * 2 + 0.1);
}
const sfxEat = () => { blip(260, 760, 0.14, 0.32, 'triangle'); blip(900, 1400, 0.08, 0.12, 'sine', 0.05); };
const sfxGrow = () => { [0, 4, 7, 12].forEach((n, i) => blip(392 * 2 ** (n / 12), 392 * 2 ** (n / 12) * 1.01, 0.5, 0.2, 'triangle', i * 0.09)); };
const sfxDie = () => { blip(320, 60, 0.9, 0.45, 'sawtooth'); blip(140, 40, 0.8, 0.4, 'sine'); };
const sfxWin = () => { [0, 4, 7, 12, 16, 19, 24].forEach((n, i) => blip(330 * 2 ** (n / 12), 330 * 2 ** (n / 12), 0.8, 0.18, 'triangle', i * 0.11)); };

// ---------------------------------------------------------------- spawning
function pickTier() {
  const p = S.tier; let edible = 0;
  for (let i = 0; i < NMAX; i++) if (NT[i] >= 0 && NT[i] < p) edible++;
  if (edible < 14) return (Math.random() * p) | 0;
  const w = []; let sum = 0;
  for (let t = 0; t <= 5; t++) { const x = t < p ? 3 : t === p ? 1.2 : t === p + 1 ? 1.6 : 0.8; w.push(x); sum += x; }
  let r = Math.random() * sum; for (let t = 0; t <= 5; t++) { r -= w[t]; if (r <= 0) return t; } return 0;
}
function spawn(minD, maxD) {
  let i = 0; while (i < NMAX && NT[i] >= 0) i++; if (i === NMAX) return;
  const t = pickTier(), s = SIZE[t], safe = t > S.tier ? max(minD, 30) : minD;
  for (let k = 0; k < 12; k++) {
    const a = Math.random() * TAU, d = safe + Math.random() * (maxD - safe);
    const x = P[0] + cos(a) * d, z = P[2] + sin(a) * d, y = clamp(P[1] + (Math.random() - 0.5) * 18, -46, -4);
    if (x * x + z * z > 130 * 130 || sdAt(x, y, z) > -0.99 || sdAt(x, y + s, z) > -0.99 || sdAt(x, y - s, z) > -0.99) continue;
    NP[i * 3] = x; NP[i * 3 + 1] = y; NP[i * 3 + 2] = z; NV[i * 3] = NV[i * 3 + 1] = NV[i * 3 + 2] = 0;
    NT[i] = t; NM[i] = 0; NTM[i] = 0; NY_[i] = Math.random() * TAU; NS[i] = Math.random(); return;
  }
}
function restart() {
  const p = POSES[0];
  P[0] = p[0]; P[1] = p[1] + 2; P[2] = p[2]; P[3] = 0; P[4] = 0; P[5] = -1; P[6] = 1; P[7] = 0;
  lookAt(...p); F[VX] = F[VY] = F[VZ] = 0;
  P[3] = sin(F[YAW]); P[5] = -cos(F[YAW]);
  S.tier = 1; S.eaten = 0; S.time = 0; S.state = 0;
  NT.fill(-1);
  for (let k = 0; k < NWANT; k++) spawn(8, 55);
  hudSet();
}

// ---------------------------------------------------------------- HUD
const hud_ = $('u'), hLv = $('ul'), hEat = $('ue'), hSt = $('us'), hTime = $('ut'), res = $('r');
let hudLast = '';
function hudSet() {
  const k = `${S.tier},${S.eaten},${S.time | 0},${P[6].toFixed(2)},${P[7]}`;
  if (k === hudLast) return; hudLast = k;
  hLv.textContent = `${TXT.lv} ${S.tier}`;
  hEat.style.transform = `scaleX(${S.eaten / NEED[S.tier]})`;
  hSt.style.transform = `scaleX(${P[6]})`; hSt.className = P[7] ? 'x' : '';
  hTime.textContent = fmt(S.time);
}
$('h').textContent = TXT.touch;
$('hint').textContent = TXT.hint;
bDive.textContent = TXT.play;
if (best) res.textContent = TXT.best(fmt(best));
function end(won) {
  S.state = won ? 3 : 2; S.deadT = 0;
  if (won) { sfxWin(); if (!best || S.time < best) { best = S.time; keep('abyssBiteBest', best); } }
  else sfxDie();
  res.textContent = (won ? TXT.won(fmt(S.time)) : TXT.dead(fmt(S.time), S.tier)) + (best ? ' · ' + TXT.best(fmt(best)) : '');
  bDive.textContent = TXT.again;
}
// the dive button starts a run, resumes a paused one or starts over after the end
bDive.onclick = () => {
  if (S.state >= 2) restart();
  if (S.state === 0) { S.state = 1; res.textContent = ''; }
  go(); bDive.textContent = TXT.resume;
};

// ---------------------------------------------------------------- the other fish
function fishStep(i, dt) {
  const t = NT[i], s = SIZE[t], o = i * 3, pt = S.tier, live = S.state === 1;
  let x = NP[o], y = NP[o + 1], z = NP[o + 2], vx = NV[o], vy = NV[o + 1], vz = NV[o + 2];
  const dx = P[0] - x, dy = P[1] - y, dz = P[2] - z, d = sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
  if (d > 90) { NT[i] = -1; return; }
  const R = 13 + 2.5 * t, base = speed(t);
  NTM[i] -= dt;
  if (live && NM[i] === 0) {
    if (t > pt && d < R && sees(x, y, z, P[0], P[1], P[2])) { NM[i] = 1; NTM[i] = 5 + Math.random() * 2; }
    else if (t < pt && d < R * 0.75) { NM[i] = 2; NTM[i] = 3.5 + Math.random(); }
  }
  let ex = 0, ey = 0, ez = 0;
  if (NM[i] === 1) { // chase: aim a little ahead of you; lose you behind rock or after a while
    if (!live || t <= pt) NM[i] = 0;
    else {
      if (!sees(x, y, z, P[0], P[1], P[2])) NTM[i] -= dt * 1.5;
      if (NTM[i] <= 0 || d > R * 1.7) { NM[i] = 3; NTM[i] = 3; }
      const lead = min(d / base, 0.8), tx = dx + F[VX] * lead, ty = dy + F[VY] * lead, tz = dz + F[VZ] * lead, l = sqrt(tx * tx + ty * ty + tz * tz) + 1e-6, sp = base * 1.02;
      ex = tx / l * sp; ey = ty / l * sp; ez = tz / l * sp;
    }
  } else if (NM[i] === 2) { // flee
    if (NTM[i] <= 0 || d > R * 1.4 || t >= pt) { NM[i] = 3; NTM[i] = 2.5; }
    const sp = base * 1.12; ex = -dx / d * sp; ey = -dy / d * sp * 0.6; ez = -dz / d * sp;
  }
  if (NM[i] === 0 || NM[i] === 3) { // wander, slower when tired
    if (NM[i] === 3 && NTM[i] <= 0) NM[i] = 0;
    NY_[i] += (Math.random() - 0.5) * dt * 2.5;
    const sp = base * (NM[i] === 3 ? 0.22 : 0.35);
    ex = sin(NY_[i]) * sp; ez = -cos(NY_[i]) * sp; ey = sin(F[TIME] * 0.3 + NS[i] * 20) * sp * 0.25;
  }
  // stay in the open water: away from rock ahead, below the surface, above the floor, inside the world
  // (the distance field only reaches 1 m, so look ahead at two points and turn away from rock found there)
  const vl = sqrt(vx * vx + vy * vy + vz * vz) + 1e-6;
  for (let q = 1; q <= 2; q++) {
    const a = (s * 0.6 + 1.2 + vl * 0.4) * q / vl, ax = x + vx * a, ay = y + vy * a, az = z + vz * a, da = sdAt(ax, ay, az);
    if (da > -0.95 && gradAt(ax, ay, az)) { const k = (da + 1) * base * 2.5 / q; ex -= GR[0] * k; ey -= GR[1] * k; ez -= GR[2] * k; }
  }
  if (y > -3) ey -= (y + 3) * 3; if (y < -48) ey += (-48 - y) * 3;
  const rh = sqrt(x * x + z * z); if (rh > 128) { ex -= x / rh * (rh - 128) * 2; ez -= z / rh * (rh - 128) * 2; }
  const k = 1 - exp(-dt * 3 / sqrt(s));
  vx += (ex - vx) * k; vy += (ey - vy) * k; vz += (ez - vz) * k;
  if (NM[i] !== 0) NY_[i] = atan2(vx, -vz); // wander on from where a chase or flight left off
  x += vx * dt; y += vy * dt; z += vz * dt;
  const r = min(0.9, 0.3 * s), d0 = sdAt(x, y, z);
  if (d0 > -r && gradAt(x, y, z)) { x -= GR[0] * (d0 + r); y -= GR[1] * (d0 + r); z -= GR[2] * (d0 + r); const vn = vx * GR[0] + vy * GR[1] + vz * GR[2]; if (vn > 0) { vx -= GR[0] * vn; vy -= GR[1] * vn; vz -= GR[2] * vn; } NY_[i] += dt * 2; }
  NP[o] = x; NP[o + 1] = y; NP[o + 2] = z; NV[o] = vx; NV[o + 1] = vy; NV[o + 2] = vz;
  // contact with you
  if (!live) return;
  const cr = 0.34 * (s + SIZE[pt]);
  if (d < cr) {
    if (t < pt) { NT[i] = -1; sfxEat(); if (++S.eaten >= NEED[pt]) { if (pt === 5) end(true); else { S.tier++; S.eaten = 0; sfxGrow(); for (let j = 0; j < NMAX; j++) if (NM[j] === 2 && NT[j] >= S.tier) NM[j] = 0; } } }
    else if (t > pt) end(false);
    else { const p = (cr - d) / d; NP[o] -= dx * p; NP[o + 1] -= dy * p; NP[o + 2] -= dz * p; }
  }
}

// ---------------------------------------------------------------- per frame
let spawnT = 0;
function gameFrame(dt) {
  const play = S.state === 1 && !menu;
  // look: mouse / touch, as in the free camera
  if (tId >= 0) {
    const tr = 4 / (innerWidth < innerHeight ? innerWidth : innerHeight); let jx = (tx - tx0) * tr, jy = (ty - ty0) * tr;
    jx = jx > 1 ? 1 : jx < -1 ? -1 : jx; jy = jy > 1 ? 1 : jy < -1 ? -1 : jy;
    lkx += jx * 1.5 * dt; lky += jy * dt;
  }
  const kq = 1 - exp(-dt * 30); lkx += mdx * 0.0022; lky += mdy * 0.0022; mdx = 0; mdy = 0;
  const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
  const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
  const yaw = F[YAW] + dyw; let pitch = F[PIT] - dpt; pitch = pitch < -1.45 ? -1.45 : pitch > 1.45 ? 1.45 : pitch;
  F[YAW] = yaw; F[PIT] = pitch;
  const ps = SIZE[S.tier], cp = cos(pitch), sy = sin(yaw), cw = cos(yaw), fx = sy * cp, fy = sin(pitch), fz = -cw * cp;
  // swim: the free camera's controls, moving the fish
  if (S.state <= 1) {
    const mf = play ? (tId >= 0 ? 0.8 : kf - kb) : 0, mr = play ? kr - kl : 0, mu = play ? ku - kd : 0, moving = mf || mr || mu;
    const dash = play && (ks || tN > 1) && moving && !P[7] && P[6] > 0;
    if (play) { if (dash) { P[6] -= dt / 2.2; if (P[6] <= 0) { P[6] = 0; P[7] = 1; } } else { P[6] = min(1, P[6] + dt / 4); if (P[7] && P[6] > 0.35) P[7] = 0; } }
    const sp = (5.8 + 0.5 * S.tier) * (dash ? 1.85 : 1), k = 1 - exp(-dt * 4.5 / sqrt(ps / 0.75));
    const vx = F[VX] + ((fx * mf + cw * mr) * sp - F[VX]) * k, vy = F[VY] + ((fy * mf + mu) * sp - F[VY]) * k, vz = F[VZ] + ((fz * mf + sy * mr) * sp - F[VZ]) * k;
    let x = P[0] + vx * dt, y = P[1] + vy * dt, z = P[2] + vz * dt;
    const rad = sqrt(x * x + z * z); if (rad > 140) { x *= 140 / rad; z *= 140 / rad; }
    y = y < -52 ? -52 : y > -1.5 ? -1.5 : y;
    F[VX] = vx; F[VY] = vy; F[VZ] = vz; F[CX] = P[0]; F[CY] = P[1]; F[CZ] = P[2]; F[MX] = x - P[0]; F[MY] = y - P[1]; F[MZ] = z - P[2];
    CR = min(0.9, 0.32 * ps); collide();
    P[0] = F[CX]; P[1] = F[CY]; P[2] = F[CZ];
    // face where it swims (or where you look when still)
    const v = sqrt(vx * vx + vy * vy + vz * vz), hk = 1 - exp(-dt * 8);
    let hx = v > 0.4 ? vx / v : fx, hy = v > 0.4 ? vy / v : 0, hz = v > 0.4 ? vz / v : fz;
    hx = P[3] + (hx - P[3]) * hk; hy = P[4] + (hy - P[4]) * hk; hz = P[5] + (hz - P[5]) * hk;
    const hl = sqrt(hx * hx + hy * hy + hz * hz) || 1; P[3] = hx / hl; P[4] = hy / hl; P[5] = hz / hl;
    if (play) S.time += dt;
  }
  // the others
  if (!menu || S.state !== 1) {
    for (let i = 0; i < NMAX; i++) if (NT[i] >= 0) fishStep(i, dt);
    let n = 0; for (let i = 0; i < NMAX; i++) if (NT[i] >= 0) n++;
    if ((spawnT -= dt) <= 0 && n < NWANT) { spawn(24, 60); spawnT = 0.25; }
  }
  if (S.state >= 2 && (S.deadT += dt) > 1.4 && !menu) { if (document.pointerLockElement) document.exitPointerLock(); else ui(true); }
  // camera behind and a little above the fish, pulled in where rock is in the way
  const cd = 1.3 + ps * 1.9, bx = -fx * cd, by = -fy * cd + cd * 0.28, bz = -fz * cd;
  let f = 1;
  for (let k = 1; k <= 10; k++) { const t = k / 10; if (sdAt(P[0] + bx * t, P[1] + by * t, P[2] + bz * t) > -0.35) { f = (k - 1) / 10; break; } }
  f = max(f, 0.15);
  F[CX] = P[0] + bx * f; F[CY] = min(P[1] + by * f, -0.6); F[CZ] = P[2] + bz * f;
  // tilt the view a touch down so the fish sits below the middle of the screen
  // instances: you, then the others
  let n = 0;
  if (S.state !== 2) { GB[0] = P[0]; GB[1] = P[1]; GB[2] = P[2]; GB[3] = ps; GB[4] = P[3]; GB[5] = P[4]; GB[6] = P[5]; GB[7] = 3.5; n = 1; }
  for (let i = 0; i < NMAX; i++) {
    const t = NT[i]; if (t < 0) continue;
    const o = i * 3, b = n * 8, vx = NV[o], vy = NV[o + 1], vz = NV[o + 2], vl = sqrt(vx * vx + vy * vy + vz * vz);
    GB[b] = NP[o]; GB[b + 1] = NP[o + 1]; GB[b + 2] = NP[o + 2]; GB[b + 3] = SIZE[t];
    if (vl > 0.05) { GB[b + 4] = vx / vl; GB[b + 5] = vy / vl * 0.6; GB[b + 6] = vz / vl; } else { GB[b + 4] = sin(NY_[i]); GB[b + 5] = 0; GB[b + 6] = -cos(NY_[i]); }
    GB[b + 7] = (t < S.tier ? 0 : t === S.tier ? 1 : 2) + NS[i] * 0.99; n++;
  }
  nGame = n; Q.writeBuffer(ibGame, 0, GB, 0, n * 8);
  hudSet();
}
restart();
