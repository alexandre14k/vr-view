const WORKER_URL = new URL('worker.js', import.meta.url).href;

class StereoCanvas {
  constructor(canvasEl, onRender) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this._color = '#ffffff';
    this._source = null;
    this.distortionScale = 0.5;

    this._workerSupported = typeof Worker !== 'undefined'
      && typeof OffscreenCanvas !== 'undefined'
      && typeof createImageBitmap !== 'undefined';

    if (this._workerSupported) {
      this._worker = new Worker(WORKER_URL);
      this._worker.onmessage = (e) => this._handleWorkerMessage(e.data);
      this._worker.onerror = (err) => {
        console.error('[stereo-view] worker failed — falling back to an undistorted feed:', err.message || err);
        this._workerSupported = false;
        this._failAllPending(new Error('worker unavailable'));
      };
      this._pending = new Map();
      this._nextRequestId = 0;
    } else {
      console.warn('[stereo-view] Worker/OffscreenCanvas unsupported — falling back to an undistorted feed.');
    }

    this._busy = false;
    this._onRender = onRender || null;

    this._resizeObserver = new ResizeObserver(
      () => this._resize()
    );
    this._resizeObserver.observe(canvasEl);
    this._resize();
  }

  _notifyRender() {
    if (this._onRender) this._onRender();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.redraw();
    }
  }

  _applyLensClip() {
    const { width, height } = this.canvas;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.4;

    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    this.ctx.closePath();
    this.ctx.clip();
  }

  fillSolid(color) {
    this._color = color;
    this._source = null;
    this.redraw();
  }

  drawFrame(source) {
    this._source = source;
    this._color = null;
    this.redraw();
  }

  redraw() {
    if (this._source) {
      this._drawFrame(this._source).catch(err =>
        console.error('[stereo-view] redraw failed:', err));
    } else if (this._color) {
      this._fillSolid(this._color);
    }
  }

  _fillSolid(color) {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return;
    this.ctx.save();
    this._applyLensClip();
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.restore();
  }

  async applyConvexDistortion(source, distortionStrength = null) {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw === 0 || ch === 0 || !this._workerSupported) return null;

    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return null;

    const k = distortionStrength ?? this.distortionScale;
    const bitmap = await createImageBitmap(source);
    const { bitmap: resultBitmap } = await this._requestDistortion(bitmap, cw, ch, k);
    return resultBitmap;
  }

  _requestDistortion(bitmap, cw, ch, k) {
    return new Promise((resolve, reject) => {
      const id = this._nextRequestId++;
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, cw, ch, k, bitmap }, [bitmap]);
    });
  }

  _handleWorkerMessage(msg) {
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    this._pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg);
  }

  _failAllPending(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
  }

  async _drawFrame(source) {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw === 0 || ch === 0) return;

    if (!this._workerSupported) {
      this._drawUndistortedFallback(source);
      return;
    }

    if (this._busy) return;
    this._busy = true;
    try {
      const resultBitmap = await this.applyConvexDistortion(source);
      if (!resultBitmap) return;

      if (resultBitmap.width !== this.canvas.width || resultBitmap.height !== this.canvas.height) {
        resultBitmap.close();
        this._notifyRender();
        return;
      }

      this.ctx.save();
      this._applyLensClip();
      this.ctx.drawImage(resultBitmap, 0, 0);
      this.ctx.restore();
      resultBitmap.close();
      this._notifyRender();
    } catch (err) {
      console.error('[stereo-view] distortion failed:', err);
    } finally {
      this._busy = false;
    }
  }

  _drawUndistortedFallback(source) {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return;

    const scale = Math.max(cw / sw, ch / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    this.ctx.save();
    this._applyLensClip();
    this.ctx.drawImage(source, dx, dy, dw, dh);
    this.ctx.restore();
  }

  blit(bitmap) {
    if (bitmap.width !== this.canvas.width ||
        bitmap.height !== this.canvas.height) return;
    this.ctx.save();
    this._applyLensClip();
    this.ctx.drawImage(bitmap, 0, 0);
    this.ctx.restore();
  }

  destroy() {
    if (this._worker) this._worker.terminate();
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }
}

class FpsMeter {
  constructor() {
    this._frames = 0;
    this._lastTime = performance.now();
    this._value = 0;
  }

  tick() {
    this._frames++;
    const now = performance.now();
    const elapsed = now - this._lastTime;
    if (elapsed >= 500) {
      this._value = (this._frames * 1000) / elapsed;
      this._frames = 0;
      this._lastTime = now;
    }
  }

  get value() {
    return this._value;
  }
}

class StereoViewController {
  constructor(leftCanvasEl, rightCanvasEl, cameraBtn, fpsEl) {
    this._fpsRender = new FpsMeter();
    this._fpsLoop = new FpsMeter();
    this._fpsEl = fpsEl;

    this.left = new StereoCanvas(
      leftCanvasEl, () => this._onRenderTick()
    );
    this.right = new StereoCanvas(rightCanvasEl);
    this.synced = true;
    this.enabled = false;
    this._stream = null;
    this._video = document.createElement('video');
    this._video.setAttribute('playsinline', '');
    this._video.muted = true;
    this._rafId = null;
    this._cameraBtn = cameraBtn;

    this._leftEye = leftCanvasEl.closest('.eye');
    this._rightEye = rightCanvasEl.closest('.eye');

    this._updateCameraButton(true);
  }

  _onRenderTick() {
    this._fpsRender.tick();
    this._refreshFps();
  }

  _refreshFps() {
    if (!this._fpsEl) return;
    const r = this._fpsRender.value.toFixed(0);
    const l = this._fpsLoop.value.toFixed(0);
    this._fpsEl.textContent = `${r} / ${l} fps`;
  }

  async startCamera() {
    if (this._stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('[stereo-view] Camera API unavailable. Use HTTPS or localhost.');
      this.showSolid('#ff0000');
      return;
    }
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this._video.srcObject = this._stream;
      await this._video.play();
      this.enabled = true;
      this._activateCamera();
      this._tick();
    } catch (err) {
      console.error('[stereo-view] camera denied:', err);
      this._stream = null;
      this.showSolid('#ff0000');
    }
  }

  stopCamera() {
    if (this._stream) {
      this._stream.getTracks().forEach(track => track.stop());
      this._stream = null;
    }
    this.enabled = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._deactivateCamera();
  }

  _activateCamera() {
    if (this._leftEye) this._leftEye.classList.add('camera-active');
    if (this._rightEye) this._rightEye.classList.add('camera-active');
    if (this._leftEye) this._leftEye.style.background = 'transparent';
    if (this._rightEye) this._rightEye.style.background = 'transparent';
  }

  _deactivateCamera() {
    if (this._leftEye) this._leftEye.classList.remove('camera-active');
    if (this._rightEye) this._rightEye.classList.remove('camera-active');
    this.showSolid('#ffffff');
  }

  toggleCamera() {
    if (this.enabled) {
      this.stopCamera();
      this._updateCameraButton(false);
    } else {
      this.startCamera();
      this._updateCameraButton(true);
    }
  }

  _updateCameraButton(isOn) {
    if (this._cameraBtn) {
      this._cameraBtn.classList.toggle('is-on', isOn);
    }
  }

  showSolid(color) {
    this.left.fillSolid(color);
    if (this.synced) this.right.fillSolid(color);
  }

  _tick() {
    if (!this.enabled) return;
    this._fpsLoop.tick();
    this._refreshFps();
    this.left.drawFrame(this._video);
    if (this.synced) this.right.drawFrame(this._video);
    this._rafId = requestAnimationFrame(() => this._tick());
  }

  async _tickSynced() {
    if (this._syncBusy) return;
    if (!this.left._workerSupported) {
      this.left.drawFrame(this._video);
      this.right.drawFrame(this._video);
      return;
    }
    this._syncBusy = true;
    try {
      const bitmap = await this.left.applyConvexDistortion(this._video);
      if (!bitmap) return;
      this.left.blit(bitmap);
      this.right.blit(bitmap);
      bitmap.close();
    } catch (err) {
      console.error('[stereo-view] synced draw failed:', err);
    } finally {
      this._syncBusy = false;
    }
  }
}

const Stereo = {
  Fullscreen: {
    async enter() {
      await document.documentElement.requestFullscreen();
    },
    async exit() {
      await document.exitFullscreen();
    },
    async toggle() {
      try {
        if (!document.fullscreenElement) {
          await Stereo.Fullscreen.enter();
        } else {
          await Stereo.Fullscreen.exit();
        }
      } catch (err) {
        console.error('[stereo-view] fullscreen error:', err);
      }
    },
  },
  UI: {
    syncToggleState(toggleBtn, cameraBtn) {
      toggleBtn.classList.toggle('is-on', !!document.fullscreenElement);
      cameraBtn.classList.toggle('is-on', window.__stereoViewController?.enabled);
    },
  },
};

function bindFullscreenButton(fullscreenBtn) {
  fullscreenBtn.addEventListener('click', () => {
    Stereo.Fullscreen.toggle();
  });
}

function bindCameraButton(cameraBtn, controller) {
  cameraBtn.addEventListener('click', () => {
    controller.toggleCamera();
  });
}

function bindKeyboard(controller) {
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyF') {
      Stereo.Fullscreen.toggle();
    } else if (e.code === 'KeyC') {
      controller.toggleCamera();
    } else if (e.code === 'ArrowUp') {
      controller.left.distortionScale = Math.min(1.0, controller.left.distortionScale + 0.1);
      controller.right.distortionScale = controller.left.distortionScale;
    } else if (e.code === 'ArrowDown') {
      controller.left.distortionScale = Math.max(-0.5, controller.left.distortionScale - 0.1);
      controller.right.distortionScale = controller.left.distortionScale;
    }
  });
}

function bindFullscreenSync(fullscreenBtn, cameraBtn) {
  document.addEventListener('fullscreenchange', () => {
    Stereo.UI.syncToggleState(fullscreenBtn, cameraBtn);
  });
}

function init() {
  const leftCanvas = document.getElementById('canvas-left');
  const rightCanvas = document.getElementById('canvas-right');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const cameraBtn = document.getElementById('camera-btn');
  const fpsEl = document.getElementById('fps-counter');

  const controller = new StereoViewController(
    leftCanvas, rightCanvas, cameraBtn, fpsEl
  );

  controller.startCamera();
  bindFullscreenButton(fullscreenBtn);
  bindCameraButton(cameraBtn, controller);
  bindKeyboard(controller);
  bindFullscreenSync(fullscreenBtn, cameraBtn);

  window.__stereoViewController = controller;
}

init();