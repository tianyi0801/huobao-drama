---
name: storyboard-breaker
description: Professional rules for storyboard breakdown — splitting a script into storyboard segments that each carry multiple sub-shots
---

# Storyboard Breakdown Guide

## Core Definition: Storyboard Segment

One storyboard = one **storyboard segment** = one video-generation task.

- A segment carries a dramatic beat: **setup—event—reaction**, related actions and short dialogue exchanges, not one isolated action
- Use **4-12 integer seconds**, content first and duration second, with no fixed target; hardware does not dictate shot grammar
- **Two to four motivated sub-shots** are a technique reference, not a quota; continuous staging can use a long take. Never cross scenes (`scene_id` is segment-level)
- Use establishing views, shot/reverse-shot, over-the-shoulder coverage, action/prop inserts, reactions and motivated movement or focus changes. Specify identities, positions and eyelines; show relevant faces clearly when identity or expression matters, without removing supporting roles

## Breakdown Process (Four Steps)

1. Call `read_storyboard_context` to read the script, characters, scenes, props, and existing storyboard summaries
2. **Identify beats**: split at major narrative boundaries, keeping setup—event—reaction together. Split a causal chain only when the task range requires it, at natural speech turns or action matches.
3. **Design coverage and timing**: build the relationship, show action/detail, then reaction/result. Allocate unequal shot lengths by new information, eyelines and dialogue turns; avoid idle padding. Concurrent speech, action and reactions do not add duration twice.
4. **Save in batches**: at most 2 segments and one save call per response; this limits save batches, not sub-shot counts. Full regeneration uses `replace_existing: true` only in the first batch; subsequent batches append. Incremental edits never clear old shots. Finish only after all required saves.

## Narrative Pacing and Coverage

- Transitions establish new space quickly; cut when information is clear, without repeated empty shots or slow pushes.
- Action—detail—reaction and shot/reverse-shot keep the dramatic exchange intact. Dialogue may continue over the listener reaction with its original speaker identified.
- Hold deliberately for a key reveal or emotional turn, then tighten the rhythm. A long take is valid for important performance; do not force every shot to the same duration.
- Use unequal continuous timing, no shot-count quota and no universal minimum length. Readable brief inserts/reactions may be under 2 seconds; speech must fit naturally.
- Maintain layout, lighting, axis, eyelines and action matches, not identical camera or composition.

## Natural Speech and Performance Time

Use the actual language, emotion and necessary pauses to estimate speech. Dialogue can run concurrently with action or reactions; do not mechanically reserve two seconds per shot. Character counts are only a speech-rate reference, never an episode-count quota.

Preserve original words. Split long lines at natural semantic boundaries only when the task range requires it, rather than rushing speech or fragmenting every action into another task.

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
10. **Duration** `duration`: 4-12 integer seconds, content first then timing, with natural speech and no fixed target duration
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

- Describe all actual `【镜头N】` in order with shot size, positions, eyelines, actions and original dialogue; each shot advances information. Map them to [Shot N] with matching cut points, no single-action task padding. Use six sections and an independent Subject for every visible character; @ references require actual images.
- Original dialogue appears once in its Shot. overall_soundscape lists permitted speakers and speech windows plus environmental/action sounds. Each character speaks only during their own lines and stays silent otherwise. Preserve original narration, add no voices; original dialogue over a reverse angle is not new off-screen speech. Without dialogue/narration explicitly state no human voices.
- non_diegetic_music defaults to no music and no singing unless explicitly requested; do not design sound from atmosphere alone
- Use only the save tool schema fields. Incremental `update_storyboard` edits never clear the episode
