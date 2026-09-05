import crypto from 'crypto';

/**
 * CAPTCHA Service - Lightweight, no external deps by default
 * Supports: math, svg, turnstile (Cloudflare), hcaptcha
 * 
 * Design for low-resource Azure VM:
 * - Math CAPTCHA: 0 deps, just question/answer
 * - SVG CAPTCHA: pure JS SVG generation, no canvas
 * - Turnstile: optional, verifies via Cloudflare API if secret set
 */

class CaptchaService {
  constructor() {
    this.store = new Map(); // id -> { answer, expires, attempts }
    this.cleanupInterval = 5 * 60 * 1000; // 5 min
    this.expiryMs = 5 * 60 * 1000; // 5 min expiry
    this.maxAttempts = 3;

    // Cleanup expired every 5 min. unref() because this is a best-effort
    // sweep: it must never be the reason a Node process stays alive when the
    // real work is finished (a test run, a one-off CLI call that imports the
    // auth routes).
    const cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

    this.type = process.env.CAPTCHA_TYPE || 'math'; // math, svg, turnstile, hcaptcha, disabled
    this.turnstileSecret = process.env.TURNSTILE_SECRET_KEY || '';
    this.hcaptchaSecret = process.env.HCAPTCHA_SECRET_KEY || '';
  }

  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }

  // Math CAPTCHA: simple arithmetic
  generateMathCaptcha() {
    const ops = ['+', '-', '*'];
    const op = ops[Math.floor(Math.random() * ops.length)];
    let a, b, answer, question;

    switch (op) {
      case '+':
        a = Math.floor(Math.random() * 20) + 1;
        b = Math.floor(Math.random() * 20) + 1;
        answer = a + b;
        question = `${a} + ${b} = ?`;
        break;
      case '-':
        a = Math.floor(Math.random() * 30) + 10;
        b = Math.floor(Math.random() * 10) + 1;
        answer = a - b;
        question = `${a} - ${b} = ?`;
        break;
      case '*':
        a = Math.floor(Math.random() * 10) + 2;
        b = Math.floor(Math.random() * 10) + 2;
        answer = a * b;
        question = `${a} × ${b} = ?`;
        break;
    }

    const id = this.generateId();
    this.store.set(id, {
      answer: String(answer),
      expires: Date.now() + this.expiryMs,
      attempts: 0,
      type: 'math'
    });

    return {
      id,
      type: 'math',
      question,
      // For accessibility, we can also provide as text
      // Answer not included - stored server-side
    };
  }

  // SVG CAPTCHA: distorted text
  generateSvgCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid I, O, 0, 1
    let text = '';
    for (let i = 0; i < 6; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const id = this.generateId();
    this.store.set(id, {
      answer: text,
      expires: Date.now() + this.expiryMs,
      attempts: 0,
      type: 'svg'
    });

    // Generate SVG with noise
    const width = 180;
    const height = 60;
    const noiseLines = 5;
    const noiseDots = 30;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
    svg += `<rect width="100%" height="100%" fill="#12121a"/>`;
    
    // Noise lines
    for (let i = 0; i < noiseLines; i++) {
      const x1 = Math.random() * width;
      const y1 = Math.random() * height;
      const x2 = Math.random() * width;
      const y2 = Math.random() * height;
      const color = `rgba(${100 + Math.random()*100}, ${100 + Math.random()*100}, ${200 + Math.random()*55}, 0.3)`;
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1"/>`;
    }

    // Noise dots
    for (let i = 0; i < noiseDots; i++) {
      const cx = Math.random() * width;
      const cy = Math.random() * height;
      const r = Math.random() * 2;
      const color = `rgba(${150 + Math.random()*100}, ${150 + Math.random()*100}, ${255}, 0.4)`;
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
    }

    // Text with random rotations and colors
    const colors = ['#8b5cf6', '#3b82f6', '#a855f7', '#6366f1', '#06b6d4'];
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const x = 15 + i * 26 + Math.random() * 4;
      const y = 35 + Math.random() * 10;
      const rotate = (Math.random() - 0.5) * 30;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const fontSize = 22 + Math.random() * 6;
      svg += `<text x="${x}" y="${y}" font-family="monospace" font-size="${fontSize}" font-weight="bold" fill="${color}" transform="rotate(${rotate} ${x} ${y})">${char}</text>`;
    }

    svg += `</svg>`;

    const base64 = Buffer.from(svg).toString('base64');
    const dataUri = `data:image/svg+xml;base64,${base64}`;

    return {
      id,
      type: 'svg',
      question: 'Enter the characters from the image',
      image: dataUri,
      svg, // raw SVG for debugging
    };
  }

  generate() {
    if (this.type === 'disabled') {
      return { id: 'disabled', type: 'disabled', question: 'CAPTCHA disabled' };
    }

    if (this.type === 'svg') {
      return this.generateSvgCaptcha();
    }

    // Default: math
    return this.generateMathCaptcha();
  }

  verify(id, answer, options = {}) {
    if (this.type === 'disabled') {
      return { success: true, message: 'CAPTCHA disabled' };
    }

    if (!id || !answer) {
      return { success: false, message: 'CAPTCHA ID and answer required' };
    }

    const record = this.store.get(id);
    if (!record) {
      return { success: false, message: 'CAPTCHA expired or invalid ID, please refresh' };
    }

    if (Date.now() > record.expires) {
      this.store.delete(id);
      return { success: false, message: 'CAPTCHA expired, please refresh' };
    }

    if (record.attempts >= this.maxAttempts) {
      this.store.delete(id);
      return { success: false, message: 'Too many attempts, please get new CAPTCHA' };
    }

    record.attempts++;

    const isCorrect = String(answer).trim().toLowerCase() === String(record.answer).trim().toLowerCase();
    
    if (isCorrect) {
      this.store.delete(id);
      return { success: true, message: 'CAPTCHA verified' };
    } else {
      // Don't delete immediately, allow retries up to maxAttempts
      if (record.attempts >= this.maxAttempts) {
        this.store.delete(id);
        return { success: false, message: 'Incorrect CAPTCHA, too many attempts - new CAPTCHA required' };
      }
      return { success: false, message: `Incorrect CAPTCHA, ${this.maxAttempts - record.attempts} attempts left` };
    }
  }

  async verifyTurnstile(token, ip) {
    if (!this.turnstileSecret) {
      return { success: false, message: 'Turnstile not configured' };
    }

    try {
      const formData = new FormData();
      formData.append('secret', this.turnstileSecret);
      formData.append('response', token);
      if (ip) formData.append('remoteip', ip);

      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      return {
        success: data.success,
        message: data.success ? 'Turnstile verified' : `Turnstile failed: ${data['error-codes']?.join(', ')}`,
        data
      };
    } catch (e) {
      return { success: false, message: `Turnstile verification error: ${e.message}` };
    }
  }

  async verifyHcaptcha(token, ip) {
    if (!this.hcaptchaSecret) {
      return { success: false, message: 'hCaptcha not configured' };
    }

    try {
      const params = new URLSearchParams();
      params.append('secret', this.hcaptchaSecret);
      params.append('response', token);
      if (ip) params.append('remoteip', ip);

      const res = await fetch('https://hcaptcha.com/siteverify', {
        method: 'POST',
        body: params
      });

      const data = await res.json();
      return {
        success: data.success,
        message: data.success ? 'hCaptcha verified' : `hCaptcha failed`,
        data
      };
    } catch (e) {
      return { success: false, message: `hCaptcha error: ${e.message}` };
    }
  }

  /**
   * Dispatch on the *configured* provider only.
   *
   * The old shape was `if (type === 'turnstile' && payload.token)`, so a client
   * that simply left `token` out fell through to the local math/SVG check - the
   * operator's chosen provider was skipped because the request said so. A
   * missing token is now a failure for the provider that expects one.
   */
  async verifyWithType(payload, ip) {
    if (this.type === 'turnstile') {
      if (!payload.token) return { success: false, message: 'Missing captcha token' };
      return await this.verifyTurnstile(payload.token, ip);
    }
    if (this.type === 'hcaptcha') {
      if (!payload.token) return { success: false, message: 'Missing captcha token' };
      return await this.verifyHcaptcha(payload.token, ip);
    }
    // math/svg
    return this.verify(payload.id, payload.answer);
  }

  cleanup() {
    const now = Date.now();
    for (const [id, rec] of this.store.entries()) {
      if (now > rec.expires) {
        this.store.delete(id);
      }
    }
  }

  getStats() {
    return {
      type: this.type,
      activeCaptchas: this.store.size,
      expiryMs: this.expiryMs,
      maxAttempts: this.maxAttempts,
      turnstileConfigured: !!this.turnstileSecret,
      hcaptchaConfigured: !!this.hcaptchaSecret,
    };
  }
}

export const captchaService = new CaptchaService();
