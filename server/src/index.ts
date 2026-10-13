import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { connect, closeAll, getDb, getDialectName } from './db/connection';
import { sql } from 'drizzle-orm';
import { connectMongo, closeMongo } from './db/mongodb/connection';
import { errorHandler, notFoundHandler } from './middleware/error';
import { isGroqConfigured } from './utils/groq';
import { env, validateEnv } from './config';
import { isRedisConfigured, checkRedisHealth } from './config/redis';
import { initSentry, sentryErrorHandler } from './config/sentry';
import { helmetMiddleware, configureCors } from './middleware/security';
import { globalRateLimit } from './middleware/rateLimit';
import { requestLogger } from './middleware/logging';
import { sanitizeInput, detectSqlInjection } from './middleware/sanitize';
import { requestId } from './middleware/requestId';
import { cacheMiddleware } from './middleware/cache';
import logger from './utils/logger';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import conversationRoutes, { historyRouter } from './routes/conversation.routes';
import tutorRoutes from './routes/tutor.routes';
import learningRoutes from './routes/learning.routes';
import communityRoutes from './routes/community.routes';
import notificationRoutes from './routes/notification.routes';
import speechRoutes from './routes/speech.routes';
import phraseRoutes from './routes/phrase.routes';
import feedbackRoutes from './routes/feedback.routes';
import gameRoutes from './routes/game.routes';
import achievementRoutes from './routes/achievement.routes';
import vocabularyRoutes from './routes/vocabulary.routes';
import challengeRoutes from './routes/challenge.routes';
import analyticsRoutes from './routes/analytics.routes';
import preservationRoutes from './routes/preservation.routes';
import publicApiRoutes from './routes/publicApi.routes';
import arRoutes from './routes/ar.routes';
import whisperRoutes from './routes/whisper.routes';
import agentRoutes from './routes/agent.routes';
import voiceRoutes from './routes/voice.routes';
import vocabularyIntelligenceRoutes from './routes/vocabulary.routes';
import pronunciationIntelligenceRoutes from './routes/pronunciation.routes';
import recommendationRoutes from './routes/recommendation.routes';
import notificationPreferencesRoutes from './routes/notificationPreferences.routes';
import adminRoutes from './routes/admin.routes';
import { authMiddleware } from './middleware/auth';
import { buildSultiPrompt, buildCharacterPrompt } from './utils/prompts';
import { success, errors } from './utils/apiResponse';

const app = express();

initSentry();

app.use(requestId);
app.use(helmetMiddleware);
app.use(
  cors({
    origin: configureCors,
    allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'X-Request-Id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);
app.use(express.json({ limit: env.MAX_REQUEST_SIZE }));
app.use(sanitizeInput());
app.use(detectSqlInjection);
app.use(requestLogger);
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  globalRateLimit(req, res, next);
});

app.use(
  '/audio/tts',
  express.static(path.join(process.cwd(), env.AUDIO_CACHE_DIR), {
    maxAge: '7d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.mp3') || filePath.endsWith('.wav') || filePath.endsWith('.ogg')) {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      }
    },
  })
);

// Serve static files (favicon, icons) from public folder
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
}));

// Root endpoint - shows server status and quick links
app.get('/', async (_req, res) => {
  const groqConfigured = isGroqConfigured();
  const health: Record<string, any> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    groq: groqConfigured ? 'configured' : 'not_set',
    mode: groqConfigured ? 'api' : 'none',
    database: { status: 'unknown', dialect: getDialectName() },
  };

  try {
    const db = getDb();
    const start = Date.now();
    await db.all(sql`SELECT 1`);
    health.database = { status: 'ok', dialect: getDialectName(), latencyMs: Date.now() - start };
  } catch (error) {
    health.database = {
      status: 'error',
      dialect: getDialectName(),
      error: (error as Error).message,
    };
    health.status = 'degraded';
  }

  const isHealthy = health.status === 'ok';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SultiAI Server</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; color: #e2e8f0; }
    .card { background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 16px; padding: 32px; max-width: 500px; width: 100%; backdrop-filter: blur(12px); }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 8px; background: linear-gradient(90deg, #06b6d4, #a855f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 0.95rem; }
    .status { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 10px; margin-bottom: 20px; background: ${isHealthy ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}; border: 1px solid ${isHealthy ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: ${isHealthy ? '#10b981' : '#ef4444'}; animation: ${isHealthy ? 'pulse 2s infinite' : 'none'}; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .status-text { font-weight: 600; color: ${isHealthy ? '#10b981' : '#ef4444'}; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .item { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.15); border-radius: 10px; padding: 14px; }
    .item-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 4px; }
    .item-value { font-family: 'SF Mono', Monaco, monospace; font-size: 0.85rem; color: #e2e8f0; }
    .links { display: flex; flex-wrap: wrap; gap: 10px; }
    .btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 8px; font-size: 0.85rem; font-weight: 500; text-decoration: none; color: #0f172a; background: linear-gradient(90deg, #06b6d4, #a855f7); transition: transform 0.15s, box-shadow 0.15s; }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(168, 85, 247, 0.4); }
    .btn.secondary { background: rgba(148, 163, 184, 0.15); color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.2); }
    .btn.secondary:hover { background: rgba(148, 163, 184, 0.25); }
    .version { margin-top: 20px; text-align: center; font-size: 0.7rem; color: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <h1>SultiAI Server</h1>
    <p class="subtitle">Bisaya Learning Platform — API Server</p>
    <div class="status">
      <span class="dot"></span>
      <span class="status-text">${isHealthy ? 'Server Healthy' : 'Server Degraded'}</span>
    </div>
    <div class="grid">
      <div class="item"><div class="item-label">Mode</div><div class="item-value">${groqConfigured ? 'API (Groq)' : 'No LLM'}</div></div>
      <div class="item"><div class="item-label">Database</div><div class="item-value">${health.database.dialect} (${health.database.status})</div></div>
      <div class="item"><div class="item-label">Uptime</div><div class="item-value">${Math.floor(process.uptime())}s</div></div>
      <div class="item"><div class="item-label">Environment</div><div class="item-value">${env.NODE_ENV}</div></div>
    </div>
    <div class="links">
      <a class="btn" href="/api/health">Health Check (JSON)</a>
      <a class="btn secondary" href="/api/docs" target="_blank">API Docs</a>
    </div>
    <div class="version">v${require('../package.json').version} • ${new Date().toISOString()}</div>
  </div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/api/health', async (_req, res) => {
  const health: Record<string, any> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    groq: isGroqConfigured() ? 'configured' : 'not_set',
    mode: isGroqConfigured() ? 'api' : 'none',
    redis: isRedisConfigured() ? 'configured' : 'not_set',
    database: { status: 'unknown', dialect: getDialectName() },
  };

  try {
    const db = getDb();
    const start = Date.now();
    await db.all(sql`SELECT 1`);
    health.database = { status: 'ok', dialect: getDialectName(), latencyMs: Date.now() - start };
  } catch (error) {
    health.database = {
      status: 'error',
      dialect: getDialectName(),
      error: (error as Error).message,
    };
    health.status = 'degraded';
  }

  if (isRedisConfigured()) {
    const redisHealth = await checkRedisHealth();
    health.redis = redisHealth;
    if (redisHealth.status === 'error') {
      health.status = 'degraded';
    }
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode);
  success(res, health);
});

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/history', historyRouter);
app.use('/api/tutor', tutorRoutes);
app.use('/api/learning', learningRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/speech', speechRoutes);
app.use('/api/saved-phrases', phraseRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/achievements', achievementRoutes);
app.use('/api/vocabulary', cacheMiddleware({ ttl: 300, keyPrefix: 'vocab' }), vocabularyRoutes);
app.use('/api/challenges', cacheMiddleware({ ttl: 60, keyPrefix: 'challenges' }), challengeRoutes);
app.use('/api/analytics', cacheMiddleware({ ttl: 60, keyPrefix: 'analytics' }), analyticsRoutes);
app.use(
  '/api/preservation',
  cacheMiddleware({ ttl: 120, keyPrefix: 'preservation' }),
  preservationRoutes
);

// Public, key-authenticated developer surface for the app's distinctive
// capabilities. Auth and per-key rate limiting are enforced per route so a
// missing key fails closed rather than falling through to the user JWT path.
app.use('/api', publicApiRoutes);
app.use('/api/ar', arRoutes);
app.use('/api/whisper', whisperRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/v2/vocabulary', vocabularyIntelligenceRoutes);
app.use('/api/v2/pronunciation', pronunciationIntelligenceRoutes);
app.use('/api/v2/recommendations', recommendationRoutes);
app.use('/api/v2/notifications/preferences', notificationPreferencesRoutes);
app.use('/api/admin', adminRoutes);

app.post('/api/assistant/chat', authMiddleware, async (req, res) => {
  try {
    const { message, character } = req.body || {};
    if (!message) {
      errors.validation(res, 'Message is required');
      return;
    }
    const { isConfigured, groqChat } = await import('./utils/groq');
    if (!isConfigured()) {
      errors.aiError(res, 'AI service not configured: set GROQ_API_KEY or enable local LLM model');
      return;
    }
    const systemPrompt = character
      ? buildCharacterPrompt(character, `The learner's native language is English.`)
      : buildSultiPrompt('chat', `The learner's native language is English.`);
    const reply = await groqChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      { temperature: 0.9, maxTokens: 800 }
    );
    success(res, { reply }, 'Chat response generated');
  } catch (err) {
    logger.error('Assistant chat error', { error: (err as Error).message });
    errors.internal(res, 'AI request failed');
  }
});

app.post('/api/groq', authMiddleware, async (req, res) => {
  try {
    const { messages, nativeLanguage } = req.body || {};
    const { isConfigured, groqChat } = await import('./utils/groq');
    if (!isConfigured()) {
      errors.aiError(res, 'AI service not configured: set GROQ_API_KEY or enable local LLM model');
      return;
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      errors.validation(res, 'Messages must be a non-empty array');
      return;
    }
    const systemPrompt = buildSultiPrompt(
      'chat',
      `The learner's native language is ${nativeLanguage || 'English'}.`
    );
    const reply = await groqChat(
      [
        { role: 'system', content: systemPrompt },
        ...messages.map((m: any) => ({
          role: m.type === 'user' ? ('user' as const) : ('assistant' as const),
          content: m.text,
        })),
      ],
      { temperature: 0.8, maxTokens: 600 }
    );
    success(res, { content: reply }, 'Response generated');
  } catch (err) {
    logger.error('Groq error', { error: (err as Error).message });
    errors.internal(res, 'AI request failed');
  }
});

app.use(notFoundHandler);
app.use(sentryErrorHandler());
app.use(errorHandler);

async function start() {
  try {
    validateEnv();
    await connect();
    await connectMongo();

    // Ensure google_id column exists (added in latest migration) — SQLite only
    if (process.env.DB_DIALECT !== 'mysql') {
      try {
        const db = getDb();
        (db as any).$client.exec(`ALTER TABLE users ADD COLUMN google_id TEXT`);
        logger.info('Added google_id column to users table');
      } catch {
        // Column already exists — ignore
      }
    }

    app.listen(env.PORT, '0.0.0.0', () => {
      const baseUrl = `http://localhost:${env.PORT}`;
      logger.info(`Server running on ${baseUrl}`);
      logger.info(`Mode: ${isGroqConfigured() ? 'API (Groq)' : 'No LLM available'}`);
      logger.info(`Environment: ${env.NODE_ENV}`);
      logger.info(`Health check: ${baseUrl}/api/health`);
      logger.info(`Dashboard: ${baseUrl}/`);
      logger.info('Ready to accept connections');
    });
  } catch (err) {
    logger.error('Failed to start server', { error: (err as Error).message });
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: (err as Error).message });
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await closeAll();
  await closeMongo();
  process.exit(0);
});

start();
