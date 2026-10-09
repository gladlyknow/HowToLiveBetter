// 站内 Markdown 渲染器：从 index.html（检索页）内联的 dmRender/dmInline 提取并改造，
// 供 tools/site/build.mjs 生成静态章节页用。只支持书里实际用到的结构：
// 标题(#~####)、段落、有序/无序列表、表格、行内 code/链接/加粗/裸 URL/转义。
// 与检索页弹窗不同：站内相对链接要解析成站内 URL（book/xx.md -> /book/xx/），
// 「第 N 条 / 第 X 节第 N 条」交叉引用就地变成锚点链接（规则与检索页 xrefKeys 一致：目标存在才链）。

export function esc(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// resolveHref(url, isMarkdownLink): 站内相对链接 -> 站内绝对路径；外部链接原样返回。
// 由 build.mjs 注入（要知道章节表才能解析 book/xx.md -> /book/xx/）。
const identity = u => u;
export let resolveHref = identity;
export function setHrefResolver(fn) { resolveHref = fn; }

// 交叉引用回调：text 匹配「第N条/第X节第N条」时返回 {href, text}[] 切分，由 build.mjs 注入。
export let xrefSplit = null;
export function setXrefSplit(fn) { xrefSplit = fn; }

// 把一段行内 markdown 文本切成 tokens：先切行内码和链接（这些里面不跑 xref 和转义规则），
// 其余纯文本段落再交给 xref 切分，最后统一转义拼装。
function inlineTokens(s) {
  const tokens = [];
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(&lt;|)<(https?:\/\/[^\s&>]+)(&gt;|>)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) tokens.push({ t: 'text', s: s.slice(last, m.index) });
    if (m[1]) tokens.push({ t: 'code', s: m[1].slice(1, -1) });
    else if (m[2]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(m[2]);
      tokens.push({ t: 'link', text: lm[1], href: lm[2] });
    } else tokens.push({ t: 'link', text: m[3], href: m[3] });
    last = m.index + m[0].length;
  }
  if (last < s.length) tokens.push({ t: 'text', s: s.slice(last) });
  return tokens;
}

// 文本 token 内的 xref 切分：把「第N条」等拆成 [text, anchor, text, ...]，目标不存在就不拆。
function xrefSegments(text) {
  if (!xrefSplit) return [{ t: 'text', s: text }];
  const segs = []; let last = 0;
  for (const { start, end, href } of xrefSplit(text)) {
    if (start > last) segs.push({ t: 'text', s: text.slice(last, start) });
    segs.push({ t: 'anchor', s: text.slice(start, end), href });
    last = end;
  }
  if (last < text.length) segs.push({ t: 'text', s: text.slice(last) });
  return segs;
}

function textHtml(s) {
  let h = esc(s);
  h = h.replace(/\*\*((?:\\\*|[^*])+)\*\*/g, '<strong>$1</strong>');
  return h.replace(/\\([*_])/g, '$1');
}

export function inline(s) {
  const out = [];
  for (const tok of inlineTokens(s)) {
    if (tok.t === 'code') out.push('<code>' + esc(tok.s) + '</code>');
    else if (tok.t === 'link') out.push('<a href="' + esc(resolveHref(tok.href)) + '">' + textHtml(tok.text) + '</a>');
    else for (const seg of xrefSegments(tok.s)) {
      if (seg.t === 'anchor') out.push('<a class="xref" href="' + esc(seg.href) + '">' + textHtml(seg.s) + '</a>');
      else out.push(textHtml(seg.s));
    }
  }
  return out.join('');
}

// 整篇渲染：返回 { html, heads:[{id,lv,txt}], title }。与 dmRender 对齐，
// 一级标题当页面标题用（章节页单独处理），表头分隔行只识别 --- 那行。
export function renderBlocks(md, { skipBackLink = true } = {}) {
  const lines = md.split(/\r?\n/);
  const out = []; const heads = [];
  let para = [], list = null, title = '';
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const flush = () => { flushP(); flushL(); };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (skipBackLink && /^\[← 回总目录\]/.test(ln)) continue;
    if (!ln.trim()) { flush(); continue; }
    let m;
    if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      const lv = m[1].length, txt = m[2].trim();
      if (lv === 1) { title = txt; continue; }
      const id = 'h-' + heads.length;
      heads.push({ id, lv, txt });
      out.push('<h' + lv + ' id="' + id + '">' + inline(txt) + '</h' + lv + '>');
      continue;
    }
    if (ln.startsWith('|')) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      i--;
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const sep = rows[1] && /^[\s|:-]+$/.test(rows[1]);
      const head = sep ? cells(rows[0]) : null;
      const body = rows.slice(sep ? 2 : 0).map(cells);
      let t = '<div class="tw"><table>';
      if (head) t += '<thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead>';
      t += '<tbody>' + body.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
      out.push(t);
      continue;
    }
    if ((m = ln.match(/^\s*([-*])\s+(.*)$/)) || (m = ln.match(/^\s*\d+\.\s+(.*)$/))) {
      const txt = m.length === 3 ? m[2] : m[1];
      const want = /^\s*\d/.test(ln) ? 'ol' : 'ul';
      flushP();
      if (list !== want) { flushL(); out.push('<' + want + '>'); list = want; }
      out.push('<li>' + inline(txt) + '</li>');
      continue;
    }
    para.push(ln.trim());
  }
  flush();
  return { html: out.join('\n'), heads, title };
}

// 去掉行内 markdown，取纯文本（章节卡片摘要、description 用）
export function plainText(s) {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<(https?:\/\/[^\s>]+)>/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\\([*_])/g, '$1')
    .trim();
}
