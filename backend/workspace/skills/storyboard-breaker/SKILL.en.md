---
name: storyboard-breaker
description: Professional rules for storyboard breakdown — splitting a script into storyboard segments that each carry multiple sub-shots
---

# Storyboard Breakdown Guide

## Core Definition: Storyboard Segment

One storyboard = one **storyboard segment** = one video-generation task.

- Use content-driven **4-12 integer seconds**, with no 5-second target and no extension to 15 seconds. This is a local stability strategy, not an official capability limit or quality guarantee
- Default to one continuous shot and one main action, with a static camera or one simple move; necessary narrative cuts use at most two shots, each at least 2 seconds, without padding
- Keep one scene per segment (`scene_id` is segment-level). Carry camera direction, character positions, doors/windows/furniture and key-light relations into adjacent segments rather than re-establishing the space
- Prefer one or two characters, on the same focal plane, with distinct identities, positions, distances, face directions and independent actions; preserve recognizable faces and all plot characters
- Prefer one main speaker per newly generated segment. Allow several lines from the same character when natural delivery fits; start a new segment for a speaker change where possible. This is not an official one-speaker-per-Shot hard limit and never justifies deleting existing dialogue or shots
- Enter the current action directly at normal speed. Do not pad with repeated establishing shots, head lifts/inhalations, slow motion or end freezes; retain pauses and performance grounded in the original

## Breakdown Process (Four Steps)

1. Read the script, characters, scenes, props and existing storyboard summaries with `read_storyboard_context`; use only the save tool's existing schema fields
2. **Causality and beats**: internally trace prior state → current action / who addresses whom with the exact line → immediate result and the next segment's continuation. Split at narrative turns and speaker changes, carrying positions and actions forward. Do not leak this planning into H3 prose or invent planning fields
3. **Estimate duration**: use natural delivery, actions, necessary pauses and reasonable overlap, not script-count or segment quotas. Continue beyond 12 seconds in the next segment at a natural semantic/action boundary; omit no lines or plot
4. **Design and save**: describe visible action and exact speech under `【镜头N】` in description, then generate video_prompt under the authoritative video-prompt skill. Save at most 2 segments per batch, one `save_storyboards` call per response. Full regeneration uses `replace_existing: true` only in the first batch; later batches append. Incremental edits never clear existing storyboards. Finish after all saves succeed

## Pacing-Tier Durations

Determine duration by the segment's function — do not use one size for all:

| Segment type | Duration | Notes |
|---|---|---|
| Short reaction | 4 s | Enter the original reaction and visible state change directly |
| Ordinary dialogue | 5-8 s | Natural original speech; several lines from one character may fit |
| Continuous action | 6-10 s | Normal-speed connected action without repeated preparation |
| Long dialogue | 10-12 s | Preserve original pauses; do not squeeze or pad to 12 |

Treat these as content references, not quotas. Keep new segments at 4-12 integer seconds and preserve the entire plot.

## Natural Speech and Action Timing

Estimate Chinese dialogue at **4.5-5.5 characters/second**, usually with **0.4-0.8 seconds total buffer**. Account for emotional pauses from the original without adding repeated buffers per sentence or action. Use natural delivery for other languages, not the Chinese character rate.

When speech and action can happen together, estimate their actual overlapping duration; sum them when sequence is required. Do not blindly add all durations or force overlap. Continue overflow beyond 12 seconds in the next segment at a natural semantic/action boundary, preserving every line and action without generic pauses, slow motion or end freezes.

## Shot Elements

1. **Shot title**: a 3-5-character summary of the segment's core content (e.g. "Nightmare Awakening")
2. **Time**: specific time of day + lighting description
3. **Location**: full scene description + spatial layout + environmental details
4. **Shot size**: the dominant shot size of the segment; for multi-size segments write a combination, e.g. "medium shot + close-up"
5. **Angle**: eye-level / low angle / high angle / side / back
6. **Camera move**: static / push-in / pull-back / pan / tracking / dolly (different sub-shots within a segment may differ)
7. **Visual description** `description`: under `【镜头1】…【镜头2】…`, write action as a complete sentence, then separate speech by a full stop or newline using the fixed syntax `角色原名说：「原句」`. Substitute the exact original business character name and complete verbatim line; do not translate names or mix action text into a speaker name. Keep only existing narration as `旁白：「原句」`
8. **Immediate result and continuity**: write the ending consequence and the next segment's established state in `description`; invent no `result` or causal-planning field
9. **Atmosphere** `atmosphere`: lighting + color + environment; do not derive new voice or music from mood alone
10. **Duration** `duration`: 4-12 integer seconds, sufficient for natural speech and action without target-driven padding
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

- Write prior state, each character's action / exact line and addressee, immediate result and continuity under `【镜头N】` in description. Retain only original narration. These markers remain the sole video-shot source; do not add or remove them for the speaker strategy
- Follow the authoritative video-prompt skill for the official six sections with English explanatory prose and original-language dialogue/lyrics/visible text. Do not duplicate its reference numbering, Subject/Sx, sound or video-style rules here
- Existing rewrites preserve duration, shot count, all actions and dialogue; bind existing multiple speakers line by line without deleting content for the new stability strategy
- Before saving check speaker, order, full original wording and occurrence count, along with causal action, actual timing and spatial continuity. Use only existing tool-schema fields; invent no result, image_prompt, bgm_prompt or sound_effect fields
- Incremental `update_storyboard` edits never clear the episode
