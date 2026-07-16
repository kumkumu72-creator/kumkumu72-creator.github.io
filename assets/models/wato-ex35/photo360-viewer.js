const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

class Photo360Viewer extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.frameCount = Math.max(1, Number(this.dataset.frameCount) || 36);
    this.basePath = this.dataset.basePath || './assets/models/wato-ex35/360';
    this.frameIndex = modulo(Number(this.dataset.initialFrame) || 0, this.frameCount);
    this.frameInterval = Math.max(80, Number(this.dataset.frameInterval) || 150);
    this.dragPixelsPerFrame = Math.max(4, Number(this.dataset.dragSensitivity) || 10);
    this.image = this.querySelector('img');
    this.loadedFrames = new Set();
    this.pointer = null;
    this.playing = false;
    this.lastFrameTime = 0;

    if (!this.image) throw new Error('Photo360Viewer requires a child img element.');

    this.image.draggable = false;
    this.image.addEventListener('load', () => this.loadedFrames.add(this.frameIndex));
    this.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    this.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.addEventListener('dragstart', (event) => event.preventDefault());

    this.setFrame(this.frameIndex, { force: true });
    this.preloadFrames();

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.hasAttribute('autoplay') && !reduceMotion) this.start();
  }

  disconnectedCallback() {
    this.stop();
  }

  frameUrl(index) {
    return `${this.basePath}/frame-${String(index).padStart(2, '0')}.webp`;
  }

  setFrame(index, { force = false } = {}) {
    const nextIndex = modulo(index, this.frameCount);
    if (!force && nextIndex === this.frameIndex) return;
    this.frameIndex = nextIndex;
    this.image.src = this.frameUrl(nextIndex);
    const angle = Math.round((nextIndex / this.frameCount) * 360) % 360;
    this.style.setProperty('--photo360-progress', `${(nextIndex / (this.frameCount - 1 || 1)) * 100}%`);
    this.dispatchEvent(new CustomEvent('photo360:frame', {
      bubbles: true,
      detail: { index: nextIndex, angle, frameCount: this.frameCount }
    }));
  }

  async preloadFrames() {
    this.setAttribute('aria-busy', 'true');
    let settled = 1;
    const onSettled = () => {
      settled += 1;
      this.dispatchEvent(new CustomEvent('photo360:progress', {
        bubbles: true,
        detail: { loaded: settled, total: this.frameCount }
      }));
      if (settled >= this.frameCount) {
        this.removeAttribute('aria-busy');
        this.dispatchEvent(new CustomEvent('photo360:ready', {
          bubbles: true,
          detail: { frameCount: this.frameCount }
        }));
      }
    };

    for (let index = 0; index < this.frameCount; index += 1) {
      if (index === this.frameIndex) continue;
      const loader = new Image();
      loader.decoding = 'async';
      loader.onload = () => {
        this.loadedFrames.add(index);
        onSettled();
      };
      loader.onerror = onSettled;
      loader.src = this.frameUrl(index);
    }
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.lastFrameTime = 0;
    this.animationFrame = requestAnimationFrame((time) => this.tick(time));
    this.dispatchPlaybackState();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.animationFrame);
    this.dispatchPlaybackState();
  }

  togglePlayback() {
    if (this.playing) this.stop();
    else this.start();
    return this.playing;
  }

  tick(time) {
    if (!this.playing) return;
    if (!this.lastFrameTime || time - this.lastFrameTime >= this.frameInterval) {
      this.setFrame(this.frameIndex + 1);
      this.lastFrameTime = time;
    }
    this.animationFrame = requestAnimationFrame((nextTime) => this.tick(nextTime));
  }

  dispatchPlaybackState() {
    this.dispatchEvent(new CustomEvent('photo360:playback', {
      bubbles: true,
      detail: { playing: this.playing }
    }));
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    this.stop();
    this.pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      frame: this.frameIndex,
      dragged: false
    };
    this.setPointerCapture?.(event.pointerId);
    this.classList.add('is-dragging');
  }

  onPointerMove(event) {
    if (!this.pointer || event.pointerId !== this.pointer.id) return;
    const deltaX = event.clientX - this.pointer.x;
    const deltaY = event.clientY - this.pointer.y;
    if (!this.pointer.dragged && Math.abs(deltaX) < 4 && Math.abs(deltaY) < 4) return;
    this.pointer.dragged = true;
    const frameDelta = Math.trunc(deltaX / this.dragPixelsPerFrame);
    this.setFrame(this.pointer.frame - frameDelta);
  }

  onPointerUp(event) {
    if (!this.pointer || event.pointerId !== this.pointer.id) return;
    this.releasePointerCapture?.(event.pointerId);
    this.pointer = null;
    this.classList.remove('is-dragging');
  }

  onKeyDown(event) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.stop();
      this.setFrame(this.frameIndex + (event.key === 'ArrowLeft' ? -1 : 1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      this.stop();
      this.setFrame(event.key === 'Home' ? 0 : this.frameCount - 1);
    } else if (event.key === ' ') {
      event.preventDefault();
      this.togglePlayback();
    }
  }
}

if (!customElements.get('photo-360-viewer')) {
  customElements.define('photo-360-viewer', Photo360Viewer);
}

export { Photo360Viewer };
