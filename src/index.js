class StereoCanvas {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this._color = '#ffffff';
    this._source = null;

    this._tempCanvas = document.createElement('canvas');
    this._tempCtx = this._tempCanvas.getContext('2d');

    this._resizeObserver = new ResizeObserver(
      () => this._resize()
    );
    this._resizeObserver.observe(canvasEl);
    this._resize();

    this.distortionScale = 0.5;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;

      this._tempCanvas.width = w;
      this._tempCanvas.height = h;

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
      this._drawFrame(this._source);
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

  applyConvexDistortion(source, distortionStrength = null) {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw === 0 || ch === 0) return this._tempCtx.createImageData(cw, ch);

    const k = distortionStrength ?? this.distortionScale;

    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;

    if (!sw || !sh) {
      return this._tempCtx.createImageData(cw, ch);
    }

    const scale = Math.max(cw / sw, ch / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    this._tempCtx.clearRect(0, 0, cw, ch);
    this._tempCtx.drawImage(source, dx, dy, dw, dh);

    const srcData = this._tempCtx.getImageData(0, 0, cw, ch);
    const srcPixels = srcData.data;

    const output = this._tempCtx.createImageData(cw, ch);
    const dstPixels = output.data;

    const halfW = cw / 2;
    const halfH = ch / 2;
    const invHalfW = 1.0 / halfW;
    const invHalfH = 1.0 / halfH;

    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {

        const nx = (x - halfW) * invHalfW;
        const ny = (y - halfH) * invHalfH;

        const rSq = nx * nx + ny * ny;

        const factor = 1.0 + k * rSq;

        const sx = nx / factor * halfW + halfW;
        const sy = ny / factor * halfH + halfH;

        const six = Math.floor(sx);
        const siy = Math.floor(sy);

        if (six >= 0 && six < cw && siy >= 0 && siy < ch) {
          const si = (siy * cw + six) * 4;
          const di = (y * cw + x) * 4;
          dstPixels[di]     = srcPixels[si];     // R
          dstPixels[di + 1] = srcPixels[si + 1]; // G
          dstPixels[di + 2] = srcPixels[si + 2]; // B
          dstPixels[di + 3] = srcPixels[si + 3]; // Alpha
        } else {
          const di = (y * cw + x) * 4;
          dstPixels[di] = 0;
          dstPixels[di + 1] = 0;
          dstPixels[di + 2] = 0;
          dstPixels[di + 3] = 255;
        }
      }
    }

    this._tempCtx.putImageData(output, 0, 0);

    return output;
  }

  _drawFrame(source) {
    const distortedData = this.applyConvexDistortion(source);

    this._tempCtx.putImageData(distortedData, 0, 0);

    this.ctx.save();
    this._applyLensClip();
    this.ctx.drawImage(this._tempCanvas, 0, 0);
    this.ctx.restore();
  }
}

class StereoViewController {
  constructor(leftCanvasEl, rightCanvasEl, cameraBtn) {
    this.left = new StereoCanvas(leftCanvasEl);
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
    this.left.drawFrame(this._video);
    if (this.synced) this.right.drawFrame(this._video);
    this._rafId = requestAnimationFrame(() => this._tick());
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

  const controller = new StereoViewController(
    leftCanvas, rightCanvas, cameraBtn
  );

  controller.startCamera();
  bindFullscreenButton(fullscreenBtn);
  bindCameraButton(cameraBtn, controller);
  bindKeyboard(controller);
  bindFullscreenSync(fullscreenBtn, cameraBtn);

  window.__stereoViewController = controller;
}

init();