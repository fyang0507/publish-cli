# Chinese-Internet Design-System Patterns — a curated teardown

**Purpose.** A curated, example-first reference for building a **personal visual
design system tailored to the Chinese internet** (小红书 first, but the patterns
generalize). It cherry-picks the strongest, most concrete artifacts from three
open-source XHS "skills" and annotates each with *why it works* and *how to adapt
it* — especially how to re-express it as **CSS design tokens + HTML templates**
(deterministic, editable, glyph-perfect) rather than image-model prompts.

**How to use it.** This is educative + tunable raw material, NOT a spec. When you
build your design system, lift the schemas/rubrics/negative-lists here and swap in
your own palettes, voice, and constraints. Verbatim Chinese is preserved (that's
the valuable part); English glosses are in parentheses.

**Scope note.** This belongs to the **orthogonal cross-channel design system**, not
the `publish xhs` channel (which only consumes finished cards + a caption — see
[XHS_HANDOFF.md](./XHS_HANDOFF.md) §3, memory `design-language-orthogonal`). Kept in
this repo's `docs/` for now; move it with the design system when that lands.

**Sources** (credit to the authors; all read 2026-07-06 on `main`):
- `cclank/xhs-cover-skill` — cover/carousel image-prompt emitter (2 style presets).
- `ziguishian/xhs-visual-director-skill` — 24-style library + hard consistency + human gates. *The richest.*
- `JuneYaooo/xhs-writer-skill` — copywriting rubrics + 素人感 aesthetic + real render code.

**The meta-lesson.** All three are prompt-engineering skills, not renderers. Taste
lives in **structured natural-language constraints + schemas**, and it is enforced
as much by **prohibition** as by direction. The ones that feel "designed" (not
generic-AI) do three things: encode taste **concretely** (exact hexes / frame-% /
emoji-%, never just adjectives), **lock consistency** across a carousel explicitly,
and **gate on a human** before batch-generating.

---

## Pattern 1 — Separate the output *contract* from the *taste*

*(from xhs-cover-skill)*

One file owns the machine-readable **output schema**; swappable style files own the
**aesthetic** and explicitly defer formatting back to the schema. Adding a new style
= adding one Markdown file, **zero code change**.

The authoritative emit schema (verbatim):

```json
{
  "title": "The Main Title 🌟",
  "content_polished": "The polished caption text for the post...",
  "tags": ["#Tag1", "#Tag2"],
  "image_prompts": [
    {
      "index": 1,
      "type": "Cover | Content | End",
      "text_overlays": { "title": "...", "subtitle": "...", "notes": "..." },
      "prompt": "Full English image generation prompt...",
      "negative_prompt": "..."
    }
  ]
}
```

Each style template ends by ceding output authority to the schema file:
> `（此部分由 SKILL.md 的 JSON 格式要求覆盖，请输出为 JSON）`

**Why it's good.** Taste and contract evolve independently. You can A/B whole
aesthetics without touching the pipeline.

**How to adapt.** Keep this split verbatim in your system: a stable `card-spec`
schema (what the renderer consumes) + a folder of interchangeable style token files.
Note the sharp idea of splitting **on-image text (`text_overlays`, carries the
Chinese) from the render prompt (English)** — in an HTML/CSS system this becomes:
structured content fields (real text) + a style token set (CSS vars). Text is never
"baked into a prompt"; it stays real, editable text.

---

## Pattern 2 — A fixed-field style schema, repeated N times

*(from xhs-visual-director — the single most copyable artifact)*

A "named style" is a **fixed 10-field block**, and the library repeats it **24
times** so the model (or you) picks from *concrete, discriminable* options instead of
inventing a vibe each time. The fields:

`适合内容` (fits) · `不适合内容` (doesn't fit) · `视觉气质` (temperament) · `配色`
(palette) · `字体` (type) · `构图` (composition, w/ **frame-%**) · `常用元素`
(motifs) · `图像提示词模板` (prompt template) · `负面提示词` (negatives) ·
`示例标题类型` (example titles)

One full style, verbatim (**#1 深色科技杂志风 / dark tech-magazine**):

> - 适合内容：AI、Vibe Coding、Agent、工具、认知升级、方法论、技术趋势。
> - 不适合内容：强生活化、亲子、甜美种草、低信息密度情绪文。
> - 视觉气质：高级、冷静、理性、科技、专业。
> - 配色：黑色、深灰、银白，少量荧光绿 / 电光蓝。
> - 字体：粗黑体大标题 + Inter 小号英文注释。
> - 构图：大标题占 30%-45%，背景细网格、结构线、玻璃面板。
> - 常用元素：代码窗口、Agent 网络、抽象芯片、数据流、状态标签。
> - 图像提示词模板：3:4 竖版深色科技杂志封面，左上大标题区，右下抽象 Agent 网络或代码窗口，细网格背景，银白文字，少量荧光绿强调，清晰留白。
> - 负面提示词：廉价蓝紫渐变、随机霓虹、复杂无意义背景、文字变形、过小文字。
> - 示例标题类型："AI 写代码，总翻车？""普通人必须学会 Vibe Coding"

The 24 styles (a menu worth mining for your own): 深色科技杂志风、黑白灰+荧光绿冲击风、
Notion高级卡片风、液态玻璃/弥散极光风、极简产品发布会风、反差冲击封面风、架构图/系统拆解风、
手机截图改造风、高级商业提案风、全球贸易网络风、高级白底杂志风、红绿对错对比风、
赛博档案/黑客文件风、未来实验室风、设计师灵感板风、高级极简黑金风、软件界面UI风、
课程讲义/黑板风、个人品牌宣言风、情绪共鸣/夜间独白风、数据报告/趋势洞察风、故事漫画分镜风、
高级电商详情页风、高级工具清单风。

Style selection is a documented procedure, not a guess: classify (1) content type,
(2) distribution goal, (3) reader emotion, (4) info density → pick **main +
auxiliary + explicitly-not-recommended** style, with written rationale. New styles
are gated behind a 5-item 合格判断 (e.g. "是否能和已有风格库区分开").

**Why it's good.** Concrete, mutually-exclusive choices with fit/anti-fit tags make
the system *judge*, not vibe. The `构图` frame-% is the difference between "minimal"
and a real layout.

**How to adapt.** This maps almost 1:1 to a design-token file per style. Curate
~4–8 styles that match YOUR content (not all 24). Each style file = palette vars +
type ramp + a composition spec (frame-%, grid) + a negative checklist + example
hooks. Keep the fit/anti-fit tags — they're what lets an agent auto-select.

---

## Pattern 3 — Lock carousel consistency explicitly

*(from xhs-visual-director)*

Cross-card drift is the #1 tell of amateur AI carousels. The fix is a **verbatim
"series-lock" string** pasted at the start of *every* card's prompt:

> Series visual master lock: create one page of the same Xiaohongshu carousel
> series, 1080x1440px, strict 3:4 vertical portrait canvas, no square, no landscape,
> no crop, no extra border. Keep identical canvas ratio, identical safe margins,
> identical typography system, identical page-number position, identical color
> tokens, identical card radius, identical line weight, and identical icon style
> across all pages. Use a 12-column grid and 8px spacing system. … only the main
> visual and information structure may change.

Backed by a numeric **版式锁定 (layout-lock) table**:

| Item | Default |
|---|---|
| Canvas | 1080×1440px, strict 3:4 |
| Safe margins | L/R 72px, T/B 80px |
| Grid | 12-column, 8px base spacing |
| Title zone | top 18%–32% (cover 35%–45%) |
| Body | 2–4 lines max, no long paragraphs |
| Page number | fixed corner (bottom-right), low weight |
| Cards / lines / icons | consistent radius / weight / all-linear-or-all-solid |

**Allowed to change per page:** main visual, information structure, local emphasis.
**Forbidden to change:** ratio, margins, font system, main+accent color, page-number
position, card radius, line style.

**Why it's good.** "Consistency" becomes enumerated, checkable tokens — not a hope.

**How to adapt.** In an HTML/CSS system this is *free and stronger*: the token table
literally becomes your CSS variables + a shared layout component; consistency is
structural, not prompted. Keep the "allowed vs forbidden to vary" split as an
explicit rule so per-card content edits can't break the series look.

---

## Pattern 4 — Encode palettes as *named, enumerated* colors

*(from xhs-cover-skill Plan B + xhs-writer-skill)*

Taste's strongest single signal is a **prescriptive, enumerated palette** — named
colors the system reuses, not "use nice colors."

xhs-cover Plan B (高级 / Morandi), verbatim:

```
主色方向（任选其一，但整组统一）
- 高级莫兰迪色：灰豆绿、雾霾蓝、燕麦米、灰粉、陶土色
- 低饱和奶油色：奶杏、浅卡其、柔雾白、暖灰
- 冷静高级灰阶：浅灰蓝、米灰、雾白
强调色（仅用于重点）：焦糖棕 / 深墨绿 / 暗酒红 / 静谧深蓝
⚠️ 强调色仅用于关键词、数字、重点框线，禁止大面积高饱和撞色。
```

xhs-writer (素人 / grassroots) goes further — **exact hexes**:

```
背景：✅ 纯色（米色 #F5F1E8、浅黄 #FFF9E6、浅粉 #FFE5E5）  ❌ 渐变、纹理、图案
```

**Why it's good.** Named/hex palettes + an "accent only for emphasis" rule produce
coherent, on-brand cards; the "pick one per set, whole group unified" instruction is
a consistency lever.

**How to adapt.** Turn each palette into a CSS `:root` token set (`--bg`, `--fg`,
`--accent`, used sparingly). Encode the "accent only on keywords/numbers/frames"
rule as a lint/checklist item. Two named families (a 高级/premium and a 素人/casual)
covers most Chinese-internet content.

---

## Pattern 5 — Enforce taste by *prohibition*, concretely

*(all three; xhs-visual-director is richest)*

Every system spends as much ink on `禁止`/`NO` as on positive direction. Verbatim
negative lists worth stealing:

Baseline aesthetic ban (visual-director):
> 禁止：廉价蓝紫渐变、随机霓虹线条、文字过小、PPT bullet 堆砌、塑料质感、儿童卡通感、巨大页码抢戏。

Universal negative-prompt string (visual-director, pasted into every generation):
> 不要廉价蓝紫渐变，不要随机霓虹线条，不要文字变形，不要小字堆积，不要 PPT bullet 列表，不要塑料质感，不要儿童卡通，不要低清晰度，不要过度装饰，不要元素遮挡标题，不要页码喧宾夺主，不要方图，不要横图，不要裁切，不要改变画幅比例，不要改变安全边距，不要每页换模板，不要不一致的卡片圆角。

The **anti-vagueness rule** (its most-repeated principle):
> 不要只会写"高级、科技、极简"，必须说明具体视觉做法。
> (Don't just write "premium/tech/minimal" — you must state the concrete visual move.)

Plus 6 named **anti-patterns** (symptom→fix): 廉价 AI 科技风 · PPT 感太重 · 信息过载 ·
伪高级感 · 文字不可读 · 风格不统一.

**Why it's good.** Negatives catch the specific failure modes generic AI falls into;
the anti-vagueness rule is what separates a real design system from mood words.

**How to adapt.** Ship a **negative-constraint checklist** as a pass/fail gate
(≤2 fonts, single visual center, no text-walls, accent-color discipline, glyphs
legible, series-consistent). Adopt the anti-vagueness rule as a *maintainer* rule:
every style token must name a concrete move, not an adjective.

---

## Pattern 6 — Rubrics that force copy decisions

*(from xhs-writer-skill)*

The best copy discipline here is **numeric and forces focus**.

**Selling-point score = 稀缺性 × 实用性 × 可感知** (multiplicative, human rates each
1–5 → a weak axis tanks the total → forces a *single* hero selling point):
- 稀缺性 (Scarcity): 其他工具能做到吗？独家 > 常见
- 实用性 (Usefulness): 解决什么具体痛点？解决痛点 > 展示技术
- 可感知 (Perceptibility): 用户能直接看到效果吗？视觉对比 > 文字描述

> 模板克隆 5×5×5 = **125 🥇核心**  vs  10种风格 2×3×3 = **18 🥉锦上添花** → 只把 Top 1-2 放上封面。

**5 title formulas** (fill-in-the-blank; always generate 5, let the human pick):
1. 痛点式：`{具体痛点}？{解决方案}` — "凌晨3点还在改PPT？这个工具能一键复刻公司模板"
2. 提问式：`有没有那种{功能描述}的{产品类型}？`
3. 发现式：`我发现了个宝藏！{核心价值}`
4. 热点词：`{热点词}爆火后，我用它做了{场景}`
5. 身份共鸣：`{身份标签}必备！{核心功能}` — "打工人必备！一键复刻老板的PPT模板"

**Card-layout grammar** (spine + per-genre recipes, not a rigid template):
- spine: `cover + content×n + ending`, each card ≤80 汉字, 一张卡只讲一个论点
- 推广类: `封面 + 核心卖点 + 功能展示 + 目标人群 + 真实案例 + CTA + 链接`
- 知识类: `封面 + 核心概念 + 步骤拆解 + 注意事项 + 总结 + CTA`

**Emotional-vocabulary lexicon** (scenario → trigger words):

| 场景 | 正面 | 负面（痛点） |
|---|---|---|
| 发现 | 宝藏、绝了、爱了 | 后悔没早知道 |
| 效果 | 好看哭了、太强了 | 之前白熬夜了 |
| 速度 | 秒出、瞬间搞定 | 等到天荒地老 |
| 质量 | 专业、设计师级 | 土到掉渣 |

**De-AI quality gate** (`humanizer-zh.md`, /50): 直接性 / 节奏 / 信任度 / 活人感 /
精炼度, each ×10 → **≥45 publish · 35–44 polish · <35 rewrite**.

**Why it's good.** Multiplicative scoring is a genuinely clever forcing function; the
formulas + lexicon give the Chinese-internet *voice* (口语化 / 闺蜜语气) concretely.

**How to adapt.** These are deterministic and language-layer — pair with an LLM copy
step. The S×U×P score and /50 de-AI gate port directly; localize the lexicon and
title formulas to your niche.

---

## Pattern 7 — Human-in-the-loop gates as forcing functions

*(from xhs-visual-director)*

Two hard gates stop the model from blasting a generic set:

1. **10 fixed Socratic questions** (groups A传播目标 / B读者 / C观点 / D素材 / E视觉),
   **forced-choice**, with a *禁止问法 / 推荐问法* rule — banned: open "你喜欢什么风格？";
   recommended: "这篇更想让人收藏，还是更想让人评论？" Then emit a
   "回答摘要与生成假设" checkpoint before proceeding.
2. **One-sample-approval**: generate exactly ONE card (default the cover), list "验证
   了哪些视觉规则" + 3–5 points to confirm, and **block** until the human approves
   before rendering the full set.

**Why it's good.** Cheap human correction twice beats regenerating a whole bad set;
matches your "publish is always human-present" principle
(memory `publish-always-headful-sync`).

**How to adapt.** Keep both gates. The forced-choice question style is the
transferable gem — it extracts real direction without design vocabulary from the user.

---

## Pattern 8 — The CJK-text lesson (why HTML/CSS wins for you)

*(from xhs-visual-director + xhs-writer-skill)*

Every image-model system here fights the same problem: **diffusion models garble
Chinese text.** Their workarounds:

- visual-director (prose fallback): `不要生成真实中文正文，只保留清晰文字占位区和版式结构，标题和正文由后期排版添加` — render a background with a **text-safe placeholder zone**, overlay real type later.
- writer-skill (code): `scripts/text_on_image.py` uses **PIL to draw real CJK text**
  (Source Han Sans) onto a photo — crisp, deterministic.
- writer-skill also encodes "reject 100% AI visuals" as a **per-card
  `synthesis_strategy` enum**: `img2img 🥇 > text_on_photo 🥈 > collage 🥉 >
  pure_text > ai_generated ⚠️慎用`.

**The takeaway for your system.** Your chosen path — **HTML/CSS → PNG via headless
Chrome with embedded fonts** — sidesteps this entirely: text is real, crisp,
editable, glyph-perfect, and reproducible. So **borrow their taste *encoding*
(Patterns 1–7) but NOT their rendering.** An image model can stay an optional
*background* layer *under* real HTML text — exactly the visual-director's own
fallback, but productized.

---

## Pattern 9 — How to *define* an aesthetic (素人感 / 高级感)

*(from all three; the most reusable technique in this teardown)*

The hardest problem is turning a fuzzy Chinese aesthetic term into something a model
(or a CSS file) will actually obey. The core move: **never let the aesthetic word
stand for itself** — the word is a *label*; the definition is always a decomposition
into obeyable parts. Four mechanisms, with verbatim evidence:

**(a) Decompose the word into an attribute do/don't grid.** 素人感 is never "feel
amateur" — it's four axes, each ✅/❌ (xhs-writer, verbatim):
> **背景：** ✅ 纯色（米色 #F5F1E8、浅黄 #FFF9E6、浅粉 #FFE5E5） ❌ 渐变、纹理、图案
> **Emoji：** ✅ 超大（占画面 20-30%）· 顶部居中 · 🤔💡✨🔥😭🪄
> **文字：** ✅ 手写感（不规则、有倾斜）· 关键词波浪下划线 · 大小对比强烈 ❌ 完美对齐、网格排版
> **整体：** ✅ 看起来"不专业"、随意、真实、有温度 ❌ 精美、高大上、品牌感

**(b) Define by contrast with the "cheap twin."** Every aesthetic is pinned by
naming the *specific bad version* it's confused with — the single highest-leverage
field. 素人感 is bounded against 广告感 (*"❌ 广告感设计：渐变背景、科技感、精美排版 →
像品牌宣传"*). 高级感 is defined **almost entirely negatively** — the visual-director
docs literally admit *"文档未直接定义"* 高级感, and instead each premium sub-style
names its own cheap twin in `负面提示词`:
- 高级极简黑金风 → **"暴发户金色"** (nouveau-riche gold vs tasteful gold)
- 高级商业提案风 → **"土味招商海报、股票软件感"**
- 高级白底杂志风 → **"空得没有重点、字体太细、PPT标题页感"**

("Gold" is neither premium nor cheap on its own — 暴发户金 vs 高级金 *is* the whole
distinction, encoded as a negative token.)

**(c) Bottom out in exact tokens** — hexes (`#F5F1E8`), emoji size (`20-30%`),
enumerated palettes, named font stacks (思源黑体/Inter). This is where "feel" becomes
a token file.

**(d) One essence sentence** as an intuition pump so edge cases resolve right:
素人感 = *"看起来像普通人做的，不是设计师作品"*; 高级 baseline = *"高级、设计师审美、
杂志感、极简但有冲击力"*.

**The meta-rule (`伪高级感` anti-pattern) — the reason these don't produce AI slop.**
It's really a rule about *how you're allowed to define an aesthetic at all* (verbatim):
> **表现：** 只会写"高级、极简、科技"。没有版式细节。看起来像空洞风格词堆叠。
> **避免方式：** 必须描述留白、层级、字体、材质、主次关系。必须说明标题、主视觉、辅助信息的布局比例。必须说明高亮色只用在哪里。

i.e. **a style word only counts as "defined" once decomposed into whitespace /
hierarchy / type / material / layout-ratio / where-the-accent-color-goes.** The
system forbids defining the aesthetic with the aesthetic's own name.

**Why 素人感 gets a positive grid but 高级感 doesn't** (a tuning lesson): 素人感 is a
*narrow, specific* look → cheap to define positively (4 attribute lists nail it).
高级感 is a *broad family* → defined instead as (i) several concrete sub-styles, each
with its own tokens + cheap-twin negative, and (ii) the shared 伪高级感 guardrail.
**Rule of thumb: narrow aesthetic → positive attribute grid; broad aesthetic → a set
of concrete sub-styles + a shared "what kills it" negative.**

**How to adapt.** For each aesthetic in your system: (1) write an attribute grid
(background / type / color / spacing / motif) as ✅/❌ pairs; (2) add a **`cheap-twin`
negative** naming the specific failure it's confused with; (3) bottom out in tokens →
your CSS `:root` vars; (4) add one essence sentence; (5) adopt the anti-vagueness
rule as a maintainer gate — no style entry may use its own aesthetic word as its
definition.

---

## A starter kit (minimum viable design system)

Synthesizing the above into what to actually build first:

1. **Contract/taste split** (P1): a stable card content-schema + a folder of style token files.
2. **4–8 named styles** (P2), each a token bundle: `palette` + `type ramp` +
   `composition (frame-%/grid)` + `fit/anti-fit tags` + `negative checklist` +
   `example hooks`. Curate to your niche; steal from the 24-style menu. **Define each
   aesthetic via P9** — attribute grid + a `cheap-twin` negative + tokens + one
   essence line; never let the style word define itself.
3. **A series-lock token set** (P3): ratio 1080×1440, margins, 12-col/8px grid, fixed
   page-number, radius/line/icon consistency — as CSS vars + a shared layout component.
4. **Two enumerated palettes** to start (P4): one 高级/Morandi, one 素人/casual (with hexes).
5. **A negative-constraint checklist** (P5) as a pass/fail gate + the anti-vagueness maintainer rule.
6. **Copy layer** (P6): S×U×P selling-point score, 5 title formulas, card-layout
   grammar, localized emotional lexicon, /50 de-AI gate.
7. **Two human gates** (P7): forced-choice intake questions + one-sample approval.
8. **Render via HTML/CSS→PNG** (P8), fonts embedded; image model only as optional background.

Localize everything to your niche and voice — the value is the *structure*; the
palettes, styles, and lexicon are yours to tune.
