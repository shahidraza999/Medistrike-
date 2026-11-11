// MediStrike: slingshot physics game with a medical theme.
// Phaser 3 (Matter physics) + Firebase v10 (Anonymous Auth + Realtime Database).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, set, get, update, remove, onValue, onDisconnect, runTransaction,
         query, orderByChild, limitToLast, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

/* ---------------------------------------------------------------- constants */
const W = 960, H = 540, GROUND_Y = 500;
const ANCHOR = { x: 150, y: 380 };   // slingshot pouch position
const MAXPULL = 100, MAXV = 22;      // max drag distance (px), max launch speed (px/step)
const TURNS = 6;                     // multiplayer: 3 shots each
const M = Phaser.Physics.Matter.Matter;

const MAT = {   // block materials
  tissue: { hp: 30, color: 0xf4a6b8, density: 0.0008 },
  bone:   { hp: 70, color: 0xf2ecd8, density: 0.0012 },
};
const ENEMY = { // germs
  bacteria: { e: '🦠', r: 16, hp: 15, pts: 100 },
  virus:    { e: '🤧', r: 18, hp: 25, pts: 150 },
  fungus:   { e: '🍄', r: 22, hp: 40, pts: 200 },
};
const PROJ = {  // medicine projectiles; mult = damage multiplier
  capsule: { e: '💊', r: 14, density: 0.0015, mult: 1.5 }, // tap: splits into 3
  syringe: { e: '💉', r: 12, density: 0.0015, mult: 1.5 }, // tap: speed boost
  tablet:  { e: '⚪', r: 18, density: 0.006,  mult: 2.2 }, // heavy, no ability
};

/* ------------------------------------------------------------- small helpers */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rnd = n => Math.floor(Math.random() * n);
const btn = (a, label, v) => `<button class="btn" data-a="${a}"${v === undefined ? '' : ` data-v="${v}"`}>${label}</button>`;
const ov = $('#overlay'), hud = $('#hud'), hudText = $('#hudText'), picker = $('#picker');
const card = html => { ov.hidden = false; ov.innerHTML = `<div class="card">${html}</div>`; };
const closeCard = () => { ov.hidden = true; ov.innerHTML = ''; };
const setHud = html => { hudText.innerHTML = html; };

/* ------------------------------------------------------------- Phaser scene */
let resolveScene;
const sceneReady = new Promise(r => { resolveScene = r; });

class GameScene extends Phaser.Scene {
  constructor() { super('game'); }

  create() {
    this.gfx = this.add.graphics();
    this.add.text(24, 14, '✚', { fontSize: '36px', color: '#e04646' });
    this.ready = this.add.text(ANCHOR.x, ANCHOR.y, '💊', { fontSize: '28px', padding: { x: 4, y: 4 } })
      .setOrigin(0.5).setVisible(false);
    // static ground (top edge at GROUND_Y)
    this.matter.add.rectangle(W / 2, GROUND_Y + 30, W * 3, 60, { isStatic: true, friction: 1, label: 'ground' });
    this.items = []; this.byId = new Map(); this.projs = [];
    this.state = 'idle';       // idle | aim | flying | wait | settled
    this.type = 'capsule';
    this.frame = 0; this.points = 0;
    this.canShoot = false; this.drag = false; this.pull = null;
    this.pendingTap = null; this.abilityUsed = false; this.launchFrame = 0; this.stillFrames = 0;
    this.matter.world.on('collisionstart', e => this.onCollide(e));
    this.input.on('pointerdown', p => this.onDown(p));
    this.input.on('pointermove', p => this.onMove(p));
    this.input.on('pointerup', () => this.onUp());
    resolveScene(this);
  }

  emit(t, d) { if (this.onEvent) this.onEvent(t, d); }
  emo(x, y, ch, size) { return this.add.text(x, y, ch, { fontSize: size + 'px', padding: { x: 4, y: 4 } }).setOrigin(0.5); }
  reg(it) { this.items.push(it); this.byId.set(it.body.id, it); }

  /* ---- level lifecycle */
  clear() {
    for (const it of this.items) { this.matter.world.remove(it.body); if (it.txt) it.txt.destroy(); }
    this.items = []; this.projs = []; this.byId.clear();
  }
  begin(def, canShoot) {            // (re)build a level and get ready to play
    this.clear();
    this.canShoot = canShoot; this.points = 0; this.drag = false; this.pull = null;
    this.pendingTap = null; this.abilityUsed = false;
    for (const o of def.objects) {
      if (o.t === 'b') {
        const m = MAT[o.m];
        const body = this.matter.add.rectangle(o.x, o.y, o.w, o.h, { density: m.density, friction: 0.6, label: 'block' });
        this.reg({ body, kind: 'block', hp: m.hp, max: m.hp, color: m.color });
      } else {
        const e = ENEMY[o.k];
        const body = this.matter.add.circle(o.x, o.y, e.r, { density: 0.0012, friction: 0.6, label: 'enemy' });
        this.reg({ body, kind: 'enemy', hp: e.hp, max: e.hp, pts: e.pts, txt: this.emo(o.x, o.y, e.e, e.r * 2) });
      }
    }
    this.state = canShoot ? 'aim' : 'wait';
    this.ready.setPosition(ANCHOR.x, ANCHOR.y).setVisible(canShoot);
  }
  stop() { this.clear(); this.state = 'idle'; this.canShoot = false; this.ready.setVisible(false); }
  nextShot() { this.state = 'aim'; this.pull = null; this.ready.setPosition(ANCHOR.x, ANCHOR.y).setVisible(true); }
  setType(t) { this.type = t; this.ready.setText(PROJ[t].e); }

  /* ---- input: drag back to aim, release to fire, tap in flight for ability */
  onDown(p) {
    if (!this.canShoot) return;
    if (this.state === 'aim' && Phaser.Math.Distance.Between(p.x, p.y, ANCHOR.x, ANCHOR.y) < 70) { this.drag = true; this.onMove(p); }
    else if (this.state === 'flying') this.tap();
  }
  onMove(p) {
    if (!this.drag) return;
    let dx = p.x - ANCHOR.x, dy = p.y - ANCHOR.y;
    const d = Math.hypot(dx, dy);
    if (d > MAXPULL) { dx *= MAXPULL / d; dy *= MAXPULL / d; }
    this.pull = { x: dx, y: dy };
    this.ready.setPosition(ANCHOR.x + dx, ANCHOR.y + dy);
  }
  onUp() {
    if (!this.drag) return;
    this.drag = false;
    const len = Math.hypot(this.pull.x, this.pull.y);
    if (len < 20) { this.pull = null; this.ready.setPosition(ANCHOR.x, ANCHOR.y); return; } // too weak: cancel
    this.fire(this.type, Math.atan2(-this.pull.y, -this.pull.x), len / MAXPULL, true);
  }

  /* ---- shooting (used for local shots AND for replaying the opponent's shot) */
  fire(type, angle, power, mine) {
    this.projs.forEach(p => this.kill(p)); this.projs = [];
    this.state = 'flying'; this.shotType = type;
    this.launchFrame = this.frame; this.abilityUsed = false; this.pendingTap = null; this.stillFrames = 0;
    const v = power * MAXV;
    this.spawn(type, ANCHOR.x, ANCHOR.y, { x: Math.cos(angle) * v, y: Math.sin(angle) * v });
    this.ready.setVisible(false); this.pull = null;
    if (mine) this.emit('shot', { type, angle, power });
  }
  replay(s) { this.setType(s.type); this.fire(s.type, s.angle, s.power, false); }
  spawn(type, x, y, vel) {
    const d = PROJ[type];
    const body = this.matter.add.circle(x, y, d.r, { density: d.density, friction: 0.4, restitution: 0.25, label: 'proj' });
    M.Body.setVelocity(body, vel);
    const it = { body, kind: 'proj', type, txt: this.emo(x, y, d.e, d.r * 2) };
    this.reg(it); this.projs.push(it);
    return it;
  }
  // The ability is scheduled for a specific physics step (offset from launch) so
  // both players trigger it on exactly the same step.
  tap() {
    if (this.shotType === 'tablet' || this.abilityUsed || this.pendingTap !== null) return;
    this.pendingTap = this.frame - this.launchFrame + 1;
    this.emit('tap', { frame: this.pendingTap });
  }
  remoteTap(f) { if (this.state === 'flying' && !this.abilityUsed && this.pendingTap === null) this.pendingTap = f; }
  ability() {
    this.abilityUsed = true;
    const p = this.projs[0];
    if (!p || p.dead) return;
    const v = p.body.velocity, q = p.body.position;
    if (p.type === 'syringe') M.Body.setVelocity(p.body, { x: v.x * 1.8, y: v.y * 1.8 });
    if (p.type === 'capsule') {   // split: two extra capsules to each side of the flight path
      const s = Math.hypot(v.x, v.y) || 1, nx = -v.y / s, ny = v.x / s;
      for (const k of [-1, 1]) this.spawn('capsule', q.x + nx * k * 30, q.y + ny * k * 30, { x: v.x + nx * k * 1.5, y: v.y + ny * k * 1.5 });
    }
  }

  /* ---- damage */
  onCollide(ev) {
    for (const pr of ev.pairs) {
      const a = pr.bodyA, b = pr.bodyB;
      const sp = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y);
      if (sp < 2.5) continue;                               // ignore gentle contacts
      const A = this.byId.get(a.id), B = this.byId.get(b.id);
      this.hit(A, B, sp); this.hit(B, A, sp);
    }
  }
  hit(t, o, sp) {
    if (!t || t.max === undefined || t.dead) return;        // projectiles and ground take no damage
    const mult = o && o.kind === 'proj' ? PROJ[o.type].mult : 1;
    t.hp -= (sp - 2) * 1.6 * mult;
  }
  kill(it) {
    if (it.dead) return;
    it.dead = true;
    this.matter.world.remove(it.body); this.byId.delete(it.body.id);
    if (it.kind === 'enemy') {
      this.points += it.pts;
      const { x, y } = it.body.position;
      const t = this.add.text(x, y, '+' + it.pts, { fontSize: '20px', color: '#fff', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5);
      this.tweens.add({ targets: t, y: y - 40, alpha: 0, duration: 700, onComplete: () => t.destroy() });
      this.emit('points');
    }
    if (it.txt) { const t = it.txt; this.tweens.add({ targets: t, alpha: 0, scale: 1.6, duration: 350, onComplete: () => t.destroy() }); }
  }

  /* ---- main loop (one physics step per call: Matter runs with a fixed timestep) */
  update() {
    this.frame++;
    if (this.pendingTap !== null && !this.abilityUsed && this.frame - this.launchFrame >= this.pendingTap) this.ability();
    for (const it of this.items) {
      if (it.dead) continue;
      const p = it.body.position;
      if (p.y > H + 250 || p.x > W + 500 || p.x < -400 || (it.max !== undefined && it.hp <= 0)) this.kill(it);
    }
    this.items = this.items.filter(i => !i.dead);

    // draw scenery, slingshot, blocks; position emoji sprites
    const g = this.gfx; g.clear();
    g.fillStyle(0xcfeff7, 1); g.fillRect(0, 0, W, GROUND_Y);
    g.fillStyle(0x6dbf67, 1); g.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    g.fillStyle(0x8b5a2b, 1);
    g.fillRect(ANCHOR.x - 6, ANCHOR.y + 12, 12, GROUND_Y - ANCHOR.y - 12);
    g.fillRect(ANCHOR.x - 20, ANCHOR.y, 8, 24); g.fillRect(ANCHOR.x + 12, ANCHOR.y, 8, 24);
    if (this.state === 'aim' && this.canShoot) {
      g.lineStyle(4, 0x7a1f1f, 1);
      g.lineBetween(ANCHOR.x - 16, ANCHOR.y + 4, this.ready.x, this.ready.y);
      g.lineBetween(ANCHOR.x + 16, ANCHOR.y + 4, this.ready.x, this.ready.y);
    }
    for (const it of this.items) {
      const b = it.body, p = b.position;
      if (it.kind === 'block') {
        g.fillStyle(it.color, 0.45 + 0.55 * it.hp / it.max); g.fillPoints(b.vertices, true);
        g.lineStyle(2, 0x5a3b3b, 1); g.strokePoints(b.vertices, true);
      } else {
        it.txt.setPosition(p.x, p.y).setRotation(b.angle);
        if (it.kind === 'enemy') it.txt.setAlpha(0.5 + 0.5 * it.hp / it.max);   // fades as it weakens
      }
    }

    // has everything come to rest? (or no enemies left / timeout)
    if (this.state === 'flying') {
      const t = this.frame - this.launchFrame;
      const alive = this.items.filter(i => i.kind === 'enemy').length;
      const still = this.items.every(i => i.body.speed < 0.3);
      this.stillFrames = still ? this.stillFrames + 1 : 0;
      if (t > 600 || (t > 45 && alive === 0) || (t > 60 && this.stillFrames >= 30)) {
        this.state = 'settled';
        if (this.canShoot) this.emit('settled', { alive, points: this.points });
      }
    }
  }
}

new Phaser.Game({
  type: Phaser.AUTO, width: W, height: H, parent: 'game', backgroundColor: '#cfeff7',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  // Fixed 60 Hz timestep so every client simulates the same number of steps per shot.
  physics: { default: 'matter', matter: { gravity: { y: 1 }, setBounds: false, runner: { isFixed: true, fps: 60 }, debug: false } },
  scene: [GameScene],
});

/* ------------------------------------------------------------ app state */
let db, auth, uid, name, scene;
let levels = [], progress = {};
let mode = 'menu';          // menu | sp | mp
let sp = null;              // single-player session
let mp = null;              // multiplayer session

/* ------------------------------------------------------------ menus */
function showMenu() {
  mode = 'menu'; scene.stop(); hud.hidden = true; picker.hidden = true;
  card(`<h1>🩺 MediStrike</h1>
    <p>Doctor: <b>${esc(name)}</b> ${btn('rename', '✏️')}</p>
    ${btn('levels', '▶ Single player')}
    ${btn('create', '👥 Create room')}
    <div class="row"><input id="code" maxlength="4" placeholder="ROOM CODE">${btn('join', 'Join')}</div>
    ${btn('board', '🏆 Leaderboard')}
    <small>Educational game. Not medical advice.</small>`);
}
function showLevels() {
  card(`<h2>Choose a level</h2>${levels.map((l, i) => {
    const p = progress[i], open = i === 0 || progress[i - 1];
    return `<button class="btn" data-a="play" data-v="${i}"${open ? '' : ' disabled'}>${i + 1}. ${esc(l.name)}<br>
      <small style="color:#fff">${p ? '⭐'.repeat(p.stars) + (p.bonus ? ' ✨' : '') : open ? 'Not played' : '🔒 Locked'}</small></button>`;
  }).join('')}${btn('menu', 'Back')}`);
}
async function showBoard() {
  card('<h2>🏆 Top 10</h2><p>Loading…</p>');
  try {
    const s = await get(query(ref(db, 'leaderboard'), orderByChild('score'), limitToLast(10)));
    const rows = [];
    s.forEach(c => { rows.push(c.val()); });
    rows.reverse();
    card(`<h2>🏆 Top 10</h2><ol style="text-align:left">${rows.map(r => `<li>${esc(r.name)}: <b>${r.score}</b></li>`).join('') || '<li>No scores yet</li>'}</ol>${btn('menu', 'Back')}`);
  } catch (e) { card(`<h2>Could not load</h2><p>${esc(e.message)}</p>${btn('menu', 'Back')}`); }
}
function setPick(t) {
  scene.setType(t);
  picker.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === t));
}

/* ------------------------------------------------------------ single player */
function startSP(i) {
  mode = 'sp'; closeCard();
  const def = levels[i];
  sp = { i, def, left: def.shots, used: 0 };
  scene.begin(def, true);
  hud.hidden = false; picker.hidden = false; $('#restartBtn').hidden = false;
  setPick('capsule'); spHud();
}
const spHud = () => setHud(`<b>${sp.i + 1}. ${esc(sp.def.name)}</b> · Shots: ${sp.left} · Score: ${scene.points}`);

function spSettled(d) {
  if (d.alive === 0) return spWin(d.points);
  if (sp.left <= 0) return card(`<h2>😷 The germs survived</h2><p>You are out of shots.</p>${btn('restart', 'Try again')}${btn('menu', 'Menu')}`);
  scene.nextShot();
}
function spWin(points) {
  const { def } = sp;
  sp.stars = sp.used <= def.par ? 3 : sp.used <= def.par + 1 ? 2 : 1;           // stars from shots used
  sp.score = points + sp.left * 50;                                              // bonus for unused shots
  card(`<h2>🎉 Cleared! ${'⭐'.repeat(sp.stars)}</h2>
    <p>Score <b>${sp.score}</b> (unused shots: +${sp.left * 50})</p>
    <p>💡 ${esc(def.fact)}</p><hr>
    <p><b>Bonus quiz:</b> ${esc(def.quiz.q)}</p>
    ${def.quiz.o.map((o, k) => btn('quiz', esc(o), k)).join('')}`);
}
function spQuiz(a) {
  const { def, i } = sp, ok = a === def.quiz.a;
  saveLevel(i, sp.stars, ok, sp.score);
  card(`<h2>${ok ? '✅ Correct! Bonus star ✨' : '❌ Not quite'}</h2>
    <p>Answer: <b>${esc(def.quiz.o[def.quiz.a])}</b></p>
    ${i + 1 < levels.length ? btn('play', 'Next level ▶', i + 1) : '<p>🎉 All levels cleared!</p>'}
    ${btn('play', 'Replay', i)}${btn('menu', 'Menu')}`);
}
async function saveLevel(i, stars, bonus, score) {
  const old = progress[i] || { stars: 0, bonus: false, score: 0 };
  const best = { stars: Math.max(old.stars, stars), bonus: !!(old.bonus || bonus), score: Math.max(old.score, score) };
  progress[i] = best;
  const total = Object.values(progress).reduce((s, p) => s + p.score + (p.bonus ? 100 : 0), 0);
  try {
    await set(ref(db, `users/${uid}/levels/${i}`), best);
    await set(ref(db, `leaderboard/${uid}`), { name, score: total });
  } catch (e) { console.warn('save failed', e); }
}

/* ------------------------------------------------------------ multiplayer */
async function createRoom() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code, r;
  for (let k = 0; k < 5; k++) {                       // find an unused 4-letter code
    code = Array.from({ length: 4 }, () => letters[rnd(letters.length)]).join('');
    r = ref(db, 'rooms/' + code);
    if (!(await get(r)).exists()) break;
  }
  await set(r, { host: uid, names: { [uid]: name }, scores: { [uid]: 0 }, online: { [uid]: true },
                 level: rnd(levels.length), turnNo: 0, status: 'waiting', created: serverTimestamp() });
  enterRoom(code, true);
  card(`<h2>Room</h2><div class="code">${code}</div><p>Share this code. Waiting for your opponent…</p>${btn('menu', 'Cancel')}`);
}
async function joinRoom() {
  const code = ($('#code').value || '').toUpperCase().trim();
  if (code.length !== 4) return alert('Enter the 4-letter room code');
  try {
    const r = ref(db, 'rooms/' + code), v = (await get(r)).val();
    if (!v || v.status !== 'waiting' || v.guest) return alert('Room not found, or already full');
    await update(r, { guest: uid, [`names/${uid}`]: name, [`scores/${uid}`]: 0, [`online/${uid}`]: true, status: 'playing' });
    enterRoom(code, false);
  } catch (e) { alert('Could not join: ' + e.message); }
}
function enterRoom(code, isHost) {
  const r = ref(db, 'rooms/' + code);
  mp = { code, r, isHost, started: false, turnNo: -1, replayed: -1, mine: false };
  if (isHost) { mp.odRemove = onDisconnect(r); mp.odRemove.remove(); }   // waiting room vanishes if host drops
  mp.unsub = onValue(r, s => onRoom(s.val()));
}
async function leaveRoom() {
  if (!mp) return;
  const { code, r, unsub, od, odRemove } = mp;
  mp = null; unsub();
  try {
    if (od) await od.cancel();
    if (odRemove) await odRemove.cancel();
    const v = (await get(r)).val();
    if (v) {
      await set(ref(db, `rooms/${code}/online/${uid}`), false);
      const other = v.host === uid ? v.guest : v.host;
      if (!other || !(v.online && v.online[other])) await remove(r);     // last one out deletes the room
    }
  } catch (e) { /* best effort */ }
}
function endMp(msg) {
  mode = 'menu'; scene.stop(); picker.hidden = true; hud.hidden = true;
  leaveRoom();
  card(`<h2>${esc(msg)}</h2>${btn('menu', 'Menu')}`);
}

function onRoom(room) {                      // called on every change of the room
  if (!mp) return;
  if (!room) { if (mp.started) endMp('The room was closed.'); return; }
  const opp = room.host === uid ? room.guest : room.host;
  if (room.status === 'waiting') return;
  if (!mp.started) {                         // opponent joined: start match
    mp.started = true; mode = 'mp';
    Promise.resolve(mp.odRemove && mp.odRemove.cancel()).then(() => {
      mp.od = onDisconnect(ref(db, `rooms/${mp.code}/online/${uid}`)); mp.od.set(false);   // presence
    });
    closeCard(); hud.hidden = false; $('#restartBtn').hidden = true;
  }
  if (room.status === 'playing' && room.online && room.online[opp] === false) return endMp('Your opponent left the match.');
  if (room.status === 'done') return mpResult(room, opp);
  if (mp.resultShown) { mp.resultShown = false; closeCard(); }
  if (room.turnNo !== mp.turnNo) beginMpTurn(room);
  const s = room.scores || {};
  setHud(`<b>You ${s[uid] || 0}</b> · ${esc((room.names || {})[opp] || 'Opponent')} ${s[opp] || 0} · Turn ${room.turnNo + 1}/${TURNS} · ${mp.mine ? '🎯 Your shot' : '👀 Watching'}`);
  const shot = room.shot;                    // opponent's shot: replay it locally
  if (shot && shot.n === mp.turnNo && shot.uid !== uid) {
    if (mp.replayed !== shot.n) { mp.replayed = shot.n; scene.replay(shot); }
    if (shot.tapFrame !== undefined) scene.remoteTap(shot.tapFrame);
  }
}
function beginMpTurn(room) {
  mp.turnNo = room.turnNo; mp.replayed = -1;
  mp.mine = (room.turnNo % 2 === 0 ? room.host : room.guest) === uid;   // host shoots on even turns
  scene.begin(levels[room.level], mp.mine);
  picker.hidden = !mp.mine;
  if (mp.mine) setPick('capsule');
}
function mpResult(room, opp) {
  mp.resultShown = true; picker.hidden = true;
  const a = (room.scores || {})[uid] || 0, b = (room.scores || {})[opp] || 0;
  const msg = a > b ? '🏆 You win!' : a < b ? 'You lose. Keep practising!' : '🤝 Draw!';
  const waiting = room.rematch && room.rematch[uid];
  card(`<h2>${msg}</h2><p>${esc(name)}: <b>${a}</b><br>${esc((room.names || {})[opp] || 'Opponent')}: <b>${b}</b></p>
    ${waiting ? '<p>Waiting for opponent…</p>' : btn('rematch', '🔁 Rematch')}${btn('menu', 'Menu')}`);
  if (mp.isHost && room.rematch && room.guest && room.rematch[room.host] && room.rematch[room.guest]) {
    update(mp.r, { status: 'playing', turnNo: 0, scores: { [room.host]: 0, [room.guest]: 0 },
                   shot: null, rematch: null, level: rnd(levels.length) });
  }
}
function mpEvent(t, d) {                     // events from my own scene while it's my turn
  if (!mp || !mp.mine) return;
  if (t === 'shot') set(ref(db, `rooms/${mp.code}/shot`), { n: mp.turnNo, uid, type: d.type, angle: d.angle, power: d.power });
  if (t === 'tap') set(ref(db, `rooms/${mp.code}/shot/tapFrame`), d.frame);
  if (t === 'settled') {                     // I'm the scorekeeper for my own shot: add points, pass the turn
    const n = mp.turnNo;
    runTransaction(mp.r, cur => {
      if (cur === null) return cur;
      if (cur.turnNo !== n) return;          // already advanced: abort
      cur.scores = cur.scores || {};
      cur.scores[uid] = (cur.scores[uid] || 0) + d.points;
      cur.turnNo = n + 1;
      if (cur.turnNo >= TURNS) cur.status = 'done';
      return cur;
    });
  }
}

/* ------------------------------------------------------------ wiring */
function onSceneEvent(t, d) {
  if (mode === 'mp') return mpEvent(t, d);
  if (mode !== 'sp') return;
  if (t === 'shot') { sp.left--; sp.used++; spHud(); }
  else if (t === 'points') spHud();
  else if (t === 'settled') spSettled(d);
}
const act = {                                // every button uses data-a="name" data-v="value"
  menu: async () => { await leaveRoom(); showMenu(); },
  levels: showLevels,
  play: v => startSP(+v),
  restart: () => { if (mode === 'sp') startSP(sp.i); },
  pick: v => setPick(v),
  quiz: v => spQuiz(+v),
  create: () => createRoom().catch(e => alert(e.message)),
  join: joinRoom,
  board: showBoard,
  rematch: () => { if (mp) set(ref(db, `rooms/${mp.code}/rematch/${uid}`), true); },
  rename: () => {
    const n = (prompt('Doctor name?', name) || '').trim().slice(0, 16);
    if (n) { name = n; localStorage.ms_name = n; set(ref(db, `users/${uid}/name`), n); }
    showMenu();
  },
};
document.addEventListener('click', e => {
  const a = e.target.closest('[data-a]');
  if (a && act[a.dataset.a]) act[a.dataset.a](a.dataset.v);
});

async function main() {
  levels = await (await fetch('levels.json')).json();
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app); db = getDatabase(app);
  await signInAnonymously(auth);
  uid = auth.currentUser.uid;
  const v = (await get(ref(db, 'users/' + uid))).val() || {};
  progress = { ...(v.levels || {}) };
  name = localStorage.ms_name || v.name;
  if (!name) name = (prompt('Choose a doctor name', 'Dr. Smith') || '').trim().slice(0, 16) || 'Dr. ' + (100 + rnd(900));
  localStorage.ms_name = name;
  set(ref(db, `users/${uid}/name`), name);
  scene = await sceneReady;
  scene.onEvent = onSceneEvent;
  showMenu();
}
main().catch(e => card(`<h2>Startup error</h2><p>${esc(e.message)}</p>
  <small>Check firebase-config.js, that Anonymous sign-in is enabled, and that you are serving over http(s), not file://.</small>`));
