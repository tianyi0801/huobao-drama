import type { RequestContext } from '@mastra/core/request-context'
import { getComfyConfig } from '../services/comfyui/config.js'
import { H3_SECTIONS } from '../services/video-prompt-structure.js'
export { H3_SECTIONS } from '../services/video-prompt-structure.js'

export const STORYBOARD_BATCH_SIZE = 2
export const STORYBOARD_MAX_STEPS = 80

/** 执行与结构由代码兜底；视频正文语言和创作细则以 video-prompt 技能为准。 */
export function buildLocalAgentContract(type: string, rc?: RequestContext): string {
  const common = `## 本地生产执行契约（与旧模板冲突时以本节为准）
- 工具注册名称与 tool id 相同，使用 snake_case；严格使用工具 schema 的参数，不猜测驼峰别名。
- 不要调用生图/视频服务或编造已生成素材。文本服务只负责创作与调用保存工具，图片/视频由本地 ComfyUI 单独执行。
- 必须实际调用保存工具并检查回执；返回 error 时应纠正输入，不能回复“完成”。保存成功后只用一句简短总结，不重复输出整份内容。
- 仅从已提供的文字/资产字段提取事实。工具只返回图片地址而未提供视觉输入时，不得声称已看过参考图。
- 参数中的字段名、ID、引用标记、小节名保持固定；非视频叙述正文按会话目标语言输出，video_prompt 正文语言遵循下方视频契约。`
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
- video_prompt 是一个完整字符串，含以下官方六节且顺序固定：${H3_SECTIONS.join(' / ')}。节名不得改名、翻译或退化成散文。视频创作细则的唯一权威是已注入的 video-prompt 技能，本节只兜底执行与结构契约。
- 六节正文使用英文，不随会话语言切换；对白/歌词与画面可见文字保留源语言。中文对白使用 <Subject 1> (S1) says, <d>[Chinese]原句</d>，每句逐字逐标点来自 description 且只出现一次，不新增台词、旁白、解说或其他人声。<Subject N> 身份与 (Sx) 发声者映射在目标视频内稳定复用；已有多个说话人时逐句明确对应 Subject 与 Sx，不以每 Shot 单说话人限制改写源内容。
- 技能文件缺失时仍按六节保存：subject_definitions 定义主体来源与特征，保留业务角色原名，有可用图写 @原名、无图写普通原名，不翻译或缩写；summary 用 [reference generation] 等任务前缀；retention_analysis 用 fully_preserved / partially_preserved / attribute_transfer / weak_reference 等官方关系标记；detailed_description 用英文描述可见动作与空间，源对白放在对应 Shot，原有画外音使用 says in an off-screen voiceover，不新增画外音；overall_soundscape 仅写实际环境音与物理声，non_diegetic_music 无配乐写 N/A。
- 读取 available_image_references，素材只写上下文中的 @角色名/@场景名/@道具名，直接复制 image_reference；系统负责编号，不手写 @图片1 / <Picture 1>。仅已有实际图片的资产才使用 @ 引用，未生图资产用普通名称描述，不虚构参考图；音色只使用 available_voice_references / has_voice 明确可用的 #角色名，规则以注入的音色契约为准。
- 新拆分 duration 为4—12的整数秒，绝不能超过12秒；按内容实际时长分配，不设目标秒数。以正常动作速度和自然发话推进剧情，少等待、不用慢动作或空白停顿凑时长；默认1个连续镜头、1个主要动作，仅叙事确需切镜时最多2个且每个至少2秒。新片段采用每片段一个主要说话人的稳态经验策略，换人优先新片段；这不是官方每 Shot 说话人数上限。
- 重写已有分镜保留 duration、全部原有动作与源台词原句，不改变 description 或绑定业务字段。description 的【镜头N】是镜头数唯一来源：video_prompt 必须写同样数量的 [Shot N]，不得合并、不得新增；只有 description 本身单镜头时才写单个 Shot。[Shot 1] 不带时间戳，后续用 [Shot N] At MM:SS.mmm，切镜点严格递增且小于 duration；段内动作与时间表达遵循 video-prompt 技能，不机械平均分配。
- description 已有空间关系在英文正文中忠实表达，逐人明确位置、朝向与独立动作，所有需要辨认的脸均清晰可见；不为清晰度删动作、改台词或改变原镜头数。项目风格由系统注入，不自行重复添加风格词。
- 元指令、说话白名单和独立音色信息头不得进入最终六节正文，尤其不进入声音节；把创作约束转成实际可见动作与实际可听声音。步数、分辨率、种子、采样器、增强开关由模板/界面控制，不写进创作文本。`
  if (type === 'storyboard_breaker') return `${common}\n${video}
- 先用 read_storyboard_context 读取本集事实与绑定ID；每段写齐 description、video_prompt、duration、character_ids、prop_ids、scene_id、atmosphere。description 将动作与台词用句号或换行分开，发话使用「角色原名说：「原句」」，不翻译角色名、不改台词原句。
- 整集重拆时首批 save_storyboards 带 replace_existing: true，后续追加；每批最多${STORYBOARD_BATCH_SIZE}段，每轮仅一次 save_storyboards；不要同时生成多批。shot_number 从1连续递增；全部批次保存后才能完成。不要一次性塞入整集，也不要每批都清空。
- 只有明确的增量编辑才使用 update_storyboard，不清空旧分镜；调整完也必须保存。`
  return `${common}\n${video}
- 图片提示词使用单段：角色正脸特写与正侧背三视图（同一身份妆造），场景无人物固定广角/前中后景布局，道具白底单品无手持。项目风格由保存工具注入，正文不要另加“电影质感”等固定风格；角色和道具参考图的白底、均匀光、固定姿势与身份清晰优先于风格里的剧情背景、动态构图或景深指令。室外场景不要求墙门，陈设按实际事实，不为凑数量而补造。
- 分镜提示词只更新指定ID的 video_prompt，通过 update_storyboard 保存；参数仅 storyboard_id 与 video_prompt，不改变描述、时长、绑定或其他分镜，不重新拆集。`
}
