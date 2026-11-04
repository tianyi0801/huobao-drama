---
name: storyboard-breaker
description: Professional rules for storyboard breakdown — splitting a script into storyboard segments that each carry multiple sub-shots
---

# Storyboard Breakdown Guide

## Core Definition: Storyboard Segment

One storyboard = one **storyboard segment** = one video-generation task.

- Local H3 baseline: **4-12 integer seconds, target 5, never exceed 12**; longer dialogue may use 9-12 without padding
- Default **one continuous shot and one main action**, static camera or one slow movement; only when necessary use at most two shots, each at least 2 seconds
- Never cross scenes (`scene_id` is segment-level); preserve the entire plot and original speech
- Two characters should share the focal plane; specify each identity, position, face direction and action. Both faces must remain clear, including supporting characters, without shallow-depth background blur

## Breakdown Process (Four Steps)

1. Call `read_storyboard_context` to read the script, characters, scenes, props, and existing storyboard summaries
2. **Identify beats**: split at narrative boundaries. A causal chain can continue across adjacent segments using stable spatial anchors and action continuity; duration and dialogue capacity take priority over keeping the chain in one segment
3. **Estimate duration**: script character count ÷ 500 × 60 yields only a rough seconds estimate, not a count or ±20% quota. Sum natural speech, actions and pauses; never delete plot to fit an estimate
4. **Design simple shots**: default one shot; cut only when necessary. Save complete fields in batches of at most 2 segments, one save call per response. Full regeneration uses `replace_existing: true` only in the first batch; subsequent batches append. Explicit incremental updates never clear old shots. Finish only after all required saves

## Pacing-Tier Durations

Determine duration by the segment's function — do not use one size for all:

| Segment type | Duration | Notes |
|---|---|---|
| Transition segment | 4-5 s | Traveling, empty shots, environment establishment, transitions |
| Narrative segment | 5-8 s | Plot advancement, dialogue |
| Longer dialogue or slow action | 9-12 s | Natural speech, pauses and one main action; no quota-driven cuts |

## Dialogue Capacity

Allow natural speaking time and approximately 2 seconds of performance headroom. Chinese 4.5 characters/second is only a reference; do not impose it as an English speech rate.

Dialogue that does not fit must be moved to the next segment; cramming unperformable dialogue into one segment is not allowed.

## Shot Elements

1. **Shot title**: a 3-5-character summary of the segment's core content (e.g. "Nightmare Awakening")
2. **Time**: specific time of day + lighting description
3. **Location**: full scene description + spatial layout + environmental details
4. **Shot size**: the dominant shot size of the segment; for multi-size segments write a combination, e.g. "medium shot + close-up"
5. **Angle**: eye-level / low angle / high angle / side / back
6. **Camera move**: static / push-in / pull-back / pan / tracking / dolly (different sub-shots within a segment may differ)
7. **Visual description** `description`: describe sub-shot by sub-shot as `【镜头1】…【镜头2】…` what the audience actually sees and hears — the visuals (who + specific action + body-language details + expression) come first; when a sub-shot has dialogue, write it inside the corresponding `【镜头N】` as "CharacterName says: "line"", and narration as "Narration: content"
8. **Visual result** `result`: the immediate consequence at the end of the segment + visual details
9. **Atmosphere** `atmosphere`: lighting + color tone + sound + overall mood
10. **Duration** `duration`: 4-12 integer seconds, target 5, never exceed 12, with natural speech capacity
11. **Scene binding**: if it can be matched to an existing scene, `scene_id` must be filled in
12. **Character binding**: fill in `character_ids`, binding 0 to multiple characters involved in this segment
13. **Prop binding**: fill in `prop_ids`, binding 0 to multiple key props appearing in this segment

## Scene Binding Rules

- Prefer the `scenes` returned by `read_storyboard_context`
- When `location + time` can be clearly matched, the correct `scene_id` must be filled in
- Do not fabricate scene IDs that do not exist
- If the script content clearly falls within an existing scene, do not create a duplicate new scene description

## Character Binding Rules

- `character_ids` must be chosen from the character list returned by `read_storyboard_context`
- A segment may have no characters, or may bind multiple characters
- Any character with a clear appearance in the segment — seen, acting, or speaking — should be bound
- Pure-environment segments, empty shots, and object close-ups may pass an empty array

## Prop Binding Rules

- `prop_ids` must be chosen from the prop list (`props`) returned by `read_storyboard_context`
- When a prop is used by a character, handed over, shown in close-up, or clearly visible in frame and meaningful to the narrative, it must be bound to that segment
- Prop close-up segments (without characters) should also bind the prop; `character_ids` may be empty
- Do not bind background items or set dressing irrelevant to the plot; segments with no props pass an empty array
- Bound props serve as reference images for video generation (white-background product shots), keeping the prop's appearance consistent across segments

## Quality Requirements

- Default to `【镜头1】` with exact positions, faces and actions. Use the official MiniMax Ref2VA six sections for `video_prompt` (subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music) written in English, with an independent <Subject N> for every visible character; use @ references only for actual available images
- Original dialogue appears once in its Shot as <d>[Chinese] ...</d> with a stable (Sx) speaker ID. overall_soundscape contains 1-4 English sentences of ambience and physical sounds only, with no speaker whitelist and no repeated dialogue
- retention_analysis uses only official markers (fully_preserved / partially_preserved / attribute_transfer / weak_reference); non_diegetic_music is N/A unless music is explicitly requested; do not design sound from atmosphere alone
- Use only the save tool schema fields. Incremental `update_storyboard` edits never clear the episode
