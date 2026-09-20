export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Remove any configured secret from a message before it is logged or returned. */
export function scrubSecrets(message: string, secrets: (string | null | undefined)[]): string {
  let scrubbed = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      scrubbed = scrubbed.split(secret).join('[redacted]');
    }
  }
  return scrubbed;
}
