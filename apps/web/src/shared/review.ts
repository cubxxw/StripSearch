/**
 * Shared annotation-workbench contract.
 *
 * These types and pure helpers are used by the server, the client and the
 * tests. They describe a versioned human-labeling vertical slice. Nothing in
 * here treats a subjective preference as gold, and a case creator's own labels
 * are always single-reviewer exploratory records.
 */

export const REVIEW_SCHEMA_VERSION = 'stripsearch/annotation-export/v1';
export const REVIEW_RUBRIC_VERSION = 1;

export type ClaimLabel = 'supported' | 'contradicted' | 'insufficient' | 'unassessable';
export type Preference = 'a' | 'b' | 'tie' | 'neither' | 'undecidable';
export type ReviewStatus = 'draft' | 'submitted';
export type QueueStatus = 'unreviewed' | 'draft' | 'reviewed';
export type ReasonTag =
  | 'factuality'
  | 'citations'
  | 'coverage'
  | 'counterevidence'
  | 'uncertainty'
  | 'readability';
export type BlindLabel = 'A' | 'B';

export const CLAIM_LABELS: Record<ClaimLabel, string> = {
  supported: '支持',
  contradicted: '矛盾',
  insufficient: '证据不足',
  unassessable: '无法判断'
};

export const PREFERENCE_LABELS: Record<Preference, string> = {
  a: 'A 更好',
  b: 'B 更好',
  tie: '平局',
  neither: '都不好',
  undecidable: '无法判断'
};

export const REASON_TAG_LABELS: Record<ReasonTag, string> = {
  factuality: '事实性',
  citations: '引用',
  coverage: '覆盖',
  counterevidence: '反证',
  uncertainty: '不确定性',
  readability: '可读性'
};

export const QUEUE_STATUS_LABELS: Record<QueueStatus, string> = {
  unreviewed: '未评审',
  draft: '草稿',
  reviewed: '已提交'
};

export const CLAIM_LABEL_ORDER: ClaimLabel[] = [
  'supported',
  'contradicted',
  'insufficient',
  'unassessable'
];

export const PREFERENCE_ORDER: Preference[] = ['a', 'b', 'tie', 'neither', 'undecidable'];

export const REASON_TAG_ORDER: ReasonTag[] = [
  'factuality',
  'citations',
  'coverage',
  'counterevidence',
  'uncertainty',
  'readability'
];

export function isClaimLabel(value: unknown): value is ClaimLabel {
  return typeof value === 'string' && Object.hasOwn(CLAIM_LABELS, value);
}

export function isPreference(value: unknown): value is Preference {
  return typeof value === 'string' && Object.hasOwn(PREFERENCE_LABELS, value);
}

export function isReasonTag(value: unknown): value is ReasonTag {
  return typeof value === 'string' && Object.hasOwn(REASON_TAG_LABELS, value);
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return value === 'draft' || value === 'submitted';
}

export function isQueueStatus(value: unknown): value is QueueStatus {
  return value === 'unreviewed' || value === 'draft' || value === 'reviewed';
}

/** A reviewer must cite at least one evidence ID for these two labels. */
export function labelRequiresEvidence(label: ClaimLabel): boolean {
  return label === 'supported' || label === 'contradicted';
}

export interface ReviewSource {
  sourceId: string;
  title: string;
  text: string;
  locator: string | null;
}

export interface ReviewClaim {
  claimId: string;
  text: string;
}

export interface ReviewCandidate {
  blindLabel: BlindLabel;
  claims: ReviewClaim[];
}

/** Actual, hidden origin metadata for one blind label. */
export interface ReviewProvenance {
  blindLabel: BlindLabel;
  candidateId: string;
  origin: string | null;
  model: string | null;
  notes: string | null;
}

export interface ReviewDecision {
  claimId: string;
  label: ClaimLabel | null;
  evidenceIds: string[];
  note: string | null;
}

export interface ReviewRubric {
  referenceAnswer: string;
  mustInclude: string[];
  mustAvoid: string[];
}

export interface ReviewAnnotationView {
  annotationId: string;
  revision: number;
  status: ReviewStatus;
  actorPseudonymousId: string;
  caseHash: string;
  rubricVersion: number;
  decisions: ReviewDecision[];
  preference: Preference | null;
  rationale: string | null;
  reasonTags: ReasonTag[];
  rubric: ReviewRubric;
  createdAt: string;
}

export interface ReviewCaseDetail {
  caseId: string;
  datasetVersion: string;
  split: 'discovery';
  kind: 'practice' | 'user';
  title: string;
  question: string;
  asOf: string | null;
  badge: string;
  rubricVersion: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  status: QueueStatus;
  latestRevision: number;
  latestStatus: ReviewStatus | null;
  sources: ReviewSource[];
  candidates: ReviewCandidate[];
  claimIds: string[];
  provenance: ReviewProvenance[] | null;
}

export interface ReviewQueueItem {
  caseId: string;
  title: string;
  question: string;
  badge: string;
  kind: 'practice' | 'user';
  status: QueueStatus;
  latestStatus: ReviewStatus | null;
  latestRevision: number;
  sourceCount: number;
  claimCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewProgress {
  total: number;
  reviewed: number;
  draft: number;
  unreviewed: number;
}

export interface ReviewCaseResponse {
  case: ReviewCaseDetail;
  annotation: ReviewAnnotationView | null;
  history: ReviewHistoryEntry[];
}

export interface ReviewHistoryEntry {
  revision: number;
  status: ReviewStatus;
  createdAt: string;
  actorPseudonymousId: string;
}

export interface ReviewInsights {
  generatedFrom: 'submitted-latest-revisions-only';
  note: string;
  caseCounts: ReviewProgress;
  factualLabels: Record<ClaimLabel, number>;
  preferenceCounts: Record<Preference, number>;
  reasonTagCounts: Record<ReasonTag, number>;
}

export interface ReviewAnnotationSaveInput {
  expectedRevision: number;
  status: ReviewStatus;
  decisions: ReviewDecision[];
  preference: Preference | null;
  rationale: string | null;
  reasonTags: ReasonTag[];
  rubric: ReviewRubric;
}

export interface ReviewCandidateSetEntry {
  candidateId: string;
  origin: string | null;
  model: string | null;
  notes: string | null;
  claims: ReviewClaim[];
}

/** The exact immutable content that is hashed; exported so the hash is reproducible. */
export interface ReviewCaseSnapshot {
  datasetVersion: string;
  split: 'discovery';
  kind: 'practice' | 'user';
  title: string;
  question: string;
  asOf: string | null;
  sources: ReviewSource[];
  candidateSet: {
    blindMap: Record<BlindLabel, string>;
    candidates: ReviewCandidateSetEntry[];
  };
}

/**
 * Hash descriptor. `payload` is exactly what was passed to `stableStringify`
 * before SHA-256, so `sha256(stableStringify(payload)) === contentHash`.
 * `stableStringify` sorts object keys, keeps array order, ignores `undefined`
 * values and emits compact JSON without whitespace.
 */
export interface ReviewHashDescriptor {
  algorithm: 'sha256';
  serialization: 'stableStringify';
  contentHash: string;
  payload: ReviewCaseSnapshot;
}

export interface ReviewExportRecord {
  schemaVersion: string;
  case: {
    caseId: string;
    datasetVersion: string;
    split: 'discovery';
    kind: 'practice' | 'user';
    title: string;
    question: string;
    asOf: string | null;
    badge: string;
    rubricVersion: number;
    contentHash: string;
    createdAt: string;
    sources: ReviewSource[];
    candidates: ReviewCandidate[];
    blindMapping: Record<BlindLabel, string>;
    provenance: ReviewProvenance[];
    hash: ReviewHashDescriptor;
  };
  annotation: ReviewAnnotationView | null;
  /** Complete append-only revision list, oldest first, with full decisions/rubric. */
  revisions: ReviewAnnotationView[];
  history: ReviewHistoryEntry[];
  reviewer: {
    pseudonymousId: string;
    humanSingleReview: true;
  };
  eligibility: {
    accepted: boolean;
    basis: 'human_single_review';
    reason: string;
  };
}

export interface ReviewExportEnvelope {
  schemaVersion: string;
  exportedAt: string;
  reviewer: {
    pseudonymousId: string;
    humanSingleReview: true;
  };
  filter: 'all' | 'reviewed';
  records: ReviewExportRecord[];
}

export interface ReviewSearchQuery {
  q: string;
  status: 'all' | QueueStatus;
}

/** Flatten a case's candidate claims into a single lookup list. */
export function caseClaims(detail: {
  candidates: ReviewCandidate[];
}): ReviewClaim[] {
  return detail.candidates.flatMap((candidate) => candidate.claims);
}

export function caseClaimIds(detail: { candidates: ReviewCandidate[] }): string[] {
  return caseClaims(detail).map((claim) => claim.claimId);
}

export function caseSourceIds(detail: { sources: ReviewSource[] }): string[] {
  return detail.sources.map((source) => source.sourceId);
}

export function emptyDecision(claimId: string): ReviewDecision {
  return { claimId, label: null, evidenceIds: [], note: null };
}

export function emptyRubric(): ReviewRubric {
  return { referenceAnswer: '', mustInclude: [], mustAvoid: [] };
}

/** Split a textarea value into bounded, de-duplicated, non-empty lines. */
export function splitLines(raw: string, maxItems: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= maxItems) break;
  }
  return result;
}

export interface AnnotationIssue {
  code: string;
  message: string;
}

/**
 * Pure validation shared by the client (fast feedback) and the server (the
 * authority). `submit` adds the completeness requirements that a draft may
 * skip. Evidence and claim IDs must belong to the case; identity is never
 * accepted from the payload.
 */
export function validateAnnotationShape(
  detail: { sources: ReviewSource[]; candidates: ReviewCandidate[]; claimIds: string[] },
  input: Pick<ReviewAnnotationSaveInput, 'status' | 'decisions' | 'preference' | 'rationale' | 'reasonTags'>,
  options: { submit?: boolean } = {}
): AnnotationIssue[] {
  const issues: AnnotationIssue[] = [];
  const submit = options.submit === true || input.status === 'submitted';
  const sourceIds = new Set(caseSourceIds(detail));
  const claimIdList = detail.claimIds.length > 0 ? detail.claimIds : caseClaimIds(detail);
  const claimIdSet = new Set(claimIdList);
  const decisions = Array.isArray(input.decisions) ? input.decisions : [];
  const seen = new Map<string, ReviewDecision>();

  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object') {
      issues.push({ code: 'invalid_decision', message: '判断记录格式不正确。' });
      continue;
    }
    if (typeof decision.claimId !== 'string' || !claimIdSet.has(decision.claimId)) {
      issues.push({ code: 'unknown_claim', message: `存在不属于该案例的论断：${String(decision.claimId)}` });
      continue;
    }
    if (seen.has(decision.claimId)) {
      issues.push({ code: 'duplicate_claim', message: `论断被重复判断：${decision.claimId}` });
      continue;
    }
    seen.set(decision.claimId, decision);
    if (typeof decision.label !== 'string' && decision.label !== null) {
      issues.push({ code: 'invalid_label', message: '判断标签类型不正确。' });
      continue;
    }
    if (decision.label !== null && !isClaimLabel(decision.label)) {
      issues.push({ code: 'invalid_label', message: `未知判断标签：${String(decision.label)}` });
      continue;
    }
    const rawEvidence = (decision as { evidenceIds?: unknown }).evidenceIds;
    if (!Array.isArray(rawEvidence)) {
      issues.push({ code: 'invalid_evidence_list', message: '证据列表必须是数组。' });
      continue;
    }
    const evidenceSeen = new Set<string>();
    let evidenceMalformed = false;
    for (const evidenceId of rawEvidence) {
      if (typeof evidenceId !== 'string' || !sourceIds.has(evidenceId)) {
        issues.push({ code: 'unknown_evidence', message: `存在不属于该案例的证据 ID：${String(evidenceId)}` });
        evidenceMalformed = true;
        continue;
      }
      if (evidenceSeen.has(evidenceId)) {
        issues.push({ code: 'duplicate_evidence', message: `证据被重复选择：${evidenceId}` });
      }
      evidenceSeen.add(evidenceId);
    }
    if (evidenceMalformed) continue;
    if (decision.label && labelRequiresEvidence(decision.label) && evidenceSeen.size === 0) {
      issues.push({ code: 'evidence_required', message: '支持或矛盾必须至少选择一条证据。' });
    }
  }

  if (submit) {
    for (const claimId of claimIdList) {
      const decision = seen.get(claimId);
      if (!decision || decision.label === null) {
        issues.push({ code: 'claim_unlabeled', message: '提交前每个论断都必须有判断。' });
        break;
      }
    }
    if (!isPreference(input.preference)) {
      issues.push({ code: 'preference_required', message: '提交前必须选择一个偏好。' });
    }
    if (typeof input.rationale !== 'string' || input.rationale.trim().length === 0) {
      issues.push({ code: 'rationale_required', message: '提交前必须填写判断理由。' });
    }
  } else if (input.preference !== null && input.preference !== undefined && !isPreference(input.preference)) {
    issues.push({ code: 'invalid_preference', message: '未知偏好选项。' });
  }
  return issues;
}
