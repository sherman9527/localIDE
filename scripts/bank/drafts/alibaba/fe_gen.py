#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阿里巴巴 · 前端（react-vitest）代码题草稿生成器 —— 微前端隔离档位与样式作用域。

取材：content/knowledge/hot-interviews/alibaba-frontend-and-open-source.md
  * 草稿 A（§5）＝ `resolveIsolation` + `scopeCss` 两个导出的纯函数题
  * §6 可判分事实表行 1、2、4、5（★）＝判分点
  * §8 来源清单 F4 / F6 / F7 ＝逐字原文的出处

**为什么这份生成器与 alibaba/gen.py 分开**：那份的 frontend 格是空的
（两份公司向素材当时都写"阿里前端无可核查机制文档"），素材 §引言 里明确说
"本文补的就是这块空白"。所以前端这批单独一个生成器、单独一个草稿目录
（`data/drafts-ab-fe/`），出处审计里挂成阿里的第三份生成器。

## 原文核对（收口人缺的那一条，这里补上）

收口人写素材时抓不到 v2.10.16 的 `src/loader.ts`，只旁证了 master（v3）。
本生成器用 GitHub MCP `get_file_contents(owner=umijs, repo=qiankun,
ref=v2.10.16, path=src/loader.ts)` 抓到了原文，逐字行如下（URL 见 blob 链接）：

  https://github.com/umijs/qiankun/blob/v2.10.16/src/loader.ts
    L64  const supportShadowDOM = !!document.head.attachShadow || !!(document.head as any).createShadowRoot;
    L80          '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
    L122       if (strictStyleIsolation) throw new QiankunError('strictStyleIsolation can not be used with legacy render!');
    L123       if (scopedCSS) throw new QiankunError('experimentalStyleIsolation can not be used with legacy render!');
    L283       "[qiankun] strictStyleIsolation configuration will be removed in 3.0, pls don't depend on it or use experimentalStyleIsolation instead!",

  https://github.com/umijs/qiankun/blob/v2.10.16/src/apis.ts
    L30        console.warn('[qiankun] Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox');
    L34            '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
    L38        return { ...configuration, sandbox: typeof sandbox === 'object' ? { ...sandbox, loose: true } : { loose: true } };
    L46          '[qiankun] Speedy mode will turn off as const destruct assignment not supported in current browser!',
    L51          sandbox: typeof sandbox === 'object' ? { ...sandbox, speedy: false } : { speedy: false },

  https://github.com/umijs/qiankun/blob/v2.10.16/src/sandbox/patchers/css.ts
    L90-105    private rewrite(rules, prefix)  →  `css +=` 逐条拼接（规则之间没有分隔符）
               case STYLE / MEDIA / SUPPORTS 改写，default 分支 `css += rule.cssText`
    L121-123   private ruleStyle(...)  const rootSelectorRE = /((?:[^\\w\\-.#]|^)(body|html|:root))/gm;
                                          const rootCombinationRE = /(html[^\\w{[]+)/gm;
    L142         const siblingSelectorRE = /(html[^\\w{]+)(\\+|~)/gm;
    L158-160       const whitePrevChars = [',', '('];
                 if (m && whitePrevChars.includes(m[0])) { return `${m[0]}${prefix}`; }
    L180         return `@media ${rule.conditionText || rule.media.mediaText} {${css}}`;
    L187         return `@supports ${rule.conditionText || rule.cssText.split('{')[0]} {${css}}`;
    L193       export const QiankunCSSRewriteAttr = 'data-qiankun';
    L205         console.warn('Feature: sandbox.experimentalStyleIsolation is not support for link element yet.');
    L216         const prefix = `${tag}[${QiankunCSSRewriteAttr}="${appName}"]`;

  https://github.com/umijs/qiankun/blob/v2.10.16/src/utils.ts
    L206-216   genAppInstanceIdByName（首次返回 appName，之后 `${appName}_${count}`，count 自增后拼接）
    L246-254   isEnableScopedCSS：typeof !== 'object' → false；strictStyleIsolation → false；否则 !!experimentalStyleIsolation
  https://github.com/umijs/qiankun/blob/v2.10.16/src/sandbox/index.ts
    L44-49     window.Proxy ? (useLooseSandbox ? new LegacySandbox : new ProxySandbox) : new SnapshotSandbox

## 与素材不符的两处（**没有**照素材写进判分点，见交付报告）

1. 素材 §1.1 机制 2 与 §6 行 5 写「`sandbox: false`（legacy render）下开任一档样式隔离都会直接抛错」。
   源码里 `legacyRender` 是 **`app.render` 自定义渲染函数**（`loader.ts` L212/L227 的
   `legacyRender = 'render' in app ? app.render : undefined`），与 `sandbox: false` 无关；
   而且 `sandbox: false` 时 `strictStyleIsolation` 与 `isEnableScopedCSS(false)` 双双为假，
   抛错分支根本进不去。→ 本题把输入写成独立的 `legacyRender: boolean`（草稿 A 的写法是对的），
   并在题面里明说"它指提供了自定义 render，不是 `sandbox:false`"。
2. 素材 §6 行 2 与 §5 草稿 A 写「`html + body` / `html ~ body` **原样 / 保持原样**」。
   源码只跳过"剥 `html` 前缀"这一步（L142-147），**随后仍走第 3 步的分组/普通分支**，
   于是 `html` 与 `body` 两个根选择器**都被替换成 prefix**。→ 判分点按源码写，
   并在 `answer` 里点名这条"看起来像例外、其实不是"的差异。

用法：
    python scripts/bank/drafts/alibaba/fe_gen.py            # 生成到 data/drafts-ab-fe/out/
    python scripts/bank/drafts/alibaba/fe_gen.py --list     # 只列登记:key
    python scripts/bank/drafts/alibaba/fe_gen.py --check    # 与已入库的题逐字段比对
"""
import io
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4)))
OUT_DIR = os.path.join(ROOT, 'data', 'drafts-ab-fe', 'out')
BANK_DIR = os.path.join(ROOT, 'content', 'questions')

KB = 'content/knowledge/hot-interviews/alibaba-frontend-and-open-source.md'

DRAFTS = {}


def draft(key):
    def deco(fn):
        DRAFTS[key] = fn
        return fn
    return deco


def base(category, difficulty, title, statement, judge_kind, tags, source, **extra):
    return {
        'category': category,
        'difficulty': difficulty,
        'title': title,
        'statement': statement,
        'judgeKind': judge_kind,
        'tags': tags,
        'source': source,
        **extra,
    }


def src(role, ref):
    return {
        'company': 'Alibaba',
        'role': role,
        'location': 'hangzhou',
        'origin': 'manual',
        'jds': [],
        'knowledgeRef': ref,
        'era': '2026',
        'addedBy': 'arena-company-expansion',
    }


class ModelError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def require(cond, message):
    if not cond:
        raise ModelError(message)


def dump(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


# ===================================================================== 源码逐字串
# 这六条是**判分事实**，逐字抄自 v2.10.16（URL 与行号见文件头）。
# 改任何一个字符都要先改源码，不许"顺手改文案"。
W_PROXY = '[qiankun] Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox'
W_SINGULAR = ('[qiankun] Setting singular as false may cause unexpected behavior '
              'while your browser not support window.Proxy')
W_SPEEDY = ('[qiankun] Speedy mode will turn off as const destruct assignment '
            'not supported in current browser!')
W_SHADOW = ('[qiankun]: As current browser not support shadow dom, your strictStyleIsolation '
            'configuration will be ignored!')
E_STRICT = 'strictStyleIsolation can not be used with legacy render!'
E_EXPERIMENTAL = 'experimentalStyleIsolation can not be used with legacy render!'

STRICT_ISOLATION = 'strictStyleIsolation'
EXPERIMENTAL_ISOLATION = 'experimentalStyleIsolation'

# =================================================================== Q1 的 Python 模型


def _resolve_sandbox(inp):
    """复刻 apis.ts 的 autoDowngradeForLowVersionBrowser + loader.ts 的档位判定。

    返回 (改写后的 sandbox 配置对象或 None, warnings, thrown, singular)。
    `None` 表示沙箱整体关闭（`if (sandbox)` 为假）。
    """
    warnings = []
    require(isinstance(inp, dict), 'input must be an object')
    sandbox = inp.get('sandbox', True)
    require(sandbox is True or sandbox is False or isinstance(sandbox, dict),
            'unknown sandbox configuration')
    require(isinstance(inp.get('hasProxy'), bool), 'hasProxy must be a boolean')
    require(isinstance(inp.get('hasConstDestructAssignment'), bool),
            'hasConstDestructAssignment must be a boolean')
    require(isinstance(inp.get('supportsShadowDOM'), bool), 'supportsShadowDOM must be a boolean')
    require(isinstance(inp.get('legacyRender'), bool), 'legacyRender must be a boolean')
    require('singular' not in inp or inp['singular'] is True or inp['singular'] is False,
            'singular must be a boolean')
    app_name = inp.get('appName')
    require(isinstance(app_name, str) and app_name != '', 'appName must be a non-empty string')
    seq = inp.get('instanceSeq')
    require(isinstance(seq, int) and not isinstance(seq, bool) and seq >= 1,
            'instanceSeq must be a positive integer')

    # --- autoDowngradeForLowVersionBrowser（只在 sandbox 为真值时执行；两条分支互斥）
    if sandbox:
        if not inp['hasProxy']:
            warnings.append(W_PROXY)
            if 'singular' in inp and inp['singular'] is False:
                warnings.append(W_SINGULAR)
            cfg = dict(sandbox) if isinstance(sandbox, dict) else {}
            cfg['loose'] = True
            sandbox = cfg
        elif not inp['hasConstDestructAssignment'] and (
                sandbox is True or sandbox.get('speedy') is not False):
            # 源码条件：sandbox === true || (typeof sandbox === 'object' && sandbox.speedy !== false)
            warnings.append(W_SPEEDY)
            cfg = dict(sandbox) if isinstance(sandbox, dict) else {}
            cfg['speedy'] = False
            sandbox = cfg

    # --- createSandboxContainer 的选型
    if not sandbox:
        sandbox_type = 'None'
    elif not inp['hasProxy']:
        sandbox_type = 'Snapshot'
    elif isinstance(sandbox, dict) and sandbox.get('loose'):
        sandbox_type = 'LegacyProxy'
    else:
        sandbox_type = 'Proxy'

    # --- loader.ts 的两档样式隔离
    strict = isinstance(sandbox, dict) and bool(sandbox.get(STRICT_ISOLATION))
    # utils.ts isEnableScopedCSS：非对象 → false；strict 开了 → false（两档互斥，strict 赢）
    scoped = isinstance(sandbox, dict) and not strict and bool(sandbox.get(EXPERIMENTAL_ISOLATION))

    thrown = []
    if inp['legacyRender']:
        if strict:
            thrown.append(E_STRICT)
        elif scoped:
            thrown.append(E_EXPERIMENTAL)

    shadow_wrapped = False
    if strict:
        if inp['supportsShadowDOM']:
            shadow_wrapped = True
        else:
            warnings.append(W_SHADOW)

    container_attr = None
    if scoped:
        container_attr = app_name if seq == 1 else '%s_%d' % (app_name, seq - 1)

    return {
        'sandboxType': sandbox_type,
        'singular': True if 'singular' not in inp else bool(inp['singular']),
        'scopedCss': scoped,
        'shadowWrapped': shadow_wrapped,
        'containerAttr': container_attr,
        'warnings': warnings,
        'thrown': thrown,
    }


# ---------------------------------------------------------------- scopeCss（css.ts）
# 三个正则的 flag 一律照抄 JS：gm / gm / gm，且 **Python 侧加 re.A**，
# 否则 `\w` 在 Python 里是 Unicode 的（中文会被当单词字符），与 JS 语义不同。
RE_ROOT = re.compile(r'((?:[^\w\-.#]|^)(body|html|:root))', re.M | re.A)
RE_ROOT_COMB = re.compile(r'(html[^\w{[]+)', re.M | re.A)
RE_SIBLING = re.compile(r'(html[^\w{]+)(\+|~)', re.M | re.A)
RE_HEAD = re.compile(r'\A[\s\S]+{', re.A)          # JS /^[\s\S]+{/ —— 没有 m，^ 只锚串首
RE_SEG = re.compile(r'(\A|,\n?)([^,]+)', re.A)     # JS /(^|,\n?)([^,]+)/g —— 同样没有 m
RE_LEAD_SP = re.compile(r'\A *', re.A)

WHITE_PREV = [',', '(']


def _rule_style(css, selector, prefix):
    """ScopedCSS.ruleStyle 的逐行移植（css.ts L121-173）。"""
    # 1) handle html { ... } / body { ... } / :root { ... }
    if selector in ('html', 'body', ':root'):
        return RE_ROOT.sub(lambda _m: prefix, css)

    # 2) handle html body { ... } / html > body { ... }
    if RE_ROOT_COMB.search(selector) and not RE_SIBLING.search(selector):
        css = RE_ROOT_COMB.sub('', css)

    # 3) handle grouping selector
    def segment(match):
        item = match.group(0)
        p = match.group(1) or ''
        s = match.group(2) or ''
        if RE_ROOT.search(item):
            def repl(m):
                mv = m.group(0)
                # do not discard valid previous character, such as body,html or *:not(:root)
                if mv and mv[0] in WHITE_PREV:
                    return mv[0] + prefix
                return prefix
            return RE_ROOT.sub(repl, item)
        return '%s%s %s' % (p, prefix, RE_LEAD_SP.sub('', s))

    return RE_HEAD.sub(lambda head: RE_SEG.sub(segment, head.group(0)), css, count=1)


def _rewrite_css(rules, prefix):
    out = []
    for rule in rules:
        require(isinstance(rule, dict), 'css rule must be an object')
        rtype = rule.get('type')
        require(isinstance(rtype, int) and not isinstance(rtype, bool), 'unknown css rule type')
        text = rule.get('text')
        require(isinstance(text, str), 'css rule text must be a string')
        if rtype == 1:      # RuleType.STYLE
            decl = rule.get('declarations')
            require(isinstance(decl, str), 'style rule needs declarations')
            out.append(_rule_style(text + ' ' + decl, text, prefix))
        elif rtype == 4:    # RuleType.MEDIA
            out.append('@media %s {%s}' % (text, _rewrite_css(rule.get('rules') or [], prefix)))
        elif rtype == 12:   # RuleType.SUPPORTS
            out.append('@supports %s {%s}' % (text, _rewrite_css(rule.get('rules') or [], prefix)))
        elif rtype in (3, 5, 6, 7, 8):
            out.append(text)               # 源码 default 分支：css += rule.cssText
        else:
            raise ModelError('unknown css rule type')
    return ''.join(out)


def _scope_css_model(rules, prefix):
    require(isinstance(rules, list), 'rules must be an array')
    require(isinstance(prefix, str) and prefix != '', 'prefix must be a non-empty string')
    return _rewrite_css(rules, prefix)


ISOLATION_CASES = [
    # (用例名, 输入)
    ('基线：全支持 + sandbox:true ⇒ 严格 Proxy 沙箱，一条告警都不该有',
     {'hasProxy': True, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': True, 'singular': True,
      'appName': 'react16', 'instanceSeq': 1}),
    ('降级：无 Proxy 且显式 singular:false ⇒ 快照沙箱 + 两条告警，但 singular 不许被改',
     {'hasProxy': False, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': True, 'singular': False,
      'appName': 'react16', 'instanceSeq': 1}),
    ('降级：loose 显式开 ⇒ LegacyProxy（严格模式才是默认）',
     {'hasProxy': True, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': {'loose': True}, 'singular': True,
      'appName': 'react16', 'instanceSeq': 1}),
    ('降级不吞配置：无 Proxy 时 experimentalStyleIsolation 要活下来（展开后补 loose）',
     {'hasProxy': False, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': {'experimentalStyleIsolation': True},
      'singular': True, 'appName': 'react16', 'instanceSeq': 1}),
    ('硬失败：legacy render + 两档隔离同开 ⇒ 只有 strict 那条抛错，且两档互斥（scopedCss 为假）',
     {'hasProxy': True, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': True, 'sandbox': {STRICT_ISOLATION: True, EXPERIMENTAL_ISOLATION: True},
      'singular': True, 'appName': 'react16', 'instanceSeq': 1}),
    ('硬失败：legacy render + experimental ⇒ 抛对应那条，但容器标识已经写上了',
     {'hasProxy': True, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': True, 'sandbox': {'experimentalStyleIsolation': True},
      'singular': True, 'appName': 'react16', 'instanceSeq': 1}),
    ('静默降级：不支持 shadow dom 时开 strict ⇒ 只 warn 并忽略，绝不进 thrown',
     {'hasProxy': True, 'hasConstDestructAssignment': True, 'supportsShadowDOM': False,
      'legacyRender': False, 'sandbox': {STRICT_ISOLATION: True},
      'singular': True, 'appName': 'react16', 'instanceSeq': 1}),
    ('三种出口同现：无 Proxy + singular:false + 无 shadow dom + legacy render + strict',
     {'hasProxy': False, 'hasConstDestructAssignment': True, 'supportsShadowDOM': False,
      'legacyRender': True, 'sandbox': {STRICT_ISOLATION: True},
      'singular': False, 'appName': 'react16', 'instanceSeq': 1}),
    ('speedy：不支持 const 解构且没显式关 ⇒ 只追加一条"关掉 speedy"的告警',
     {'hasProxy': True, 'hasConstDestructAssignment': False, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': True, 'singular': True,
      'appName': 'react16', 'instanceSeq': 1}),
    ('speedy 已显式关闭 ⇒ 不该再报"我要关掉它"',
     {'hasProxy': True, 'hasConstDestructAssignment': False, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': {'speedy': False}, 'singular': True,
      'appName': 'react16', 'instanceSeq': 1}),
    ('分支互斥：无 Proxy 时先返回，const 解构不支持也不该再报 speedy',
     {'hasProxy': False, 'hasConstDestructAssignment': False, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': True, 'singular': True,
      'appName': 'react16', 'instanceSeq': 1}),
    ('退化：sandbox:false ⇒ 不降级、不告警，singular:false 原样保留（沙箱压根没建）',
     {'hasProxy': False, 'hasConstDestructAssignment': False, 'supportsShadowDOM': False,
      'legacyRender': False, 'sandbox': False, 'singular': False,
      'appName': 'react16', 'instanceSeq': 1}),
    ('实例标识：同名第 3 次加载 ⇒ 容器属性值是 react16_2，不是 react16',
     {'hasProxy': True, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': {'experimentalStyleIsolation': True},
      'appName': 'react16', 'instanceSeq': 3}),
    ('非法：整行是 null', None),
    ('非法：sandbox 写成字符串（true/false/对象之外的第四种）',
     {'hasProxy': True, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': 'yes', 'singular': True,
      'appName': 'react16', 'instanceSeq': 1}),
    ('非法：instanceSeq 为 0（加载序从 1 开始）',
     {'hasProxy': True, 'hasConstDestructAssignment': True, 'supportsShadowDOM': True,
      'legacyRender': False, 'sandbox': {'experimentalStyleIsolation': True},
      'appName': 'react16', 'instanceSeq': 0}),
]

ISOLATION_THROWS = {
    '非法：整行是 null': 'input must be an object',
    '非法：sandbox 写成字符串（true/false/对象之外的第四种）': 'unknown sandbox configuration',
    '非法：instanceSeq 为 0（加载序从 1 开始）': 'instanceSeq must be a positive integer',
}

CSS_PREFIX = 'div[data-qiankun="react16"]'

CSS_CASES = [
    ('基线：普通规则加前缀，@font-face 与 @keyframes 一个字都不动',
     [{'type': 1, 'text': '.app-main', 'declarations': '{font-size: 14px}'},
      {'type': 5, 'text': '@font-face{font-family:icon;src:url(icon.woff)}'},
      {'type': 7, 'text': '@keyframes fadeIn{from{opacity:0}to{opacity:1}}'}]),
    ('根选择器：html / body / :root 是被**替换**成容器，不是加前缀',
     [{'type': 1, 'text': 'html', 'declarations': '{margin: 0}'},
      {'type': 1, 'text': 'body', 'declarations': '{padding: 0}'},
      {'type': 1, 'text': ':root', 'declarations': '{--brand: blue}'}]),
    ('组合选择器：html body 与 html > body 先剥掉 html 前缀',
     [{'type': 1, 'text': 'html body', 'declarations': '{color: red}'},
      {'type': 1, 'text': 'html > body', 'declarations': '{color: green}'}]),
    ('非标准兄弟规则：不剥前缀，但两个根选择器照样各自被替换（素材说"原样"是错的）',
     [{'type': 1, 'text': 'html + body', 'declarations': '{color: red}'},
      {'type': 1, 'text': 'html ~ body', 'declarations': '{color: blue}'}]),
    ('组选择器：逐段处理，段首的逗号/括号不能被吃掉（body,html 与 *:not(:root)）',
     [{'type': 1, 'text': 'div, body, span', 'declarations': '{color: red}'},
      {'type': 1, 'text': 'body,html', 'declarations': '{margin: 0}'},
      {'type': 1, 'text': '*:not(:root)', 'declarations': '{color: red}'}]),
    ('条件规则：@media/@supports 的条件原样保留、内部递归改写',
     [{'type': 4, 'text': 'screen and (max-width: 300px)',
       'rules': [{'type': 1, 'text': '.a', 'declarations': '{color: red}'},
                 {'type': 5, 'text': '@font-face{font-family:x}'}]},
      {'type': 12, 'text': '(display: grid)',
       'rules': [{'type': 1, 'text': 'body', 'declarations': '{gap: 1px}'}]}]),
    ('不参与作用域的其余两类：@import 与 @page 原样输出（字体名/动画名/分页仍全局打架）',
     [{'type': 3, 'text': '@import url("theme.css");'},
      {'type': 6, 'text': '@page{margin:1cm}'}]),
    ('退化：空规则表 ⇒ 空串（幂等：同一份输入喂两次结果必须一字不差）', []),
    ('非法：未知规则类型（CSSRule.type 里没有 99）',
     [{'type': 99, 'text': 'whatever'}]),
]


# ===================================================================== 装配工具
def js(value):
    return json.dumps(value, ensure_ascii=False)


# =================================================================== Q1 装配
@draft('ab-fe-qiankun-isolation')
def q_isolation():
    """§5 草稿 A：resolveIsolation（三档隔离的决策表）+ scopeCss（运行时作用域改写器）。"""

    cases = []
    for name, inp in ISOLATION_CASES:
        if name in ISOLATION_THROWS:
            cases.append({'name': name, 'input': [inp], 'expected': None,
                          'expectThrow': 'Error',
                          'throwMessage': ISOLATION_THROWS[name]})
            continue
        cases.append({'name': name, 'input': [inp],
                      'expected': _resolve_sandbox(inp)})

    for name, rules in CSS_CASES:
        try:
            got = _scope_css_model(rules, CSS_PREFIX)
        except ModelError as exc:
            cases.append({'name': name, 'input': [rules, CSS_PREFIX], 'expected': None,
                          'expectThrow': 'Error', 'throwMessage': exc.message})
            continue
        cases.append({'name': name, 'input': [rules, CSS_PREFIX], 'expected': got})

    # ------------------------------------------------------------------ 测试文件
    tl = [
        "import { describe, expect, it } from 'vitest';",
        "import { resolveIsolation, scopeCss } from './Solution';",
        '',
        '/**',
        ' * 断言由 fe_gen.py 里同一份 Python 模型（_resolve_sandbox / _rule_style）生成，不手抄 ——',
        ' * react-vitest 题的判分事实来源就是这份测试文件，抄错一次就永久错一次。',
        ' * 契约型用例断言到**消息**：只写 .toThrow() 会让几条"都该抛错"的用例收敛成同一条。',
        ' */',
    ]

    def iso_lines():
        out = ["describe('resolveIsolation：微前端隔离档位的三种出口', () => {"]
        for name, inp in ISOLATION_CASES:
            c = next(x for x in cases if x['name'] == name)
            out.append('  it(%s, () => {' % js(name))
            if c.get('expectThrow'):
                out.append('    expect(() => resolveIsolation(%s as never)).toThrow(%s);'
                           % (js(inp), js(c['throwMessage'])))
            else:
                out.append('    expect(resolveIsolation(%s)).toEqual(%s);'
                           % (js(inp), js(c['expected'])))
            out.append('  });')
        out.append('});')
        return out

    def css_lines():
        out = ["describe('scopeCss：运行时 scoped CSS 的改写规则', () => {"]
        for name, rules in CSS_CASES:
            c = next(x for x in cases if x['name'] == name)
            out.append('  it(%s, () => {' % js(name))
            if c.get('expectThrow'):
                out.append('    expect(() => scopeCss(%s as never, %s)).toThrow(%s);'
                           % (js(rules), js(CSS_PREFIX), js(c['throwMessage'])))
            else:
                # 三条一起断：结果、幂等（同一份输入再喂一次）、入参没被就地改写
                out.append('    const rules = %s;' % js(rules))
                out.append('    const once = scopeCss(rules, %s);' % js(CSS_PREFIX))
                out.append('    expect(once).toEqual(%s);' % js(c['expected']))
                out.append('    expect(scopeCss(JSON.parse(JSON.stringify(rules)), %s)).toEqual(once);'
                           % js(CSS_PREFIX))
                out.append('    expect(rules).toEqual(%s);' % js(rules))
            out.append('  });')
        out.append('});')
        return out

    tl.extend(iso_lines())
    tl.append('')
    tl.extend(css_lines())
    test_file = '\n'.join(tl)

    reference = REFERENCE_Q1
    naive = NAIVE_Q1

    return base(
        'frontend', 'senior',
        '微前端隔离档位回归：抛错 / 忽略 / 降级三种出口必须分开，scoped css 也不是"全都加前缀"',
        STATEMENT_Q1, 'react-vitest',
        ['microfrontend-isolation', 'css-scoping', 'silent-degradation',
         'decision-table', 'modern:micro-frontend'],
        src('前端工程（微前端基座 / 中台工程化方向） 高级工程师',
            KB + '#5 出题角度 草稿 A ＋ §6 可判分事实表行 1、2、4、5（★）；'
            '逐字文案由 fe_gen.py 按 §8 F4/F6/F7 的 v2.10.16 原文复核'),
        language='typescript',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 60_000,
                'files': [{'path': 'isolation.test.ts', 'content': test_file}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=45,
        answer=ANSWER_Q1,
    )


# ===================================================================== Q1 题面 / 题解
STATEMENT_Q1 = """## 背景（版本必须钉住：qiankun 2.10.16，npm `latest`）

一个基座（主应用）挂多个子应用。"隔离"在 qiankun 里**不是一个开关**，而是两组互相牵连的配置：

* **全局变量沙箱**：浏览器有没有 `window.Proxy` 决定 ProxySandbox 还是 SnapshotSandbox；
  `sandbox.loose` 决定 ProxySandbox 还是 LegacySandbox；
* **样式隔离**：`strictStyleIsolation`（把内容塞进 shadow dom）与
  `experimentalStyleIsolation`（运行时改写 `<style>` 里的选择器）。**这两档互斥，strict 赢**。

难点不是"知不知道有这几个配置"，而是**三种出口长得很像、后果完全不同**：

| 出口 | 触发条件 | 线上表现 |
| --- | --- | --- |
| **硬失败**（抛 `QiankunError`） | 子应用提供了自定义 `render`（旧渲染）却又开了任一档样式隔离 | 应用压根加载不出来 |
| **静默忽略**（只 `console.warn`） | 浏览器不支持 shadow dom 时开 `strictStyleIsolation` | 配置写了、没生效、也没人报错 |
| **自动降级**（改写配置 + warn） | 浏览器没有 `window.Proxy` | 换成快照沙箱，`loose` 被强制为真 |

把三种出口压成一条 `warnings` 的决策器，就是这道题要筛掉的答案。

## 你要实现的两个导出

```ts
export function resolveIsolation(input: IsolationInput): IsolationView;
export function scopeCss(rules: CssRule[], prefix: string): string;
```

### 1) `resolveIsolation`

```ts
interface IsolationInput {
  hasProxy: boolean;                   // window.Proxy 是否存在
  hasConstDestructAssignment: boolean; // 是否支持 `const { a } = { a: 1 }`（speedy 的前提）
  supportsShadowDOM: boolean;
  legacyRender: boolean;               // 子应用提供了自定义 render（旧渲染），**不是指 sandbox:false**
  sandbox?: true | false | {
    strictStyleIsolation?: boolean;
    experimentalStyleIsolation?: boolean;
    loose?: boolean;
    speedy?: boolean;
  };
  singular?: boolean;
  appName: string;
  instanceSeq: number;                 // 该 appName 第几次被加载，从 1 开始
}

interface IsolationView {
  sandboxType: 'Proxy' | 'LegacyProxy' | 'Snapshot' | 'None';
  singular: boolean;
  scopedCss: boolean;
  shadowWrapped: boolean;
  containerAttr: string | null;        // 容器上会写入的 data-qiankun 值；不启用 scoped css 时为 null
  warnings: string[];                  // 只放"告警后继续跑"的那几条
  thrown: string[];                    // 只放"抛 QiankunError"的那条（本版本最多一条）
}
```

**默认值**：`sandbox` 省略按 `true`、`singular` 省略按 `true`
（对应 `start()` 里的 `frameworkConfiguration = { prefetch: true, singular: true, sandbox: true, ...opts }`）。

**规则（逐条对应源码）**

1. **低版本浏览器降级**：仅当 `sandbox` 为真值时执行，且**两条分支互斥**（第一条命中就直接返回）：
   * `hasProxy === false` ⇒ 追加 `W_PROXY`；**当且仅当输入里显式写了 `singular: false`** 再追加
     `W_SINGULAR`；然后把 `sandbox` 改写为 `{ ...原对象, loose: true }`
     （原值是 `true` 时变成 `{ loose: true }`）。
     ⚠️ **`singular` 的值不许被改写**——FAQ 说"会自动把 singular 配为 true"，v2.10.16 源码只警告不改值，
     本题按源码判。
   * 否则（有 Proxy）当 `hasConstDestructAssignment === false` 且
     （`sandbox === true` 或 `sandbox.speedy !== false`）⇒ 追加 `W_SPEEDY`（speedy 被关掉）。
2. **沙箱选型**：`sandbox` 为假 ⇒ `'None'`；否则
   `hasProxy ? (改写后 loose 为真 ? 'LegacyProxy' : 'Proxy') : 'Snapshot'`。
3. **两档样式隔离互斥**：`strict = 改写后是对象 && !!strictStyleIsolation`；
   `scopedCss = 改写后是对象 && !strict && !!experimentalStyleIsolation`。
4. **shadow dom 不支持 ⇒ 静默忽略**：`strict && !supportsShadowDOM` ⇒ 追加 `W_SHADOW`，
   `shadowWrapped: false`，**这条绝不许进 `thrown`**。`shadowWrapped = strict && supportsShadowDOM`。
5. **旧渲染硬失败**（顺序：先 strict 后 scoped，所以两档同开时只有一条）：
   `legacyRender && strict` ⇒ `thrown` 收 `E_STRICT`；否则 `legacyRender && scopedCss` ⇒ 收 `E_EXPERIMENTAL`。
   注意求值顺序是"先建元素（写 `data-qiankun`、判 shadow dom）→ 再取 wrapper（这里才抛）"，
   所以第 6 条与 `thrown` **可以同时非空**。
6. **容器标识**：`scopedCss` 为真时 `containerAttr = instanceId`，其中
   `instanceId = instanceSeq === 1 ? appName : appName + '_' + (instanceSeq - 1)`
   （同名第二次加载得到 `react16_1`）。
7. **顺序**：`warnings` 按时间序输出（降级发生在 `start()`，shadow dom 那条发生在建元素时）。

**校验（`throw new Error(...)`，消息文本必须一致；按下列顺序检查）**

| 条件 | 消息 |
| --- | --- |
| 输入是 `null` / `undefined` | `input must be an object` |
| `sandbox` 不是 `true`/`false`/对象 | `unknown sandbox configuration` |
| `hasProxy` / `hasConstDestructAssignment` / `supportsShadowDOM` / `legacyRender` 不是布尔 | `字段名 must be a boolean` |
| `singular` 出现但不是布尔 | `singular must be a boolean` |
| `appName` 不是非空字符串 | `appName must be a non-empty string` |
| `instanceSeq` 不是 ≥1 的整数 | `instanceSeq must be a positive integer` |

### 2) `scopeCss(rules, prefix)`

运行时 scoped CSS 的改写器。**不要求你写 CSS 解析器**：入参已经是 CSSOM 走查后
拿到的规则序列（对应 `ScopedCSS.rewrite(rules, prefix)` 的入参形态），
你只需要按同样的规则决定"哪条被改写、改成什么"。

```ts
interface CssRule {
  type: number;        // CSSRule.type：1 STYLE / 3 IMPORT / 4 MEDIA / 5 FONT_FACE / 6 PAGE / 7 KEYFRAMES / 8 KEYFRAME / 12 SUPPORTS
  text: string;        // type 1：selectorText（已 trim）；type 4/12：conditionText；其余：整条规则的原文
  declarations?: string;  // 仅 type 1：声明块原文（自带首尾大括号），整条规则的原文 = text + ' ' + declarations
  rules?: CssRule[];      // 仅 type 4/12：内层规则
}
```

**输出**：一个字符串，等于「逐条渲染后直接拼接」（源码就是 `css += ...`，
**规则之间没有任何分隔符**）。单条渲染：

* `type 1` ⇒ 对 `text + ' ' + declarations` 跑下面的三步改写；
* `type 4` ⇒ `'@media ' + text + ' {' + <内层递归渲染> + '}'`；
* `type 12` ⇒ `'@supports ' + text + ' {' + <内层递归渲染> + '}'`；
* `type 3 / 5 / 6 / 7 / 8` ⇒ **原样输出 `text`**（字体名、动画名、分页、`@import` 都不进作用域）。

**`type 1` 的三步（顺序不能调）**

```
rootSelectorRE    = /((?:[^\\w\\-.#]|^)(body|html|:root))/gm
rootCombinationRE = /(html[^\\w{[]+)/gm
siblingSelectorRE = /(html[^\\w{]+)(\\+|~)/gm
```

1. 若 `selectorText` 恰好是 `html` / `body` / `:root` ⇒ 把整条原文里所有
   `rootSelectorRE` 的匹配**替换成 `prefix`**，结束。
2. 若 `rootCombinationRE.test(selectorText)` 且 **不**满足 `siblingSelectorRE.test(selectorText)`
   ⇒ `css = css.replace(rootCombinationRE, '')`（剥掉 `html...` 前缀）。
   `html + body` / `html ~ body` 就是被这条例外**跳过剥前缀**的——但注意它**接下来照样进第 3 步**。
3. 取整条原文里"到最后一个 `{` 为止"的段（`/^[\\s\\S]+{/`，**无 m 标志**，`^` 只锚串首），
   把它按 `/(^|,\\n?)([^,]+)/g` 逐段处理（`item` = 整段，`p` = 第 1 组，`s` = 第 2 组）：
   * 若 `rootSelectorRE.test(item)` ⇒ 对 `item` 跑 `replace(rootSelectorRE, m => ...)`：
     匹配首字符是 `,` 或 `(` 时返回 `m[0] + prefix`（**不许吃掉前一个合法字符**，
     这就是 `body,html` 与 `*:not(:root)` 不被破坏的原因），否则只返回 `prefix`；
   * 否则 ⇒ 返回 `` `${p}${prefix} ${s.replace(/^ */, '')}` ``。

**契约**：`scopeCss` 必须是纯函数——同一份输入喂两次结果一字不差，且**不得就地改动入参数组**
（对应源码里 `ScopedCSS.ModifiedTag` 的"同一个 style 节点只改写一次"意图）。
`rules` 里出现 `CSSRule.type` 取值表之外的类型 ⇒ `throw new Error('unknown css rule type')`；
`rules` 不是数组 ⇒ `rules must be an array`；`prefix` 是空串 ⇒ `prefix must be a non-empty string`。

> **用例保证的输入约束**：`declarations` 内不含 `{`、`}`、`html`、`body`、`:root` 字样，
> 也不含换行。因此"只在 selector 段上做替换"与"在整条 cssText 上跑同样的正则"两种写法**结果等价**，
> 本题不区分。

## 消息常量表（逐字比对；这是基座团队自己维护的常量，不是要你背 qiankun）

| 代号 | 文本 |
| --- | --- |
| `W_PROXY` | `[qiankun] Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox` |
| `W_SINGULAR` | `[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy` |
| `W_SPEEDY` | `[qiankun] Speedy mode will turn off as const destruct assignment not supported in current browser!` |
| `W_SHADOW` | `[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!` |
| `E_STRICT` | `strictStyleIsolation can not be used with legacy render!` |
| `E_EXPERIMENTAL` | `experimentalStyleIsolation can not be used with legacy render!` |

不许引入第三方依赖。"""

ANSWER_Q1 = """## 参考答案要点

两个函数都是**查表 + 顺序敏感**，没有算法。分数的三个来源全在"顺序"上：
**出口的类别**（抛 / 忽略 / 降级）、**分支的互斥**（无 Proxy 时不再判 speedy）、
**改写的例外清单**（哪些根选择器被替换而不是加前缀）。

**`resolveIsolation` 的四条硬判分点**

1. **legacy render 抛错，shadow dom 不抛**。这是全题最贵的一格：
   `strictStyleIsolation` 在不支持 shadow dom 的环境里是 `console.warn` 后**继续跑**
   （`createElement` 里那条），而子应用自带 `render` 时是 `getAppWrapperGetter` 里
   `throw new QiankunError(...)` —— 同一个配置项，一个静默一个致命。
   **两者都进 `thrown`** 或**两者都进 `warnings`** 的实现都会在"静默降级"与"硬失败"里各挂一条。
2. **两档互斥，strict 赢**（`isEnableScopedCSS` 里明写 `if (sandbox.strictStyleIsolation) return false`）。
   所以"两档同开 + legacy render"只抛 **strict 那条**，且 `scopedCss` 必须是 `false`、
   `containerAttr` 必须是 `null`。写成 `scopedCss = strict || experimental` 的实现挂三处。
3. **`singular` 不许被改**。v2.10.16 的 `autoDowngradeForLowVersionBrowser` 在无 Proxy 时只做两件事：
   把 `sandbox` 改写成 `{loose:true}`、以及**警告**。它**没有**改 `singular`——
   与 FAQ 那句"qiankun 会自动将 singular 配置为 true"是**不一致**的，本题按源码判。
   （素材 §6 表末尾专门写了这条冲突，出处是素材 F2 vs F6。）
4. **降级分支先 return，speedy 那条不会被执行**。所以
   `hasProxy:false + hasConstDestructAssignment:false` 只有一条 `W_PROXY`，
   **没有** `W_SPEEDY`。写成两个独立 `if` 的实现多出一条告警。
   顺带：无 Proxy 时 speedy 名义上还是开的（源码 `speedy !== false` 的判定发生在
   `loadApp` 里读**降级之后**的 sandbox，而降级只是加了 `loose`）。

**另外三处容易写反的方向**

* **`containerAttr` 与 `thrown` 可以同时非空**：`data-qiankun` 是在 `createElement` 里写的，
  抛错发生在随后取 wrapper 时。把"抛错了所以没容器标识"当成常识就会挂这一格。
* **`loose` 只在有 Proxy 时才有意义**：无 Proxy 时不管 `loose` 是什么都是 `Snapshot`。
  用 `loose ? 'LegacyProxy' : 'Proxy'` 开头、把 Proxy 判定放在后面的写法会漏掉这条。
* **实例 id 的偏置**：`genAppInstanceIdByName` 首次返回 `appName` 本身，第二次先自增再拼接，
  所以第 3 次是 `react16_2` 而不是 `react16_3`。差一是这类计数器最典型的 off-by-one。

**`scopeCss` 的判分核心是"三个不是"**

* **不是"全都加前缀"**：`@font-face` / `@keyframes` / `@import` / `@page` 走 `default` 分支原样输出。
  这正是"开了 `experimentalStyleIsolation`，子应用的图标字体还是把主应用改了"的根因——
  **字体名与动画名是全局的，scoped css 管不到**。
* **不是"根选择器也加前缀"**：`html` / `body` / `:root` 是被**替换**成 prefix（"根样式落到容器上"）。
  所以 `html {margin: 0}` 出来是 `div[data-qiankun="react16"] {margin: 0}`，
  写成 `prefix + ' html'` 的选择器永远不会命中（div 里没有 html 后代）——
  **配置生效了但样式全丢**，是最难查的那种坏法。
* **`html + body` 不是"原样"**：源码里 `siblingSelectorRE` 那条注释
  （"transformer will ignore it"）说的是**跳过"剥 html 前缀"这一步**，
  不是"整条规则不处理"。它随后照样进第 3 步，于是 `html` 与 `body` 两个根匹配
  **各自被替换成 prefix**，得到 `prefix + ' + ' + prefix`。
  （素材 §6 行 2 把这条写成"原样"，与 v2.10.16 源码不符，本题按源码判。）

**两个实现细节才是真门槛**

* **带 `g` 标志的正则不能提到模块作用域复用**。`rootSelectorRE.test(...)` 会推进 `lastIndex`，
  下一次 `replace` 虽然会重置，但 `rootCombinationRE.test()` + 下一条规则再 `test()` 就会漏判。
  源码把三个正则**声明在函数体内**正是为此。 hoist 出去复用 ⇒ 多条规则连喂时结果依赖调用顺序，
  而本题的用例恰好每条都新建一次，所以只有"组选择器"那条会暴露它。
* **`whitePrevChars = [',', '(']`**：`body,html` 里 `html` 的匹配串是 `,html`，
  若直接返回 prefix 就把逗号吃了（`div,PREFIX,PREFIX` 变成合法但**少一段**的选择器）；
  `*:not(:root)` 里匹配串是 `(:root`，吃掉 `(` 会产出非法 CSS。
  所以"首字符是 `,` 或 `(` 时要把它还回去"。`*:not(:root)` 这条用例专门打这一点。

**工程延伸（面试追问点）**

1. 既然 scoped css 挡不住 `@font-face` / `@keyframes`，你怎么办？
   （不改构建链的止血：基座给主应用的 antd 前缀做 `@ant-prefix` modifyVars +
   `ConfigProvider prefixCls`，把命名空间冲突面缩小；根治：构建期给子应用的
   字体名与动画名加前缀（`postcss-modules` / `css-modules` 的 `generateScopedName` 同族做法），
   或把字体走 CDN 绝对路径。`LINK` 引入的样式表更直接——
   源码只对 `<style>` 生效，`<link>` 只 `console.warn('Feature: sandbox.experimentalStyleIsolation is not support for link element yet.')`。）
2. 为什么"抛错"要设计成延迟到取 wrapper 时才抛，而不是 `loadApp` 入口就校验？
   （`getAppWrapperGetter` 每次 mount/unmount 都会被调，抛错点贴近真实使用；
   代价是**错误发生在异步链路深处**，表现为"应用 died in status ..."而不是配置期报错。
   基座团队的做法是在 `registerMicroApps` 之前把这些组合校验前移成一道 lint/CI 检查。）
3. 这个决策器该放前端还是服务端？
   （`hasProxy` / `hasConstDestructAssignment` 是**浏览器能力**，只能在运行时探；
   但"哪个子应用用哪档隔离"是**基座配置**，必须由服务端下发并版本化，
   否则同一个子应用在灰度批次里拿到不同档位，样式表现会随用户命中的配置漂移。）
4. 怎么防止新增一档隔离时这里失配？
   （给这张决策表写**契约测试**：把 `{hasProxy, sandbox 的 5 个开关, legacyRender, supportsShadowDOM}`
   的笛卡尔积全跑一遍，断言"每个输入恰好命中一个出口类别，且 `warnings` 与 `thrown` 不同时包含
   同一条文案"。加档位时它会红，而不是靠 code review。本仓库的 `naiveSolution` 就是被
   这种测试筛出来的一次"看起来能跑"的实现。）"""

REFERENCE_Q1 = r'''export const STRICT_MSG = 'strictStyleIsolation can not be used with legacy render!';
export const EXPERIMENTAL_MSG = 'experimentalStyleIsolation can not be used with legacy render!';
const W_PROXY = '[qiankun] Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox';
const W_SINGULAR =
  '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy';
const W_SPEEDY =
  '[qiankun] Speedy mode will turn off as const destruct assignment not supported in current browser!';
const W_SHADOW =
  '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!';

export interface SandboxCfg {
  strictStyleIsolation?: boolean;
  experimentalStyleIsolation?: boolean;
  loose?: boolean;
  speedy?: boolean;
}

export interface IsolationInput {
  hasProxy: boolean;
  hasConstDestructAssignment: boolean;
  supportsShadowDOM: boolean;
  /** 子应用提供了自定义 render（旧渲染），不是指 sandbox:false */
  legacyRender: boolean;
  sandbox?: true | false | SandboxCfg;
  singular?: boolean;
  appName: string;
  instanceSeq: number;
}

export interface IsolationView {
  sandboxType: 'Proxy' | 'LegacyProxy' | 'Snapshot' | 'None';
  singular: boolean;
  scopedCss: boolean;
  shadowWrapped: boolean;
  containerAttr: string | null;
  warnings: string[];
  thrown: string[];
}

const isBool = (v: unknown): boolean => typeof v === 'boolean';

export function resolveIsolation(input: IsolationInput): IsolationView {
  if (input === null || input === undefined) throw new Error('input must be an object');
  const raw = input as unknown as Record<string, unknown>;
  let sandbox: true | false | SandboxCfg = raw.sandbox === undefined ? true : (raw.sandbox as SandboxCfg);
  if (sandbox !== true && sandbox !== false && typeof sandbox !== 'object') {
    throw new Error('unknown sandbox configuration');
  }
  if (!isBool(raw.hasProxy)) throw new Error('hasProxy must be a boolean');
  if (!isBool(raw.hasConstDestructAssignment)) throw new Error('hasConstDestructAssignment must be a boolean');
  if (!isBool(raw.supportsShadowDOM)) throw new Error('supportsShadowDOM must be a boolean');
  if (!isBool(raw.legacyRender)) throw new Error('legacyRender must be a boolean');
  if (raw.singular !== undefined && !isBool(raw.singular)) throw new Error('singular must be a boolean');
  if (typeof raw.appName !== 'string' || raw.appName === '') throw new Error('appName must be a non-empty string');
  if (typeof raw.instanceSeq !== 'number' || !Number.isInteger(raw.instanceSeq) || raw.instanceSeq < 1) {
    throw new Error('instanceSeq must be a positive integer');
  }
  const hasProxy = raw.hasProxy as boolean;
  const hasConst = raw.hasConstDestructAssignment as boolean;
  const supportsShadowDOM = raw.supportsShadowDOM as boolean;
  const singular = (raw.singular === undefined ? true : raw.singular) as boolean;

  const warnings: string[] = [];
  // --- autoDowngradeForLowVersionBrowser：两条分支互斥，无 Proxy 那条先 return
  if (sandbox) {
    if (!hasProxy) {
      warnings.push(W_PROXY);
      if (raw.singular === false) warnings.push(W_SINGULAR);
      sandbox = { ...(typeof sandbox === 'object' ? sandbox : {}), loose: true };
    } else if (!hasConst && (sandbox === true || (sandbox as SandboxCfg).speedy !== false)) {
      warnings.push(W_SPEEDY);
      sandbox = { ...(sandbox as SandboxCfg), speedy: false };
    }
  }

  let sandboxType: IsolationView['sandboxType'] = 'None';
  if (sandbox) {
    sandboxType = !hasProxy ? 'Snapshot' : ((sandbox as SandboxCfg).loose ? 'LegacyProxy' : 'Proxy');
  }

  // isEnableScopedCSS：strict 开着时 experimental 不生效（两档互斥，strict 赢）
  const strict = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;
  const scopedCss = typeof sandbox === 'object' && !strict && !!sandbox.experimentalStyleIsolation;

  const thrown: string[] = [];
  if (raw.legacyRender) {
    if (strict) thrown.push(STRICT_MSG);
    else if (scopedCss) thrown.push(EXPERIMENTAL_MSG);
  }

  let shadowWrapped = false;
  if (strict) {
    if (supportsShadowDOM) shadowWrapped = true;
    else warnings.push(W_SHADOW);
  }

  const seq = raw.instanceSeq as number;
  const appInstanceId = seq === 1 ? (raw.appName as string) : raw.appName + '_' + (seq - 1);

  return {
    sandboxType,
    singular,
    scopedCss,
    shadowWrapped,
    containerAttr: scopedCss ? appInstanceId : null,
    warnings,
    thrown,
  };
}

export interface CssRule {
  type: number;
  text: string;
  declarations?: string;
  rules?: CssRule[];
}

/**
 * ScopedCSS.ruleStyle 的逐行对应实现（v2.10.16 src/sandbox/patchers/css.ts L121-173）。
 * 三个正则**必须每次新建**：带 g 标志的正则 .test() 会推进 lastIndex，
 * 提到模块作用域复用会让多条规则连喂时结果依赖调用顺序。
 */
function ruleStyle(css: string, selector: string, prefix: string): string {
  const rootSelectorRE = /((?:[^\w\-.#]|^)(body|html|:root))/gm;
  const rootCombinationRE = /(html[^\w{[]+)/gm;

  // handle html { ... } / body { ... } / :root { ... }
  if (selector === 'html' || selector === 'body' || selector === ':root') {
    return css.replace(rootSelectorRE, prefix);
  }

  // handle html body { ... } / html > body { ... }
  if (rootCombinationRE.test(selector)) {
    const siblingSelectorRE = /(html[^\w{]+)(\+|~)/gm;
    // since html + body is a non-standard rule for html, transformer will ignore it
    if (!siblingSelectorRE.test(selector)) {
      css = css.replace(rootCombinationRE, '');
    }
  }

  // handle grouping selector, a,span,p,div { ... }
  return css.replace(/^[\s\S]+{/, (selectors) =>
    selectors.replace(/(^|,\n?)([^,]+)/g, (item, p, s) => {
      const rootRE = /((?:[^\w\-.#]|^)(body|html|:root))/gm;
      if (rootRE.test(item)) {
        return item.replace(rootRE, (m) => {
          // do not discard valid previous character, such as body,html or *:not(:root)
          const whitePrevChars = [',', '('];
          if (m && whitePrevChars.includes(m[0])) {
            return `${m[0]}${prefix}`;
          }
          return prefix;
        });
      }
      return `${p}${prefix} ${s.replace(/^ */, '')}`;
    }),
  );
}

function rewrite(rules: CssRule[], prefix: string): string {
  let css = '';
  rules.forEach((rule) => {
    if (rule === null || typeof rule !== 'object') throw new Error('css rule must be an object');
    if (typeof rule.type !== 'number' || !Number.isInteger(rule.type)) throw new Error('unknown css rule type');
    if (typeof rule.text !== 'string') throw new Error('css rule text must be a string');
    switch (rule.type) {
      case 1:
        if (typeof rule.declarations !== 'string') throw new Error('style rule needs declarations');
        css += ruleStyle(rule.text + ' ' + rule.declarations, rule.text, prefix);
        break;
      case 4:
        css += `@media ${rule.text} {${rewrite(rule.rules ?? [], prefix)}}`;
        break;
      case 12:
        css += `@supports ${rule.text} {${rewrite(rule.rules ?? [], prefix)}}`;
        break;
      case 3:
      case 5:
      case 6:
      case 7:
      case 8:
        css += `${rule.text}`;
        break;
      default:
        throw new Error('unknown css rule type');
    }
  });
  return css;
}

export function scopeCss(rules: CssRule[], prefix: string): string {
  if (!Array.isArray(rules)) throw new Error('rules must be an array');
  if (typeof prefix !== 'string' || prefix === '') throw new Error('prefix must be a non-empty string');
  return rewrite(rules, prefix);
}
'''

NAIVE_Q1 = r'''export function resolveIsolation(input: any): any {
  // "一律 warn"版：三种出口（抛错 / 忽略 / 降级）被压进同一个 warnings 数组。
  // 症状：legacy render 下只 warn（线上表现是"隔离配了没生效、也没人报错"），
  // 且照着 FAQ 把 singular 改成 true（v2.10.16 源码其实只警告不改值）。
  const warnings: string[] = [];
  const sandbox = input?.sandbox === undefined ? true : input.sandbox;
  const cfg = typeof sandbox === 'object' ? sandbox : {};
  const strict = !!cfg.strictStyleIsolation;
  const scoped = !!cfg.experimentalStyleIsolation;
  let singular = input?.singular !== false;
  if (!input?.hasProxy) {
    warnings.push('[qiankun] Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox');
    singular = true;
  }
  if (!input?.hasConstDestructAssignment) {
    warnings.push('[qiankun] Speedy mode will turn off as const destruct assignment not supported in current browser!');
  }
  if (strict && !input?.supportsShadowDOM) {
    warnings.push('[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!');
  }
  if (input?.legacyRender && (strict || scoped)) {
    warnings.push('style isolation can not be used with legacy render!');
  }
  return {
    sandboxType: input?.hasProxy ? (cfg.loose ? 'LegacyProxy' : 'Proxy') : 'Snapshot',
    singular,
    scopedCss: strict || scoped,
    shadowWrapped: strict,
    containerAttr: scoped ? input?.appName : null,
    warnings,
    thrown: [],
  };
}

export function scopeCss(rules: any[], prefix: string): string {
  // "给每条规则都加前缀"版：例外清单与"根选择器是被替换"这两条都没有。
  let css = '';
  rules.forEach((rule) => {
    if (rule.type === 1) {
      css += prefix + ' ' + rule.text + ' ' + rule.declarations;
    } else if (rule.type === 4 || rule.type === 12) {
      css += '@media ' + rule.text + ' {' + scopeCss(rule.rules ?? [], prefix) + '}';
    } else {
      css += prefix + ' ' + rule.text;
    }
  });
  return css;
}
'''


# ===================================================================== 落盘 / 自检
def gen_all():
    out = {}
    for key, fn in DRAFTS.items():
        q = fn()
        if 'id' in q:
            raise AssertionError('%s: 草稿不该自带 id（入库时由 ingest 按类别顺序分配）' % key)
        for c in q.get('cases') or []:
            if c.get('expected') is None and not c.get('expectThrow'):
                raise AssertionError('%s/%s: expected 为 null 却没声明 expectThrow' % (key, c['name']))
        names = [c['name'] for c in q.get('cases') or []]
        if len(names) != len(set(names)):
            raise AssertionError('%s: 用例名重复，判题器按名字回收结果会串台' % key)
        if len(names) < 3:
            raise AssertionError('%s: 只有 %d 个用例（约定至少 3 个）' % (key, len(names)))
        runner = q.get('runner') or {}
        if not runner.get('naiveSolution'):
            raise AssertionError('%s: 缺 naiveSolution（能跑但必然错的解，证明判题器不是橡皮图章）' % key)
        if not any(re.search(r'\.(test|spec)\.(tsx|ts)$', f['path']) for f in runner.get('files') or []):
            raise AssertionError('%s: runner.files 里没有 *.test.ts(x)，react-vitest 判题器收不到结果' % key)
        if len(q.get('tags') or []) > 6:
            raise AssertionError('%s: 标签超过 6 个' % key)
        out[key] = q
    return out


DRAFT_FREE_FIELDS = ('id', 'schemaVersion')


def strip_ingested(q):
    out = {k: v for k, v in q.items() if k not in DRAFT_FREE_FIELDS}
    out['source'] = {k: v for k, v in (out.get('source') or {}).items() if k != 'ingestedAt'}
    if 'cases' in out:
        out['cases'] = [{k: v for k, v in c.items() if k != 'visible'} for c in (out.get('cases') or [])]
    runner = out.get('runner')
    if isinstance(runner, dict):
        runner = dict(runner)
        for key, value in (('entry', 'function'), ('orderSensitive', False), ('timeoutMs', 20000)):
            runner.setdefault(key, value)
        out['runner'] = runner
    return out


def bank_by_statement():
    out = {}
    root = os.path.join(BANK_DIR)
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            if not name.endswith('.json'):
                continue
            with io.open(os.path.join(dirpath, name), encoding='utf-8') as fh:
                q = json.load(fh)
            out.setdefault(q.get('statement'), []).append((q.get('id'), q))
    return out


RUNNER_DEFAULTS = {'entry': 'function', 'orderSensitive': False, 'timeoutMs': 20000}


def fill_defaults(q):
    """草稿侧补齐 zod 会写进库文件的默认值 —— 与 check_provenance.py 同一段判据，别另立。"""
    runner = q.get('runner')
    if isinstance(runner, dict):
        for key, value in RUNNER_DEFAULTS.items():
            runner.setdefault(key, value)
    return q


def check(drafts):
    """与已入库的题逐字段比对：改了库里的题却没改模型（或反之）都会在这里红。"""
    bank = bank_by_statement()
    bad, matched, pending = [], 0, []
    for key, q in drafts.items():
        hits = bank.get(q['statement'])
        if not hits:
            pending.append(key)
            continue
        bid, bq = hits[0]
        expect = strip_ingested(bq)
        got = fill_defaults(q)
        if dump(expect) != dump(got):
            diff = sorted(k for k in set(expect) | set(got)
                          if dump(expect.get(k, '@')) != dump(got.get(k, '@')))
            bad.append('%s ↔ %s: 不一致字段 %s' % (key, bid, diff))
        else:
            matched += 1
    return matched, bad, pending


def main(argv):
    drafts = gen_all()
    if '--list' in argv:
        for key in sorted(drafts):
            q = drafts[key]
            print('%-28s %s / %d 用例' % (key, q['judgeKind'], len(q['cases'])))
        return 0

    os.makedirs(OUT_DIR, exist_ok=True)
    for key in sorted(drafts):
        path = os.path.join(OUT_DIR, key + '.json')
        with io.open(path, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(drafts[key], fh, ensure_ascii=False, indent=2)
            fh.write('\n')
        print('  草稿 %-28s %d 用例 → %s' % (key, len(drafts[key]['cases']),
                                              os.path.relpath(path, ROOT).replace(os.sep, '/')))
    print('共写出 %d 份草稿' % len(drafts))

    if '--check' in argv:
        matched, bad, pending = check(drafts)
        for line in bad:
            print('DRIFT ' + line)
        print('[ab-fe --check] 与库内逐字段一致 %d 道｜漂移 %d 道｜未入库候选 %d 道（%s）'
              % (matched, len(bad), len(pending), ', '.join(sorted(pending)) or '—'))
        return 1 if bad else 0
    return 0




# ============================================================= Q2 的时间线模型
#
# 这份模型就是 expected 的唯一来源：它模拟 ahooks `Fetch.runAsync` 的
# `count / currentCount` 裁决 ＋ `usePollingPlugin` 的"完成后再等 interval"与连续失败计数。
# 生成出来的 *.test.tsx 里每一步 `advanceTimersByTimeAsync(delta)` 推进的虚拟时钟
# 与模型推进的是同一串数字 —— 所以"手算时间轴"这件事在本仓库里不需要存在。
class _Sim:
    def __init__(self, script, options):
        self.script = script            # [{delay, fail?}] 按调用序取，用完重复最后一条
        self.opts = dict(options)
        for s in script:
            if not isinstance(s.get('delay'), int) or s['delay'] <= 0:
                raise AssertionError('service 脚本的 delay 必须是正整数（0 会让事件同刻撞车）')
        if self.opts.get('pollingInterval'):
            if not isinstance(self.opts['pollingInterval'], int) or self.opts['pollingInterval'] <= 0:
                raise AssertionError('pollingInterval 要么是 0/省略，要么是正整数')
        self.t = 0
        self.count = 0
        self.params = []
        self.state = {'loading': not self.opts.get('manual', False),
                      'data': None, 'error': None}
        self.calls = []
        self.events = []
        self.pending = []
        self.timer = None
        self.sub = False
        self.hidden = False
        self.err_count = 0

    # ---- 基础动作 -----------------------------------------------------------
    def _stop_polling(self):
        self.timer = None
        self.sub = False

    def _start(self, args, async_call):
        """对应 runAsync：count 先自增，loading 置真（**不清 data/error**），同步调用 service。"""
        self.count += 1
        cc = self.count
        self._stop_polling()
        self.params = list(args)
        self.state['loading'] = True
        key = ','.join(str(a) for a in args)
        self.calls.append(key)
        if len(self.calls) > len(self.script):
            raise AssertionError('用例的 service 脚本不够用（调了 %d 次，只准备了 %d 条）'
                                 % (len(self.calls), len(self.script)))
        spec = self.script[len(self.calls) - 1]
        self.pending.append({'cc': cc, 'at': self.t + spec['delay'],
                             'fail': bool(spec.get('fail')), 'key': key,
                             'idx': len(self.calls), 'async': async_call})

    def _schedule(self, at):
        interval = self.opts.get('pollingInterval', 0)
        if not interval:
            return
        retry = self.opts.get('pollingErrorRetryCount', -1)
        if retry == -1 or self.err_count <= retry:
            self.timer = at + interval
        else:
            self.err_count = 0
            self.timer = None

    def _settle(self, p):
        if p['cc'] != self.count:
            # 竞态裁决发生在 setState **之前**：旧请求连 loading:false 都不会写
            if p['async']:
                self.events.append('reject:CancelledError')
            return
        if not p['fail']:
            data = '#%d:%s' % (p['idx'], p['key'])
            self.state = dict(self.state, data=data, error=None, loading=False)
            self.events.append('success:' + data)
            self.err_count = 0
            self.events.append('finally:ok:' + data)
            if p['async']:
                self.events.append('resolved:' + data)
            self._schedule(p['at'])
        else:
            message = 'svc-' + p['key']
            self.state = dict(self.state, error=message, loading=False)
            self.events.append('error:' + message)
            self.err_count += 1
            self.events.append('finally:err:' + message)
            if p['async']:
                self.events.append('reject:Error')
            self._schedule(p['at'])

    def _fire_timer(self):
        self.timer = None
        if not self.opts.get('pollingWhenHidden', True) and self.hidden:
            self.sub = True
            return
        self._start(self.params, False)

    def _visible_event(self):
        if not self.sub:
            return
        self.sub = False
        self._start(self.params, False)

    def _merge(self, patch):
        self.opts = dict(self.opts, **patch)
        if patch.get('pollingInterval') is not None and not self.opts.get('pollingInterval'):
            self._stop_polling()

    # ---- 时钟 ---------------------------------------------------------------
    def advance_to(self, target):
        while True:
            soon = None
            if self.pending:
                soon = min(p['at'] for p in self.pending)
            if self.timer is not None:
                soon = self.timer if soon is None else min(soon, self.timer)
            if soon is None or soon > target:
                break
            self.t = soon
            for p in [x for x in self.pending if x['at'] == soon]:
                self.pending.remove(p)
                self._settle(p)
            if self.timer is not None and self.timer == soon:
                self._fire_timer()
        self.t = max(self.t, target)

    def snapshot(self):
        return {
            'loading': '1' if self.state['loading'] else '0',
            'data': '-' if self.state['data'] is None else self.state['data'],
            'error': '-' if self.state['error'] is None else self.state['error'],
            'calls': '|'.join(self.calls) or '-',
            'events': '|'.join(self.events) or '-',
        }


# ================================================================= Q2 的用例程序
# program 里的每条指令都由同一个 walker 同时喂给模型（算 expected）与 JS 生成器
# （写进测试文件）。分两处写必然漂移，所以这里**只允许一个 walker**。
SLOW = {'delay': 900}
FAST = {'delay': 100}


def _spec(label, argsets, script, options, program, note=None):
    sim = _Sim(script, options)
    tl = ['    let view: ReturnType<typeof render>;',
          '    const service = makeService(%s);' % js(script)]
    checks = []
    needs_settle = True

    def opts_literal():
        return js(sim.opts)

    def emit_mount():
        tl.append('    view = render(<Probe service={service} options={wire(%s)} argsets={%s} />);'
                  % (opts_literal(), js(argsets)))

    for op in program:
        kind = op[0]
        if kind == 'mount':
            if not sim.opts.get('manual', False):
                sim._start(sim.opts.get('defaultParams') or [], False)
            emit_mount()
            needs_settle = True
        elif kind == 'rerender':
            sim._merge(op[1])
            tl.append('    view.rerender(<Probe service={service} options={wire(%s)} argsets={%s} />);'
                      % (opts_literal(), js(argsets)))
            needs_settle = True
        elif kind == 'click':
            sim._start(argsets[op[1]], False)
            tl.append("    fireEvent.click(screen.getByTestId(%s));" % js('run-%d' % op[1]))
            needs_settle = True
        elif kind == 'aclick':
            sim._start(argsets[op[1]], True)
            tl.append("    fireEvent.click(screen.getByTestId(%s));" % js('async-%d' % op[1]))
            needs_settle = True
        elif kind == 'cancel':
            sim.count += 1
            sim.state = dict(sim.state, loading=False)
            sim._stop_polling()
            tl.append("    fireEvent.click(screen.getByTestId('cancel'));")
            needs_settle = True
        elif kind == 'hide':
            sim.hidden = True
            tl.append('    await act(async () => { applyHidden(true); });')
            needs_settle = True
        elif kind == 'show':
            sim.hidden = False
            sim._visible_event()
            tl.append('    await act(async () => { applyHidden(false); });')
            needs_settle = True
        elif kind == 'to':
            if sim.t > op[1]:
                raise AssertionError('%s：时间只能前进（%d → %d）' % (label, sim.t, op[1]))
            delta = op[1] - sim.t
            tl.append('    await tick(%d);  // t=%d' % (delta, op[1]))
            sim.advance_to(op[1])
            needs_settle = False
        elif kind == 'assert':
            # 每次都先做一次零长度推进：把"promise 落地 → .catch → 调用方 .then"这条
            # 微任务链彻底排空，否则 reject:/resolved: 可能还没落进 log 就被读走了。
            tl.append('    await tick(0);')
            obs = sim.snapshot()
            checks.append({'t': sim.t, 'obs': obs})
            tl.append('    // t=%d' % sim.t)
            tl.append('    expect(obs()).toEqual(%s);' % js(obs))
            needs_settle = False
        else:
            raise AssertionError('未知指令 %r' % (kind,))
    body = ['  it(%s, async () => {' % js(label)] + tl + ['  });']
    case = {'name': label,
            'input': {'options': options, 'argsets': argsets,
                      'script': script,
                      'program': [list(o) for o in program]},
            'expected': checks}
    if note:
        case['note'] = note
    return case, body


Q2_CASES = [
    dict(
        label='竞态：后发先至时，先发的那条既不写 data 也不报告任何东西',
        argsets=[['slow'], ['fast']],
        script=[{'delay': 900}, {'delay': 100}],
        options={'manual': True, 'pollingInterval': 0},
        program=[['mount'], ['click', 0], ['to', 100], ['assert'],
                 ['click', 1], ['to', 200], ['assert'], ['to', 950], ['assert']],
        note='F20：`if (currentCount !== this.count) throw new CancelledError()` 位于 setState 之前',
    ),
    dict(
        label='竞态：被覆盖的 runAsync 以 CancelledError reject，而不是静默成功',
        argsets=[['slow'], ['fast']],
        script=[{'delay': 900}, {'delay': 100}],
        options={'manual': True, 'pollingInterval': 0},
        program=[['mount'], ['aclick', 0], ['to', 100], ['aclick', 1],
                 ['to', 200], ['assert'], ['to', 950], ['assert']],
    ),
    dict(
        label='竞态反向：先发的那条自身失败，也只能以 CancelledError reject（业务错误被吞）',
        argsets=[['boom'], ['ok']],
        script=[{'delay': 400, 'fail': True}, {'delay': 150}],
        options={'manual': True, 'pollingInterval': 0},
        program=[['mount'], ['aclick', 0], ['to', 100], ['aclick', 1],
                 ['to', 250], ['assert'], ['to', 450], ['assert']],
        note='素材 F13 原话："即使它自身的 promise 是以 service 错误 reject 的，被覆盖的调用也只会以 CancelledError reject"',
    ),
    dict(
        label='cancel 只让结果不可见：不中止 promise、不清 data、loading 立刻归位',
        argsets=[['p']],
        script=[{'delay': 500}],
        options={'manual': True, 'pollingInterval': 0},
        program=[['mount'], ['aclick', 0], ['to', 100], ['assert'],
                 ['cancel'], ['to', 200], ['assert'], ['to', 600], ['assert']],
    ),
    dict(
        label='轮询：下一次在"上一次完成 + interval"才发，不是从发起时刻起算',
        argsets=[['p']],
        script=[{'delay': 100}] * 4,
        options={'manual': True, 'pollingInterval': 1000},
        program=[['mount'], ['click', 0], ['to', 100], ['assert'],
                 ['to', 1000], ['assert'], ['to', 1100], ['assert'],
                 ['to', 1200], ['assert']],
    ),
    dict(
        label='轮询：请求比 interval 还慢时自动串行化，不会叠加并发',
        argsets=[['p']],
        script=[{'delay': 1500}] * 3,
        options={'manual': True, 'pollingInterval': 1000},
        program=[['mount'], ['click', 0], ['to', 1000], ['assert'],
                 ['to', 1500], ['assert'], ['to', 2000], ['assert'],
                 ['to', 2500], ['assert']],
    ),
    dict(
        label='pollingErrorRetryCount:2 ⇒ 容忍 2 次，第 3 次连续失败才停（判据是 <=）',
        argsets=[['p']],
        script=[{'delay': 100, 'fail': True}] * 5,
        options={'manual': True, 'pollingInterval': 1000, 'pollingErrorRetryCount': 2},
        program=[['mount'], ['click', 0], ['to', 3400], ['assert'],
                 ['to', 8000], ['assert']],
    ),
    dict(
        label='失败计数是"连续"：中途成功一次就归零，总失败 3 次也只按 1 次算',
        argsets=[['p']],
        script=[{'delay': 100, 'fail': True}, {'delay': 100},
                {'delay': 100, 'fail': True}, {'delay': 100, 'fail': True},
                {'delay': 100}],
        options={'manual': True, 'pollingInterval': 1000, 'pollingErrorRetryCount': 1},
        program=[['mount'], ['click', 0], ['to', 6000], ['assert']],
        note='F23：onError 计数 +1、onSuccess 归零',
    ),
    dict(
        label='pollingErrorRetryCount 默认 -1 ⇒ 无限次：连错 5 次也还在轮询',
        argsets=[['p']],
        script=[{'delay': 100, 'fail': True}] * 6,
        options={'manual': True, 'pollingInterval': 1000},
        program=[['mount'], ['click', 0], ['to', 4600], ['assert']],
    ),
    dict(
        label='pollingWhenHidden:false ⇒ 隐藏时不排下一次，重新可见补发一次 refresh',
        argsets=[['p']],
        script=[{'delay': 100}] * 3,
        options={'manual': True, 'pollingInterval': 1000, 'pollingWhenHidden': False},
        program=[['mount'], ['click', 0], ['to', 100], ['assert'],
                 ['hide'], ['to', 3000], ['assert'],
                 ['show'], ['to', 3200], ['assert']],
    ),
    dict(
        label='pollingWhenHidden 默认 true ⇒ 页面隐藏也照打服务端（SRE 投诉的那条）',
        argsets=[['p']],
        script=[{'delay': 100}] * 3,
        options={'manual': True, 'pollingInterval': 1000},
        program=[['mount'], ['click', 0], ['hide'], ['to', 1300], ['assert']],
    ),
    dict(
        label='pollingInterval 默认 0 ⇒ 压根不进入轮询模式',
        argsets=[['p']],
        script=[{'delay': 100}] * 3,
        options={'manual': True},
        program=[['mount'], ['click', 0], ['to', 5000], ['assert']],
    ),
    dict(
        label='pollingInterval 由 0 改成 1000 不会自动启动，必须再 run 一次',
        argsets=[['p']],
        script=[{'delay': 100}] * 3,
        options={'manual': True, 'pollingInterval': 0},
        program=[['mount'], ['click', 0], ['to', 100], ['assert'],
                 ['rerender', {'pollingInterval': 1000}], ['to', 5000], ['assert']],
    ),
    dict(
        label='manual:true 时初始化不启动轮询（哪怕 interval 已经为正）',
        argsets=[['p']],
        script=[{'delay': 100}] * 3,
        options={'manual': True, 'pollingInterval': 1000},
        program=[['mount'], ['to', 3000], ['assert']],
    ),
    dict(
        label='manual 默认 false ⇒ 挂载即跑 defaultParams 并开始轮询，后续复用同一批实参',
        argsets=[['p']],
        script=[{'delay': 100}] * 4,
        options={'pollingInterval': 1000, 'defaultParams': ['p']},
        program=[['mount'], ['to', 1300], ['assert']],
    ),
]


TEST_PREAMBLE = """import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePollingRequest } from './Solution';

/**
 * 断言由 fe_gen.py 里的 _Sim 时间线模型生成，不手算 ——
 * react-vitest 题的判分事实来源就是这份文件，抄错一次就永久错一次。
 *
 * 三个"判题器自己接线"的零件，候选人改不了：
 *   1) service 的耗时/成败由 spec 给定，并把每次调用的实参记进 log.calls；
 *   2) onSuccess/onError/onFinally 由 wire() 覆盖，只负责往 log.events 里追加；
 *   3) 可见性由 applyHidden() 改 document.visibilityState 并派发冒泡的 visibilitychange。
 * 所以本题判的是"该不该调用、什么时候再调用"，不是"文案写得像不像 ahooks"。
 */
type Log = { calls: string[]; events: string[] };
type Step = { delay: number; fail?: boolean };

let log: Log = { calls: [], events: [] };

function makeService(steps: Step[]) {
  return (...args: unknown[]) => {
    const key = args.join(',');
    log.calls.push(key);
    const n = log.calls.length;
    const spec = steps[Math.min(n - 1, steps.length - 1)];
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (spec.fail) reject(new Error('svc-' + key));
        else resolve('#' + n + ':' + key);
      }, spec.delay);
    });
  };
}

function applyHidden(v: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (v ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

function wire(options: Record<string, unknown>) {
  return {
    ...options,
    onSuccess: (data: unknown) => {
      log.events.push('success:' + String(data));
    },
    onError: (e: unknown) => {
      log.events.push('error:' + String((e as Error).message));
    },
    onFinally: (params: unknown[], data: unknown, e: unknown) => {
      const key = (params ?? []).join(',');
      log.events.push(e === undefined ? 'finally:ok:' + String(data) : 'finally:err:svc-' + key);
    },
  };
}

function Probe({ service, options, argsets }: { service: any; options: any; argsets: any[][] }) {
  const res = usePollingRequest<any, any[]>(service, options);
  return (
    <div>
      <span data-testid="loading">{res.loading ? '1' : '0'}</span>
      <span data-testid="data">{res.data === undefined ? '-' : String(res.data)}</span>
      <span data-testid="error">{res.error === undefined ? '-' : String((res.error as Error).message)}</span>
      <span data-testid="calls">{log.calls.join('|') || '-'}</span>
      <span data-testid="events">{log.events.join('|') || '-'}</span>
      {argsets.map((args: unknown[], i: number) => (
        <span key={i}>
          <button data-testid={'run-' + i} onClick={() => res.run(...args)} />
          <button
            data-testid={'async-' + i}
            onClick={() => {
              Promise.resolve(res.runAsync(...args)).then(
                (v: unknown) => log.events.push('resolved:' + String(v)),
                (e: unknown) => log.events.push('reject:' + (e as Error).name),
              );
            }}
          />
        </span>
      ))}
      <button data-testid="cancel" onClick={() => res.cancel()} />
    </div>
  );
}

const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const obs = () => ({
  // loading/data/error 走 DOM：它们只有在 React 真的重渲染后才会变，这正是要判的东西。
  // calls/events 走判题器自己的数组：它们是"外部记账"，不该依赖候选人有没有触发渲染。
  loading: screen.getByTestId('loading').textContent,
  data: screen.getByTestId('data').textContent,
  error: screen.getByTestId('error').textContent,
  calls: log.calls.join('|') || '-',
  events: log.events.join('|') || '-',
});

describe('usePollingRequest：竞态裁决与轮询续期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    log = { calls: [], events: [] };
    applyHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
"""

TEST_EPILOGUE = '});\n'


@draft('ab-fe-userequest-polling')
def q_polling():
    """§6 行 12（★）＋行 13、14：组件级 react-vitest，真跑 React + 假 timer + visibilitychange。"""

    cases = []
    body = [TEST_PREAMBLE]
    for spec in Q2_CASES:
        c, lines = _spec(spec['label'], spec['argsets'], spec['script'], spec['options'],
                         spec['program'], spec.get('note'))
        cases.append(c)
        body.extend(lines)
        body.append('')
    body.append(TEST_EPILOGUE)
    test_file = '\n'.join(body)

    return base(
        'frontend', 'senior',
        '任务状态轮询组件：竞态只认最新那次，轮询是"完成后再等"而不是 setInterval',
        STATEMENT_Q2, 'react-vitest',
        ['request-race', 'polling-semantics', 'async-state-machine',
         'fake-timers', 'modern:data-layer'],
        src('前端工程（中台数据层 / 微前端基座方向） 高级工程师',
            KB + '#6 可判分事实表行 12（★）＋行 13、14（§1.3 竞态裁决与轮询续期，'
            '出处 §8 F13/F20/F21/F14/F23/F24；ahooks 按 alibaba/hooks@master 抓取）'),
        language='typescript',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 90_000,
                'files': [{'path': 'polling.test.tsx', 'content': test_file}],
                'referenceSolution': REFERENCE_Q2, 'naiveSolution': NAIVE_Q2},
        estimatedMinutes=40,
        answer=ANSWER_Q2,
    )


# ===================================================================== Q2 题面 / 题解
STATEMENT_Q2 = """## 背景（版本锚点：ahooks 3.10.0 / `alibaba/hooks@master` 的 `useRequest` 内核）

中台页面里有一个"任务状态"查询：3 秒一次轮询一个任务进度接口。
这类组件最容易写对的是"能转起来"，最容易写错的是**两件事**：

1. **两次调用之间谁的结果可见**（竞态）——不是"谁后到"，是**谁后发起**；
2. **"下一次什么时候发"**（轮询）——不是 `setInterval` 从发起时刻起算，
   而是**上一次完成之后再等 `pollingInterval`**。

这两条都不是风格问题，是判分点：前者决定用户会不会看到过期数据覆盖新数据，
后者决定慢接口会不会被自己叠成 DDoS。

## 你要实现的入口

```ts
export function usePollingRequest<TData = unknown, TParams extends any[] = any[]>(
  service: (...args: TParams) => Promise<TData>,
  options?: Options<TData, TParams>,
): Result<TData, TParams>;
```

```ts
interface Options<TData, TParams> {
  manual?: boolean;                       // 默认 false：挂载时用 defaultParams 自动跑一次
  defaultParams?: TParams;                // 默认 []
  pollingInterval?: number;               // 默认 0；>0 才进入轮询模式
  pollingWhenHidden?: boolean;            // 默认 true
  pollingErrorRetryCount?: number;        // 默认 -1（无限次）
  onSuccess?: (data: TData, params: TParams) => void;
  onError?: (error: Error, params: TParams) => void;
  onFinally?: (params: TParams, data?: TData, error?: Error) => void;
}

interface Result<TData, TParams> {
  loading: boolean;
  data: TData | undefined;
  error: Error | undefined;
  run: (...args: TParams) => void;
  runAsync: (...args: TParams) => Promise<TData>;
  refresh: () => void;                    // 用上一次实参再跑一次（= run(...params)）
  cancel: () => void;
}
```

测试会渲染一个 `<Probe>`（判题器提供，你改不了它），上面有
`loading / data / error / calls / events` 五个 `data-testid`，
以及每个实参组两个按钮（`run-<i>` 走 `run`，`async-<i>` 走 `runAsync` 并把结果记进
`events`）和一个 `cancel` 按钮。`service` 由判题器提供，每次调用把实参记进 `calls`，
在指定毫秒数后 resolve 成 `'#<第几次调用>:<实参>'` 或 reject 成 `new Error('svc-<实参>')`。
`onSuccess / onError / onFinally` 由判题器接线，只会往 `events` 里追加
`success:<data>` / `error:<message>` / `finally:ok:<data>` / `finally:err:<message>`；
`runAsync` 的按钮再追加 `resolved:<data>` 或 `reject:<error.name>`。
（断言时 `loading/data/error` 从 DOM 读，`calls/events` 从判题器的记账数组读 ——
后者是外部事实，不该取决于你有没有触发一次渲染。）

## 语义清单（每一条都有用例）

**A. 竞态裁决**

1. 每次 `run`/`runAsync` 让一个调用计数 +1，并记住这次调用开始时的计数值 `currentCount`。
2. promise 落回时先比 `currentCount` 与当前计数：**不相等就当作"被覆盖"**，
   此时**不写 `data`、不写 `error`、不把 `loading` 置回 false、不触发
   `onSuccess/onError/onFinally`**（裁决发生在写状态**之前**）。
3. 被覆盖的那次调用：`run` **什么都不报告**；`runAsync` 的 promise 以
   **`name === 'CancelledError'` 的 Error** reject。
   ⚠️ 即使这次调用**自身是失败的**（service reject），被覆盖后也只能以 `CancelledError` reject
   —— 业务错误不许浮上来。
4. `cancel()` 只做两件事：让当前计数 +1（于是进行中的调用变成"被覆盖"）、
   把 `loading` 置为 false、并停止轮询。
   **它不会中止 service 的 promise**（那个 promise 照样会落地，只是结果不可见），
   也**不会清空 `data`**。

**B. 轮询续期**

5. 只有 `pollingInterval > 0` 才进入轮询模式；`pollingInterval` 为 `0`/省略时，
   成功与失败都**不**排下一次。
6. 排期时机：**本次落回的时刻 + `pollingInterval`**（不是发起时刻，也不是固定频率）。
7. 续期用 `refresh()`，即**复用上一次 `run`/`runAsync` 的实参**。
8. 连续失败计数：失败 +1、**成功归零**。设了 `pollingErrorRetryCount = n` 时，
   落回后按 `n === -1 || 连续失败数 <= n` 决定是否续期；不满足则把计数清零并**停止轮询**。
   默认 `-1` ⇒ 无限次。
9. 每一次新的 `run`/`runAsync` 与 `cancel()` 都会先**取消已有的排期**。
10. `pollingInterval` 在运行中被改：从 `1000` 改成 `0` ⇒ 停掉排期；
    从 `0` 改成 `1000` ⇒ **不会自动开始**，必须再 `run`/`runAsync` 一次才生效。
11. `manual: true` ⇒ 挂载时不跑，因此也不会自动开始轮询。

**C. 可见性**

12. "是否可见"的判据是 `document.visibilityState !== 'hidden'`。
    测试用 `applyHidden(v)` 改这个 getter 并在 `document` 上派发**冒泡的**
    `visibilitychange` 事件（所以监听 `document` 或 `window` 都收得到）。
13. `pollingWhenHidden: false` 且排期到点时页面隐藏 ⇒ **不发这一次请求**，
    改为订阅可见性；**重新变为可见时补发一次 `refresh()`**，然后恢复常规排期。
14. `pollingWhenHidden` 默认 `true` ⇒ 隐藏期间照旧发请求。
    取消订阅的时机：新的 `run`/`runAsync`、`cancel()`、组件卸载。

**D. 其它**

15. `run`/`runAsync` 只把 `loading` 置真，**不清空 `data` 与 `error`**
    （`Fetch.runAsync` 里是 `setState({ loading: true, params, ...state })`）。
    只有落回时才写 `data`/`error`。
16. `loading` 的初值是 `!manual`。
17. 组件卸载时等价于 `cancel()`。

不许引入第三方依赖（**包括 `ahooks` 本身**：本题要的就是这个内核，不是调用它）。
不要写 `formatResult`（当前版本官方文档不提供该 API）。"""

ANSWER_Q2 = """## 参考答案要点

骨架就是 `Fetch` 类加一个轮询插件，**没有算法**，全部难度在"哪一步该写状态"上。

**三条最容易写反的**

1. **裁决式在写状态之前**（语义 2）。`await service()` 之后第一句必须是
   `if (currentCount !== this.count) throw new CancelledError()`，然后才 `setState`。
   反过来写（先 setState 再判断）的话，过期响应会把新数据盖掉，
   而且 `loading:false` 也会被过期那条写一次 —— 用户看到的是"闪回旧值"。
   `race` 那三条用例分别断到：`data` 不变、`loading` 不变、`events` 里
   **一条回调记录都没有**、并且 `runAsync` 以 `name==='CancelledError'` reject。
2. **"后发先至"里输的是先发起的那条，不是先落地的那条**（语义 1/3）。
   用"最后一个 resolve 赢"的实现（`if (res === latest)` 之类）会挂反向那条：
   `boom` 先发但**后**失败，按 `count` 裁决它必须被吞掉、`error` 也不许被写；
   按"谁后落地"它就会把 `ok` 的结果覆盖成错误态。
   这也是"我用了 AbortController 所以没有竞态"这类回答的照妖镜 ——
   本题的 `cancel()` 语义（语义 4）明确写了**请求不会被中止**，
   官方原话："调用 `cancel` 函数并不会取消 promise 的执行"。
3. **轮询是"完成后再等"，不是 `setInterval`**（语义 6）。
   `interval=1000 / delay=100` 那条在第 1000ms 断"还没发第二次"；
   `interval=1000 / delay=1500` 那条在第 2000ms 断"还没发第二次"。
   `setInterval` 版两条全挂，而且它还会在慢接口上叠并发 ——
   这正是"轮询把自己打成 DDoS"的成因。

**连续失败计数：判据是 `<=`，默认是 -1**

`pollingErrorRetryCount: 2` 给的是 **3 次失败**（1、2 容忍，第 3 次 `3 <= 2` 不成立才停）。
写成 `<` 的实现只跑 2 次；写成"总共 n 次"的实现挂"中途成功一次要归零"那条
（用例里 `err, ok, err, err` 在 `n=1` 下仍然发满 4 次，因为连续数从没超过 1）。
默认值是 **`-1`（无限）**而不是 `0`：写成 `0` 的话第一次失败就停，
`默认 -1 ⇒ 连错 5 次还在轮询` 那条就是专门抓它的。

**可见性那一格考的是"暂停 ≠ 取消"**

`pollingWhenHidden:false` + 隐藏 ⇒ 排期到点时**不发请求，但保留订阅**，
重新可见时补发**一次** `refresh()`（不是把错过的次数全补上）。
默认 `true` 那条对照着断："切到后台就不打了"这句面试常说的话在这套栈里是错的，
必须显式写 `pollingWhenHidden: false`。
另外"取消订阅"的时机容易漏：新 `run`、`cancel()`、卸载三处都要清，
否则一个隐藏期间挂上的监听会在组件已经不渲染之后再 `setState`。

**`run` 不清 `data`/`error`（语义 15）是本题唯一"反直觉"的一格**

多数人会写 `setState({ loading: true, data: undefined, error: undefined })`。
`Fetch.ts` 里那一行是 `this.setState({ loading: true, params, ...state })`，
`state` 是插件 `onBefore` 的返回值（常规情况下是 `{}`）——所以旧数据在 loading 期间**仍然可见**，
这是列表页"刷新时不闪空白"的实现依据。`cancel` 那条用例在第 100ms 断到 `data` 仍是
`-`（此时本来就没数据），而轮询那几条在第 1100ms 断到 `loading:'1'` 的同时
`data` 还是 `#1:p` —— 清掉 data 的实现会写成 `-`，当场红。

**工程延伸（面试追问点）**

1. 什么场景**不该**丢弃过期响应？（分页/增量列表要**合并**而不是覆盖：
   第 2 页和第 3 页并发返回时两条都该进列表。这时该做的是"按 key 归并 + 请求序号只做展示排序"，
   而不是"只认最新"。把 `usePollingRequest` 当成万能药就会丢数据。）
2. 轮询的退避怎么做？（`pollingErrorRetryCount` 只管"失败几次就停"，**没有退避**；
   要指数退避得配合 `retryCount/retryInterval`（不设 `retryInterval` 时是
   `1000 * 2 ** retryCount`，超过 30s 取 30s）或者自己在 service 外面包一层。）
3. 页面隐藏仍打服务端的成本怎么算？（`pollingInterval * 隐藏时长` 就是纯浪费的 QPS；
   真实治理是 `pollingWhenHidden:false` + 回到前台补一次，
   并把"任务已完成/失败"作为停止轮询的**业务条件**（`cancel()`），
   而不是让它在终态上一直转。）
4. 为什么这套语义能脱离网络库来测？（判题器接管了三件事：service 的耗时/成败、
   回调的记录、可见性的切换。于是"竞态"与"轮询"退化成一个**纯状态机 + 虚拟时钟**问题——
   这也是本题不用 `antd Form` / `ahooks` 真身的原因：判题镜像里没有它们，
   而机制本身可复刻，比 mock 一个外部库更不容易假绿。）"""

REFERENCE_Q2 = r'''import { useEffect, useRef, useState } from 'react';

export interface PollingOptions<TData, TParams extends any[]> {
  manual?: boolean;
  defaultParams?: TParams;
  pollingInterval?: number;
  pollingWhenHidden?: boolean;
  pollingErrorRetryCount?: number;
  onSuccess?: (data: TData, params: TParams) => void;
  onError?: (error: Error, params: TParams) => void;
  onFinally?: (params: TParams, data?: TData, error?: Error) => void;
}

class CancelledError extends Error {
  constructor(message = 'the request was cancelled or superseded') {
    super(message);
    this.name = 'CancelledError';
  }
}

const isCancelledError = (e: unknown): boolean => !!e && (e as Error).name === 'CancelledError';
const isDocumentVisible = (): boolean => document.visibilityState !== 'hidden';

interface Kernel {
  count: number;
  params: any[];
  state: { loading: boolean; data?: unknown; error?: Error };
  timer: ReturnType<typeof setTimeout> | undefined;
  unsubscribe: (() => void) | undefined;
  errCount: number;
  options: any;
  service: any;
  write: (s: Partial<Kernel['state']>) => void;
  run: (args: any[], asyncCall: boolean) => Promise<unknown>;
  plainRun: (args: any[]) => void;
  refreshNow: () => void;
  stopPolling: () => void;
  schedule: () => void;
}

export function usePollingRequest<TData = unknown, TParams extends any[] = any[]>(
  service: (...args: TParams) => Promise<TData>,
  options: PollingOptions<TData, TParams> = {},
) {
  const [state, setStateRaw] = useState<{ loading: boolean; data?: TData; error?: Error }>({
    loading: !options.manual,
  });
  const ref = useRef<Kernel | null>(null);
  if (!ref.current) {
    ref.current = {
      count: 0,
      params: [],
      state: { loading: !options.manual },
      timer: undefined,
      unsubscribe: undefined,
      errCount: 0,
      options,
      service,
    } as Kernel;
  }
  const k = ref.current;
  k.options = options;
  k.service = service;

  k.write = (s) => {
    k.state = { ...k.state, ...s };
    setStateRaw(k.state as any);
  };

  k.stopPolling = () => {
    if (k.timer !== undefined) clearTimeout(k.timer);
    k.timer = undefined;
    if (k.unsubscribe) k.unsubscribe();
    k.unsubscribe = undefined;
  };

  k.schedule = () => {
    const opts = k.options;
    const interval: number = opts.pollingInterval ?? 0;
    if (!interval) return;
    const retry: number = opts.pollingErrorRetryCount ?? -1;
    const whenHidden: boolean = opts.pollingWhenHidden ?? true;
    if (retry === -1 || k.errCount <= retry) {
      k.timer = setTimeout(() => {
        k.timer = undefined;
        if (!whenHidden && !isDocumentVisible()) {
          const onVisible = () => {
            if (!isDocumentVisible()) return;
            k.unsubscribe?.();
            k.unsubscribe = undefined;
            k.refreshNow();
          };
          document.addEventListener('visibilitychange', onVisible);
          k.unsubscribe = () => document.removeEventListener('visibilitychange', onVisible);
        } else {
          k.refreshNow();
        }
      }, interval);
    } else {
      k.errCount = 0;
    }
  };

  k.refreshNow = () => k.plainRun(k.params);

  k.run = (args, asyncCall) => {
    k.count += 1;
    const currentCount = k.count;
    k.stopPolling();
    k.params = args;
    // 只置 loading：不清 data / error（对应 setState({ loading: true, params, ...state })）
    k.write({ loading: true });
    const opts = k.options;
    return (async () => {
      try {
        const res = await k.service(...args);
        if (currentCount !== k.count) throw new CancelledError();
        k.write({ data: res, error: undefined, loading: false });
        opts.onSuccess?.(res, args as any);
        k.errCount = 0;
        opts.onFinally?.(args as any, res, undefined);
        if (currentCount === k.count) k.schedule();
        return res;
      } catch (error) {
        if (currentCount !== k.count) {
          throw isCancelledError(error) ? (error as Error) : new CancelledError();
        }
        k.write({ error: error as Error, loading: false });
        opts.onError?.(error as Error, args as any);
        k.errCount += 1;
        opts.onFinally?.(args as any, undefined, error as Error);
        if (currentCount === k.count) k.schedule();
        throw error;
      }
    })().catch((e) => {
      if (asyncCall) throw e;
      // run：取消不是失败，业务错误也不由 run 报告
      return undefined;
    });
  };

  k.plainRun = (args) => {
    void k.run(args, false);
  };

  const cancel = () => {
    k.count += 1;
    k.write({ loading: false });
    k.stopPolling();
  };

  useEffect(() => {
    if (!options.manual) k.plainRun((options.defaultParams ?? []) as any);
    return () => cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 对应 usePollingPlugin 的 useUpdateEffect：interval 被改成 0 时停掉已排好的下一次。
  // 反向（0 改成正数）**不做任何事** —— 必须再 run 一次才会启动轮询。
  const prevInterval = useRef<number>(options.pollingInterval ?? 0);
  useEffect(() => {
    const next = options.pollingInterval ?? 0;
    if (prevInterval.current !== next) {
      prevInterval.current = next;
      if (!next) k.stopPolling();
    }
  });

  return {
    loading: state.loading,
    data: state.data,
    error: state.error,
    run: (...args: TParams) => { void k.run(args, false); },
    runAsync: (...args: TParams) => k.run(args, true) as Promise<TData>,
    refresh: () => k.refreshNow(),
    cancel,
  };
}

export default usePollingRequest;
'''

NAIVE_Q2 = r'''import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 朴素解：setInterval + "谁后到谁赢" + 失败计数按总数算 + cancel 清空 data。
 * 四个症状各自对应一类真实事故：慢接口被自己叠成并发、旧响应盖掉新数据、
 * 轮询在第一次失败后就静默停止、切页面时列表闪成空。
 */
export function usePollingRequest(service: any, options: any = {}) {
  const { manual = false, defaultParams, pollingInterval = 0, pollingErrorRetryCount = 1 } = options;
  const [state, setState] = useState<any>({ loading: !manual });
  const stateRef = useRef(state);
  const paramsRef = useRef<any[]>([]);
  const failsRef = useRef(0);

  const write = (patch: any) => {
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
  };

  const once = useCallback(async (...args: any[]) => {
    write({ loading: true, data: undefined, error: undefined });
    try {
      const res = await service(...args);
      write({ data: res, loading: false });
      options.onSuccess?.(res, args);
      return res;
    } catch (e) {
      write({ error: e, loading: false });
      failsRef.current += 1;
      options.onError?.(e, args);
      throw e;
    }
  }, [service]);

  useEffect(() => {
    if (!pollingInterval) return undefined;
    const id = setInterval(() => {
      if (failsRef.current >= pollingErrorRetryCount) return;
      void once(...paramsRef.current).catch(() => undefined);
    }, pollingInterval);
    return () => clearInterval(id);
  }, [pollingInterval, once]);

  useEffect(() => {
    if (!manual) void once(...(defaultParams ?? [])).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    loading: state.loading,
    data: state.data,
    error: state.error,
    run: (...args: any[]) => { paramsRef.current = args; void once(...args).catch(() => undefined); },
    runAsync: (...args: any[]) => { paramsRef.current = args; return once(...args); },
    refresh: () => once(...paramsRef.current),
    cancel: () => write({ loading: false, data: undefined, error: undefined }),
  };
}

export default usePollingRequest;
'''

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
