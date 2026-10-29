/* ライター名鑑 データベース
 * The database ships encrypted (data.enc.js). Entering the PIN derives the AES key
 * (PBKDF2-SHA256) and decrypts it in the browser; a wrong PIN simply fails to decrypt.
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  // NFKC + lower-case + katakana→hiragana, whitespace removed: makes kana search forgiving.
  const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '');

  /* =================================================================
     Starfield (shared by lock + app)
     ================================================================= */
  function startSky(canvas) {
    const ctx = canvas.getContext('2d');
    let stars = [];
    let w = 0, h = 0, dpr = 1, last = 0;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round((w * h) / 9000);
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h * 0.85,
        r: Math.random() < 0.08 ? 1.4 + Math.random() : 0.4 + Math.random() * 0.8,
        p: Math.random() * Math.PI * 2, s: 0.4 + Math.random() * 1.6,
        gold: Math.random() < 0.35,
      }));
    }
    function draw(t) {
      requestAnimationFrame(draw);
      if (document.hidden || t - last < 50) return;
      last = t;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(s.p + (t / 1000) * s.s));
        ctx.globalAlpha = a * (1 - s.y / (h * 1.1));
        ctx.fillStyle = s.gold ? '#ffe2a0' : '#dfe6ff';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
        if (s.r > 1.4) {
          ctx.globalAlpha *= 0.35;
          ctx.fillRect(s.x - s.r * 3, s.y - 0.3, s.r * 6, 0.6);
          ctx.fillRect(s.x - 0.3, s.y - s.r * 3, 0.6, s.r * 6);
        }
      }
      ctx.globalAlpha = 1;
    }
    resize();
    addEventListener('resize', resize);
    requestAnimationFrame(draw);
  }

  /* =================================================================
     Sound effects (synthesised with Web Audio, no files)
     ================================================================= */
  const Sound = {
    ctx: null,
    master: null,
    on: store.get('meikan:sound') !== 'off',
    ensure() {
      if (!this.on) return null;
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, { t = 0, dur = 0.15, type = 'sine', gain = 0.15, glide = null, attack = 0.005 } = {}) {
      const ctx = this.ensure(); if (!ctx) return;
      const now = ctx.currentTime + t;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, now);
      if (glide) o.frequency.exponentialRampToValueAtTime(glide, now + dur);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(gain, now + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.connect(g).connect(this.master);
      o.start(now); o.stop(now + dur + 0.05);
    },
    noise({ t = 0, dur = 1, gain = 0.1, from = 400, to = 400, type = 'lowpass' } = {}) {
      const ctx = this.ensure(); if (!ctx) return;
      const now = ctx.currentTime + t;
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b = 0;
      for (let i = 0; i < d.length; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = b * 3.5; }
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = type;
      f.frequency.setValueAtTime(from, now); f.frequency.exponentialRampToValueAtTime(to, now + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(gain, now + dur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(f).connect(g).connect(this.master);
      src.start(now); src.stop(now + dur);
    },
    key(i) { this.tone(640 + i * 24, { dur: 0.09, type: 'triangle', gain: 0.11 }); this.tone(1280 + i * 48, { dur: 0.05, gain: 0.035 }); },
    back() { this.tone(420, { dur: 0.09, type: 'triangle', gain: 0.09, glide: 300 }); },
    error() { this.tone(196, { dur: 0.2, type: 'square', gain: 0.045 }); this.tone(147, { t: 0.16, dur: 0.32, type: 'square', gain: 0.045 }); },
    charge() { this.noise({ dur: 0.8, gain: 0.07, from: 200, to: 4000, type: 'bandpass' }); this.tone(110, { dur: 0.8, gain: 0.08, glide: 440, attack: 0.3 }); },
    unseal() {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
        this.tone(f, { t: i * 0.05, dur: 1.8, gain: 0.07 });
        this.tone(f * 2.01, { t: i * 0.05, dur: 0.9, gain: 0.02 });
      });
    },
    gate() { this.noise({ dur: 2, gain: 0.3, from: 90, to: 260 }); this.tone(55, { dur: 1.8, gain: 0.1, attack: 0.4 }); },
    welcome() { [783.99, 987.77, 1174.66, 1567.98].forEach((f, i) => this.tone(f, { t: i * 0.12, dur: 1.4, gain: 0.05, type: 'triangle' })); },
  };

  /* =================================================================
     Lock-screen particles
     ================================================================= */
  function startParticles(canvas) {
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, dpr = 1, running = true, attract = null;
    let motes = [], sparks = [];
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const spawn = (y = Math.random() * h) => ({ x: Math.random() * w, y, vy: 0.15 + Math.random() * 0.5, r: 0.6 + Math.random() * 1.8, p: Math.random() * 6.28, a: 0.2 + Math.random() * 0.6 });
    resize();
    motes = Array.from({ length: reduceMotion ? 0 : 70 }, () => spawn());
    addEventListener('resize', resize);
    function frame(t) {
      if (!running) return;
      requestAnimationFrame(frame);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (const m of motes) {
        if (attract) {
          m.x += (attract.x - m.x) * 0.035; m.y += (attract.y - m.y) * 0.035;
        } else {
          m.y -= m.vy; m.x += Math.sin(m.p + t / 1300) * 0.25;
        }
        if (m.y < -10) Object.assign(m, spawn(h + 10));
        ctx.globalAlpha = m.a * (0.6 + 0.4 * Math.sin(m.p + t / 400));
        ctx.fillStyle = '#ffd68c';
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 6.28); ctx.fill();
      }
      sparks = sparks.filter((s) => s.life > 0);
      for (const s of sparks) {
        s.x += s.vx; s.y += s.vy; s.vx *= 0.965; s.vy = s.vy * 0.965 + 0.04; s.life -= 0.012;
        ctx.globalAlpha = Math.max(0, s.life);
        ctx.fillStyle = s.c;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * s.life + 0.3, 0, 6.28); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    requestAnimationFrame(frame);
    return {
      attractTo(pt) { attract = pt; },
      burst(x, y, n = 160) {
        attract = null;
        if (reduceMotion) return;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 9;
          sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 1 + Math.random() * 2.4, life: 0.7 + Math.random() * 0.5, c: Math.random() < 0.3 ? '#ffffff' : '#ffd68c' });
        }
        for (const m of motes) Object.assign(m, spawn());
      },
      stop() { running = false; ctx.clearRect(0, 0, w, h); },
    };
  }

  /* =================================================================
     Vault
     ================================================================= */
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function openVault(pin) {
    const v = window.MEIKAN_VAULT;
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(v.salt), iterations: v.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(v.iv) }, key, b64(v.data));
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  /* =================================================================
     Lock screen controller
     ================================================================= */
  function medallionSVG() {
    const petals = Array.from({ length: 12 }, (_, i) => `<ellipse cx="100" cy="56" rx="9" ry="30" stroke-opacity=".4" transform="rotate(${i * 30} 100 100)"/>`).join('');
    const star = Array.from({ length: 16 }, (_, i) => {
      const r = i % 2 ? 24 : 56, a = (i * Math.PI) / 8 - Math.PI / 2;
      return `${(100 + r * Math.cos(a)).toFixed(1)},${(100 + r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    return `<svg viewBox="0 0 200 200" class="lock-door-medallion" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="100" cy="100" r="96" stroke-opacity=".55"/><circle cx="100" cy="100" r="88" stroke-opacity=".6" stroke-dasharray="2 5"/>
      ${petals}<circle cx="100" cy="100" r="44" stroke-opacity=".5"/>
      <polygon points="${star}" stroke-opacity=".7"/><rect x="84" y="84" width="32" height="32" stroke-opacity=".6" transform="rotate(45 100 100)"/>
      <circle cx="100" cy="100" r="8" stroke-opacity=".8"/></svg>`;
  }

  function initLock() {
    const root = $('#lock');
    const PIN_LEN = window.MEIKAN_VAULT?.pinLength || 15;
    const MAX_FAILS = 5, COOLDOWN = 30;
    const slots = $('#lock-slots'), status = $('#lock-status'), submit = $('#lock-submit'), hidden = $('#pin');
    let pin = '', fails = 0, coolUntil = 0, busy = false, timers = [], db = null, finished = false;

    $$('[data-medallion]').forEach((d) => d.insertAdjacentHTML('beforeend', medallionSVG()));
    $('#sigil-shards').innerHTML = Array.from({ length: 8 }, (_, i) =>
      `<g transform="rotate(${i * 45} 120 120)"><g class="sigil-shard" style="--i:${i};animation-delay:${i * 30}ms"><path d="M120 6 L128 22 L120 34 L112 22Z"/></g></g>`).join('');
    slots.innerHTML = Array.from({ length: PIN_LEN }, (_, i) => `<span class="lock-slot" style="--i:${i}"></span>`).join('');
    hidden.maxLength = PIN_LEN;

    startSky($('#sky'));
    const particles = startParticles($('#lock-canvas'));
    const setPhase = (p) => { root.dataset.phase = p; };
    const setStatus = (msg, error = false) => { status.textContent = msg; status.classList.toggle('is-error', error); };

    function render() {
      $$('.lock-slot', slots).forEach((s, i) => {
        s.toggleAttribute('data-filled', i < pin.length);
        s.toggleAttribute('data-current', i === pin.length);
      });
      hidden.value = pin;
      submit.disabled = pin.length !== PIN_LEN || busy;
      if (!busy && Date.now() >= coolUntil) setStatus(`${pin.length} / ${PIN_LEN} 桁`);
    }

    function press(key) {
      if (busy || Date.now() < coolUntil) return;
      if (root.dataset.phase === 'error') setPhase('idle');
      const btn = $(`.lock-key[data-key="${key}"]`);
      if (btn) { btn.classList.add('is-pressed'); setTimeout(() => btn.classList.remove('is-pressed'), 120); }
      if (/^\d$/.test(key)) {
        if (pin.length >= PIN_LEN) return;
        pin += key; Sound.key(pin.length);
        render();
        if (pin.length === PIN_LEN) setTimeout(attempt, 220);
      } else if (key === 'back') {
        if (!pin) return;
        pin = pin.slice(0, -1); Sound.back(); render();
      } else if (key === 'clear') {
        if (!pin) return;
        pin = ''; Sound.back(); render();
      }
    }

    function cooldown() {
      const tick = () => {
        const left = Math.ceil((coolUntil - Date.now()) / 1000);
        if (left > 0) { setStatus(`試行回数の上限です。${left}秒後に再入力できます`, true); setTimeout(tick, 250); }
        else { fails = 0; $$('.lock-key').forEach((k) => { k.disabled = false; }); render(); }
      };
      $$('.lock-key').forEach((k) => { k.disabled = true; });
      tick();
    }

    async function attempt() {
      if (busy || pin.length !== PIN_LEN || Date.now() < coolUntil) return;
      if (!window.MEIKAN_VAULT) return setStatus('データファイル（data.enc.js）が見つかりません', true);
      if (!window.crypto?.subtle || !window.DecompressionStream) return setStatus('このブラウザ／接続では解錠できません（HTTPS か localhost で開いてください）', true);
      busy = true; render();
      setPhase('checking'); setStatus('照合しています…');
      try {
        [db] = await Promise.all([openVault(pin), wait(reduceMotion ? 0 : 650)]);
      } catch {
        db = null;
      }
      busy = false;
      if (!db) {
        fails += 1;
        setPhase('error'); Sound.error();
        const msg = `PINコードが正しくありません（あと${MAX_FAILS - fails}回）`;
        if (fails >= MAX_FAILS) { coolUntil = Date.now() + COOLDOWN * 1000; cooldown(); } else setStatus(msg, true);
        setTimeout(() => { pin = ''; render(); if (Date.now() >= coolUntil) setStatus(msg, true); }, 650);
        return;
      }
      pin = ''; hidden.value = '';
      setStatus('解錠しました');
      sequence();
    }

    function emblemCenter() {
      const r = $('.lock-emblem').getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight * 0.4 };
    }

    function sequence() {
      if (reduceMotion) return finish();
      const at = (ms, fn) => timers.push(setTimeout(fn, ms));
      setPhase('charge'); Sound.charge(); particles.attractTo(emblemCenter());
      at(750, () => { setPhase('unseal'); Sound.unseal(); const c = emblemCenter(); particles.burst(c.x, c.y); });
      at(1850, () => { setPhase('gate'); Sound.gate(); App.mount(db); });
      at(3500, () => { setPhase('welcome'); Sound.welcome(); });
      at(5900, finish);
    }

    function finish() {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      App.mount(db);
      setPhase('done');
      document.body.classList.remove('is-locked');
      App.reveal();
      setTimeout(() => { particles.stop(); root.remove(); }, 1000);
    }

    // Input wiring
    $('#lock-keypad').addEventListener('click', (e) => { const k = e.target.closest('[data-key]'); if (k) press(k.dataset.key); });
    $('#pin-form').addEventListener('submit', (e) => { e.preventDefault(); attempt(); });
    hidden.addEventListener('input', () => { pin = hidden.value.replace(/\D/g, '').slice(0, PIN_LEN); render(); if (pin.length === PIN_LEN) attempt(); });
    addEventListener('keydown', function onKey(e) {
      if (!document.body.contains(root)) return removeEventListener('keydown', onKey);
      const ph = root.dataset.phase;
      if (['charge', 'unseal', 'gate', 'welcome'].includes(ph)) {
        if (['Enter', ' ', 'Escape'].includes(e.key)) { e.preventDefault(); finish(); }
        return;
      }
      if (e.target === hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Escape') press('clear');
      else if (e.key === 'Enter') { e.preventDefault(); attempt(); }
    });
    root.addEventListener('click', () => { if (['charge', 'unseal', 'gate', 'welcome'].includes(root.dataset.phase)) finish(); });

    const soundBtn = $('#sound-toggle');
    const syncSound = () => {
      soundBtn.setAttribute('aria-pressed', String(Sound.on));
      soundBtn.setAttribute('aria-label', Sound.on ? '効果音をオフにする' : '効果音をオンにする');
      soundBtn.title = Sound.on ? '効果音: オン' : '効果音: オフ';
    };
    soundBtn.addEventListener('click', (e) => { e.stopPropagation(); Sound.on = !Sound.on; store.set('meikan:sound', Sound.on ? 'on' : 'off'); syncSound(); if (Sound.on) Sound.key(3); });
    syncSound();

    if (!reduceMotion) {
      root.addEventListener('pointermove', (e) => {
        const x = (e.clientX / innerWidth - 0.5) * 2, y = (e.clientY / innerHeight - 0.5) * 2;
        $('.lock-parallax').style.translate = `${x * -10}px ${y * -8}px`;
      });
    }
    document.body.classList.add('is-locked');
    render();
  }

  /* =================================================================
     Application
     ================================================================= */
  const SNS = {
    x: { label: 'X', mark: 'X' },
    note: { label: 'note', mark: 'n' },
    instagram: { label: 'Instagram', mark: 'IG' },
    facebook: { label: 'Facebook', mark: 'f' },
  };
  const LINK_FILTERS = [['portfolio', 'ポートフォリオ'], ['x', 'X'], ['note', 'note'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['contact', '連絡フォーム']];
  const KANA_ORDER = 'あかさたなはまやらわ';
  const SIDEBAR_CATS = ['政治・社会', '経済', 'テクノロジー', '文化・カルチャー', '暮らし・ライフスタイル'];
  const TAG_LIMIT = 28;

  const App = {
    db: null,
    mounted: false,
    results: [],
    S: { q: '', tags: new Set(), prefs: new Set(), services: new Set(), style: '', invoice: '', links: new Set(), sort: 'kana', dir: 1, layout: store.get('meikan:layout') || 'grid', tagQ: '', tagAll: false, tiQ: '', tiSort: 'count' },
    drawerIdx: -1,

    mount(db) {
      if (this.mounted) return;
      this.mounted = true;
      this.db = db;
      this.prepare();
      $('#app').hidden = false;
      this.renderStatic();
      this.bind();
      this.route();
      this.update();
    },

    reveal() {
      const app = $('#app');
      app.classList.add('is-revealing');
      this.countUp();
      setTimeout(() => app.classList.remove('is-revealing'), 1200);
    },

    prepare() {
      const { writers, tags, meta } = this.db;
      this.prefOrder = new Map(meta.prefOrder.map((p, i) => [p, i]));
      this.tagInfo = new Map(tags.map((t) => [t.name, t]));
      const svcCount = new Map();
      writers.forEach((w, i) => {
        w.idx = i;
        w.tagSet = new Set(w.tags);
        w.svcSet = new Set(w.services);
        w.kanaN = norm(w.kana || w.name);
        w.groupN = KANA_ORDER.indexOf(w.group);
        w.idNum = Number(w.id) || 0;
        w.hay = norm([w.name, w.kana, w.area, w.pref, w.catch, w.profile, w.tags.join(' '), w.genres.flat().join(' '), w.services.join(' ')].join(' '));
        w.services.forEach((s) => svcCount.set(s, (svcCount.get(s) || 0) + 1));
      });
      this.services = [...svcCount].sort((a, b) => b[1] - a[1]).map(([s]) => s);
      this.prefs = [...new Set(writers.map((w) => w.pref))].sort((a, b) => (this.prefOrder.get(a) ?? 99) - (this.prefOrder.get(b) ?? 99));
    },

    /* ---------- filtering ---------- */
    match(w, skip) {
      const S = this.S;
      if (skip !== 'q' && this.qTokens.length && !this.qTokens.every((t) => w.hay.includes(t))) return false;
      if (skip !== 'tags') for (const t of S.tags) if (!w.tagSet.has(t)) return false;
      if (skip !== 'prefs' && S.prefs.size && !S.prefs.has(w.pref)) return false;
      if (skip !== 'services') for (const s of S.services) if (!w.svcSet.has(s)) return false;
      if (skip !== 'style' && S.style && w.style !== S.style) return false;
      if (skip !== 'invoice' && S.invoice && (S.invoice === 'yes') !== w.invoice) return false;
      if (skip !== 'links') for (const l of S.links) if (!this.hasLink(w, l)) return false;
      return true;
    },
    hasLink(w, l) {
      if (l === 'portfolio') return w.portfolio.length > 0;
      if (l === 'contact') return Boolean(w.contact);
      return Boolean(w.sns[l]?.length);
    },
    compare() {
      const { sort, dir } = this.S;
      const kana = (a, b) => (a.groupN - b.groupN) || a.kanaN.localeCompare(b.kanaN, 'ja');
      const fns = {
        kana: (a, b) => dir * kana(a, b),
        new: (a, b) => dir * (b.idNum - a.idNum),
        tags: (a, b) => dir * (b.tags.length - a.tags.length) || kana(a, b),
        pref: (a, b) => dir * ((this.prefOrder.get(a.pref) ?? 99) - (this.prefOrder.get(b.pref) ?? 99)) || kana(a, b),
      };
      return fns[sort] || fns.kana;
    },
    activeCount() {
      const S = this.S;
      return (S.q ? 1 : 0) + S.tags.size + S.prefs.size + S.services.size + (S.style ? 1 : 0) + (S.invoice ? 1 : 0) + S.links.size;
    },
    clearAll() {
      const S = this.S;
      S.q = ''; $('#q').value = '';
      S.tags.clear(); S.prefs.clear(); S.services.clear(); S.links.clear(); S.style = ''; S.invoice = '';
    },
    filterByTag(tag) {
      this.clearAll();
      this.S.tags.add(tag);
      this.closeDrawer();
      location.hash = '#directory';
      this.update();
      this.toast(`「${tag}」タグで絞り込みました`);
      $('.results').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    },

    update() {
      this.qTokens = this.S.q.split(/[\s　]+/).map(norm).filter(Boolean);
      this.results = this.db.writers.filter((w) => this.match(w)).sort(this.compare());
      this.renderFilters();
      this.renderActive();
      this.renderResults();
      if (this.view === 'insights') this.renderInsights();
    },

    /* ---------- static parts ---------- */
    renderStatic() {
      const { writers, tags, meta } = this.db;
      const n = writers.length;
      const pct = (k) => Math.round((k / n) * 100);
      const invoice = writers.filter((w) => w.invoice).length;
      const full = writers.filter((w) => w.style === '専業').length;
      const sns = writers.filter((w) => Object.keys(w.sns).length).length;
      const prefCounts = this.countBy(writers, (w) => [w.pref]);
      const [topPref, topN] = prefCounts[0];
      $('#hero-sub').textContent = `全国 ${n} 名のフリーライターと ${tags.length} のタグを収録したプライベート・アーカイブ。`;
      const kpis = [
        { label: '掲載ライター', value: n, unit: '名', note: `${this.prefs.length} 都道府県から` },
        { label: 'タグ', value: tags.length, unit: '件', note: `最多「${tags[0].name}」${tags[0].count}名` },
        { label: '最多エリア', text: topPref, note: `${topN}名・全体の${pct(topN)}%` },
        { label: 'インボイス登録', value: pct(invoice), unit: '%', note: `${invoice}名が登録済`, meter: pct(invoice) },
        { label: '専業ライター', value: pct(full), unit: '%', note: `専業 ${full}名 / 兼業 ${n - full}名`, meter: pct(full) },
        { label: 'SNS掲載', value: pct(sns), unit: '%', note: `${sns}名がSNSを掲載`, meter: pct(sns) },
      ];
      $('#kpis').innerHTML = kpis.map((k, i) => `
        <div class="kpi" style="--i:${i}">
          <p class="kpi-label">${esc(k.label)}</p>
          <p class="kpi-value">${k.text ? esc(k.text) : `<span data-count="${k.value}">${k.value}</span><small>${esc(k.unit)}</small>`}</p>
          <p class="kpi-note">${esc(k.note)}</p>
          ${k.meter != null ? `<div class="kpi-meter"><span style="width:${k.meter}%"></span></div>` : ''}
        </div>`).join('');
      $('#footer-meta').innerHTML = `出典：<a href="${esc(meta.source)}" target="_blank" rel="noopener">ライター名鑑（jobmagazine.jp/meikan）</a> ・ 取得日 ${esc(meta.scrapedAt)} ・ ${n}名 / ${tags.length}タグ`;
      $('#style-seg').innerHTML = [['', 'すべて'], ['専業', '専業'], ['兼業', '兼業']].map(([v, l]) => `<button type="button" data-style="${v}">${l}</button>`).join('');
      $('#invoice-seg').innerHTML = [['', 'すべて'], ['yes', '登録済'], ['no', '未登録']].map(([v, l]) => `<button type="button" data-invoice="${v}">${l}</button>`).join('');
      this.syncLayout();
    },

    countUp() {
      $$('[data-count]').forEach((el) => {
        const target = Number(el.dataset.count);
        if (reduceMotion) { el.textContent = target; return; }
        const t0 = performance.now(), dur = 1400;
        const step = (t) => {
          const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * e);
          if (p < 1) requestAnimationFrame(step);
        };
        el.textContent = '0';
        requestAnimationFrame(step);
      });
    },

    countBy(list, keysOf) {
      const m = new Map();
      for (const w of list) for (const k of keysOf(w)) m.set(k, (m.get(k) || 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1]);
    },

    /* ---------- filters sidebar ---------- */
    renderFilters() {
      const S = this.S, R = this.results, all = this.db.writers;
      // Tags (AND): counts are within the current result set.
      const tagCounts = new Map();
      for (const w of R) for (const t of w.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      const q = norm(S.tagQ);
      let list = this.db.tags.filter((t) => !q || norm(t.name).includes(q));
      list.sort((a, b) => (S.tags.has(b.name) - S.tags.has(a.name)) || ((tagCounts.get(b.name) || 0) - (tagCounts.get(a.name) || 0)) || (b.count - a.count));
      const total = list.length;
      if (!S.tagAll && !q) list = list.slice(0, Math.max(TAG_LIMIT, S.tags.size));
      $('#tag-chips').innerHTML = list.map((t) => {
        const on = S.tags.has(t.name), n = tagCounts.get(t.name) || 0;
        return `<button type="button" class="chip" data-tag="${esc(t.name)}" aria-pressed="${on}" ${!on && !n ? 'disabled' : ''}>${esc(t.name)}<span class="n">${n}</span></button>`;
      }).join('') || '<p class="muted" style="margin:0;font-size:12.5px">該当するタグがありません</p>';
      const more = $('#tag-more');
      more.hidden = Boolean(q) || total <= TAG_LIMIT;
      more.textContent = S.tagAll ? '主なタグだけ表示' : `すべてのタグを表示（${total}件）`;

      // Prefectures (OR within facet): counts ignore the prefecture facet itself.
      const base = all.filter((w) => this.match(w, 'prefs'));
      const pc = new Map();
      base.forEach((w) => pc.set(w.pref, (pc.get(w.pref) || 0) + 1));
      const byRegion = new Map();
      all.forEach((w) => { if (!byRegion.has(w.region)) byRegion.set(w.region, new Set()); byRegion.get(w.region).add(w.pref); });
      $('#pref-groups').innerHTML = this.db.meta.regions.filter((r) => byRegion.has(r)).map((r) => {
        const prefs = this.prefs.filter((p) => byRegion.get(r).has(p));
        const allOn = prefs.every((p) => S.prefs.has(p));
        return `<div class="pref-group">
          <button type="button" class="pref-region" data-region="${esc(r)}" aria-pressed="${allOn}">${esc(r)}</button>
          <div class="chips">${prefs.map((p) => {
            const on = S.prefs.has(p), n = pc.get(p) || 0;
            return `<button type="button" class="chip" data-pref="${esc(p)}" aria-pressed="${on}" ${!on && !n ? 'disabled' : ''}>${esc(p)}<span class="n">${n}</span></button>`;
          }).join('')}</div></div>`;
      }).join('');

      // Services (AND)
      const sc = new Map();
      R.forEach((w) => w.services.forEach((s) => sc.set(s, (sc.get(s) || 0) + 1)));
      $('#service-chips').innerHTML = this.services.map((s) => {
        const on = S.services.has(s), n = sc.get(s) || 0;
        return `<button type="button" class="chip" data-service="${esc(s)}" aria-pressed="${on}" ${!on && !n ? 'disabled' : ''}>${esc(s)}<span class="n">${n}</span></button>`;
      }).join('');

      // Segments
      const styleBase = all.filter((w) => this.match(w, 'style'));
      $$('#style-seg button').forEach((b) => {
        const v = b.dataset.style;
        b.setAttribute('aria-pressed', String(S.style === v));
        const n = v ? styleBase.filter((w) => w.style === v).length : styleBase.length;
        b.textContent = `${v || 'すべて'} ${n}`;
      });
      const invBase = all.filter((w) => this.match(w, 'invoice'));
      $$('#invoice-seg button').forEach((b) => {
        const v = b.dataset.invoice;
        b.setAttribute('aria-pressed', String(S.invoice === v));
        const n = v ? invBase.filter((w) => (v === 'yes') === w.invoice).length : invBase.length;
        b.textContent = `${{ '': 'すべて', yes: '登録済', no: '未登録' }[v]} ${n}`;
      });

      // Links (AND)
      $('#link-chips').innerHTML = LINK_FILTERS.map(([k, label]) => {
        const on = S.links.has(k), n = R.filter((w) => this.hasLink(w, k)).length;
        return `<button type="button" class="chip" data-link="${k}" aria-pressed="${on}" ${!on && !n ? 'disabled' : ''}>${label}<span class="n">${n}</span></button>`;
      }).join('');
      $('#filter-badge').textContent = this.activeCount() || '';
    },

    renderActive() {
      const S = this.S, items = [];
      if (S.q) items.push(['q', '', `検索：${S.q}`]);
      S.tags.forEach((t) => items.push(['tag', t, `#${t}`]));
      S.prefs.forEach((p) => items.push(['pref', p, p]));
      S.services.forEach((s) => items.push(['service', s, s]));
      if (S.style) items.push(['style', '', S.style]);
      if (S.invoice) items.push(['invoice', '', S.invoice === 'yes' ? 'インボイス登録済' : 'インボイス未登録']);
      S.links.forEach((l) => items.push(['link', l, LINK_FILTERS.find(([k]) => k === l)[1]]));
      $('#active-filters').innerHTML = items.length
        ? `<span class="label">条件</span>${items.map(([k, v, l]) => `<button type="button" class="chip chip-x" aria-pressed="true" data-remove="${k}" data-value="${esc(v)}" aria-label="${esc(l)} を解除">${esc(l)}</button>`).join('')}<button type="button" class="link-btn" data-clear-all style="margin:0 0 0 6px">すべて解除</button>`
        : '';
    },

    /* ---------- results ---------- */
    portrait(w, badge = true) {
      const img = w.img
        ? `<img src="${esc(w.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-mono="${esc([...w.name][0] || '名')}">`
        : `<span class="monogram">${esc([...w.name][0] || '名')}</span>`;
      return `<div class="portrait"><div class="portrait-inner">${img}</div>${badge && w.invoice ? '<span class="portrait-badge gold-fill">インボイス登録済</span>' : ''}</div>`;
    },

    renderResults() {
      const R = this.results, n = R.length, total = this.db.writers.length;
      $('#result-count').innerHTML = n === total ? `<b>${n}</b>名 すべて表示中` : `<b>${n}</b>名 / 全${total}名`;
      $('#empty').hidden = n > 0;
      const grid = $('#grid'), tableWrap = $('#table-wrap');
      const isGrid = this.S.layout === 'grid';
      grid.hidden = !isGrid || !n;
      tableWrap.hidden = isGrid || !n;
      $('#sort').value = this.S.sort;
      if (!n) return;
      if (isGrid) {
        grid.innerHTML = R.map((w, i) => {
          const shown = w.tags.slice(0, 4);
          const sns = Object.keys(SNS).filter((k) => w.sns[k]?.length);
          return `<article class="card" tabindex="0" role="button" data-idx="${w.idx}" style="--i:${i}" aria-label="${esc(w.name)}の詳細を開く">
            ${this.portrait(w)}
            <p class="card-area">${esc(w.area || w.pref)}</p>
            <h3 class="card-name">${esc(w.name)}</h3>
            <p class="card-kana">${esc(w.kana)}</p>
            <p class="card-catch">${esc(w.catch)}</p>
            <div class="card-tags">${shown.map((t) => `<span class="tag-mini">${esc(t)}</span>`).join('')}${w.tags.length > 4 ? `<span class="tag-mini more">+${w.tags.length - 4}</span>` : ''}</div>
            <div class="card-foot"><span>${esc(w.style)} ・ 業務${w.services.length}種</span><span class="sns-dots">${sns.map((k) => `<span class="sns-dot" title="${SNS[k].label}">${SNS[k].mark}</span>`).join('')}</span></div>
          </article>`;
        }).join('');
      } else {
        const S = this.S;
        const th = (key, label) => {
          const dirAttr = S.sort === key ? ` data-dir="${(key === 'kana' || key === 'pref') === (S.dir === 1) ? 'asc' : 'desc'}"` : '';
          return `<th scope="col"><button type="button" data-sortkey="${key}"${dirAttr}>${label}</button></th>`;
        };
        $('#table').innerHTML = `<thead><tr>${th('kana', '名前')}${th('pref', '地域')}<th scope="col">業務形態</th><th scope="col">インボイス</th>${th('tags', 'タグ数')}<th scope="col">主なタグ</th>${th('new', 'ID')}</tr></thead>
          <tbody>${R.map((w) => `<tr data-idx="${w.idx}" tabindex="0">
            <td><div class="t-person">${w.img ? `<img src="${esc(w.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-mono="${esc([...w.name][0])}">` : `<span class="t-mono">${esc([...w.name][0])}</span>`}<div><b>${esc(w.name)}</b><small>${esc(w.kana)}</small></div></div></td>
            <td>${esc(w.area || w.pref)}</td><td>${esc(w.style)}</td><td>${w.invoice ? '登録済' : '—'}</td>
            <td class="t-num">${w.tags.length}</td>
            <td class="t-tags">${w.tags.slice(0, 5).map((t) => `<span class="tag-mini">${esc(t)}</span>`).join(' ')}</td>
            <td class="t-num">${esc(w.id || '—')}</td></tr>`).join('')}</tbody>`;
      }
    },

    syncLayout() {
      $$('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === this.S.layout)));
    },

    /* ---------- insights ---------- */
    barChart({ title, note, rows, total, kind, cols2 = false, span2 = false, i }) {
      const max = Math.max(1, ...rows.map((r) => r[1]));
      const S = this.S;
      const pressed = (k) => (kind === 'tag' && S.tags.has(k)) || (kind === 'pref' && S.prefs.has(k)) || (kind === 'service' && S.services.has(k));
      const body = rows.map(([k, v], j) => {
        const attrs = `data-tip="${esc(k)}" data-v="${v}" data-total="${total}"`;
        const inner = `<span class="bar-label">${esc(k)}</span><span class="bar-track"><span class="bar-fill" style="width:${(v / max) * 88}%;--i:${j}"></span><span class="bar-value">${v}</span></span>`;
        return kind
          ? `<button type="button" class="bar-row" data-kind="${kind}" data-key="${esc(k)}" aria-pressed="${pressed(k)}" aria-label="${esc(k)} ${v}名" ${attrs}>${inner}</button>`
          : `<div class="bar-row" tabindex="0" aria-label="${esc(k)} ${v}名" ${attrs}>${inner}</div>`;
      }).join('');
      return `<section class="chart-panel panel${span2 ? ' span-2' : ''}" style="--i:${i}">
        <div class="chart-head"><h2 class="panel-title">${esc(title)}</h2><p>${esc(note)}</p></div>
        <div class="bars${cols2 ? ' cols-2' : ''}">${body || '<p class="muted">データがありません</p>'}</div></section>`;
    },

    renderInsights() {
      const R = this.results, n = R.length, total = this.db.writers.length;
      $('#insights-scope').innerHTML = n === total ? `対象：<b>全${total}名</b>` : `対象：<b>${n}名</b>（現在の絞り込み結果 / 全${total}名）`;
      const regions = this.db.meta.regions.map((r) => [r, R.filter((w) => w.region === r).length]).filter(([, v]) => v);
      const prefs = this.countBy(R, (w) => [w.pref]);
      const services = this.countBy(R, (w) => w.services);
      const cats = this.countBy(R, (w) => w.cats);
      const tags = this.countBy(R, (w) => w.tags).slice(0, 30);
      const pct = (k) => (n ? Math.round((k / n) * 100) : 0);
      const meters = [
        ['専業', R.filter((w) => w.style === '専業').length],
        ['インボイス登録済', R.filter((w) => w.invoice).length],
        ['ポートフォリオ掲載', R.filter((w) => w.portfolio.length).length],
        ...Object.entries(SNS).map(([k, s]) => [`${s.label} 掲載`, R.filter((w) => w.sns[k]?.length).length]),
      ];
      const meterPanel = `<section class="chart-panel panel" style="--i:1">
        <div class="chart-head"><h2 class="panel-title">属性の割合</h2><p>対象ライターに占める割合</p></div>
        <div class="meters">${meters.map(([l, v]) => `<div class="meter-row"><div class="meter-top"><span>${esc(l)}</span><span><b>${pct(v)}%</b> <span class="muted">${v}名</span></span></div><div class="meter" role="img" aria-label="${esc(l)} ${pct(v)}%"><span style="width:${pct(v)}%"></span></div></div>`).join('')}</div></section>`;
      $('#insights').innerHTML = [
        this.barChart({ title: '地域別', note: 'クリックでその地域に絞り込み', rows: regions, total: n, kind: 'region', i: 0 }),
        meterPanel,
        this.barChart({ title: '都道府県別', note: '多い順 ・ クリックで絞り込み', rows: prefs, total: n, kind: 'pref', cols2: true, span2: true, i: 2 }),
        this.barChart({ title: '対応業務', note: 'クリックで絞り込み', rows: services, total: n, kind: 'service', i: 3 }),
        this.barChart({ title: 'ジャンル大分類', note: 'プロフィールの対応ジャンル', rows: cats.slice(0, 14), total: n, i: 4 }),
        this.barChart({ title: '人気タグ TOP 30', note: 'クリックでタグを追加', rows: tags, total: n, kind: 'tag', cols2: true, span2: true, i: 5 }),
      ].join('');
    },

    /* ---------- tag index ---------- */
    renderTagIndex() {
      const S = this.S, q = norm(S.tiQ);
      const list = this.db.tags.filter((t) => !q || norm(t.name).includes(q));
      const max = Math.max(...this.db.tags.map((t) => t.count));
      const sorter = S.tiSort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'ja') : (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja');
      const groups = [...SIDEBAR_CATS.map((c) => [c, list.filter((t) => t.cat === c)]), ['その他のタグ', list.filter((t) => !SIDEBAR_CATS.includes(t.cat))]].filter(([, ts]) => ts.length);
      $('#tag-index-count').textContent = q ? `${list.length}件ヒット` : `全${list.length}タグ`;
      $('#tag-index').innerHTML = groups.map(([name, ts], i) => `
        <section class="tag-group panel${name === 'その他のタグ' ? ' wide' : ''}" style="--i:${i}">
          <h2>${esc(name)}<small>${ts.length}タグ</small></h2>
          <div class="tag-cloud">${ts.sort(sorter).map((t) => `<button type="button" class="chip" data-goto-tag="${esc(t.name)}" style="--w:${Math.sqrt(t.count / max).toFixed(3)}" title="${esc(t.name)}：${t.count}名">${esc(t.name)}<span class="n">${t.count}</span></button>`).join('')}</div>
        </section>`).join('') || '<div class="empty panel"><p class="empty-title">該当するタグがありません</p></div>';
      $$('#tag-index-sort button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === S.tiSort)));
    },

    /* ---------- drawer ---------- */
    openDrawer(idx) {
      const w = this.db.writers[idx];
      if (!w) return;
      this.drawerIdx = idx;
      this.lastFocus = this.lastFocus || document.activeElement;
      const pos = this.results.findIndex((r) => r.idx === idx);
      const byCat = new Map();
      w.cats.forEach((c) => byCat.set(c, []));
      w.genres.forEach(([c, s]) => { if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(s); });
      const tagBtn = (t) => (this.tagInfo.has(t)
        ? `<button type="button" class="chip" data-goto-tag="${esc(t)}">${esc(t)}</button>`
        : `<span class="chip">${esc(t)}</span>`);
      const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
      const links = [
        ...w.portfolio.map(([l, u]) => `<a class="d-link gold-outline" href="${esc(u)}" target="_blank" rel="noopener noreferrer"><span class="sns-dot">◆</span>${esc(l || 'リンク')}<span class="muted">${esc(host(u))}</span></a>`),
        ...Object.entries(SNS).flatMap(([k, s]) => (w.sns[k] || []).map((u) => `<a class="d-link gold-outline" href="${esc(u)}" target="_blank" rel="noopener noreferrer"><span class="sns-dot">${s.mark}</span>${s.label}</a>`)),
      ];
      const kv = [
        ['活動エリア', w.area], ['都道府県', w.pref], ['業務形態', w.style], ['インボイス', w.invoice ? '登録済' : '未登録'],
        ...w.extra, ['掲載ID', w.id || '—'],
      ];
      const d = $('#drawer');
      d.innerHTML = `
        <div class="drawer-bar">
          <span class="pos">${pos >= 0 ? `${pos + 1} / ${this.results.length}` : ''}</span>
          <div class="drawer-nav">
            <button type="button" class="icon-btn gold-outline" data-drawer="prev" aria-label="前のライター" ${pos <= 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m15 6-6 6 6 6"/></svg></button>
            <button type="button" class="icon-btn gold-outline" data-drawer="next" aria-label="次のライター" ${pos < 0 || pos >= this.results.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></button>
            <button type="button" class="icon-btn gold-outline" data-drawer="close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
          </div>
        </div>
        <div class="drawer-body">
          <div class="d-head">
            ${this.portrait(w, false)}
            <div>
              <p class="d-area">◆ ${esc(w.area || w.pref)}</p>
              <h2 class="d-name" id="drawer-name">${esc(w.name)}</h2>
              <p class="d-kana">${esc(w.kana)}</p>
              <div class="d-badges">
                ${w.style ? `<span class="chip">${esc(w.style)}</span>` : ''}
                ${w.invoice ? '<span class="chip" aria-pressed="true">インボイス登録済</span>' : ''}
                <span class="chip">タグ ${w.tags.length}</span>
              </div>
            </div>
          </div>
          ${w.catch ? `<p class="d-catch">${esc(w.catch)}</p>` : ''}
          <section class="d-section"><h3>プロフィール</h3><p class="d-profile">${esc(w.profile)}</p></section>
          ${byCat.size ? `<section class="d-section"><h3>対応ジャンル</h3><dl>${[...byCat].map(([c, subs]) => `<div class="d-genre"><dt>${esc(c)}</dt><dd>${subs.length ? subs.map(tagBtn).join('') : '<span class="muted" style="font-size:12px">—</span>'}</dd></div>`).join('')}</dl></section>` : ''}
          ${w.tags.length ? `<section class="d-section"><h3>掲載タグ</h3><div class="chips">${w.tags.map(tagBtn).join('')}</div></section>` : ''}
          ${w.services.length ? `<section class="d-section"><h3>対応業務</h3><div class="d-services">${w.services.map((s) => `<span class="d-service">${esc(s)}</span>`).join('')}</div></section>` : ''}
          ${w.apps.length ? `<section class="d-section"><h3>対応アプリ</h3><div class="chips">${w.apps.map((a) => `<span class="chip">${esc(a)}</span>`).join('')}</div></section>` : ''}
          <section class="d-section"><h3>基本情報</h3><dl class="d-kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>
          ${links.length ? `<section class="d-section"><h3>リンク</h3><div class="d-links">${links.join('')}</div></section>` : ''}
          <div class="d-cta">
            ${w.contact ? `<a class="gold-fill" href="${esc(w.contact)}" target="_blank" rel="noopener noreferrer">このライターに連絡する</a>` : ''}
            <a class="gold-outline" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">掲載ページを見る ↗</a>
          </div>
        </div>`;
      d.hidden = false;
      $('#drawer-backdrop').hidden = false;
      d.scrollTop = 0;
      document.body.style.overflow = 'hidden';
      $('[data-drawer="close"]', d).focus({ preventScroll: true });
    },
    stepDrawer(delta) {
      const pos = this.results.findIndex((r) => r.idx === this.drawerIdx);
      const next = this.results[pos + delta];
      if (next) this.openDrawer(next.idx);
    },
    closeDrawer() {
      if ($('#drawer').hidden) return;
      $('#drawer').hidden = true;
      $('#drawer-backdrop').hidden = true;
      document.body.style.overflow = '';
      this.drawerIdx = -1;
      this.lastFocus?.focus?.({ preventScroll: true });
      this.lastFocus = null;
    },

    /* ---------- misc ---------- */
    toast(msg) {
      const t = $('#toast');
      t.textContent = msg; t.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
    },
    exportCSV() {
      const rows = [['ID', '名前', 'ふりがな', '都道府県', '活動エリア', '業務形態', 'インボイス', 'キャッチコピー', 'タグ', '対応業務', 'X', 'note', 'Instagram', 'Facebook', 'ポートフォリオ', '連絡フォーム', '掲載ページ']];
      this.results.forEach((w) => rows.push([w.id, w.name, w.kana, w.pref, w.area, w.style, w.invoice ? '登録済' : '', w.catch, w.tags.join(' | '), w.services.join(' | '),
        ...Object.keys(SNS).map((k) => (w.sns[k] || []).join(' | ')), w.portfolio.map(([, u]) => u).join(' | '), w.contact, w.url]));
      const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `writers_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${this.results.length}.csv`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this.toast(`${this.results.length}名分のCSVを書き出しました`);
    },
    route() {
      const v = (location.hash.slice(1) || 'directory');
      this.view = ['directory', 'insights', 'tags'].includes(v) ? v : 'directory';
      $$('.view').forEach((s) => { s.hidden = s.dataset.view !== this.view; });
      $$('.tabs a').forEach((a) => (a.dataset.view === this.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
      if (this.view === 'insights') this.renderInsights();
      if (this.view === 'tags') this.renderTagIndex();
    },
    showTip(el, x, y) {
      const tip = $('#tooltip'), v = Number(el.dataset.v), total = Number(el.dataset.total);
      tip.innerHTML = `<b>${esc(el.dataset.tip)}</b> ${v}名<small>対象の ${total ? ((v / total) * 100).toFixed(1) : 0}%</small>`;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(innerWidth - r.width - 8, Math.max(8, x + 14))}px`;
      tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
    },

    bind() {
      const S = this.S;
      let qTimer;
      $('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value.trim(); this.update(); }, 120); });
      $('#tag-q').addEventListener('input', (e) => { S.tagQ = e.target.value; this.renderFilters(); });
      $('#tag-more').addEventListener('click', () => { S.tagAll = !S.tagAll; this.renderFilters(); });
      $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; S.dir = 1; this.update(); });
      $$('[data-layout]').forEach((b) => b.addEventListener('click', () => { S.layout = b.dataset.layout; store.set('meikan:layout', S.layout); this.syncLayout(); this.renderResults(); }));
      $('#filters-open').addEventListener('click', () => $('#filters').classList.add('is-open'));
      $('#filters-close').addEventListener('click', () => $('#filters').classList.remove('is-open'));
      $('#export-btn').addEventListener('click', () => this.exportCSV());
      $('#relock-btn').addEventListener('click', () => { location.hash = ''; location.reload(); });
      $('#tag-index-q').addEventListener('input', (e) => { S.tiQ = e.target.value; this.renderTagIndex(); });
      $('#tag-index-sort').addEventListener('click', (e) => { const b = e.target.closest('[data-sort]'); if (b) { S.tiSort = b.dataset.sort; this.renderTagIndex(); } });
      addEventListener('hashchange', () => { this.closeDrawer(); this.route(); });

      const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));
      document.addEventListener('click', (e) => {
        const t = e.target;
        let el;
        if ((el = t.closest('[data-tag]'))) { toggle(S.tags, el.dataset.tag); this.update(); }
        else if ((el = t.closest('[data-pref]'))) { toggle(S.prefs, el.dataset.pref); this.update(); }
        else if ((el = t.closest('[data-region]'))) {
          const prefs = this.db.writers.filter((w) => w.region === el.dataset.region).map((w) => w.pref);
          const allOn = prefs.every((p) => S.prefs.has(p));
          prefs.forEach((p) => (allOn ? S.prefs.delete(p) : S.prefs.add(p)));
          this.update();
        }
        else if ((el = t.closest('[data-service]'))) { toggle(S.services, el.dataset.service); this.update(); }
        else if ((el = t.closest('[data-style]'))) { S.style = el.dataset.style; this.update(); }
        else if ((el = t.closest('[data-invoice]'))) { S.invoice = el.dataset.invoice; this.update(); }
        else if ((el = t.closest('[data-link]'))) { toggle(S.links, el.dataset.link); this.update(); }
        else if ((el = t.closest('[data-remove]'))) {
          const { remove: k, value: v } = el.dataset;
          if (k === 'q') { S.q = ''; $('#q').value = ''; }
          else if (k === 'tag') S.tags.delete(v);
          else if (k === 'pref') S.prefs.delete(v);
          else if (k === 'service') S.services.delete(v);
          else if (k === 'style') S.style = '';
          else if (k === 'invoice') S.invoice = '';
          else if (k === 'link') S.links.delete(v);
          this.update();
        }
        else if (t.closest('[data-clear-all]')) { this.clearAll(); this.update(); }
        else if ((el = t.closest('[data-goto-tag]'))) this.filterByTag(el.dataset.gotoTag);
        else if ((el = t.closest('[data-sortkey]'))) {
          const k = el.dataset.sortkey;
          if (S.sort === k) S.dir *= -1; else { S.sort = k; S.dir = 1; }
          this.update();
        }
        else if ((el = t.closest('.bar-row[data-kind]'))) {
          const { kind, key } = el.dataset;
          if (kind === 'region') {
            const prefs = this.db.writers.filter((w) => w.region === key).map((w) => w.pref);
            S.prefs = new Set(prefs);
          } else if (kind === 'pref') toggle(S.prefs, key);
          else if (kind === 'service') toggle(S.services, key);
          else if (kind === 'tag') toggle(S.tags, key);
          $('#tooltip').hidden = true;
          location.hash = '#directory';
          this.update();
          this.toast(`「${key}」で絞り込みました（${this.results.length}名）`);
        }
        else if ((el = t.closest('[data-drawer]'))) {
          const a = el.dataset.drawer;
          if (a === 'close') this.closeDrawer(); else this.stepDrawer(a === 'next' ? 1 : -1);
        }
        else if ((el = t.closest('[data-idx]')) && !t.closest('a')) { this.lastFocus = el; this.openDrawer(Number(el.dataset.idx)); }
        else if (t.id === 'drawer-backdrop') this.closeDrawer();
      });
      document.addEventListener('keydown', (e) => {
        if (!$('#drawer').hidden) {
          if (e.key === 'Escape') this.closeDrawer();
          else if (e.key === 'ArrowRight') this.stepDrawer(1);
          else if (e.key === 'ArrowLeft') this.stepDrawer(-1);
          return;
        }
        if (e.key === 'Escape') $('#filters').classList.remove('is-open');
        const card = e.target.closest?.('[data-idx]');
        if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.lastFocus = card; this.openDrawer(Number(card.dataset.idx)); }
        if (e.key === '/' && !/input|textarea|select/i.test(e.target.tagName) && this.view === 'directory') { e.preventDefault(); $('#q').focus(); }
      });
      // Broken profile images fall back to a monogram.
      document.addEventListener('error', (e) => {
        const img = e.target;
        if (img.tagName === 'IMG' && img.dataset.mono) {
          const span = document.createElement('span');
          span.className = img.closest('.t-person') ? 't-mono' : 'monogram';
          span.textContent = img.dataset.mono;
          img.replaceWith(span);
        }
      }, true);
      // Chart tooltips
      const insights = $('#insights');
      insights.addEventListener('pointermove', (e) => { const r = e.target.closest('.bar-row'); if (r) this.showTip(r, e.clientX, e.clientY); else $('#tooltip').hidden = true; });
      insights.addEventListener('pointerleave', () => { $('#tooltip').hidden = true; });
      insights.addEventListener('focusin', (e) => { const r = e.target.closest('.bar-row'); if (r) { const b = r.getBoundingClientRect(); this.showTip(r, b.left + b.width / 2, b.top); } });
      insights.addEventListener('focusout', () => { $('#tooltip').hidden = true; });
    },
  };

  initLock();
})();
