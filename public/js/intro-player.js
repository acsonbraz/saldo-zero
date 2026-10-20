/* Saldo Zero · player da abertura ("trailer").
 * Lê /intro/intro.json  {"slides":[{"file":"slide-1.svg","caption":"texto","ms":3500},...],"music":"/audio/intro-samba.mp3"}
 * e mostra cada SVG inline (com as animações CSS internas), legenda em faixa de telejornal, crossfade, barra de
 * progresso por slide, um único botão "Pular" (avança uma cena por toque; no último slide, entra no jogo) e Som.
 * Avança sozinho pelo "ms" de cada slide; pausa com a aba oculta. prefers-reduced-motion: sem animação nem
 * crossfade, mas os slides aparecem. Sem intro.json (ou com erro), chama onDone(false) na hora.
 * API: window.IntroPlayer.play({ onDone(shown), sound: bool, onSound(on) })  ·  IntroPlayer.active() */
(function () {
  var BASE = '/intro/';
  var MIN_MS = 1200, MAX_MS = 15000, DEF_MS = 3500;
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cur = null;

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ico(n) { return '<svg class="i" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; }

  function loadJSON() {
    return fetch(BASE + 'intro.json').then(function (r) { if (!r.ok) throw new Error('sem intro'); return r.json(); }).then(function (d) {
      var slides = (d && Array.isArray(d.slides) ? d.slides : []).filter(function (x) { return x && /^[\w.-]+\.svg$/.test(String(x.file || '')); })
        .map(function (x) { var ms = Number(x.ms) || DEF_MS; return { file: x.file, caption: String(x.caption || '').slice(0, 220), ms: Math.min(MAX_MS, Math.max(MIN_MS, ms)) }; });
      if (!slides.length) throw new Error('intro vazia');
      return slides;
    });
  }
  /* SVG do próprio site, injetado inline (mesmo esquema de /scenes/home-scenes.js); por higiene, tira <script> e on*. */
  function loadSlide(file) {
    return fetch(BASE + file).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (txt) {
      var wrap = document.createElement('div');
      wrap.className = 'intro-slide'; wrap.setAttribute('aria-hidden', 'true');
      wrap.innerHTML = txt;
      wrap.querySelectorAll('script,foreignObject').forEach(function (n) { n.remove(); });
      wrap.querySelectorAll('*').forEach(function (n) { [].slice.call(n.attributes).forEach(function (a) { if (/^on/i.test(a.name)) n.removeAttribute(a.name); }); });
      var svg = wrap.querySelector('svg');
      if (!svg) return null;
      svg.removeAttribute('role'); svg.setAttribute('focusable', 'false');
      if (!svg.getAttribute('preserveAspectRatio')) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      return wrap;
    }).catch(function () { return null; });
  }

  function play(opts) {
    opts = opts || {};
    var done = typeof opts.onDone === 'function' ? opts.onDone : function () {};
    if (cur) return;
    var finished = false, prevFocus = document.activeElement;
    var state = { i: -1, slides: [], els: [], timer: null, left: 0, startedAt: 0, paused: false };
    cur = state;

    var root = document.createElement('div');
    root.className = 'intro' + (reduced ? ' rm' : '');
    root.id = 'introScreen';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Abertura do Saldo Zero');
    root.innerHTML =
      '<div class="intro-top"><div class="intro-bars" aria-hidden="true"></div>' +
      '<div class="intro-row"><span class="intro-live">' + ico('sirene') + 'AO VIVO</span><span class="intro-count" aria-hidden="true"></span>' +
      '<button type="button" class="intro-sound" aria-pressed="false">' + ico('mudo') + '<span>Som</span></button></div></div>' +
      '<div class="intro-stage"></div>' +
      '<div class="intro-cap" aria-live="polite"><b>PLANTÃO</b><p></p></div>' +
      '<div class="intro-ctl"><button type="button" class="big intro-next">Pular</button></div>';
    var stage = root.querySelector('.intro-stage'), cap = root.querySelector('.intro-cap p'), bars = root.querySelector('.intro-bars'),
      count = root.querySelector('.intro-count'), btnNext = root.querySelector('.intro-next'), btnSound = root.querySelector('.intro-sound');

    function renderSound(on) { btnSound.setAttribute('aria-pressed', on ? 'true' : 'false'); btnSound.innerHTML = ico(on ? 'som' : 'mudo') + '<span>' + (on ? 'Som ligado' : 'Ativar som') + '</span>'; }
    renderSound(!!opts.sound);
    btnSound.onclick = function () { var on = btnSound.getAttribute('aria-pressed') !== 'true'; renderSound(on); if (opts.onSound) opts.onSound(on); if (on && window.GameAudio) GameAudio.intro(); };

    function close(shown) {
      if (finished) return; finished = true;
      clearTimeout(state.timer);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVis);
      if (window.GameAudio) GameAudio.stopIntro(500);
      root.classList.add('out');
      setTimeout(function () { root.remove(); }, reduced ? 0 : 260);
      cur = null;
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
      done(shown);
    }
    function schedule(ms) {
      clearTimeout(state.timer); state.left = ms; state.startedAt = Date.now();
      if (!state.paused) state.timer = setTimeout(next, ms);
    }
    function onVis() {
      if (document.hidden) { state.paused = true; clearTimeout(state.timer); state.left = Math.max(0, state.left - (Date.now() - state.startedAt)); root.classList.add('paused'); }
      else if (state.paused) { state.paused = false; root.classList.remove('paused'); schedule(state.left); }
    }
    function show(i) {
      var s = state.slides[i]; if (!s) return close(true);
      state.i = i;
      var el = state.els[i];
      [].forEach.call(stage.children, function (c) { c.classList.toggle('on', c === el); });
      if (el && !el.parentNode) { stage.appendChild(el); void el.offsetWidth; el.classList.add('on'); }
      cap.textContent = s.caption;
      root.querySelector('.intro-cap').hidden = !s.caption;
      count.textContent = (i + 1) + '/' + state.slides.length;
      [].forEach.call(bars.children, function (b, k) { b.className = k < i ? 'done' : k === i ? 'run' : ''; b.style.setProperty('--d', s.ms + 'ms'); });
      btnNext.setAttribute('aria-label', i === state.slides.length - 1 ? 'Pular: entrar no jogo' : 'Pular para a próxima cena');
      schedule(s.ms);
    }
    function next() {
      var j = state.i + 1;
      if (j >= state.slides.length) return close(true);
      if (state.els[j]) return show(j);
      // slide ainda carregando: espera até 2,5 s; se falhar, pula para o seguinte
      var t0 = Date.now();
      (function wait() {
        if (finished) return;
        if (state.els[j]) return show(j);
        if (state.els[j] === null || Date.now() - t0 > 2500) { state.i = j; return next(); }
        state.timer = setTimeout(wait, 120);
      })();
    }
    function onKey(e) {
      if (e.key === 'Escape' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); clearTimeout(state.timer); next(); } // mesmo efeito do Pular
      else if (e.key === 'Tab') { // foco preso nos dois botões
        var f = [btnSound, btnNext], k = f.indexOf(document.activeElement);
        e.preventDefault(); f[(k + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    }
    btnNext.onclick = function () { clearTimeout(state.timer); next(); };

    loadJSON().then(function (slides) {
      state.slides = slides;
      bars.innerHTML = slides.map(function () { return '<i></i>'; }).join('');
      slides.forEach(function (s, k) { state.els[k] = undefined; loadSlide(s.file).then(function (el) { state.els[k] = el; }); });
      return loadSlide(slides[0].file);
    }).then(function (first) {
      if (finished) return;
      if (!first) throw new Error('slide 1 indisponível');
      state.els[0] = first;
      document.body.appendChild(root);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('visibilitychange', onVis);
      if (opts.sound && window.GameAudio) GameAudio.intro();
      show(0);
      btnNext.focus({ preventScroll: true });
    }).catch(function () { if (!finished) { finished = true; cur = null; done(false); } });
  }

  window.IntroPlayer = { play: play, active: function () { return !!cur; } };
})();
