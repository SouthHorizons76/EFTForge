// Hex background animation - v1
// Random per-hex opacity pulses, yellow/amber color, R=48
// To enable: add <canvas id="hex-bg" aria-hidden="true"></canvas> right after <body>,
// add #hex-bg CSS (position:fixed; top:0; left:0; z-index:9990; pointer-events:none;),
// and load this script at the end of <body>.

(function () {
  const canvas = document.getElementById('hex-bg');
  const ctx = canvas.getContext('2d');

  const R        = 48;                        // hex circumradius (px)
  const W_HEX    = Math.sqrt(3) * R;          // pointy-top hex width
  const ROW_H    = R * 1.5;                   // row pitch (3/4 of hex height)
  const MIN_A    = 0.04;                      // min opacity
  const MAX_A    = 0.18;                      // max opacity
  const TICK_MS  = 200;                       // ~5 fps redraw
  const DUR_MIN  = 2500;                      // min anim duration (ms)
  const DUR_MAX  = 7000;                      // max anim duration (ms)
  const CHANCE   = 0.005;                     // per-hex per-tick chance to start a fade

  let hexes = [];
  let resizeTimer;

  function buildGrid() {
    hexes = [];
    const W = canvas.width, H = canvas.height;
    const cols = Math.ceil(W / W_HEX) + 2;
    const rows = Math.ceil(H / ROW_H) + 2;
    for (let r = -1; r < rows; r++) {
      for (let c = -1; c < cols; c++) {
        hexes.push({
          cx: c * W_HEX + (r & 1) * (W_HEX / 2),
          cy: r * ROW_H,
          opacity: MIN_A,
          from: MIN_A,
          target: MIN_A,
          t0: 0,
          dur: 0,
          active: false
        });
      }
    }
  }

  function drawHex(cx, cy, a) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI / 6 + (Math.PI / 3) * i;
      const x = cx + R * Math.cos(ang);
      const y = cy + R * Math.sin(ang);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle   = 'rgba(200,155,40,' + (a * 0.25).toFixed(3) + ')';
    ctx.strokeStyle = 'rgba(200,155,40,' + a.toFixed(3) + ')';
    ctx.fill();
    ctx.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 1.5;
    for (const h of hexes) drawHex(h.cx, h.cy, h.opacity);
  }

  let lastTick = 0;
  function tick(ts) {
    requestAnimationFrame(tick);
    if (ts - lastTick < TICK_MS) return;
    lastTick = ts;

    let dirty = false;
    for (const h of hexes) {
      if (h.active) {
        const p = Math.min(1, (ts - h.t0) / h.dur);
        const e = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p; // ease-in-out
        h.opacity = h.from + (h.target - h.from) * e;
        if (p >= 1) { h.opacity = h.target; h.active = false; }
        dirty = true;
      } else if (Math.random() < CHANCE) {
        h.from   = h.opacity;
        h.target = MIN_A + Math.random() * (MAX_A - MIN_A);
        h.t0     = ts;
        h.dur    = DUR_MIN + Math.random() * (DUR_MAX - DUR_MIN);
        h.active = true;
        dirty    = true;
      }
    }
    if (dirty) redraw();
  }

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    buildGrid();
    redraw();
  }

  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 200);
  });

  resize();
  requestAnimationFrame(tick);
}());
