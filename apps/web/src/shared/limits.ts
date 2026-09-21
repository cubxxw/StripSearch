/** Central bounds for request, provider and job limits. */

export const LIMITS = {
  questionMin: 2,
  questionMax: 500,
  seedUrlMax: 2048,
  displayNameMax: 60,
  emailMax: 254,
  passwordMin: 8,
  passwordMax: 128,

  /** JSON bodies for application routes. */
  jsonBodyBytes: 32 * 1024,
  /** Raw bodies for the Better Auth handler, checked before it reads the stream. */
  authBodyBytes: 8 * 1024,

  /** Provider network bounds. */
  providerTimeoutMs: 15_000,
  providerMaxBytes: 512 * 1024,
  githubReposPerPage: 30,
  githubMaxWorks: 8,
  exaResults: 6,
  exaExcerptMax: 1200,
  exaAnswerMax: 4000,

  /** Job scheduling. */
  globalConcurrentJobs: 3,
  userConcurrentJobs: 1,
  maxRunsPerUser: 200,
  startRateWindowMs: 60_000,
  startRateMax: 10,

  ssePollIntervalMs: 400,
  sseHeartbeatMs: 15_000
} as const;

export const SESSION_EXPIRES_SECONDS = 60 * 60 * 24 * 7;
