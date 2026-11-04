---
name: video-prompt
description: 视频提示词规范 — 按 MiniMax 官方 Ref2VA Full-Reference 六节结构，把分镜段落转成参考生视频提示词
---

# 视频提示词（分镜段落 → video_prompt）

本项目本地视频工作流是 MiniMax H3 **Ref2VA（参考生视频）**。官方为这个模式定义了专用六节结构，
字段名、顺序、时间轴、对白与关系标记都是模型识别结构的锚点，必须原样输出。

> 依据：MiniMax 官方 `MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/ref-en.txt`
> （Full-Reference Mode Rewrite Output Format Guide）。工作流贴士也写明「AI生成提示词可以生成为官方模板格式的提示词，对于生成视频乱说话很有用」。
> 项目早期自造的 `shot_summary` / `reference_usage` / `identity_reference` / 中文正文 / `[Shot 1] 0.0-5.0秒` 均非官方格式，已废弃。

## 输出格式（六节名固定、顺序不可变）

```
subject_definitions:
<Subject 1> is the young man in @小明, with short black hair, a square face, and a dark jacket.
<Subject 2> is the café interior in @咖啡馆, with an exposed brick wall and a window behind the counter.

summary:
[reference generation] The target video shows <Subject 1> greeting <Subject 2>'s visitor in a single continuous shot inside <Subject 2>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - his face, short black hair and dark jacket are retained.
<Subject 2> (appears in [Shot 1]): fully_preserved - the brick wall and the window behind the counter are retained.

detailed_description:
The target video uses a realistic cinematic style with soft indoor lighting.
[Shot 1] A medium two-shot places <Subject 1> on the left and a visitor on the right at the same distance from a static camera, with the window behind them slightly to the left. Both faces are clearly visible. <Subject 1> (S1) turns toward the visitor and says, <d>[Chinese] 你终于来了。</d> He then closes his lips while the visitor nods once. The camera holds a static shot with no cuts.

overall_soundscape:
Quiet indoor café room tone with a faint cup clink and soft footsteps on the wooden floor.

non_diegetic_music:
N/A
```

## 硬性规则

**语言**：六节正文一律用**英文**；只有 `<d>` 内的对白/歌词、以及画面里可见的文字保留原语言（本项目为中文）。
这条是格式硬要求，不受会话目标语言指令影响；会话语言只影响图片提示词与对话回复。

**六节职责**：

- `subject_definitions:` 每个需要跟踪的可见内容一行，用 `<Subject N>` 定义可复用主体（人物、场景、物件、服装、风格），
  写明来源参考与必须保持的特征。`<Picture N>` / `<Video N>` / `<Audio N>` 是官方标签，本项目由 `@图片N` 在运行时转换，
  **不要手写**这些编号标签；只有图片本身作为首帧/构图锚点时才在正文里用自然语言说明。
- `summary:` 一段英文，必须以方括号任务类型前缀开头。默认 `[reference generation]`；
  有首尾帧时用 `[keyframe completion + reference generation]`；多类型用 ` + ` 连接。
  用已定义的 `<Subject N>` 说明主体、镜头流程与参考关系，不引入新标签，不抄对白。
- `retention_analysis:` 每个参考标签一行，**必须使用官方固定关系标记**：
  可见内容 `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`；
  音频 `fully_copy` / `partially_copy` / `reference` / `weak_reference`。
  格式为 `<Subject 1> (appears in [Shot 1]): fully_preserved - ...`。禁止自造 `identity_reference` / `scene_reference` / `object_reference` / `continuity_reference`。
- `detailed_description:` 正文主体。风格句（1—2 句英文）必须写在 `[Shot 1]` **之前**，由系统自动注入，不要自己写风格词。
  `[Shot 1]` **不带时间戳**；后续镜头写 `[Shot 2] At 00:03.000, the shot cuts to ...`，切镜时间严格递增且小于 duration。
  每个镜头写清构图、主体外观与位置、环境与光线、动作与状态变化、运镜（类型 + 幅度 + 速度）、当前声音、参考内容生效点。
  描述要具体可见，不能退化成剧情摘要或参考关系清单。官方建议 350—500 英文词；本项目 5 秒单镜头不必硬凑字数，但信息必须完整。
- `overall_soundscape:` 1—4 句英文，只写环境音与物理动作声（风、雨、脚步、碰撞、呼吸），**不重复对白、不写音乐**；
  只有全静音才写 `N/A`。「说话白名单」和成串的否定句不是官方写法，禁止使用。
- `non_diegetic_music:` 1—3 句英文，只写观众能听到而角色听不到的配乐（乐器、速度、节奏、动态）；
  **没有配乐就写 `N/A`**，不要写「无背景配乐、无歌声」这类中文否定句。

**素材引用**：只写 `@角色名` / `@场景名` / `@道具名`，名字必须与 `read_storyboard_context` 返回的列表完全一致。
前端按「场景 → 角色 → 道具」自动编号成 `@图片N名字`（如 @小明 → @图片2小明），节点运行时再转成 H3 的 `<Picture N>` 标签。
不要手写 `@图片1`、`<Picture 1>` 等编号；只引用本段已绑定的素材。

**对白与说话人**：
- 台词放进 `<d>[Chinese] 原句</d>`，逐字来自 `description`，只在对应 Shot 写一次，不新增台词、旁白或解说。
- 实际发声者按出现顺序分配稳定 ID `(S1)`、`(S2)`，写成 `<Subject 1> (S1) ... says, <d>[Chinese] ...</d>`；
  不发声的角色**不分配** `(Sx)`，用 `keeps lips closed` 之类的可见描写表达闭口。
- 有可用音色的角色在对白处写 `#角色名`（后端会转成 `@音频N` 音色参考）；没有音色就用角色姓名描述说话人。
- 画外音固定写 `says in an off-screen voiceover`，并说明画面中人物嘴唇保持闭合。
- 画面中可见的招牌、字幕等文字用英文双引号逐字写出。

**时间轴与镜头**：
- 默认 1 个连续镜头，固定机位或缓慢单一运镜、1 个主要动作；叙事确需切镜时最多 2 个，每个至少 2 秒，不跨场景。
- 新拆分优先 5 秒，允许 4—12 秒且绝不超过 12 秒；重写已有分镜时保留 duration 与全部动作/对白。
- 每个 Shot 都要有空间锚点（机位在哪一侧、门窗与家具相对角色的位置、主光方向）；`description` 已有的空间描述必须原样保留对应的英文表达。
- 双人戏优先同焦平面平视中近景，逐人交代左右位置、距离、朝向与独立动作，所有需要辨认的脸清晰可见；
  避免浅景深、背景人物虚化、遮脸、焦点转移与快速运动。

**内容来源**：`description` 是画面、动作、台词、旁白的唯一来源；`atmosphere` 只用于补光线与色调；
角色外貌只取已有文字资料，不能声称看过参考图；不虚构资产、场景事实或剧情动作。

**禁止事项**：跨场景切换与闪回；引用列表之外的素材名；漏写六节或改节名；
抽象心理描写与文学比喻；在声音节抄对白；自造关系标记；把风格词写在 `[Shot 1]` 之后。

## 保存

调用 `update_storyboard` 仅更新该分镜段落的 `video_prompt` 字段，不要改动其他字段，不要重新拆分整集。
