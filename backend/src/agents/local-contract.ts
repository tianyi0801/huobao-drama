import type { RequestContext } from '@mastra/core/request-context'
import { getComfyConfig } from '../services/comfyui/config.js'
import { H3_SECTIONS } from '../services/video-prompt-structure.js'
export { H3_SECTIONS } from '../services/video-prompt-structure.js'

export const STORYBOARD_BATCH_SIZE = 2
export const STORYBOARD_MAX_STEPS = 80

/** 结构规则是代码契约，正文语言仍由本次内容语言指令控制。 */
export function buildLocalAgentContract(type: string, rc?: RequestContext): string {
  const common = `## 本地生产执行契约（与旧模板冲突时以本节为准）
- 工具注册名称与 tool id 相同，使用 snake_case；严格使用工具 schema 的参数，不猜测驼峰别名。
- 不要调用生图/视频服务或编造已生成素材。文本服务只负责创作与调用保存工具，图片/视频由本地 ComfyUI 单独执行。
- 必须实际调用保存工具并检查回执；返回 error 时应纠正输入，不能回复“完成”。保存成功后只用一句简短总结，不重复输出整份内容。
- 仅从已提供的文字/资产字段提取事实。工具只返回图片地址而未提供视觉输入时，不得声称已看过参考图。
- 参数中的字段名、ID、引用标记、小节名保持固定；叙述正文按会话目标语言输出。`
  if (type === 'script_rewriter') return `${common}
- 先用 read_episode_script 读原文，自己完成改写，再用 save_script 保存完整 content。rewrite_to_screenplay 只读取原文和格式说明，不会代替你改写；已读原文不必重复调用它。
- 场景头使用 ## S编号 | 内景/外景 · 地点 | 时间段；动作写自然段，对白按角色名标注，不加入相机或模型参数。
- 改写不得省略或擅改原文明确的外貌、衣饰、关键物件外观、空间位置与人物关系；时间段沿用已知信息，原文只写白天或夜晚时不猜具体时刻。`
  if (type === 'extractor') {
    const target = rc?.get('extractTarget' as never) as string | undefined
    return `${common}
- ${target ? `本次只提取 ${target}：只调用 read_existing_${target} 与 save_dedup_${target}，不要读取或写入其他资产类型。` : '仅提取用户请求的资产类型；未指定时可提取角色、场景、道具。'}
- 先调用 read_script_for_extraction；同名资产合并复用，不能为了重提而创建重复资产。
- 角色输出 appearance（可见外貌/性格外化）与 styling（妆造）；场景输出 prompt（无人物环境布局）与 lighting；道具 description 仅描述物品外观。不要预先生成图片最终提示词。
- 同名已存在资产默认复用，仅补齐空字段，不覆盖已确定外貌、妆造、空间布局或物件外观；需要更改时由用户明确编辑资产。背景故事不能当妆造，事实不足不凑300—500字；未出现的墙、门、家具不为满足数量而杜撰。
- 初次提取保存本集完整所需集合，增量仅补指定资产；未返回或空数组均不删除或解绑已有资产。
- 道具须推动情节且需要独立参考图；以下任一为“是”就排除：删除它剧情仍成立？只是日常随手物品？只是场景陈设？通常最多3个。仅当本次目标包含道具时，没有合格道具也必须调用 save_dedup_props 并传 props: []。`
  }
  const comfy = getComfyConfig()
  const localVideo = comfy.video?.name || '尚未绑定本地视频工作流'
  const video = `## 本地 ComfyUI 视频提示词契约（MiniMax 官方 Ref2VA 格式）
- 实际视频模板：${localVideo}。本项目内置 H3 Ref2VA 工作流；不要按历史云端配置显示名改用其他提示词格式。
- video_prompt 是一个完整字符串，含以下官方六节且顺序固定：${H3_SECTIONS.join(' / ')}。节名是英文结构锚点，禁止改名、翻译或退化成单段散文；禁止使用项目旧版自造的 shot_summary / reference_usage / identity_reference / continuity_reference。
- 六节正文一律用简体中文写作；只有 <d> 内的对白/歌词保留原语言，画面可见文字照原样书写。节名、关系标记、[Shot N]、At MM:SS.mmm、<d>[Chinese] 这些结构锚点必须保持英文原样，不可翻译或改写；这是格式硬要求，不受会话语言指令影响。逐节细则以注入的 video-prompt 技能为准。
- subject_definitions：用 <Subject N> 逐行定义可复用主体，写明来源参考与必须保持的特征；summary：以 [reference generation] 等官方任务类型前缀开头的一段中文；retention_analysis：每个标签一行，只用官方关系标记 fully_preserved / partially_preserved / attribute_transfer / weak_reference（音频用 fully_copy / partially_copy / reference / weak_reference）。
- detailed_description：风格句由系统在 [Shot 1] 之前注入，不要自己写风格词；[Shot 1] 不带时间戳，后续镜头写 [Shot N] At MM:SS.mmm, 镜头切至近景；逐镜头用中文写清构图、主体位置与外观、环境与光线、动作与状态变化、运镜类型+幅度+速度、当前声音。描述必须具体可见，不能写成剧情摘要或参考关系清单。
- 对白写成 <Subject 1> (S1) 说，<d>[Chinese] 原句</d>；(Sx) 按实际发声顺序分配，不发声的角色不分配。台词逐字来自 description，只在对应 Shot 写一次，不新增台词、旁白或解说。overall_soundscape 只写 1—4 句中文环境音与物理声，不抄对白、不用说话白名单或否定句堆砌；non_diegetic_music 无配乐时写 N/A。
- 素材只写 @角色名/@场景名/@道具名，精确匹配上下文，系统负责编号，不手写 @图片1 / <Picture 1>。仅 image_url 已有实际图片的资产才使用 @ 引用，未生图资产用普通名称描述，不虚构参考图。
- 新拆分 duration 为4—12的整数秒，目标5秒，绝不能超过12秒；默认1个连续镜头、固定机位或缓慢单一运镜、1个主要动作，仅叙事确需切镜时最多2个且每个至少2秒。重写已有分镜时保留 duration 与全部业务动作/台词。
- description 的【镜头N】是镜头数唯一来源：video_prompt 必须写同样数量的 [Shot N]，不得合并、不得新增；只有 description 本身单镜头时才写单个 Shot。后续镜头的切镜点用官方 At MM:SS.mmm，严格递增且小于 duration；镜头正文里不要写「0-3 秒：」这类段内时间段，段内节奏用动作先后的自然叙述表达。
- 无对白/旁白时 overall_soundscape 必须写一句中文「本段无对白、旁白与人声」，只保留环境/动作声；有对白时用一句中文说明只有实际发声者出声、其余角色闭口不出声。detailed_description 每个 Shot 都要写清当前谁发声、谁闭口。
- 每个 Shot 都要带空间锚点，description 已有的空间描述原样保留对应的中文表达；双人对话优先同焦平面平视中近景，逐人写清左右位置、距离、朝向与独立动作，所有需要辨认的脸均清晰可见，避免浅景深、背景人物虚化、遮脸与快速运动。
- 一个 Shot 只允许一个说话人 ID：角色要回应时用 [Shot N] At MM:SS.mmm 另起镜头，多轮对话拆到相邻段落，避免模型把台词串读或错配给别人。
- 禁止写入元指令（无字幕、不要说话、保持一致、必须、只能、4K、高清、参考这张图）：模型会把这类约束当成台词或画面文字。要表达同样效果就写可见状态，例如「中景平视，人物位于画面中央」「暖黄灯光均匀照亮脸部」「人物仍穿黑色外套，右手拿着木盒」。
- 只有 available_voice_references / has_voice 明确可用的角色才用 #角色名 标注对白音色；否则用角色姓名描述说话人。步数、分辨率、种子、采样器、增强开关由模板/界面控制，不写进创作文本。`
  if (type === 'storyboard_breaker') return `${common}\n${video}
- 先用 read_storyboard_context 读取本集事实与绑定ID；每段写齐 description、video_prompt、duration、character_ids、prop_ids、scene_id、atmosphere。
- 整集重拆时首批 save_storyboards 带 replace_existing: true，后续追加；每批最多${STORYBOARD_BATCH_SIZE}段，每轮仅一次 save_storyboards；不要同时生成多批。shot_number 从1连续递增；全部批次保存后才能完成。不要一次性塞入整集，也不要每批都清空。
- 只有明确的增量编辑才使用 update_storyboard，不清空旧分镜；调整完也必须保存。`
  return `${common}\n${video}
- 图片提示词使用单段：角色正脸特写与正侧背三视图（同一身份妆造），场景无人物固定广角/前中后景布局，道具白底单品无手持。项目风格由保存工具注入，正文不要另加“电影质感”等固定风格；角色和道具参考图的白底、均匀光、固定姿势与身份清晰优先于风格里的剧情背景、动态构图或景深指令。室外场景不要求墙门，陈设按实际事实，不为凑数量而补造。
- 分镜提示词只更新指定ID的 video_prompt，通过 update_storyboard 保存；参数仅 storyboard_id 与 video_prompt，不改变描述、时长、绑定或其他分镜，不重新拆集。`
}
