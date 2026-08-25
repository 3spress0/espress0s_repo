import { captchaService } from '../services/captchaService.js';

export async function captchaRoutes(fastify) {
  // Generate CAPTCHA
  fastify.get('/captcha', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const captcha = captchaService.generate();
    
    // Don't expose answer, only question/image/id
    const { answer, ...safe } = captcha;
    
    return {
      ...safe,
      expiresIn: 300, // 5 min
      message: captcha.type === 'math' ? 'Solve the math problem' : 
               captcha.type === 'svg' ? 'Enter characters from image' :
               captcha.type === 'disabled' ? 'CAPTCHA disabled' : 'Complete CAPTCHA',
    };
  });

  // Verify CAPTCHA (standalone endpoint for testing)
  fastify.post('/captcha/verify', async (request, reply) => {
    const { id, answer, token } = request.body || {};
    
    const result = await captchaService.verifyWithType({ id, answer, token }, request.ip);
    
    if (result.success) {
      return result;
    } else {
      return reply.code(400).send(result);
    }
  });

  // Stats (admin or public)
  fastify.get('/captcha/stats', async (request, reply) => {
    return captchaService.getStats();
  });

  // Config info
  fastify.get('/captcha/config', async (request, reply) => {
    return {
      type: process.env.CAPTCHA_TYPE || 'math',
      types: {
        math: 'Simple math question (0 deps, low resource)',
        svg: 'Distorted text image (pure SVG, no canvas)',
        turnstile: 'Cloudflare Turnstile (requires TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY)',
        hcaptcha: 'hCaptcha (requires HCAPTCHA_SECRET_KEY and HCAPTCHA_SITE_KEY)',
        disabled: 'No CAPTCHA (not recommended for production)',
      },
      env: {
        CAPTCHA_TYPE: process.env.CAPTCHA_TYPE || 'math',
        TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY ? 'Set (hidden)' : 'Not set',
        TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY ? 'Set (hidden)' : 'Not set',
        HCAPTCHA_SITE_KEY: process.env.HCAPTCHA_SITE_KEY ? 'Set (hidden)' : 'Not set',
        HCAPTCHA_SECRET_KEY: process.env.HCAPTCHA_SECRET_KEY ? 'Set (hidden)' : 'Not set',
      },
      frontend: {
        math: 'Shows question like "5 + 3 = ?" and input',
        svg: 'Shows SVG image data URI and input',
        turnstile: 'Embed Cloudflare Turnstile widget, send token',
        hcaptcha: 'Embed hCaptcha widget, send token',
      }
    };
  });
}
