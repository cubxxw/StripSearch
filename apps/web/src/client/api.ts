import type {
  CanonicalView,
  ProviderName,
  RunEventRecord,
  RunSummary,
  SessionUser
} from '../shared/types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiEnvelope {
  run?: CanonicalView;
  runs?: RunSummary[];
  events?: RunEventRecord[];
  latestSeq?: number;
  idempotent?: boolean;
  changed?: boolean;
  code?: string;
  error?: { code?: string; message?: string };
  message?: string;
}

export interface CreateRunInput {
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
  parentRunId?: string | null;
  retryOf?: string | null;
  followup?: boolean;
}

export interface HealthResponse {
  status: string;
  app: string;
  version: string;
  capabilities: { github: boolean; exa: boolean };
  limits: Record<string, number>;
}

export class ApiClient {
  private requestToken = 0;

  constructor(private readonly baseUrl = '') {}

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {})
      }
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const envelope = (body ?? {}) as ApiEnvelope;
      const code = envelope.error?.code ?? envelope.code ?? `http_${response.status}`;
      const message =
        envelope.error?.message ??
        envelope.message ??
        (typeof body === 'string' && body.length > 0 ? body : '请求失败。');
      throw new ApiError(response.status, String(code), message);
    }
    return body as T;
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/api/health');
  }

  async session(): Promise<{ user: SessionUser; session: { id: string } } | null> {
    try {
      const data = await this.request<{ user?: SessionUser; session?: { id: string } } | null>(
        '/api/auth/get-session'
      );
      if (!data?.user) return null;
      return { user: data.user, session: { id: data.session?.id ?? '' } };
    } catch {
      return null;
    }
  }

  private async authenticate(
    pathname: string,
    payload: Record<string, string>
  ): Promise<{ user: SessionUser }> {
    const data = await this.request<{ user?: SessionUser; error?: { message?: string } }>(pathname, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!data?.user) {
      throw new ApiError(400, 'auth_failed', '登录失败。');
    }
    return { user: data.user };
  }

  signUp(payload: { name: string; email: string; password: string }): Promise<{ user: SessionUser }> {
    return this.authenticate('/api/auth/sign-up/email', payload);
  }

  signIn(payload: { email: string; password: string }): Promise<{ user: SessionUser }> {
    return this.authenticate('/api/auth/sign-in/email', payload);
  }

  async signOut(): Promise<void> {
    await this.request('/api/auth/sign-out', { method: 'POST', body: '{}' });
  }

  async listRuns(): Promise<RunSummary[]> {
    const data = await this.request<{ runs: RunSummary[] }>('/api/runs');
    return data.runs ?? [];
  }

  private nextIdempotencyKey(label: string): string {
    const token = ++this.requestToken;
    return `${label}-${token}-${Date.now().toString(36)}`;
  }

  async createRun(input: CreateRunInput): Promise<{ run: CanonicalView; idempotent: boolean }> {
    const idempotencyKey = this.nextIdempotencyKey('run');
    const data = await this.request<ApiEnvelope>('/api/runs', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input)
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return { run: data.run, idempotent: Boolean(data.idempotent) };
  }

  async getRun(id: string, since = 0): Promise<{ run: CanonicalView; events: RunEventRecord[]; latestSeq: number }> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}?since=${since}&events=1`);
    if (!data.run) throw new ApiError(404, 'run_not_found', '未找到该研究。');
    return { run: data.run, events: data.events ?? [], latestSeq: data.latestSeq ?? 0 };
  }

  async cancelRun(id: string): Promise<CanonicalView> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}'
    });
    if (!data.run) throw new ApiError(404, 'run_not_found', '未找到该研究。');
    return data.run;
  }

  async resumeRun(id: string, seedUrl: string): Promise<CanonicalView> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: JSON.stringify({ seedUrl })
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return data.run;
  }

  async retryRun(id: string): Promise<CanonicalView> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      headers: { 'idempotency-key': this.nextIdempotencyKey('retry') },
      body: '{}'
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return data.run;
  }

  async followup(id: string, question: string): Promise<CanonicalView> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}/followup`, {
      method: 'POST',
      headers: { 'idempotency-key': this.nextIdempotencyKey('followup') },
      body: JSON.stringify({ question })
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return data.run;
  }

  async deleteRun(id: string): Promise<void> {
    await this.request(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async exportRun(id: string, format: 'markdown' | 'json'): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/api/runs/${encodeURIComponent(id)}/export?format=${format}`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) {
      throw new ApiError(response.status, 'export_failed', '导出失败。');
    }
    return response.text();
  }

  async setExclusion(
    id: string,
    sourceKey: string,
    exclude: boolean,
    expectedRevision: number
  ): Promise<{ run: CanonicalView; changed: boolean }> {
    const action = exclude ? 'exclude' : 'restore';
    const data = await this.request<ApiEnvelope>(
      `/api/runs/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceKey)}/${action}`,
      { method: 'POST', body: JSON.stringify({ expectedRevision }) }
    );
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return { run: data.run, changed: Boolean(data.changed) };
  }
}
