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
- 本地 H3 调优基线：RTX 4060 Ti 8GB 显存、32GB 内存。这是低复杂度创作策略，不是模型硬件能力或质量保证。
- subject_definitions：每个可见人物单独一行，<Subject N> 是 角色名：文字上下文已有的脸部/发型、服装识别点；主角与配角同等明确。仅 image_url 已有实际图片的资产使用 @角色名/@场景名/@道具名；未生图资产用普通名称描述，不虚构 @ 引用。shot_summary：谁、在哪、做什么、结果，不重复台词。
- reference_usage：仅声明实际已有参考素材的 identity_reference / scene_reference / object_reference 用途；角色图提供身份与服装，不复制三视图拼版、姿势或背景，场景图提供空间，衔接尾帧可声明 continuity_reference；没有图片时写 N/A，不虚构参考图。
- detailed_description：连续的 [Shot N] 起始秒-结束秒，含景别/角度/运镜、空间锚点、动作及原有对白。总长严格等于 duration，不跨场景，不创作新台词。
- 新拆分 duration 为4—12的整数秒，目标5秒，绝不能超过12秒；长对白或缓慢动作可按需延长到9—12秒，不强制凑满12秒；默认1个连续镜头、固定机位或缓慢单一运镜、1个主要动作。仅叙事确需切镜时最多2个，每个至少2秒；不要为了段数而切镜。重写已有分镜时保留 duration 与全部业务动作/台词，只在不删情节时合并冗余切镜，否则保留原时间轴，不改描述或时长。
- 双人对话优先同一焦平面的平视中近景，写清每人的画面左右位置、距离、脸部朝向与独立动作；所有需要辨认的脸均清晰可见，避免浅景深、背景人物虚化、背脸遮挡、焦点转移和快速运动。复杂多人戏优先拆为单人/双人镜头，不删除有剧情作用的配角，不增加无关路人。
- 对白只从 description 逐字提取，仅在 detailed_description 对应时间段写一次完整原句，明确说话人；overall_soundscape 只列说话白名单和环境/动作声，不再次抄写台词。其他人物保持闭口、全程不发声；原文没有旁白则禁止旁白、解说、画外人声、哼唱及临时对白。
- 无对白/旁白时 overall_soundscape 明确写“无任何人声，仅有画面对应的环境/动作声”，全静音要求则写“全程静音”；不能仅靠 N/A 表示禁人声。non_diegetic_music 默认写“无背景配乐、无歌声”，只有原文或用户明确指定才设计配乐。@角色名/@场景名/@道具名精确匹配上下文，系统负责最终图片编号，不手写 @图片1。
- 六节正文简短、一次只说明一件事；每人2—3个可靠外观识别点即可，不堆叠无关衣饰或质量词，不用总字数上限挤掉配角身份、动作或对白白名单。
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
