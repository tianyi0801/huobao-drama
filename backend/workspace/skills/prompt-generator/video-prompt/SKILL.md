---
name: video-prompt
description: 视频提示词规范 — 按 MiniMax 官方 Ref2VA Full-Reference 六节结构，把分镜段落转成参考生视频提示词
---

# 视频提示词（分镜段落 → video_prompt）

将已有分镜转成 MiniMax H3 **Ref2VA（参考生视频）** 提示词。本技能是视频格式、引用、声音与对白细则的权威；剧情因果和新分段节奏由 storyboard-breaker 技能负责，角色/场景/道具的图片规范不用于视频正文。

依据 MiniMax 官方 `MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/ref-en.txt`（Full-Reference Mode Rewrite Output Format Guide）。采用官方英文 baseline，不把模板、语言或本地稳态经验宣称为效果保证。

## 六节结构与语言

按以下六节名及固定顺序输出一个 `video_prompt` 字符串：

1. `subject_definitions:`
2. `summary:`
3. `retention_analysis:`
4. `detailed_description:`
5. `overall_soundscape:`
6. `non_diegetic_music:`

六节说明正文全部用**英文**；对白、歌词与画面可见文字逐字保留原语言。中文原句使用 `<d>[Chinese] 原句</d>`，不改写、翻译、增删或补语气词。节名、`<Subject N>`、`(Sx)`、关系标记、`[Shot 1]`、`At MM:SS.mmm` 等官方英文锚点原样保留，不使用中文节名或旧版 `shot_summary` / `reference_usage` / `identity_reference` 等自造结构。人类说明与业务 `description` 继续使用各自原语言。

### 各节职责

- `subject_definitions:` 逐行定义需跟踪的人物、场景、物件等 `<Subject N>`，来源与特征只取已有资产资料。人物主体定义必须保留**业务原始角色名**，即使英文正文也不翻译角色名：有可用图写 `@原角色名`，无图写原角色名，以便系统核对逐句对白归属。业务角色身份保持稳定；目标视频内实际发声角色按首次发声顺序建立 Subject 与 `(S1)`、`(S2)` 的绑定，后续复用，不因换 Shot 或服装而换身份。不发声角色仍可有 Subject，但不分配 `(Sx)`。无视觉输入不声称看过参考图。
- `summary:` 用简洁英文呈现当前主体行动及即时因果，不写文学摘要、不抄对白、不引入新标签。以官方任务前缀开头，默认 `[reference generation]`；已有首尾帧时使用 `[keyframe completion + reference generation]`；多类型用 ` + ` 连接。
- `retention_analysis:` 按主体与引用列出实际保留内容，使用官方关系标记。视觉仅用 `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`；音频仅用 `fully_copy` / `partially_copy` / `reference` / `weak_reference`。写法如 `<Subject 1> (appears in [Shot 1]): fully_preserved - ...`。未用音频引用不增加音频条目。
- `detailed_description:` 按 description 的真实镜头写构图、主体位置与朝向、外观、空间与光线、动作先后、状态变化及必要运镜。视频专用的简洁风格描述由系统注入在 `[Shot 1]` 之前，不自行添加图片风格串、`quality`、`4K`、`animation still` 或质量口号。直接进入当前行动，以正常动作速度表现原剧情；保留必要空间锚点但不反复建立镜头，不补抬头吸气、慢动作或尾部定格来凑长。内容足够明确即可，不强制350词，也不设极端字数上限。
- `overall_soundscape:` 用1—4句英文描述画面支持的环境、物理动作及合理非语言声，如风、雨、脚步、杯子接触、原有动作中的呼吸。不抄对白、不列说话白名单、不写否定要求或字幕禁令，不用“本段无对白、旁白与人声”或“只有(S1)允许出声”替代声音描写。仅用户明确要求**全静音**时填 `N/A`；无对白不等于全静音，不添加无依据的歌声或人声。
- `non_diegetic_music:` 仅在原文或用户明确要求配乐时，用1—3句英文说明乐器、速度、节奏和动态；无配乐填 `N/A`，不因 atmosphere 自动配乐或配音。

## 素材引用与图号机制

只引用 `read_storyboard_context` 中本段已绑定、实际有可用图片的 `@角色名` / `@场景名` / `@道具名`，名称精确匹配，不缩写、翻译或创造资产。缺少图片的已有角色在主体定义中写业务原角色名与已有文字资料，如 `<Subject 1> is 小明, a young man with short black hair.`，不伪造 `@` 引用。

系统按**场景 → 角色 → 道具**顺序把真实素材引用编号成 `@图片N名字`，节点运行时再转换成官方 `<Picture N>`；图号表示输入顺序，不是 Subject 或说话人身份。不要手写 `@图片1`、`<Picture 1>`、`<Video N>`、`<Audio N>` 或假定编号；只有已有图片确作首帧/构图锚点时才用自然语言说明对应作用。

音色引用 `#角色名` 必须来自当前上下文中合法 `has_voice` 的已有角色，并在该角色原有对白处使用；系统转换为音频引用。无合法音色不写 `#`，不能新增配音、音频素材或台词来用音色。

## 对白与主体绑定

- 所有对白、歌词、旁白逐字来自 `description`，完整保留原文、说话角色、先后顺序与出现次数；仅在 `detailed_description` 对应 Shot 内出现一次，不复制到 summary 或声音节。没有依据的旁白、解说、画外人声或临时台词不得补写。新分镜的 description 对白统一 `角色原名说：「原句」`，画面动作与对白用句号或换行分开，避免将动作文本混入说话人名称；重写已有分镜不修改 description。
- 画面内每句对白明确写成 `<Subject 1> (S1) says, <d>[Chinese] 原句</d>`。同一角色的多句复用同一 Subject 与 Sx；已有多说话人镜头逐句明确主体绑定，不能笼统写“他们对话”。原文本身重复的句子按原次数保留，不误去重。
- 新拆分采用**每个生成片段一个主要说话人**的本地稳态策略：同角色可连续多句，前提是自然发话时间充足；换人回应优先新片段。此策略不是官方“每Shot只能一个说话人”的硬上限，也不用于删改已有多说话人段落。
- 不为无台词人物分配 Sx，不机械加闭口要求；但原剧情中的说完后闭嘴等可见表演可保留。仅原有画外音使用官方精确短语 `<Subject N> (Sx) says in an off-screen voiceover, <d>[Chinese] 原句</d>`，在原句后描述画面内对应主体嘴唇闭合，如 `<Subject N>'s lips remain closed.`；这是合法口型描写，不应一刀切删除。
- 可见招牌、字幕等文字用引号逐字保留，不能翻译或擅自添加；不把字幕禁令、说话许可、质量要求或因果规划写入模型正文。

## 镜头与时间

- **description 的 `【镜头N】` 是唯一镜头来源**：与 `[Shot N]` 数量和顺序一一对应，不新增、合并或删镜。`[Shot 1]` 不带时间戳；真实后续切镜写 `[Shot 2] At 00:03.000, ...`，时间严格递增且小于 `duration`。
- 重写已有分镜只改 `video_prompt`，保留 duration、镜头数量、全部动作及原句对白；即使存在多说话人或更复杂镜头也不要重新拆分。新分段的4—12整数秒及内容驱动时长，遵循 storyboard-breaker，不设5秒目标，不扩大到15秒。
- 用自然先后交代段内动作；复杂动作可加入简短明确的英文段内时间说明，如 `During the first two seconds, ...; then ...`，不改变 `[Shot N]` / 切镜 `At MM:SS.mmm` 语法，不机械套“前中后三行”或平均分时间。
- 动作与对白能自然同时发生时合理重叠，必须先后发生时累计时间，避免动作与台词错位。空间事实取自 description，翻译时保留机位方向、人物位置、门窗/家具与主光的相对关系；相邻镜头不重新想象布局。
- 双人戏清楚交代逐人位置、距离、朝向与独立动作，需辨认的脸保持可见；不靠浅景深、遮脸、焦点转移或快速运动掩盖角色。

## 完整英文六节示例

示例假定 description 为 `【镜头1】小明将杯子递给访客。小明说：「你终于来了。」说完闭嘴，访客接杯点头。`，仅一个镜头、6秒，@小明、@访客、@咖啡馆、@杯子 均为已有绑定图片；风格句由系统另行注入。中文真实对白仅在正文出现一次，主体定义保留原始角色名。

```text
subject_definitions:
<Subject 1> is the young man from @小明, with short black hair and a dark jacket; his speaking identity is (S1).
<Subject 2> is the visitor from @访客, wearing a light coat.
<Subject 3> is the interior from @咖啡馆, with a brick wall and a window behind the counter.
<Subject 4> is the cup from @杯子.

summary:
[reference generation] <Subject 1> hands <Subject 4> to <Subject 2> inside <Subject 3>; the visitor accepts it and nods.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - Preserve his short black hair, face shape and dark jacket.
<Subject 2> (appears in [Shot 1]): fully_preserved - Preserve the visitor's face and light coat.
<Subject 3> (appears in [Shot 1]): fully_preserved - Preserve the brick wall and window behind the counter.
<Subject 4> (appears in [Shot 1]): fully_preserved - Preserve the cup's shape and material.

detailed_description:
[Shot 1] An eye-level medium two-shot places <Subject 1> on the left and <Subject 2> on the right at equal distance from the static camera. The counter and window remain behind them, with soft window light from the left. <Subject 1> extends <Subject 4> toward <Subject 2> at a normal pace while <Subject 1> (S1) says, <d>[Chinese] 你终于来了。</d> He closes his mouth after the line. <Subject 2> takes the cup and nods once, continuing the handover.

overall_soundscape:
Quiet cafe room tone surrounds the handover. The cup makes a light ceramic contact as it changes hands.

non_diegetic_music:
N/A
```

### 无对白声音节（复用写法）

已有画面为人物穿过木地板并合门时，直接描述对应声音，不声明“无人说话”，不列说话人权限：

```text
overall_soundscape:
Footsteps tap across the wooden floor. The door latch clicks as the door closes, with faint outdoor wind behind it.

non_diegetic_music:
N/A
```

### 原有画外音（复用写法）

仅当 description 已有对应角色的这句画外音时使用；本例假定小明已绑定 `<Subject 1>` 与 `(S1)`，不用于新增旁白：

```text
[Shot 1] <Subject 1> looks at the closed door. <Subject 1> (S1) says in an off-screen voiceover, <d>[Chinese] 我记得这扇门。</d> <Subject 1>'s lips remain closed.
```

## 保存前自查与保存

逐句对照 description 检查**角色绑定、顺序、完整原句与次数**；检查六节英文正文、实际图/音色引用、Shot数量与真实切镜时间，以及动作—结果承接。规划留在内部，不新增 schema 字段。

调用 `update_storyboard` 只传 `storyboard_id` 和 `video_prompt`，不回传其他字段、不重拆整集。
