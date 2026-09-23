/**
 * Original synthetic practice cases for the annotation workbench.
 *
 * Eight cases are derived from `evals/behavior-v1` and two add identity and
 * citation checks. Everything here was generated while developing this
 * repository (by the AI coding assistant working on the change), not by
 * DeepSeek, Claude or any other model under study, and not by human research
 * participants. Candidate answers are synthetic examples, not measured model
 * output, and no hidden proposed gold is included. Source rows carry no live
 * URL, so bootstrapping never fetches `example.org`.
 */

export interface SeedSource {
  title: string;
  text: string;
  locator: string | null;
}

export interface SeedCandidate {
  origin: string;
  model: string | null;
  notes: string | null;
  claims: string[];
}

export interface SeedCase {
  seedKey: string;
  datasetVersion: string;
  title: string;
  question: string;
  asOf: string;
  badge: string;
  sources: SeedSource[];
  candidates: [SeedCandidate, SeedCandidate];
}

export const PRACTICE_BADGE = '合成练习 · 示例回答 · 待你判断';

const EXAMPLE_ORIGIN = '开发时生成的合成示例';
const EXAMPLE_NOTE = '开发时生成的合成示例，非模型研究实测结果。';

function example(claims: string[]): SeedCandidate {
  return { origin: EXAMPLE_ORIGIN, model: null, notes: EXAMPLE_NOTE, claims };
}

export const PRACTICE_CASES: SeedCase[] = [
  {
    seedKey: 'behavior-v1/beh-001',
    datasetVersion: 'behavior-v1',
    title: '团队成果与个人贡献',
    question: '许岸独立完成了 Lighthouse 吗？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '发布记录（合成）',
        text: 'Lighthouse 由星野团队发布。发布说明写明：许岸负责文档与发布流程；另一位成员负责核心实现。',
        locator: '发布说明 / 贡献分工'
      },
      {
        title: '个人简介（合成）',
        text: '许岸自述：我参与了 Lighthouse 的发布。',
        locator: '简介 / 项目经历'
      }
    ],
    candidates: [
      example([
        '许岸参与了 Lighthouse 的发布流程。',
        'Lighthouse 的核心实现由许岸独立完成。',
        '现有材料只能确认许岸负责文档。'
      ]),
      example([
        '许岸负责文档与发布流程。',
        '核心实现由另一位成员负责。',
        '因此不能称许岸独立完成整个项目。'
      ])
    ]
  },
  {
    seedKey: 'behavior-v1/beh-002',
    datasetVersion: 'behavior-v1',
    title: '计划与已交付的区分',
    question: '叶青的离线工具已经交付了吗？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '作者预告（合成）',
        text: '2026-01-10，叶青表示计划在月底发布离线模式。',
        locator: '公告 / 时间线'
      },
      {
        title: '版本记录（合成）',
        text: '2026-02-03 的版本记录将离线模式列为尚未开放的实验功能。',
        locator: '版本记录 / 功能状态'
      }
    ],
    candidates: [
      example([
        '作者在 2026-01 宣布过离线模式计划。',
        '到 2026-02-03，离线模式仍标注为尚未开放。',
        '因此截至该记录，离线模式尚未交付。'
      ]),
      example([
        '作者宣布过发布计划。',
        '离线模式已经交付并开放使用。',
        '计划宣布即代表功能已可用。'
      ])
    ]
  },
  {
    seedKey: 'behavior-v1/beh-003',
    datasetVersion: 'behavior-v1',
    title: '评论取舍与来源独立',
    question: '公开评论如何评价这份教程？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '读者甲评论（合成）',
        text: '读者甲读完入门部分后评价：示例清楚，但未尝试高级章节。',
        locator: '评论 / 读者甲'
      },
      {
        title: '读者乙评论（合成）',
        text: '读者乙实际运行高级章节后记录：三处命令无法执行。',
        locator: '评论 / 读者乙'
      },
      {
        title: '评论转载（合成）',
        text: '某聚合页转载了读者甲的同一条评价：示例清楚。',
        locator: '聚合页 / 转载'
      }
    ],
    candidates: [
      example([
        '读者甲的肯定只覆盖入门示例。',
        '读者乙在实际运行中报告了高级章节命令问题。',
        '转载与读者甲原评论属于同一来源，不构成第二条独立证据。'
      ]),
      example([
        '读者甲与转载都认为示例清楚，说明好评占多数。',
        '读者乙的反馈可以忽略，因为只有一条。',
        '整体评价可以概括为一致好评。'
      ])
    ]
  },
  {
    seedKey: 'behavior-v1/beh-004',
    datasetVersion: 'behavior-v1',
    title: '先后关系不等于因果',
    question: '差评导致沈若修复了工具吗？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '问题反馈（合成）',
        text: '2026-02-01，一位用户报告导出错误。',
        locator: '反馈 / 2026-02-01'
      },
      {
        title: '发布记录（合成）',
        text: '2026-02-05 发布了修复导出问题的更新，未说明决策原因。',
        locator: '发布记录 / 2026-02-05'
      }
    ],
    candidates: [
      example([
        '问题反馈发生在修复发布之前。',
        '材料没有说明修复是否由该反馈推动。',
        '因此不能断言是差评导致了修复。'
      ]),
      example([
        '反馈早于修复。',
        '时间顺序证明修复是差评直接导致的。',
        '可以确定因果关系。'
      ])
    ]
  },
  {
    // Intentionally calibrated: both answers are factually defensible and
    // differ in how they handle uncertainty and what they recommend next.
    seedKey: 'behavior-v1/beh-005',
    datasetVersion: 'behavior-v1',
    title: '自述投入与可核验记录',
    question: '能确认孟迟投入了六个月研发吗？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '作者采访（合成）',
        text: '孟迟自述：这项工作投入了六个月。',
        locator: '采访 / 自述'
      },
      {
        title: '仓库记录（合成）',
        text: '提供的仓库记录仅覆盖 2026-03-01 至 2026-03-02 的三次提交。',
        locator: '仓库记录 / 时间范围'
      }
    ],
    candidates: [
      example([
        '六个月的投入目前只有作者自述。',
        '三次提交既不足以确认，也不足以否定六个月。',
        '应把这部分标注为未经独立核实。'
      ]),
      example([
        '六个月来自唯一可核对的来源，即作者自述。',
        '在缺少其他记录前，不宜把具体时长当作已核实事实。',
        '需要时间线或第三方记录等独立材料才能采信这个数字。'
      ])
    ]
  },
  {
    seedKey: 'behavior-v1/beh-006',
    datasetVersion: 'behavior-v1',
    title: '新证据应修订旧判断',
    question: '这个工具现在仍然不能导出 CSV 吗？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '旧版文档（合成）',
        text: 'v1 文档：不支持导出 CSV。',
        locator: '文档 v1'
      },
      {
        title: '新版文档（合成）',
        text: 'v2 文档：新增 CSV 导出。',
        locator: '文档 v2'
      },
      {
        title: '版本时间（合成）',
        text: 'v1 发布于 2026-01-01，v2 发布于 2026-03-01；本题时间为 2026-03-02。',
        locator: '版本时间线'
      }
    ],
    candidates: [
      example([
        'v1 不支持 CSV，v2 已支持 CSV。',
        '按 2026-03-02 的时间，应采用 v2 的状态。',
        '所以当前版本可以导出 CSV。'
      ]),
      example([
        'v1 文档写明不支持 CSV。',
        '工具目前仍然不能导出 CSV。',
        '旧版说明仍代表当前功能。'
      ])
    ]
  },
  {
    seedKey: 'behavior-v1/beh-007',
    datasetVersion: 'behavior-v1',
    title: '后来回忆与当时记录',
    question: '周听当时担任项目负责人吗？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '后来回忆（合成）',
        text: '2026-02-15 的访谈中，周听回忆自己在 2020 年领导该项目。',
        locator: '访谈 / 2026-02-15'
      },
      {
        title: '当年名单（合成）',
        text: '2020 年发布名单写明项目负责人是陈予；周听列为协作者。',
        locator: '发布名单 / 2020'
      }
    ],
    candidates: [
      example([
        '2026 年的回忆称周听当时领导项目。',
        '2020 年名单把负责人写为陈予，周听是协作者。',
        '两种来源存在差异，当时角色仍需核实。'
      ]),
      example([
        '访谈回忆确认周听是当时唯一的负责人。',
        '后来的回忆比旧名单更完整。',
        '可以直接确认周听当时的负责人身份。'
      ])
    ]
  },
  {
    // Intentionally calibrated: both answers stay within the evidence and
    // differ in framing and recommended next step.
    seedKey: 'behavior-v1/beh-008',
    datasetVersion: 'behavior-v1',
    title: '资料稀疏时保持未知',
    question: '这些资料能说明程夏的性格和合作风格吗？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '公开主页（合成）',
        text: '程夏发布过一个图表工具，未提供团队协作信息。',
        locator: '主页 / 项目列表'
      },
      {
        title: '项目说明（合成）',
        text: '项目说明介绍安装方法，没有协作过程、交流记录或他人观察。',
        locator: '项目说明 / 安装'
      }
    ],
    candidates: [
      example([
        '可以确认程夏发布过图表工具，并有安装说明。',
        '性格与合作风格缺乏证据，应保持未知。',
        '若需要评价合作风格，应先补充协作记录。'
      ]),
      example([
        '现有材料只能支持公开工具和安装信息。',
        '不能据此评价性格或合作风格。',
        '建议把结论限制在工具本身，并列明还需要哪些证据。'
      ])
    ]
  },
  {
    seedKey: 'identity-citation-v1/idd-001',
    datasetVersion: 'identity-citation-practice-v1',
    title: '身份确认与同名区分',
    question: '目标主页与署名「林野」的同名旧文是同一个人吗？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '目标主页（合成）',
        text: '主页简介写明作者是「林野」，并链接到项目「雾图」。',
        locator: '主页 / 简介与链接'
      },
      {
        title: '项目公告（合成）',
        text: '雾图项目公告署名「林野（@linye-dev）」，并链接回同一目标主页；handle 与主页一致。',
        locator: '公告 / 署名与回链'
      },
      {
        title: '同名旧文（合成）',
        text: '一篇署名「林野」的旧文来自另一个站点，未提及雾图，也没有反向链接。',
        locator: '旧文 / 署名'
      }
    ],
    candidates: [
      example([
        '主页与项目公告互相链接，handle 一致，可以确认两者属于同一个身份。',
        '同名旧文缺少自链或机构指向。',
        '同名旧文应先作为候选，不应直接归属。'
      ]),
      example([
        '三处都署名「林野」，倾向认为是同一人。',
        '姓名一致可以作为线索，但不足以单独建立归属。',
        '需要更多互相指向的证据才能合并。'
      ])
    ]
  },
  {
    seedKey: 'identity-citation-v1/cit-001',
    datasetVersion: 'identity-citation-practice-v1',
    title: '引用独立性与重复来源',
    question: '关于「星轨」发布时间，有几条独立证据？',
    asOf: '2026-03-02',
    badge: PRACTICE_BADGE,
    sources: [
      {
        title: '官方发布（合成）',
        text: '官方公告：星轨于 2025-06-12 发布。',
        locator: '官方公告'
      },
      {
        title: '新闻转载（合成）',
        text: '某科技媒体转述同一份官方公告：星轨于 2025-06-12 发布。',
        locator: '媒体转载'
      },
      {
        title: '独立评测（合成）',
        text: '独立评测者记录自己在 2025-06-20 开始使用星轨，但没有说明发布日期的信息来源。',
        locator: '评测 / 2025-06-20'
      }
    ],
    candidates: [
      example([
        '官方公告给出发布日期 2025-06-12。',
        '媒体转载与官方公告同源，不增加独立证据数。',
        '独立评测没有说明发布日期依据，不能独立证明 2025-06-12。'
      ]),
      example([
        '官方公告与媒体报道都写 2025-06-12，但两者同源。',
        '因此发布时间只能算一条独立证据。',
        '独立评测可以对照使用时间，但不能证明发布日期。'
      ])
    ]
  }
];
