#!/usr/bin/env node
// tools/site/build.mjs — 静态站点构建：生成 _site/（首页 + 34 个章节页 + 检索页 + 静态资源）。
// 用法：node tools/site/build.mjs [输出目录]   默认输出 _site/
// 与仓库其它构建一样不维护文件名单：章节从 README 里 book/ 链接的出现顺序推导，
// 章节号、条目、成本标签全部解析自 book/*.md 原文，正文一字不改。
// 输出目录交给 Cloudflare Pages（构建命令 node tools/site/build.mjs，输出目录 _site）。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ROOT, REPO, SITE, TITLE, read, buildStamp } from '../lib/book.mjs';
import { esc, inline, plainText, renderBlocks, setHrefResolver, setXrefSplit } from './render.mjs';

const OUT = resolve(ROOT, process.argv[2] ?? '_site');
const STAMP = buildStamp();
const TODAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date());
const BOOK_URL = SITE;

/* ---------- 章节清单与问题表 ---------- */
const readme = read('README.md');
const files = [...new Set(Array.from(readme.matchAll(/\]\((book\/[^)]+\.md)\)/g), m => m[1]))];
if (!files.length) throw new Error('README 里没找到 book/ 链接，章节清单是空的');

// 「这本书想回答的问题」表格：一个问题指到一节，做章节卡片的副题。
const qTable = {};
{
  const from = readme.indexOf('## 这本书想回答的问题');
  const to = readme.indexOf('## 怎么读');
  const seg = from >= 0 && to > from ? readme.slice(from, to) : '';
  for (const m of seg.matchAll(/^\|\s*(.+?)\s*\|\s*\[[^\]]+\]\(book\/(.+?)\.md\)\s*\|$/gm)) {
    qTable[m[2]] = m[1].replace(/[|*`]/g, '').trim();
  }
}

/* ---------- 解析章节 ---------- */
const FIELD_KEYS = { 成本: 'cost', 说人话: 'human', 收益: 'gain', 证据等级: 'grade', 来源: 'src', 备注: 'note' };
const GRADE_TEXT = {
  A: 'A 级：有具体数字可查，出处是荟萃分析、大型队列或随机分组试验（RCT）',
  B: 'B 级：有研究支持，但难量化或样本小',
  C: 'C 级：作者经验或公认做法，没有直接研究文献',
};
const TAG_LABELS = {
  money: { '0': '不花钱', '少': '花小钱', '多': '花钱多' },
  time: { '少': '顺手', '中': '几小时', '多': '每天占用' },
  will: { '否': '不用毅力', '些': '要一点毅力', '是': '要很多毅力' },
  level: { '大': '收益：大', '中': '收益：中', '小': '收益：小' },
};

function parseChapter(md) {
  const lines = md.split(/\r?\n/);
  let num = 0, title = '';
  const intro = [], groups = [], blocks = [];
  let cur = null, lastField = null, started = false;
  const flushItem = () => { if (cur) { blocks.push({ t: 'item', item: cur }); cur = null; lastField = null; } };
  for (const raw of lines) {
    const ln = raw.trimEnd();
    if (!ln || /^\[← 回总目录\]/.test(ln)) continue;
    let m;
    if ((m = /^# (\d+)\. (.+)$/.exec(ln))) { num = +m[1]; title = m[2].trim(); continue; }
    if (/^## /.test(ln)) { started = true; flushItem(); blocks.push({ t: 'sub', text: ln.replace(/^##\s+/, '').trim() }); continue; }
    if ((m = /^### (\d+)\. (.+)$/.exec(ln))) {
      started = true; flushItem();
      cur = { n: +m[1], title: m[2].trim(), cost: '', human: '', gain: '', grade: '', src: '', note: '', tags: {} };
      continue;
    }
    if (cur) {
      if ((m = /^<!--\s*成本标签:\s*(.*?)\s*-->/.exec(ln))) {
        for (const kv of m[1].split(/\s+/)) {
          const [k, v] = kv.split('=');
          if (k === '钱') cur.tags.money = v; else if (k === '时间') cur.tags.time = v;
          else if (k === '毅力') cur.tags.will = v; else if (k === '收益') cur.tags.level = v;
          else if (k === '口径') cur.tags.lens = v;
        }
        continue;
      }
      if ((m = /^- (成本|说人话|收益|证据等级|来源|备注)：?\s*(.*)$/.exec(ln))) {
        const key = FIELD_KEYS[m[1]];
        const val = m[2].trim();
        // 证据等级只取 A/B/C（与检索页 parseReadme 一致），「（争议）」等后缀单独记账
        if (key === 'grade') {
          const gm = /^([ABC])(.*)$/.exec(val);
          cur.grade = gm ? gm[1] : val;
          if (gm && gm[2] && /争议/.test(gm[2])) cur.disputeTag = true;
        } else {
          cur[key] = (cur[key] ? cur[key] + '\n' : '') + val;
        }
        lastField = key;
        continue;
      }
      // 续行和其它少见格式并进上一个字段，保证原文一字不丢
      if (lastField) cur[lastField] += '\n' + ln.trim();
      continue;
    }
    if (started) { blocks.push({ t: 'para', text: ln }); continue; }
    // 正文开始前的导览分组行：**路上**：系安全带（第 1 条），……
    const gm = /^\*\*([^*]+)\*\*[:：]\s*(.*)$/.exec(ln);
    if (gm) groups.push({ label: gm[1].trim(), text: gm[2].trim() });
    else intro.push(ln);
  }
  flushItem();
  return { num, title, intro, groups, blocks };
}

const chapters = [];
for (const f of files) {
  const md = read(f);
  const ch = parseChapter(md);
  if (!ch.num || !ch.title) throw new Error(`${f} 解析不到章节标题（# N. 标题）`);
  ch.file = f;
  ch.slug = f.replace(/^book\//, '').replace(/\.md$/, '');
  ch.question = qTable[ch.slug] ?? '';
  ch.items = ch.blocks.filter(b => b.t === 'item').map(b => b.item);
  for (const it of ch.items) {
    it.dispute = it.disputeTag || /^争议/.test(it.note);
    it.todo = /待核实|TODO/.test(it.src + it.gain + it.note + it.cost);
  }
  ch.gradeCounts = { A: 0, B: 0, C: 0 };
  for (const it of ch.items) if (ch.gradeCounts[it.grade] !== undefined) ch.gradeCounts[it.grade]++;
  chapters.push(ch);
}
chapters.sort((a, b) => a.num - b.num);
const byNum = new Map(chapters.map(c => [c.num, c]));
const itemCount = chapters.reduce((s, c) => s + c.items.length, 0);
const gradeTotal = { A: 0, B: 0, C: 0 };
for (const c of chapters) for (const k of 'ABC') gradeTotal[k] += c.gradeCounts[k];
const disputeCount = chapters.reduce((s, c) => s + c.items.filter(i => i.dispute).length, 0);
const srcUrls = new Set();
for (const c of chapters) for (const it of c.items)
  for (const m of it.src.matchAll(/https?:\/\/[^\s<>)\]）;，。]+/g)) srcUrls.add(m[0].replace(/[),.]+$/, ''));

/* ---------- 链接解析：站内相对链接 -> 站内路径 ---------- */
function resolveSiteHref(u) {
  if (/^(https?:|mailto:|#)/.test(u)) return u;
  const [path, frag] = u.split('#');
  const clean = (path || '').replace(/^(\.\.?\/)+/, '');
  let base;
  if (clean === '' || clean === 'README.md' || clean === 'index.html') base = '/';
  else {
    const bm = /^book\/(.+)\.md$/.exec(clean);
    if (bm) base = '/book/' + bm[1] + '/';
    else base = '/' + clean;
  }
  return base + (frag ? '#' + frag : '');
}
setHrefResolver(resolveSiteHref);

/* ---------- 交叉引用：第N条 / 第X节第N条 / 第X节（规则与检索页 xrefKeys 一致：目标存在才链） ---------- */
function makeXrefSplit(ch) {
  const itemSet = new Set(ch.items.map(i => i.n));
  const re = /第\s*(\d+)\s*节\s*第\s*(\d+)\s*条|本节第\s*(\d+)\s*条|第\s*(\d+)\s*条|第\s*([\d、]+)\s*节/g;
  return text => {
    const res = []; re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      let href = null;
      if (m[1] && m[2]) {
        const t = byNum.get(+m[1]);
        if (t && t.items.some(i => i.n === +m[2])) href = '/book/' + t.slug + '/#item-' + m[2];
      } else if ((m[3] && itemSet.has(+m[3])) || (m[4] && itemSet.has(+m[4]))) {
        href = '#item-' + (m[3] ?? m[4]);
      } else if (m[5]) {
        const secs = String(m[5]).split('、').map(x => x.trim()).filter(x => byNum.has(+x));
        if (secs.length) href = '/book/' + byNum.get(+secs[0]).slug + '/';
      }
      if (href) res.push({ start: m.index, end: m.index + m[0].length, href });
    }
    return res;
  };
}

/* ---------- 渲染工具 ---------- */
function fieldHtml(s) { return s.split('\n').filter(x => x.trim()).map(l => inline(l)).join('<br>'); }
function truncate(s, n) { return plainText(s).length > n ? plainText(s).slice(0, n) + '…' : plainText(s); }
const fmt = (html, map) => html.replace(/@(\w+)@/g, (m, k) => (k in map ? map[k] : m));

function badgesHtml(it) {
  const b = [];
  if (it.tags.money) b.push(`<span class="badge">钱：<b>${esc(TAG_LABELS.money[it.tags.money] ?? it.tags.money)}</b></span>`);
  if (it.tags.time) b.push(`<span class="badge">时间：<b>${esc(TAG_LABELS.time[it.tags.time] ?? it.tags.time)}</b></span>`);
  if (it.tags.will) b.push(`<span class="badge">毅力：<b>${esc(TAG_LABELS.will[it.tags.will] ?? it.tags.will)}</b></span>`);
  if (it.tags.level) b.push(`<span class="badge">${esc(TAG_LABELS.level[it.tags.level] ?? '收益：' + it.tags.level)}</span>`);
  if (it.tags.lens) b.push(`<span class="badge">口径：<b>${esc(it.tags.lens)}</b></span>`);
  if (it.grade) b.push(`<span class="badge b-grade${it.grade === 'A' ? '' : ' b-' + it.grade}">${esc(it.grade)} 级证据</span>`);
  if (it.dispute) b.push('<span class="badge b-dispute">争议</span>');
  if (it.todo) b.push('<span class="badge">待核实</span>');
  return b.join('');
}

function itemHtml(ch, it) {
  const fields = [];
  if (it.human) fields.push(`<div class="human"><span class="fl">说人话</span>${fieldHtml(it.human)}</div>`);
  const rows = [];
  if (it.cost) rows.push(`<dt>成本</dt><dd>${fieldHtml(it.cost)}</dd>`);
  if (it.gain) rows.push(`<dt>收益</dt><dd>${fieldHtml(it.gain)}</dd>`);
  if (it.grade) rows.push(`<dt>证据等级</dt><dd class="grade${it.grade}">${esc(GRADE_TEXT[it.grade] ?? it.grade)}</dd>`);
  if (it.src) rows.push(`<dt>来源</dt><dd>${fieldHtml(it.src)}</dd>`);
  if (it.note) rows.push(`<dt>备注</dt><dd>${fieldHtml(it.note)}</dd>`);
  return `<article class="item" id="item-${it.n}">
<div class="item-h"><span class="no">第 ${it.n} 条</span><h2>${inline(it.title)}</h2></div>
<div class="badges">${badgesHtml(it)}</div>
<div class="fields">${fields.join('\n')}<dl>${rows.join('\n')}</dl></div>
</article>`;
}

/* ---------- 渲染章节页 ---------- */
const chapterTpl = readFileSync(resolve(ROOT, 'site/chapter.template.html'), 'utf8');
const nextOf = (i) => chapters[i + 1] ?? null;
const prevOf = (i) => chapters[i - 1] ?? null;
const chHref = ch => 'book/' + ch.slug + '/';
const chUrl = ch => BOOK_URL + chHref(ch);

for (let i = 0; i < chapters.length; i++) {
  const ch = chapters[i];
  const prev = prevOf(i), next = nextOf(i);
  setXrefSplit(makeXrefSplit(ch));
  const firstP = ch.intro.find(x => x.trim()) ?? '';
  const desc = (truncate(firstP, 150) || ch.question || ch.title) + ' 来自《高性价比人生指南》：每条写明成本、收益、证据等级和原始出处。';
  const introHtml = renderBlocks(ch.intro.join('\n')).html;
  const guideHtml = ch.groups.length
    ? `<div class="guide"><h2>本节导览</h2><ul>${ch.groups.map(g => `<li><b>${inline(g.label)}</b>：${inline(g.text)}</li>`).join('')}</ul></div>`
    : '';
  const itemsHtml = [];
  for (const b of ch.blocks) {
    if (b.t === 'sub') itemsHtml.push(`<h2 class="ch-sub" id="sub-${itemsHtml.length}">${inline(b.text)}</h2>`);
    else if (b.t === 'para') itemsHtml.push(`<p>${inline(b.text)}</p>`);
    else itemsHtml.push(itemHtml(ch, b.item));
  }
  const tocHtml = ch.items.map(it => `<li><a href="#item-${it.n}">${it.n}. ${esc(it.title)}</a></li>`).join('');
  const posLinks = [];
  posLinks.push(prev ? `上一节 <a href="/${chHref(prev)}">${esc(prev.title)}</a>` : `第一节 · 回到<a href="${BOOK_URL}">首页</a>`);
  posLinks.push(next ? `下一节 <a href="/${chHref(next)}">${esc(next.title)}</a>` : `最后一节 · 回到<a href="${BOOK_URL}">首页</a>`);
  const pagerCell = (dir, target, label, title) => target
    ? `<a class="${dir}" href="${target}"><div class="p-l">${label}</div><div class="p-t">${title}</div></a>`
    : `<a class="${dir}" href="${BOOK_URL}"><div class="p-l">${label === '上一节' ? '已到第一节' : '已到最后一节'}</div><div class="p-t">回到首页 · 高性价比人生指南</div></a>`;
  const articleJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: TITLE, item: BOOK_URL },
          { '@type': 'ListItem', position: 2, name: '全部章节', item: BOOK_URL + '#chapters' },
          { '@type': 'ListItem', position: 3, name: ch.num + '. ' + ch.title },
        ],
      },
      {
        '@type': 'Article',
        headline: ch.num + '. ' + ch.title,
        description: desc,
        inLanguage: 'zh-CN',
        url: chUrl(ch),
        license: 'https://creativecommons.org/licenses/by/4.0/',
        isPartOf: { '@type': 'Book', name: TITLE, url: BOOK_URL },
        mainEntityOfPage: { '@type': 'WebPage', '@id': chUrl(ch) },
      },
    ],
  });
  const html = fmt(chapterTpl, {
    TITLE: ch.num + '. ' + ch.title + ' · ' + TITLE,
    DESC: esc(desc),
    KEYWORDS: `长寿,健康,循证,省钱,法律常识,急救,${ch.title}`,
    CANON: chUrl(ch),
    SITE: BOOK_URL,
    OG_TITLE: esc(ch.num + '. ' + ch.title),
    H1: esc(ch.num + '. ' + ch.title),
    NUM: ch.num,
    ITEM_COUNT: ch.items.length,
    BC_TITLE: esc(ch.num + '. ' + ch.title),
    CH_POS: `<p class="ch-pos">第 ${ch.num} 节 · ${ch.items.length} 条 · ${posLinks.join(' · ')}</p>`,
    INTRO_HTML: introHtml,
    GUIDE_HTML: guideHtml,
    ITEMS_HTML: itemsHtml.join('\n'),
    TOC_HTML: tocHtml,
    PAGER_HTML: `<nav class="pager" aria-label="章节翻页">${pagerCell('prev', prev ? '/' + chHref(prev) : null, '上一节', prev ? prev.title : '')}${pagerCell('next', next ? '/' + chHref(next) : null, '下一节', next ? next.title : '')}</nav>`,
    ARTICLE_JSON: articleJson,
    BUILD_STAMP: STAMP,
  });
  const dir = join(OUT, 'book', ch.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
}

/* ---------- 首页 ---------- */
setXrefSplit(makeXrefSplit(chapters[0]));
const homeTpl = readFileSync(resolve(ROOT, 'site/home.template.html'), 'utf8');
const DESC = `按性价比排序的人生指南：${itemCount} 条建议，覆盖长寿防病、意外急救、省钱理财、防骗与法律红线、失业兜底、创业风险、恋爱婚育、出国与技能。每条写明成本、收益、证据等级和原始出处，可按钱、时间、毅力三个成本维度检索。`;
const statsHtml = [
  `<div class="stat"><b>${itemCount}</b><span>条建议</span></div>`,
  `<div class="stat"><b>${chapters.length}</b><span>个章节</span></div>`,
  `<div class="stat"><b>${gradeTotal.A}</b><span>A 级证据</span></div>`,
  `<div class="stat"><b>${gradeTotal.B}</b><span>B 级证据</span></div>`,
  `<div class="stat"><b>${gradeTotal.C}</b><span>C 级证据</span></div>`,
  `<div class="stat"><b>${srcUrls.size}</b><span>处原始出处</span></div>`,
].join('\n');
const cardsHtml = chapters.map(ch => {
  const q = ch.question ? `<div class="c-q">${esc(ch.question)}</div>` : '';
  const meta = [`<span>${ch.items.length} 条</span>`];
  if (ch.gradeCounts.A) meta.push(`<span class="g gA">A ${ch.gradeCounts.A}</span>`);
  if (ch.gradeCounts.B) meta.push(`<span class="g gB">B ${ch.gradeCounts.B}</span>`);
  if (ch.gradeCounts.C) meta.push(`<span class="g gC">C ${ch.gradeCounts.C}</span>`);
  return `<a class="card" href="/${chHref(ch)}"><span class="c-num">第 ${ch.num} 节</span><h3>${esc(ch.num)}. ${esc(ch.title)}</h3>${q}<span class="c-meta">${meta.join('')}</span></a>`;
}).join('\n');
const featured = chapters[0].items.slice(0, 10).map(it => `<tr>
<td><a class="f-t" href="/${chHref(chapters[0])}#item-${it.n}">${it.n}. ${esc(plainText(it.title))}</a></td>
<td>${esc(truncate(it.cost, 48))}</td>
<td>${esc(truncate(it.human, 140))}</td>
<td>${it.grade ? `<span class="g gA">${esc(it.grade)} 级</span>` : ''}${it.dispute ? ' <span class="g gC">争议</span>' : ''}</td>
</tr>`).join('\n');
const faq = [
  ['这本书是什么？', `按性价比排序的人生指南，${itemCount} 条建议，覆盖长寿防病、意外急救、省钱理财、防骗与法律红线、失业兜底、创业风险、恋爱婚育、出国与技能。每条写明花掉什么、换回什么、证据等级和原始出处。`],
  [`${itemCount} 条全都要做吗？`, '不用。这是按性价比排好的备选单，不是任务清单。挑走一两条就算数，剩下的放着，需要时再回来查。作者自己也没做到其中大部分。'],
  ['证据等级 A/B/C 是什么意思？', 'A 级：有具体数字可查，出处是多项研究合并的荟萃分析、大型队列或随机分组试验；B 级：有研究支持，但难量化或样本小；C 级：作者经验或公认做法，没有直接文献。有争议的 A/B 级条目会标注「争议」并列出反方证据。'],
  ['数据和说法可信吗？', '来源只引原始文献：期刊论文（附 DOI 或 PubMed 链接）和 WHO/CDC/国家统计局等官方机构报告，不引二手转述。少数官方不公开的案件引署名的原创新闻报道并附网页存档，只在备注里说明。不确定的数字标「待核实」。'],
  ['怎么找到针对我的条目？', `打开<a href="${BOOK_URL}search/">全文检索页</a>，可按关键词、章节、证据等级筛选，也可按「花不花钱、花多少时间、要不要毅力」三个成本维度筛选，几个条件可叠用。每节内按性价比从高到低排列。`],
  ['收费吗？怎么离线看？', '免费。正文按 CC BY 4.0 发布，转载改编请署名并附原文链接。另有 PDF、EPUB、离线单文件 HTML 和 Anki 牌组可下载（见 GitHub 仓库 Releases）。觉得有用可自愿赞赏，给不给都不影响任何内容。'],
];
const faqHtml = faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><div class="a"><p>${a}</p></div></details>`).join('\n');
const faqJson = JSON.stringify({
  '@type': 'FAQPage',
  mainEntity: faq.map(([q, a]) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a.replace(/<[^>]+>/g, '') },
  })),
});
const websiteJson = JSON.stringify({
  '@type': 'WebSite', '@id': BOOK_URL + '#website', url: BOOK_URL, name: TITLE, description: DESC, inLanguage: 'zh-CN',
  potentialAction: {
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: BOOK_URL + 'search/?q={search_term_string}' },
    'query-input': 'required name=search_term_string',
  },
});
const bookJson = JSON.stringify({
  '@type': 'Book', '@id': BOOK_URL + '#book', name: TITLE, url: BOOK_URL, inLanguage: 'zh-CN',
  bookFormat: 'https://schema.org/EBook', numberOfPages: itemCount,
  license: 'https://creativecommons.org/licenses/by/4.0/', abstract: DESC,
  about: ['健康', '长寿', '个人理财', '急救', '法律常识', '消费者保护'], isAccessibleForFree: true,
});
const howtoJson = JSON.stringify({
  '@type': 'HowTo', name: '如何开始读这本书',
  step: [
    { '@type': 'HowToStep', position: 1, name: '先挑一两条', text: '不用全做：这是一份按性价比排好的备选单。从第 1 节最前面的条目里挑一两条零成本、收益大的先做，就算数。' },
    { '@type': 'HowToStep', position: 2, name: '想挑最省力的', text: '打开检索页，把「花钱」选「不花钱」、「要毅力」选「不用」，剩下的就是最省力的条目。' },
    { '@type': 'HowToStep', position: 3, name: '需要时再回来查', text: '剩下的放着，遇到具体问题（失业、看病、租房、出国）时按章节回来查对应条目。' },
  ],
});
const homeHtml = fmt(homeTpl, {
  TITLE: esc(TITLE + ' · 用最少的钱、时间和精力换回寿命、金钱和人身自由'),
  DESC: esc(DESC),
  SITE: BOOK_URL,
  STATS: statsHtml,
  CHAPTER_COUNT: chapters.length,
  ITEM_COUNT: itemCount,
  CHAPTER_CARDS: cardsHtml,
  FEATURED_ROWS: featured,
  FAQ_HTML: faqHtml,
  WEBSITE_JSON: websiteJson,
  BOOK_JSON: bookJson,
  FAQ_JSON: faqJson,
  HOWTO_JSON: howtoJson,
  BUILD_STAMP: STAMP,
});
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), homeHtml);

/* ---------- 检索页：原 index.html（site/search.html）原样进 _site/search/ ---------- */
mkdirSync(join(OUT, 'search'), { recursive: true });
copyFileSync(resolve(ROOT, 'site/search.html'), join(OUT, 'search', 'index.html'));

/* ---------- 静态资源 ---------- */
for (const f of ['README.md', 'og.png', 'LICENSE', 'LICENSE-CODE']) {
  const src = resolve(ROOT, f);
  if (existsSync(src)) copyFileSync(src, join(OUT, f));
}
// 站点共享样式：首页/章节页/404 都引 https://…/styles.css，漏拷则全站裸奔
copyFileSync(resolve(ROOT, 'site/styles.css'), join(OUT, 'styles.css'));
copyFileSync(resolve(ROOT, '.nojekyll'), join(OUT, '.nojekyll'));
for (const dir of ['book', 'docs', 'ads', 'skills']) {
  const src = resolve(ROOT, dir);
  if (!existsSync(src)) continue;
  mkdirSync(join(OUT, dir), { recursive: true });
  for (const f of walk(src)) {
    const rel = f.slice(src.length + 1);
    const parent = rel.split('/').slice(0, -1).join('/');
    if (parent) mkdirSync(join(OUT, dir, parent), { recursive: true });
    copyFileSync(f, join(OUT, dir, rel));
  }
}
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

/* ---------- sitemap.xml / robots.txt / llms.txt ---------- */
const urls = [
  { loc: BOOK_URL, p: '1.0' },
  { loc: BOOK_URL + 'search/', p: '0.8' },
  { loc: BOOK_URL + 'README.md', p: '0.7' },
  ...chapters.map(ch => ({ loc: chUrl(ch), p: '0.9' })),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u.p}</priority>
  </url>`).join('\n')}
</urlset>
`;
writeFileSync(join(OUT, 'sitemap.xml'), sitemap);

const robots = `# 所有常规爬虫
User-agent: *
Allow: /

# AI 爬虫与生成式引擎爬虫（GEO）：全部放行
User-agent: GPTBot
User-agent: ChatGPT-User
User-agent: OAI-SearchBot
User-agent: ClaudeBot
User-agent: Claude-Web
User-agent: Google-Extended
User-agent: PerplexityBot
Allow: /

Sitemap: ${BOOK_URL}sitemap.xml
# 站点面向 LLM 的介绍：${BOOK_URL}llms.txt
`;
writeFileSync(join(OUT, 'robots.txt'), robots);

const llmsTpl = readFileSync(resolve(ROOT, 'site/llms.txt'), 'utf8');
const llmsChapters = chapters.map(ch => `- [${ch.num}. ${ch.title}](${BOOK_URL}book/${ch.slug}/)：${ch.question || truncate(ch.intro[0] ?? ch.title, 80)}（${ch.items.length} 条）`).join('\n');
writeFileSync(join(OUT, 'llms.txt'), llmsTpl.replace(/@CHAPTERS@/g, llmsChapters).replace(/@SITE@/g, BOOK_URL).replace(/@ITEM_COUNT@/g, itemCount).replace(/@GRADE_A@/g, gradeTotal.A).replace(/@GRADE_B@/g, gradeTotal.B).replace(/@GRADE_C@/g, gradeTotal.C));

/* ---------- 404 ---------- */
const nf = readFileSync(resolve(ROOT, 'site/404.html'), 'utf8').replace(/@SITE@/g, BOOK_URL);
writeFileSync(join(OUT, '404.html'), nf);

/* ---------- 校验 ---------- */
const errors = [];
if (chapters.length !== 34) errors.push(`章节数 ${chapters.length}，预期 34`);
for (const ch of chapters) {
  if (!ch.items.length) errors.push(`第 ${ch.num} 节没有条目`);
  for (const it of ch.items) {
    for (const k of ['cost', 'human', 'gain', 'grade', 'src']) if (!it[k]) errors.push(`第 ${ch.num} 节第 ${it.n} 条缺字段 ${k}`);
  }
}
const homeOut = readFileSync(join(OUT, 'index.html'), 'utf8');
if (!/application\/ld\+json/.test(homeOut)) errors.push('首页缺 JSON-LD');
// 首页/章节页引用的站内资源必须真实存在，漏拷任何一个都是线上裸奔
for (const asset of ['styles.css', 'og.png', 'ads/mcyyy-side.webp', 'ads/wechat-reward.png']) {
  if (!existsSync(join(OUT, asset))) errors.push(`_site 缺资源 ${asset}（构建脚本没拷）`);
}
if (errors.length) {
  console.error('构建校验发现问题：');
  for (const e of errors) console.error(' - ' + e);
  process.exitCode = 1;
}
console.log(`构建完成：${chapters.length} 节 ${itemCount} 条 -> ${OUT}（${STAMP}）`);
console.log(`证据：A ${gradeTotal.A} · B ${gradeTotal.B} · C ${gradeTotal.C} · 争议 ${disputeCount} · 原始出处 ${srcUrls.size} 处`);
