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
  const video = `## 本地 ComfyUI 视频提示词契约
- 实际视频模板：${localVideo}。本项目内置 H3 工作流；不要按历史云端配置显示名改用其他提示词格式。
- video_prompt 是一个完整字符串，含以下六节且顺序固定：${H3_SECTIONS.join(' / ')}。六节不是六个节点参数，禁止退化为单段散文。
- 分镜创作按戏剧节拍组织，不把硬件配置当成单镜头或单动作限制；一个生成段落可以包含铺垫—发生—反应及多轮短对白，不为了某个固定秒数把因果链切碎。
- 优先读取 target_storyboard 的绑定素材与 available_image_references，直接复制其中 image_reference（如 @林墨）而不是自己按ID猜名称；整集拆分按资产 image_url 与本段绑定生成同样引用。有图且在画面中使用的资产必须使用精确 @角色名/@场景名/@道具名，不是可选修饰；只有确实无图的资产才用普通名称。
- subject_definitions：每个可见人物单独一行；有图写 <Subject N> 是 @角色名：文字资料已有的脸部/发型、服装识别点，无图才省略 @。主角与配角同等明确；shot_summary 与 detailed_description 提到有图人物/场景/道具时也保留精确 @名称，原句对白正文不插入资源标记。
- reference_usage：每条必须点名实际素材与用途，如 <Subject 1>（@林墨）: identity_reference、@林墨家客厅: scene_reference、@钥匙: object_reference，不写“角色参考图”“场景参考图”等泛称。有图的绑定场景及本段使用的有图角色/道具逐项列出；角色图提供身份与服装，不复制三视图拼版、姿势或背景，场景图提供空间，尾帧可声明 continuity_reference。只有确实没有可用图片时才写 N/A，不虚构引用；保存回执提示缺少 @引用时必须按清单补齐后重试。
- detailed_description：连续的 [Shot N] 起始秒-结束秒，含景别/角度/运镜、空间锚点、动作及原有对白。总长严格等于 duration，不跨场景，不创作新台词。
- 新拆分 duration 为4—12的整数秒，绝不能超过12秒；先设计节拍、动作与自然对白，再确定时长，没有固定目标秒数，不填充空停顿。一般可用2—4个有叙事作用的子镜头表达建立关系、动作细节与反应，这只是手法参考，不是镜头数量配额；完整调度适合长镜头时可用1个镜头，不设最多2镜头或每镜头2秒下限。切镜按信息变化、视线、动作或话轮，不机械等分；短促插入特写与反应可少于2秒，但须看清内容，台词须有自然发话时间。
- 优先在同段保留铺垫—发生—反应，超出时长范围才在自然话轮或动作承接处拆段，不删剧情。对白可与动作、听者反应并行，不为每个子镜头机械预留2秒；中文约4—5字/秒仅为语速估算，实际按语言、情绪与停顿分配。重写已有分镜时保留 duration、description、全部动作/原句对白以及原有子镜头顺序和切镜点，不为单镜头偏好合并或新增子镜头。
- 景别和机位服务叙事：可使用建立镜头、正反打、过肩、动作/道具特写、反应镜头、推拉跟移与动机明确的焦点转移，不把双人戏锁为平视同焦中近景。写清逐镜人物相对位置、视线、动作与关注主体，需辨认身份或表情时脸部应清晰；可有背影、遮挡和景深变化，但不丢剧情角色。保持场景布局、光源、轴线与动作连续，允许叙事性换机位、景别和构图。
- 对白只从 description 逐字提取，仅在 detailed_description 对应时间段写一次完整原句，明确说话人；overall_soundscape 只列说话白名单和环境/动作声，不再次抄写台词。可按原文轮流发话，逐段标明发话起止；每人仅在自己的对白时段发声，未轮到发话或无台词者闭口不发声。原文没有旁白则禁止旁白、解说、画外人声、哼唱及临时对白；原文对白在合法反打时延续不等于新增画外人声。
- 无对白/旁白时 overall_soundscape 明确写“无任何人声，仅有画面对应的环境/动作声”，全静音要求则写“全程静音”；不能仅靠 N/A 表示禁人声。non_diegetic_music 默认写“无背景配乐、无歌声”，只有原文或用户明确指定才设计配乐。@角色名/@场景名/@道具名精确匹配上下文，系统负责最终图片编号，不手写 @图片1。
- 六节正文精炼但不牺牲戏剧回合；每人2—3个可靠外观识别点即可，不堆叠无关衣饰或质量词，不用总字数上限挤掉配角身份、动作或对白白名单。
- 只有 available_voice_references / has_voice 明确可用的角色才用 #角色名 标注对白音色；否则用角色姓名描述对白，不虚构声音引用。
- 步数、分辨率、种子、采样器、增强开关由模板/界面控制，不写进创作文本。`
  if (type === 'storyboard_breaker') return `${common}\n${video}
- 先用 read_storyboard_context 读取本集事实与绑定ID；每段写齐 description、video_prompt、duration、character_ids、prop_ids、scene_id、atmosphere。
- 整集重拆时首批 save_storyboards 带 replace_existing: true，后续追加；每批最多${STORYBOARD_BATCH_SIZE}段，每轮仅一次 save_storyboards；不要同时生成多批。shot_number 从1连续递增；全部批次保存后才能完成。不要一次性塞入整集，也不要每批都清空。
- 只有明确的增量编辑才使用 update_storyboard，不清空旧分镜；调整完也必须保存。`
  return `${common}\n${video}
- 图片提示词使用单段：角色正脸特写与正侧背三视图（同一身份妆造），场景无人物固定广角/前中后景布局，道具白底单品无手持。项目风格由保存工具注入，正文不要另加“电影质感”等固定风格；角色和道具参考图的白底、均匀光、固定姿势与身份清晰优先于风格里的剧情背景、动态构图或景深指令。室外场景不要求墙门，陈设按实际事实，不为凑数量而补造。
- 分镜提示词只更新指定ID的 video_prompt，通过 update_storyboard 保存；参数仅 storyboard_id 与 video_prompt，不改变描述、时长、绑定或其他分镜，不重新拆集。`
}
