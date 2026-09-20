import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { SESSION_EXPIRES_SECONDS } from '../shared/limits.js';
import type { AppConfig } from './config.js';
import type { DB } from './db/index.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Better Auth owns password hashing and sessions. This module only constrains
 * the signup payload and pins the cookie / session / rate-limit policy.
 */
export function createAuth(db: DB, config: AppConfig) {
  return betterAuth({
    appName: 'StripSearch',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: db,
    trustedOrigins: config.allowedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128
    },
    session: {
      expiresIn: SESSION_EXPIRES_SECONDS,
      updateAge: 60 * 60 * 24
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 10 }
      }
    },
    advanced: {
      cookiePrefix: 'stripsearch',
      useSecureCookies: false,
      // Migrations are applied explicitly on boot (db/migrate.ts), so runtime
      // schema validation would only log a false mismatch during init.
      database: { validateSchema: false },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/'
      }
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const name = typeof user.name === 'string' ? user.name.trim() : '';
            if (name.length < 1 || name.length > 60) {
              throw new APIError('BAD_REQUEST', { message: '显示名称需为 1–60 个字符。' });
            }
            const email = typeof user.email === 'string' ? user.email.trim() : '';
            if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) {
              throw new APIError('BAD_REQUEST', { message: '邮箱格式不正确。' });
            }
            return { data: { ...user, name, email } };
          }
        }
      }
    }
  });
}

export type Auth = ReturnType<typeof createAuth>;
