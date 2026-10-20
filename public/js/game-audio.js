/* Saldo Zero · gerenciador de áudio (Web Audio).
 * - Um único AudioContext, criado/retomado só depois de um gesto do usuário (política de autoplay).
 * - Arquivos buscados sob demanda (fetch + decodeAudioData) e guardados em memória; nada é baixado na instalação.
 * - Música com fade in/out por GainNode (no iOS, HTMLAudioElement.volume é somente leitura).
 * - Tudo obedece a GameAudio.setEnabled(on), ligado ao botão Som do jogo. Aba oculta: contexto suspenso.
 * API: window.GameAudio = { context(), unlock(), setEnabled(on), scene(name), intro(), stopIntro(ms), sfx(key), defeat() }
 *   scene: 'home' | 'game' | 'end'  (tema toca só em 'game')
 * Arquivos (contrato com o EDITOR): /audio/intro-samba.mp3, tema-bossa.mp3, sirene.mp3, derrota.mp3 */
(function () {
  var FILES = { intro: '/audio/intro-samba.mp3', tema: '/audio/tema-bossa.mp3', sirene: '/audio/sirene.mp3', derrota: '/audio/derrota.mp3' };
  var VOL = { intro: 0.7, tema: 0.2, sirene: 0.45, derrota: 0.6 };
  var FADE = 900;            // ms do fade da música
  var SFX_COOLDOWN = 15000;  // a sirene não se repete em sequência rápida
  var ctx = null, master = null, enabled = false, current = 'home';
  var buffers = {}, loading = {}, music = {}, lastSfx = {};

  function context() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; }
      if (ctx) { master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination); }
    }
    return ctx;
  }
  function unlock() { var c = context(); if (c && c.state === 'suspended' && !document.hidden) c.resume().catch(function () {}); }

  function load(key) {
    if (buffers[key]) return Promise.resolve(buffers[key]);
    if (loading[key]) return loading[key];
    var c = context(); if (!c) return Promise.resolve(null);
    loading[key] = fetch(FILES[key]).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then(function (ab) { return new Promise(function (res, rej) { c.decodeAudioData(ab, res, rej); }); })
      .then(function (buf) { buffers[key] = buf; return buf; })
      .catch(function () { delete loading[key]; return null; }); // arquivo ausente: silêncio, o jogo segue
    return loading[key];
  }

  function ramp(g, to, ms) {
    var t = ctx.currentTime; g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(to, t + Math.max(0.01, ms / 1000));
  }
  /* Música (tema/intro): um canal por chave; play é idempotente. */
  function playMusic(key, loop) {
    if (!enabled || !context()) return Promise.resolve(false);
    unlock();
    var m = music[key];
    if (m && m.playing) { ramp(m.gain, VOL[key], FADE); return Promise.resolve(true); }
    var token = {}; music[key] = { playing: true, token: token, gain: null, src: null };
    return load(key).then(function (buf) {
      var cur = music[key];
      if (!buf || !cur || cur.token !== token || !enabled) { if (cur && cur.token === token) cur.playing = false; return false; }
      var g = ctx.createGain(); g.gain.value = 0; g.connect(master);
      var src = ctx.createBufferSource(); src.buffer = buf; src.loop = !!loop; src.connect(g);
      src.onended = function () { if (music[key] && music[key].src === src) music[key].playing = false; };
      src.start(); cur.gain = g; cur.src = src; ramp(g, VOL[key], FADE);
      return true;
    });
  }
  function stopMusic(key, ms) {
    var m = music[key]; if (!m) return;
    m.playing = false; m.token = null;
    if (m.src && m.gain && ctx) {
      var src = m.src; ramp(m.gain, 0, ms == null ? FADE : ms);
      setTimeout(function () { try { src.stop(); } catch (e) {} }, (ms == null ? FADE : ms) + 60);
    }
    m.src = null;
  }
  function stopAll(ms) { Object.keys(music).forEach(function (k) { stopMusic(k, ms); }); }

  function sfx(key) {
    if (!enabled || !context()) return;
    var now = Date.now();
    if (lastSfx[key] && now - lastSfx[key] < SFX_COOLDOWN) return;
    lastSfx[key] = now; unlock();
    load(key).then(function (buf) {
      if (!buf || !enabled) return;
      var g = ctx.createGain(); g.gain.value = VOL[key] || 0.5; g.connect(master);
      var src = ctx.createBufferSource(); src.buffer = buf; src.connect(g); src.start();
    });
  }

  function scene(name) {
    current = name;
    if (name === 'game') { stopMusic('intro', 400); stopMusic('derrota', 400); playMusic('tema', true); }
    else stopMusic('tema');
  }
  function defeat() {
    current = 'end'; stopMusic('tema', 300);
    if (enabled) playMusic('derrota', false);
  }
  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) { stopAll(250); return; }
    if (!ctx) return; // sem gesto ainda: o contexto nasce no primeiro unlock()/play
    unlock();
    if (current === 'game') playMusic('tema', true);
  }

  document.addEventListener('visibilitychange', function () {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(function () {});
    else if (enabled) ctx.resume().catch(function () {});
  });

  window.GameAudio = {
    context: context, unlock: unlock, setEnabled: setEnabled, scene: scene, sfx: sfx, defeat: defeat,
    intro: function () { return playMusic('intro', false); },
    stopIntro: function (ms) { stopMusic('intro', ms); },
    get enabled() { return enabled; },
    _state: function () { var o = {}; Object.keys(music).forEach(function (k) { o[k] = !!(music[k] && music[k].playing); }); return { enabled: enabled, scene: current, music: o, sfx: Object.assign({}, lastSfx) }; }
  };
})();
