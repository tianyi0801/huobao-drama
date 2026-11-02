import type { RequestContext } from '@mastra/core/request-context'
import { getComfyConfig } from '../services/comfyui/config.js'

export const STORYBOARD_BATCH_SIZE = 2
export const STORYBOARD_MAX_STEPS = 80

export const H3_SECTIONS = ['subject_definitions', 'shot_summary', 'reference_usage', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'] as const

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
- 场景头使用 ## S编号 | 内景/外景 · 地点 | 时间段；动作写自然段，对白按角色名标注，不加入相机或模型参数。`
  if (type === 'extractor') {
    const target = rc?.get('extractTarget' as never) as string | undefined
    return `${common}
- ${target ? `本次只提取 ${target}：只调用 read_existing_${target} 与 save_dedup_${target}，不要读取或写入其他资产类型。` : '仅提取用户请求的资产类型；未指定时可提取角色、场景、道具。'}
- 先调用 read_script_for_extraction；同名资产合并复用，不能为了重提而创建重复资产。
- 角色输出 appearance（可见外貌/性格外化）与 styling（妆造）；场景输出 prompt（无人物环境布局）与 lighting；道具 description 仅描述物品外观。不要预先生成图片最终提示词。
- 道具须推动情节且需要独立参考图；以下任一为“是”就排除：删除它剧情仍成立？只是日常随手物品？只是场景陈设？通常最多3个，没有合格道具也必须调用 save_dedup_props 并传 props: []。`
  }
  const comfy = getComfyConfig()
  const localVideo = comfy.video?.name || '尚未绑定本地视频工作流'
  const video = `## 本地 ComfyUI 视频提示词契约
- 实际视频模板：${localVideo}。本项目内置 H3 工作流；不要按历史云端配置显示名改用其他提示词格式。
- video_prompt 是一个完整字符串，含以下六节且顺序固定：${H3_SECTIONS.join(' / ')}。六节不是六个节点参数，禁止退化为单段散文。
- subject_definitions：只列本段人物，<Subject N> 是 @角色名：文字上下文已有外貌。shot_summary：谁、在哪、做什么、结果。
- reference_usage：仅声明实际已有参考素材的 identity_reference / scene_reference / object_reference 用途；资产图不提供姿态或构图，衔接尾帧可声明 continuity_reference；没有图片时写 N/A，不虚构参考图。
- detailed_description：连续的 [Shot N] 起始秒-结束秒，含景别/角度/运镜、空间锚点、动作及原有对白。总长严格等于 duration，不跨场景，不创作新台词。
- duration 为4—8的整数秒，目标5秒；≤5秒2个子镜头，6—8秒2—3个。子镜头长度按动作合理分配，不另加互相冲突的1.5—2.5秒硬限制。
- overall_soundscape 写环境音、动作音和对白；non_diegetic_music 写配乐；没有时 N/A。@角色名/@场景名/@道具名精确匹配上下文，系统负责最终图片编号，不手写 @图片1。
- 只有 available_voice_references / has_voice 明确可用的角色才用 #角色名 标注对白音色；否则用角色姓名描述对白，不虚构声音引用。
- 步数、分辨率、种子、采样器、增强开关由模板/界面控制，不写进创作文本。`
  if (type === 'storyboard_breaker') return `${common}\n${video}
- 先用 read_storyboard_context 读取本集事实与绑定ID；每段写齐 description、video_prompt、duration、character_ids、prop_ids、scene_id、atmosphere。
- 整集重拆时首批 save_storyboards 带 replace_existing: true，后续追加；每批最多${STORYBOARD_BATCH_SIZE}段，每轮仅一次 save_storyboards；不要同时生成多批。shot_number 从1连续递增；全部批次保存后才能完成。不要一次性塞入整集，也不要每批都清空。
- 只有明确的增量编辑才使用 update_storyboard，不清空旧分镜；调整完也必须保存。`
  return `${common}\n${video}
- 图片提示词使用单段：角色正脸特写与正侧背三视图（同一身份妆造），场景无人物固定广角/前中后景布局，道具白底单品无手持。项目风格由保存工具注入，正文不要另加“电影质感”等固定风格。
- 分镜提示词只更新指定ID的 video_prompt，通过 update_storyboard 保存；参数仅 storyboard_id 与 video_prompt，不改变描述、时长、绑定或其他分镜，不重新拆集。`
}
