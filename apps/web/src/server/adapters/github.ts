import type { AnswerSectionDraft, ObservationDraft, ProviderResult, RunInput, SourceDraft } from '../../shared/types.js';
import { NeedsInputError } from '../../shared/types.js';
import { extractGitHubHandle, isPublicHttpsUrl } from '../../shared/validation.js';
import { asArray, asNumber, asRecord, asString, safeFetchJson } from './http.js';
import { ProviderError } from './types.js';
import type { ProviderContext, ResearchProvider } from './types.js';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_MAX_WORKS = 8;
export const GITHUB_REPOS_PER_PAGE = 30;
export const GITHUB_CAPABILITY_NOTE =
  'GitHub 来源只整理账号与仓库公开元数据，不解释任意问题；问答与整理结果需要配置 Exa。';

export interface GitHubProfile {
  login: string;
  name: string | null;
  bio: string | null;
  company: string | null;
  blog: string | null;
  htmlUrl: string;
  createdAt: string | null;
  publicRepos: number | null;
}

export interface GitHubRepo {
  name: string;
  description: string | null;
  htmlUrl: string;
  homepage: string | null;
  language: string | null;
  pushedAt: string | null;
  fork: boolean;
  archived: boolean;
  topics: string[];
}

function normalizeBlog(raw: string | null): string | null {
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return isPublicHttpsUrl(candidate) ? candidate : null;
}

function accountUrlMatches(url: string, login: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://github.com') return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    if (parsed.search || parsed.hash) return false;
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments.length === 1 && (segments[0] ?? '').toLowerCase() === login.toLowerCase();
  } catch {
    return false;
  }
}

function repoUrlMatches(url: string, owner: string, name: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://github.com') return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    const segments = parsed.pathname.split('/').filter(Boolean);
    return (
      segments.length === 2 &&
      (segments[0] ?? '').toLowerCase() === owner.toLowerCase() &&
      segments[1] === name
    );
  } catch {
    return false;
  }
}

/**
 * Reads only safe public professional fields. Location and email are never
 * parsed, stored or rendered, and the payload must actually describe the
 * requested account.
 */
export function parseGitHubProfile(raw: unknown, expectedLogin: string): GitHubProfile | null {
  const object = asRecord(raw);
  const login = asString(object.login);
  if (!login || login.toLowerCase() !== expectedLogin.toLowerCase()) return null;
  const rawHtmlUrl = asString(object.html_url);
  const htmlUrl = rawHtmlUrl ?? `https://github.com/${encodeURIComponent(login)}`;
  if (!accountUrlMatches(htmlUrl, login)) return null;
  return {
    login,
    name: asString(object.name),
    bio: asString(object.bio),
    company: asString(object.company),
    blog: normalizeBlog(asString(object.blog)),
    htmlUrl: `https://github.com/${login}`,
    createdAt: asString(object.created_at),
    publicRepos: asNumber(object.public_repos)
  };
}

/** Only repositories owned by the requested account are accepted. */
export function parseGitHubRepo(raw: unknown, expectedLogin: string): GitHubRepo | null {
  const object = asRecord(raw);
  const name = asString(object.name);
  const htmlUrl = asString(object.html_url);
  if (!name || !htmlUrl) return null;
  const owner = asRecord(object.owner);
  const ownerLogin = asString(owner.login);
  if (!ownerLogin || ownerLogin.toLowerCase() !== expectedLogin.toLowerCase()) return null;
  if (!repoUrlMatches(htmlUrl, ownerLogin, name)) return null;
  const homepage = normalizeBlog(asString(object.homepage));
  const topics = asArray(object.topics).filter((item): item is string => typeof item === 'string').slice(0, 8);
  const fork = object.fork === true;
  return {
    name,
    description: asString(object.description),
    htmlUrl: `https://github.com/${ownerLogin}/${name}`,
    homepage,
    language: asString(object.language),
    pushedAt: asString(object.pushed_at) ?? asString(object.updated_at),
    fork,
    archived: object.archived === true,
    topics
  };
}

/** Non-forks with at least one meaningful field, most recently pushed first. */
export function selectWorks(repos: GitHubRepo[], max = GITHUB_MAX_WORKS): GitHubRepo[] {
  return repos
    .filter((repo) => !repo.fork)
    .filter((repo) => Boolean(repo.description || repo.homepage || repo.language))
    .sort((a, b) => {
      const left = a.pushedAt ?? '';
      const right = b.pushedAt ?? '';
      if (left === right) return a.name.localeCompare(b.name);
      return right.localeCompare(left);
    })
    .slice(0, max);
}

function formatDate(iso: string | null): string {
  if (!iso) return '时间未标注';
  return iso.slice(0, 10);
}

function buildSources(profile: GitHubProfile, works: GitHubRepo[]): SourceDraft[] {
  const sources: SourceDraft[] = [
    {
      key: 'S1',
      url: profile.htmlUrl,
      title: `${profile.login} · GitHub 公开主页`,
      kind: 'profile',
      publishedAt: null,
      excerpt: profile.bio,
      excerptLocator: profile.bio ? '公开简介' : null,
      identityLabel: '种子账号',
      identityConfirmed: true,
      fetchStatus: 'ok',
      limits: ['资料由账号本人维护，未独立核实。']
    }
  ];
  works.forEach((repo, index) => {
    sources.push({
      key: `S${index + 2}`,
      url: repo.htmlUrl,
      title: `${profile.login}/${repo.name}`,
      kind: 'work',
      publishedAt: repo.pushedAt,
      excerpt: repo.description,
      excerptLocator: repo.description ? '仓库简介' : null,
      identityLabel: '种子账号的公开仓库',
      identityConfirmed: true,
      fetchStatus: 'ok',
      limits: [
        '公开仓库元数据；仓库归属该账号，不代表个人在团队中的具体贡献。',
        ...(repo.archived ? ['仓库已归档。'] : [])
      ]
    });
  });
  return sources;
}

export interface BuildGitHubOptions {
  profile: GitHubProfile;
  works: GitHubRepo[];
  usage: { requests: number; bytes: number };
  repoLimitReached: boolean;
  reposError: string | null;
}

export function buildGitHubResult(options: BuildGitHubOptions): ProviderResult {
  const { profile, works, usage, repoLimitReached, reposError } = options;
  const sources = buildSources(profile, works);
  const observations: ObservationDraft[] = [
    {
      statement: `GitHub 账号 ${profile.login} 的公开资料显示${profile.name ? `姓名为 ${profile.name}` : '未填写姓名'}${profile.bio ? `，自述「${profile.bio}」` : ''}。`,
      kind: 'attributed_statement',
      sourceKeys: ['S1'],
      limitations: ['以上为账号本人维护的自述内容。']
    }
  ];
  works.forEach((repo, index) => {
    observations.push({
      statement: `仓库 ${repo.name} 的公开简介为「${repo.description ?? '无'}」，主要语言 ${repo.language ?? '未标注'}，最近推送 ${formatDate(repo.pushedAt)}。`,
      kind: 'factual',
      sourceKeys: [`S${index + 2}`],
      limitations: ['仅读取仓库元数据，未读取代码。']
    });
  });

  const identityBullets: AnswerSectionDraft['bullets'] = [];
  identityBullets.push(
    profile.name
      ? { text: `公开姓名为 ${profile.name}（GitHub 账号 ${profile.login}）。`, sourceKeys: ['S1'], kind: 'attributed_statement' }
      : { text: `GitHub 账号 ${profile.login} 未填写公开姓名。`, sourceKeys: ['S1'], kind: 'factual' }
  );
  if (profile.bio) identityBullets.push({ text: `自述：${profile.bio}`, sourceKeys: ['S1'], kind: 'attributed_statement' });
  if (profile.company) identityBullets.push({ text: `公开资料中的公司：${profile.company}`, sourceKeys: ['S1'], kind: 'attributed_statement' });
  if (profile.blog) identityBullets.push({ text: `公开主页或博客：${profile.blog}`, sourceKeys: ['S1'], kind: 'attributed_statement' });

  const worksBullets: AnswerSectionDraft['bullets'] = works.map((repo, index) => ({
    text: `${repo.name}：${repo.description ?? '无简介'}（${repo.language ?? '语言未标注'}，最近推送 ${formatDate(repo.pushedAt)}${repo.archived ? '，已归档' : ''}）`,
    sourceKeys: [`S${index + 2}`],
    kind: 'factual'
  }));

  const factsBullets: AnswerSectionDraft['bullets'] = [
    { text: `账号创建于 ${formatDate(profile.createdAt)}。`, sourceKeys: ['S1'], kind: 'factual' }
  ];
  if (profile.publicRepos !== null) {
    factsBullets.push({
      text: `公开仓库计数为 ${profile.publicRepos} 个；本次只读取一页（最多 ${GITHUB_REPOS_PER_PAGE} 个）。`,
      sourceKeys: ['S1'],
      kind: 'factual'
    });
  }

  const languageCounts = new Map<string, number>();
  works.forEach((repo) => {
    if (repo.language) languageCounts.set(repo.language, (languageCounts.get(repo.language) ?? 0) + 1);
  });
  const topLanguages = [...languageCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const explanations: AnswerSectionDraft['bullets'] = [];
  if (works.length >= 2 && topLanguages.length > 0) {
    explanations.push({
      text: `最近更新的仓库集中在 ${topLanguages.slice(0, 3).join('、')}，可能反映近期的工作方向。`,
      sourceKeys: works.map((_, index) => `S${index + 2}`),
      kind: 'inference'
    });
  }

  const unknowns: AnswerSectionDraft['bullets'] = [
    {
      text: repoLimitReached
        ? `只读取了一页公开仓库（最多 ${GITHUB_REPOS_PER_PAGE} 个），可能遗漏较早或未列出的作品。`
        : '只读取了最近更新的公开仓库，可能遗漏较早或未列出的作品。',
      sourceKeys: [],
      kind: 'inference'
    },
    { text: '仓库归属该账号，不能据此判断个人在团队中的具体贡献。', sourceKeys: [], kind: 'inference' },
    { text: '未读取仓库代码，无法判断项目质量或维护持续性。', sourceKeys: [], kind: 'inference' }
  ];
  if (reposError) unknowns.push({ text: reposError, sourceKeys: [], kind: 'inference' });

  const answer: AnswerSectionDraft[] = [
    {
      id: 'identity',
      heading: '这个人是谁',
      body: `以下信息来自 GitHub 账号 ${profile.login} 的公开资料；这是账号与仓库元数据，不是对任意问题的回答。`,
      bullets: identityBullets
    },
    {
      id: 'works',
      heading: '做过什么',
      body:
        works.length > 0
          ? `该账号最近更新的公开仓库（最多 ${GITHUB_MAX_WORKS} 个）：`
          : '没有筛选出可展示的公开仓库。',
      bullets: worksBullets
    },
    { id: 'facts', heading: '查到的事实', body: '以下为公开元数据中可直接核对的事实。', bullets: factsBullets },
    {
      id: 'explanations',
      heading: '可能的解释',
      body: explanations.length > 0 ? '以下为基于公开元数据的解释，不是已核实事实。' : '本次没有足够材料形成解释。',
      bullets: explanations
    },
    { id: 'unknowns', heading: '还不确定', body: '以下内容目前无法确认。', bullets: unknowns }
  ];

  const limitations = [
    ...unknowns.map((bullet) => bullet.text),
    GITHUB_CAPABILITY_NOTE,
    'GitHub 资料为公开元数据；报告不代替对当事人的核实。'
  ];

  return {
    state: works.length === 0 ? 'partial' : 'completed',
    identity: {
      displayName: profile.name ?? profile.login,
      handle: profile.login,
      profileUrl: profile.htmlUrl,
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources,
    observations,
    answer,
    limitations,
    usage,
    stopReason: works.length === 0 ? 'github_profile_only' : 'github_public_metadata'
  };
}

function reportSources(context: ProviderContext, sources: SourceDraft[]): void {
  for (const source of sources) context.report.source(source);
}

export const githubProvider: ResearchProvider = {
  name: 'github',
  available: true,
  async run(input: RunInput, context: ProviderContext): Promise<ProviderResult> {
    const handle = extractGitHubHandle(input.seedUrl) ?? extractGitHubHandle(input.question);
    if (!handle) {
      throw new NeedsInputError('请填写 https://github.com/<用户名> 形式的主页链接，用于确认同名候选。');
    }
    const totalStages = 4;
    context.report.stage(0, totalStages, 'profile', '确认公开账号', 'active');
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'StripSearch-Alpha',
      'x-github-api-version': '2022-11-28'
    };
    if (context.githubToken) headers.authorization = `Bearer ${context.githubToken}`;

    let attempted = 0;
    let bytes = 0;
    attempted += 1;
    const profileResponse = await safeFetchJson({
      transport: context.transport,
      url: `${GITHUB_API_ORIGIN}/users/${encodeURIComponent(handle)}`,
      init: { method: 'GET', headers },
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      maxBytes: context.maxBytes
    });
    bytes += profileResponse.bytes;
    const profile = parseGitHubProfile(profileResponse.json, handle);
    if (!profile) {
      throw new ProviderError('provider_bad_response', 'GitHub 返回的账号资料与请求的用户名不一致。');
    }
    context.report.stage(0, totalStages, 'profile', '确认公开账号', 'done', `已确认 ${profile.login}`);

    context.report.stage(1, totalStages, 'repos', '读取公开仓库', 'active');
    let works: GitHubRepo[] = [];
    let repoLimitReached = false;
    let reposError: string | null = null;
    try {
      attempted += 1;
      const reposResponse = await safeFetchJson({
        transport: context.transport,
        url: `${GITHUB_API_ORIGIN}/users/${encodeURIComponent(handle)}/repos?per_page=${GITHUB_REPOS_PER_PAGE}&sort=updated&direction=desc&type=owner`,
        init: { method: 'GET', headers },
        signal: context.signal,
        timeoutMs: context.timeoutMs,
        maxBytes: context.maxBytes
      });
      bytes += reposResponse.bytes;
      repoLimitReached = asArray(reposResponse.json).length >= GITHUB_REPOS_PER_PAGE;
      const parsed = asArray(reposResponse.json)
        .map((raw) => parseGitHubRepo(raw, profile.login))
        .filter((repo): repo is GitHubRepo => repo !== null);
      works = selectWorks(parsed);
      context.report.stage(1, totalStages, 'repos', '读取公开仓库', 'done', `读取 ${works.length} 个公开作品`);
    } catch (error) {
      if (context.signal.aborted) throw error;
      reposError = '读取公开仓库失败，本次只保留账号资料。';
      context.report.stage(1, totalStages, 'repos', '读取公开仓库', 'error', reposError);
    }

    context.report.stage(2, totalStages, 'assemble', '整理公开事实', 'active');
    const result = buildGitHubResult({
      profile,
      works,
      usage: { requests: attempted, bytes },
      repoLimitReached,
      reposError
    });
    context.report.stage(2, totalStages, 'assemble', '整理公开事实', 'done');
    context.report.stage(3, totalStages, 'limits', '标注限制', 'active');
    reportSources(context, result.sources);
    context.report.stage(3, totalStages, 'limits', '标注限制', 'done', `${result.limitations.length} 条限制`);
    return result;
  }
};
