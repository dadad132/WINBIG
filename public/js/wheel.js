/* Canvas prize wheel. The server decides the result; spinTo() only animates the wheel to it. */
(function () {
  const COLORS = [
    { fill: '#ffc940', text: '#2a1a00' },
    { fill: '#ff3d8b', text: '#ffffff' },
    { fill: '#7c5cff', text: '#ffffff' },
    { fill: '#22b8f0', text: '#ffffff' },
  ];

  class PrizeWheel {
    constructor(container, values) {
      this.container = container;
      this.rotation = 0;
      container.classList.add('wheel');
      container.innerHTML =
        '<div class="wheel-pointer"></div><div class="wheel-rotor"><canvas></canvas></div><div class="wheel-hub">WIN<br>BIG</div>';
      this.rotor = container.querySelector('.wheel-rotor');
      this.canvas = container.querySelector('canvas');
      this.setValues(values);

      const onResize = () => (container.isConnected ? this.draw() : window.removeEventListener('resize', onResize));
      window.addEventListener('resize', onResize);
      if (document.fonts) document.fonts.ready.then(() => this.draw());
    }

    // Short lists are repeated so the wheel always has at least 6 slices (1,2,3,4 -> 1,2,3,4,1,2,3,4).
    setValues(values) {
      const list = values.length ? values : [1];
      this.segments = Array.from({ length: Math.ceil(6 / list.length) }, () => list).flat();
      this.draw();
    }

    draw() {
      const size = this.container.clientWidth || 320;
      const dpr = window.devicePixelRatio || 1;
      const canvas = this.canvas;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = canvas.style.height = size + 'px';

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.translate(size / 2, size / 2);

      const r = size / 2;
      const inner = r - size * 0.06;
      const arc = (Math.PI * 2) / this.segments.length;

      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1b1f4d';
      ctx.fill();

      this.segments.forEach((value, i) => {
        const start = -Math.PI / 2 + i * arc; // slice 0 starts at the top and slices go clockwise
        const color = COLORS[i % COLORS.length];
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, inner, start, start + arc);
        ctx.closePath();
        ctx.fillStyle = color.fill;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.18)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.save();
        ctx.rotate(start + arc / 2);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color.text;
        ctx.font = `800 ${Math.round(size * 0.1)}px Outfit, system-ui, sans-serif`;
        ctx.fillText(`+${value}`, inner - size * 0.05, -size * 0.012);
        ctx.font = `700 ${Math.round(size * 0.032)}px Outfit, system-ui, sans-serif`;
        ctx.fillText(value === 1 ? 'ENTRY' : 'ENTRIES', inner - size * 0.05, size * 0.05);
        ctx.restore();
      });

      // Light bulbs around the rim.
      const bulbs = this.segments.length * 2;
      for (let i = 0; i < bulbs; i++) {
        const a = (i / bulbs) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * (r - size * 0.03), Math.sin(a) * (r - size * 0.03), size * 0.011, 0, Math.PI * 2);
        ctx.fillStyle = i % 2 ? '#ffe9a8' : '#ffffff';
        ctx.fill();
      }
    }

    // Spins until a slice showing `value` stops under the pointer. Resolves when the wheel stops.
    spinTo(value, { duration = 5600, turns = 7 } = {}) {
      const matches = this.segments.map((v, i) => (v === value ? i : -1)).filter((i) => i >= 0);
      const index = matches.length
        ? matches[Math.floor(Math.random() * matches.length)]
        : Math.floor(Math.random() * this.segments.length);

      const sliceDeg = 360 / this.segments.length;
      const jitter = (Math.random() - 0.5) * sliceDeg * 0.6; // don't always stop dead-centre
      const target = (((360 - (index + 0.5) * sliceDeg + jitter) % 360) + 360) % 360;
      const current = ((this.rotation % 360) + 360) % 360;
      this.rotation += turns * 360 + ((target - current + 360) % 360);

      const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 600 : duration;
      this.rotor.style.transition = `transform ${ms}ms cubic-bezier(.12,.68,.08,1)`;
      this.rotor.style.transform = `rotate(${this.rotation}deg)`;
      return new Promise((resolve) => setTimeout(resolve, ms + 100));
    }
  }

  window.PrizeWheel = PrizeWheel;
})();
