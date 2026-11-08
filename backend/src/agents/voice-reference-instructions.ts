/** 首次拆分与单条/批量视频提示词共用，运行时注入以覆盖自定义模板的音色契约。 */
const instructions: Record<string, string> = {
  zh: `## 视频提示词中的角色音色引用
- read_storyboard_context 的角色提供 has_voice 与 voice_reference；已有分镜提供 available_voice_references。只有 has_voice 为 true 的角色才有可用音色。
- 为某个分镜生成或重写 video_prompt 时，只使用该分镜 available_voice_references 中的音色；首次拆分时，只使用本段 character_ids 对应角色的 voice_reference。
- 先从 description 原句确定发声者，画面使用 @角色名；在六节英文正文的 detailed_description 中，每句对白内联对应的 <Subject N>、稳定 (Sx)、可用 #角色名 与 says。例如：[Shot 1] @林小雨 looks up. <Subject 1> (S1) #林小雨 says softly, <d>[Chinese]早上好。</d>
- Subject/Sx 在目标视频内稳定复用，发声角色、形象引用、音色引用与原句逐一对应。每次发话都明确自己的 #角色名，不把音色集中在开头，不加独立音色信息头或说话白名单，也不把绑定规则写进 overall_soundscape。
- 原样复制完整 voice_reference（如 #林小雨），不改名、缩写、翻译或添加后缀。@角色名参考形象，#角色名仅参考 timbre，不是 audio reuse，也不复制参考音频的台词、语速或背景声。
- 没有上传音色的角色、未绑定角色、已移除音色和不说话的角色，不添加 # 引用。旁白只有明确对应某个已绑定、已有音色的角色时才可引用，不借用其他角色的音色；没有可用音色也不要求新增声音。
- 台词逐字逐标点与发话顺序遵循 description，不为使用音色新增对白、旁白、其他人声、人物或镜头，不将原句改成音频中的内容。
- 保存前检查 Subject/Sx、@形象、#音色与源原句对应关系。video_prompt 保留原始 #角色名，不写音频 URL、Base64 或音频1 等上游编号，视频生成接口负责映射。`,
  en: `## Character voice references in video_prompt
- read_storyboard_context provides has_voice and voice_reference for each character, plus available_voice_references for each existing storyboard.
- For an existing shot, use only its available_voice_references. During initial breakdown, use only voice_reference values belonging to this segment's character_ids.
- Identify speakers from the source utterances in description. Within detailed_description of the six English sections, bind each utterance inline to <Subject N>, stable (Sx), its available #CharacterName and says. Example: [Shot 1] @Alex looks up. <Subject 1> (S1) #Alex says softly, <d>[Chinese]早上好。</d>
- Reuse Subject/Sx consistently throughout the target video. Match speaker, image, voice and utterance individually; mark the correct #speaker on every utterance. Do not collect voices at the start, add a separate voice header or a speaker whitelist, or put binding rules in overall_soundscape.
- Copy the complete voice_reference value exactly (e.g. #Alex), without translation, abbreviation or suffix. @CharacterName references the image; #CharacterName references timbre only, not audio reuse or the reference recording's words, delivery speed or background sounds.
- Do not add # references for unbound characters, missing/removed uploads, or silent characters. Narration may use a voice only when its speaker is explicitly a bound character with that voice; never borrow another character's voice. Missing references do not require new voices.
- Preserve source dialogue character-for-character, including punctuation and speaking order from description. Do not add dialogue, narration, other vocal sounds, characters or shots to use a voice, or replace the source words with the reference recording.
- Before saving, check Subject/Sx, image/voice references and source utterance bindings. Save the original #CharacterName tokens, never audio URLs, Base64 or provider audio numbers; video generation resolves the indices.`,
  ja: `## video_prompt のキャラクター音声参照
- read_storyboard_context は各キャラクターの has_voice と voice_reference、既存ショットの available_voice_references を返す。
- 既存ショットではその available_voice_references のみ使用する。初回分割では、その段落の character_ids に含まれるキャラクターの voice_reference のみ使用する。
- description の原文から話者を確認する。英語本文の六節中の detailed_description で、発話ごとに <Subject N>、固定 (Sx)、利用可能な #名前 と says をインラインで対応させる。例：[Shot 1] @太郎 looks up. <Subject 1> (S1) #太郎 says softly, <d>[Chinese]早上好。</d>
- 対象動画内で Subject/Sx を一貫して再利用し、話者・画像・声質・原文を一対一で対応させる。発話ごとに #名前 を付け、冒頭に集約しない。独立した音声ヘッダーや話者ホワイトリストを追加せず、overall_soundscape に対応規則を書かない。
- voice_reference（例：#太郎）を完全一致でコピーし、翻訳・省略・接尾辞の追加をしない。@名前 は画像、#名前 は timbre の参照のみで audio reuse ではない。参照録音のセリフ・速度・背景音をコピーしない。
- 未紐付け・未アップロード・削除済み音声・無言の人物には # 参照を付けない。ナレーションは話者が音声付きの紐付け済みキャラクターと明示された場合のみ参照し、別人の声を流用しない。参照がなくても新しい声を要求しない。
- description のセリフを文字・句読点まで原文通り保持し、発話順を守る。声質参照のためにセリフ・ナレーション・他の人声・人物・カットを追加せず、参照録音の内容に置き換えない。
- 保存前に Subject/Sx・@画像・#声質・原文の対応を確認する。元の #名前 を保存し、音声URL、Base64、上流の音声番号を書かない。番号への変換は動画生成側が行う。`,
  ko: `## video_prompt의 캐릭터 음색 참조
- read_storyboard_context는 캐릭터별 has_voice와 voice_reference, 기존 샷별 available_voice_references를 제공한다.
- 기존 샷은 해당 available_voice_references만 사용한다. 최초 분할은 해당 구간 character_ids에 속하는 캐릭터의 voice_reference만 사용한다.
- description의 원문 대사에서 화자를 확인한다. 영어 본문 여섯 섹션 중 detailed_description에서 각 발화에 <Subject N>, 고정 (Sx), 사용 가능한 #이름 및 says를 인라인으로 연결한다. 예: [Shot 1] @민수 looks up. <Subject 1> (S1) #민수 says softly, <d>[Chinese]早上好。</d>
- 대상 영상에서 Subject/Sx를 일관되게 재사용하며 화자, 이미지, 음색, 원문을 각각 대응시킨다. 매 대사에 올바른 #이름을 붙이고 처음에 모아 쓰지 않는다. 별도의 음색 헤더나 화자 허용 목록을 추가하지 않고 overall_soundscape에 연결 규칙을 쓰지 않는다.
- voice_reference(예: #민수)를 그대로 복사하고 번역, 축약, 접미사 추가를 하지 않는다. @이름은 이미지, #이름은 timbre만 참고하며 audio reuse가 아니다. 참조 녹음의 대사, 발화 속도, 배경음을 복사하지 않는다.
- 미연결 캐릭터, 미업로드/삭제된 음색, 말하지 않는 캐릭터에는 # 참조를 추가하지 않는다. 내레이션은 화자가 음색이 있는 연결 캐릭터로 명시된 경우에만 참조하고 다른 사람의 목소리를 빌리지 않는다. 참조가 없어도 새로운 목소리를 요구하지 않는다.
- description의 대사를 문자와 문장부호까지 그대로 유지하고 발화 순서를 지킨다. 음색 사용을 위해 대사, 내레이션, 기타 사람 소리, 인물, 샷을 추가하거나 참조 녹음 내용으로 대체하지 않는다.
- 저장 전 Subject/Sx, @이미지, #음색, 원문 대사의 연결을 확인한다. 원래 #이름 토큰을 저장하고 오디오 URL, Base64, 공급자 오디오 번호는 쓰지 않는다. 번호 변환은 영상 생성 단계에서 수행한다.`,
}

export function getVoiceReferenceInstructions(agentType: string, language?: string | null): string {
  if (agentType !== 'prompt_generator' && agentType !== 'storyboard_breaker') return ''
  return instructions[language || 'zh'] || instructions.zh
}
