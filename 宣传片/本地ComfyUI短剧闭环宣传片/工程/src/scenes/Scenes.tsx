import React from "react";
import { AbsoluteFill } from "remotion";
import { EASE, ramp, scene, type SceneName } from "../lib/anim";
import { C, FONT } from "../lib/theme";
import { Clip } from "../ui/Clip";
import { Film, Glow, Grid, Head, Kicker, Mark, Pill, ShotCard, Stage } from "../ui/Kit";

const RATIO_UI = 3840 / 2104; // 真实截图（已裁掉浏览器标签条）
const RATIO_COMFY = 1920 / 1080;

const inside = (name: SceneName, t: number) => {
  const s = scene(name);
  return { on: t >= s.start && t < s.end, start: s.start, u: t - s.start };
};

const fadeEnd = (t: number, end: number, dur = 0.42) => 1 - ramp(t, [end - dur, end], [0, 1], EASE.in);

/** 深色底：网格 + 双光晕 */
const DarkBG: React.FC<{ accent?: "purple" | "red" | "none" }> = ({ accent = "purple" }) => (
  <AbsoluteFill style={{ background: C.bg }}>
    <Grid opacity={0.045} />
    {accent !== "none" && (
      <>
        <Glow color={C.purple} x={980} y={300} size={900} opacity={accent === "purple" ? 0.4 : 0.18} />
        <Glow color={accent === "red" ? C.red : C.cyan} x={120} y={1620} size={760} opacity={0.26} />
      </>
    )}
  </AbsoluteFill>
);

// ── 1. 钩子：黑场，逐行出字 ─────────────────────────────
const Hook1: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("hook1", t);
  if (!on) return null;
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, start + 3.214, 0.28) }}>
      <DarkBG />
      <Stage style={{ justifyContent: "center" }}>
        <Kicker t={u} at={0.16}>RTX 4060Ti · 8G · 本地闭环</Kicker>
        <div style={{ height: 34 }} />
        <Head
          t={u}
          size={112}
          lines={[
            { text: "这条短剧", at: 0.36 },
            { text: "没有一个真人", at: 1.12, accent: 1 },
          ]}
        />
      </Stage>
    </AbsoluteFill>
  );
};

// ── 2. 钩子：真实影像 + 说明 ────────────────────────────
const Hook2: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("hook2", t);
  if (!on) return null;
  return (
    <AbsoluteFill>
      <Film
        t={u}
        at={0}
        out={3.215}
        clip={<Clip src="clip/s6.mp4" at={start} dur={3.215} srcStart={1.0} />}
      />
      <Stage style={{ justifyContent: "flex-end", paddingBottom: 300 }}>
        <Head
          t={u}
          size={88}
          lines={[
            { text: "演员是 AI 生的", at: 0.34 },
            { text: "场景也是", at: 0.86, accent: 2 },
          ]}
        />
        <div style={{ height: 22 }} />
        <Kicker t={u} at={1.5} color="rgba(255,255,255,0.6)">分镜 #26 · 参考图生视频</Kicker>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 3. 钩子：主角特写 + 成本反转 ─────────────────────────
const Hook3: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("hook3", t);
  if (!on) return null;
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, start + 3.214, 0.3) }}>
      <Film src="img/film3.jpg" t={u} at={0} out={3.214} dim={0.7} />
      <Stage style={{ justifyContent: "flex-end", paddingBottom: 280 }}>
        <Head
          t={u}
          size={92}
          lines={[
            { text: "只花了一台", at: 0.3 },
            { text: "家用电脑", at: 0.78, accent: 1 },
          ]}
        />
      </Stage>
    </AbsoluteFill>
  );
};

// ── 4. 标题：三段工作流 ─────────────────────────────────
const Title: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("title", t);
  if (!on) return null;
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, start + 3.214, 0.3) }}>
      <DarkBG />
      <Stage style={{ justifyContent: "center" }}>
        <Kicker t={u} at={0.1}>HOW IT WORKS</Kicker>
        <div style={{ height: 30 }} />
        <Head
          t={u}
          size={98}
          lines={[
            { text: "三段工作流", at: 0.28 },
            { text: "一条闭环", at: 0.72, accent: 1 },
          ]}
        />
        <div style={{ height: 48 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
          <Pill t={u} at={1.16} tone="purple">① 文生图 · 出场景</Pill>
          <Pill t={u} at={1.46} tone="purple">② 图生图 · 改场景</Pill>
          <Pill t={u} at={1.76} tone="cyan">③ 参考图生视频 · 出片段</Pill>
        </div>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 5. 硬件 ────────────────────────────────────────────
const Hardware: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("hw", t);
  if (!on) return null;
  const pop = ramp(u, [0.25, 0.62], [0.9, 1], EASE.back);
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, start + 3.214, 0.3) }}>
      <DarkBG accent="red" />
      <Stage style={{ justifyContent: "center" }}>
        <Kicker t={u} at={0.08} color={C.red}>实测硬件</Kicker>
        <div style={{ height: 34 }} />
        <div
          style={{
            fontFamily: FONT.display,
            fontSize: 156,
            fontWeight: 600,
            letterSpacing: "-0.03em",
            lineHeight: 1,
            backgroundImage: `linear-gradient(96deg, ${C.purple}, ${C.cyan})`,
            WebkitBackgroundClip: "text",
            color: "transparent",
            opacity: ramp(u, [0.2, 0.6]),
            transform: `scale(${pop})`,
            transformOrigin: "left bottom",
          }}
        >
          4060 Ti
        </div>
        <div style={{ height: 18 }} />
        <Head t={u} size={92} lines={[{ text: "8G 显存", at: 0.62 }]} />
        <Head t={u} size={92} lines={[{ text: "32G 内存", at: 1.02, accent: 3 }]} />
        <div style={{ height: 40 }} />
        <div
          style={{
            width: 300,
            height: 2,
            background: C.line,
            transform: `scaleX(${ramp(u, [1.4, 1.9])})`,
            transformOrigin: "left",
          }}
        />
        <div style={{ height: 34 }} />
        <Kicker t={u} at={1.62} color="rgba(255,255,255,0.62)">没有云端 · 没有排队 · 不按秒计费</Kicker>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 6~10. 技术流程截图场景 ───────────────────────────────
const Flow: React.FC<{
  name: SceneName;
  t: number;
  kicker: string;
  headline: string;
  src: string;
  path: string;
  ratio: number;
  zoom?: number;
  focusX?: number;
  scrollY?: number;
  note: string;
  cardH?: number;
  mark?: { x: number; y: number; w: number; h: number; text: string; side?: "left" | "right" };
}> = ({ name, t, kicker, headline, src, path, ratio, zoom, focusX, scrollY, note, cardH = 584, mark }) => {
  const { on, start, u } = inside(name, t);
  if (!on) return null;
  const end = start + (scene(name).end - start);
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, end, 0.3) }}>
      <DarkBG />
      <Stage style={{ justifyContent: "center" }}>
        <Kicker t={u} at={0.08}>{kicker}</Kicker>
        <div style={{ height: 22 }} />
        <Head t={u} size={72} lines={[{ text: headline, at: 0.24 }]} />
        <div style={{ height: 40 }} />
        <div style={{ position: "relative" }}>
          <ShotCard
            src={src}
            path={path}
            ratio={ratio}
            t={u}
            at={0.4}
            width={960}
            height={cardH}
            zoom={zoom}
            focusX={focusX}
            scrollY={scrollY}
          />
          {mark && <Mark t={u} at={1.1} {...mark} />}
        </div>
        <div style={{ height: 30 }} />
        <Kicker t={u} at={0.95} color="rgba(255,255,255,0.6)">{note}</Kicker>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 11~12. 片段快切 ─────────────────────────────────────
const ClipBurst: React.FC<{ name: SceneName; t: number; clips: string[] }> = ({ name, t, clips }) => {
  const { on, start } = inside(name, t);
  if (!on) return null;
  const span = scene(name).end - start;
  const each = span / clips.length;
  const idx = Math.min(clips.length - 1, Math.floor((t - start) / each));
  return (
    <AbsoluteFill>
      <Clip
        key={idx}
        src={clips[idx]}
        at={start + idx * each}
        dur={each + 0.04}
        srcStart={0.6 + idx * 0.35}
      />
      <AbsoluteFill
        style={{
          background: "linear-gradient(180deg, rgba(6,6,10,0.55) 0%, rgba(6,6,10,0) 30%, rgba(6,6,10,0) 70%, rgba(6,6,10,0.72) 100%)",
        }}
      />
      <Stage style={{ justifyContent: "flex-end", paddingBottom: 250 }}>
        <Kicker t={0.2} at={0} color="rgba(255,255,255,0.72)">分镜片段 · 逐条生成</Kicker>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 13. 导出页 ──────────────────────────────────────────
const ExportScene: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("export", t);
  if (!on) return null;
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, start + 3.214, 0.3) }}>
      <DarkBG />
      <Stage style={{ justifyContent: "center" }}>
        <Kicker t={u} at={0.08}>拼接导出</Kicker>
        <div style={{ height: 22 }} />
        <Head
          t={u}
          size={70}
          lines={[{ text: "26 个镜头", at: 0.24 }, { text: "自动拼成片", at: 0.58, accent: 1 }]}
        />
        <div style={{ height: 36 }} />
        <ShotCard
          src="img/ui-export.jpg"
          path="localhost:3013/drama/1/episode/1"
          ratio={RATIO_UI}
          t={u}
          at={0.62}
          width={960}
          height={570}
          zoom={1.12}
          focusX={0.5}
          scrollY={0.14}
        />
        <div style={{ height: 28 }} />
        <Kicker t={u} at={1.0} color="rgba(255,255,255,0.6)">31 秒成片 · 一次导出</Kicker>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 14~15. 成片播放 ─────────────────────────────────────
const FilmRun: React.FC<{ name: SceneName; t: number; srcStart: number; note?: string }> = ({
  name,
  t,
  srcStart,
  note,
}) => {
  const { on, start } = inside(name, t);
  if (!on) return null;
  const span = scene(name).end - start;
  return (
    <AbsoluteFill>
      <Clip src="clip/final.mp4" at={start} dur={span} srcStart={srcStart} />
      <AbsoluteFill
        style={{
          background: "linear-gradient(180deg, rgba(6,6,10,0.6) 0%, rgba(6,6,10,0) 26%, rgba(6,6,10,0) 66%, rgba(6,6,10,0.9) 100%)",
        }}
      />
      {note && (
        <Stage style={{ justifyContent: "flex-end", paddingBottom: 250 }}>
          <Kicker t={0.3} at={0} color="rgba(255,255,255,0.68)">{note}</Kicker>
        </Stage>
      )}
    </AbsoluteFill>
  );
};

// ── 16. 结果 ───────────────────────────────────────────
const Result: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("result", t);
  if (!on) return null;
  return (
    <AbsoluteFill>
      <Clip src="clip/final.mp4" at={start} dur={3.214} srcStart={24.2} />
      <AbsoluteFill style={{ background: "rgba(6,6,10,0.42)" }} />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(6,6,10,0.85) 0%, rgba(6,6,10,0.1) 34%, rgba(6,6,10,0.2) 52%, rgba(6,6,10,0.95) 100%)",
        }}
      />
      <Stage style={{ justifyContent: "flex-end", paddingBottom: 330 }}>
        <Head
          t={u}
          size={102}
          lines={[
            { text: "零人工剪辑", at: 0.2, accent: 1 },
            { text: "全自动出片", at: 0.62 },
          ]}
        />
        <div style={{ height: 24 }} />
        <Kicker t={u} at={1.0} color="rgba(255,255,255,0.72)">分镜 · 提示词 · 拼接 全自动</Kicker>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 17. 成本 ───────────────────────────────────────────
const Cost: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("cost", t);
  if (!on) return null;
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, start + 3.214, 0.3) }}>
      <DarkBG />
      <Stage style={{ justifyContent: "center" }}>
        <Kicker t={u} at={0.08}>整条链路的花费</Kicker>
        <div style={{ height: 30 }} />
        <Head
          t={u}
          size={108}
          lines={[
            { text: "1 台家用机", at: 0.26 },
            { text: "1 张 8G 卡", at: 0.7, accent: 1 },
          ]}
        />
        <div style={{ height: 44 }} />
        <div style={{ fontFamily: FONT.mono, fontSize: 26, lineHeight: 1.9, color: C.dim }}>
          {["RTX 4060 Ti · 8G 显存", "32G 内存 · 一张消费级卡", "本地 ComfyUI + 开源短剧平台"].map((s, i) => (
            <div key={s} style={{ opacity: ramp(u, [1.1 + i * 0.18, 1.5 + i * 0.18]) }}>
              — {s}
            </div>
          ))}
        </div>
        <div style={{ height: 36 }} />
        <Pill t={u} at={1.9} tone="cyan">没租过一次云 GPU</Pill>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 18. 洞察 ───────────────────────────────────────────
const Insight: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("insight", t);
  if (!on) return null;
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, start + 3.214, 0.34) }}>
      <DarkBG />
      <Stage style={{ justifyContent: "center" }}>
        <Head
          t={u}
          size={128}
          lines={[
            { text: "算力自由", at: 0.16, accent: 1 },
            { text: "才是内容自由", at: 0.66 },
          ]}
        />
        <div style={{ height: 30 }} />
        <Kicker t={u} at={1.2} color="rgba(255,255,255,0.62)">本地跑得动，才敢一直做下去</Kicker>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 19. CTA ────────────────────────────────────────────
const Cta: React.FC<{ t: number }> = ({ t }) => {
  const { on, start, u } = inside("cta", t);
  if (!on) return null;
  return (
    <AbsoluteFill style={{ opacity: fadeEnd(t, start + 3.214, 0.3) }}>
      <DarkBG />
      <Stage style={{ justifyContent: "center" }}>
        <Kicker t={u} at={0.08}>想要这套流程</Kicker>
        <div style={{ height: 34 }} />
        <Head t={u} size={86} lines={[{ text: "评论区留", at: 0.26 }, { text: "「工作流」", at: 0.66, accent: 1 }]} />
        <div style={{ height: 44 }} />
        <div style={{ fontFamily: FONT.body, fontSize: 30, lineHeight: 1.7, color: C.dim, opacity: ramp(u, [0.95, 1.35]) }}>
          开源短剧平台 + ComfyUI 三段工作流
          <br />
          全部本地，4060Ti 8G 实测跑通
        </div>
      </Stage>
    </AbsoluteFill>
  );
};

// ── 20. 收尾 ───────────────────────────────────────────
const End: React.FC<{ t: number }> = ({ t }) => {
  const { on, u } = inside("end", t);
  if (!on) return null;
  return (
    <AbsoluteFill>
      <Film src="img/film1.jpg" t={u} at={0} out={2.2} dim={0.95} />
      <Stage style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 430 }}>
        <div
          style={{
            fontFamily: FONT.display,
            fontSize: 88,
            fontWeight: 600,
            textAlign: "center",
            lineHeight: 1.34,
            letterSpacing: "-0.02em",
            color: C.fg,
            textShadow: "0 6px 34px rgba(0,0,0,0.7)",
            opacity: ramp(u, [0.16, 0.5]),
          }}
        >
          8G 显存
          <br />
          <span
            style={{
              backgroundImage: `linear-gradient(96deg, ${C.purple}, ${C.cyan})`,
              WebkitBackgroundClip: "text",
              color: "transparent",
            }}
          >
            一样能出片
          </span>
        </div>
      </Stage>
    </AbsoluteFill>
  );
};

export const Scenes: React.FC<{ t: number }> = ({ t }) => (
  <>
    <Hook1 t={t} />
    <Hook2 t={t} />
    <Hook3 t={t} />
    <Title t={t} />
    <Hardware t={t} />
    <Flow
      name="t2i"
      t={t}
      kicker="① 文生图"
      headline="场景，本机出图"
      src="img/comfy-t2i.jpg"
      path="localhost:8188 · text to image"
      ratio={RATIO_COMFY}
      zoom={1.28}
      focusX={0.46}
      scrollY={0.42}
      cardH={584}
      note="Qwen Image 2.1 · ComfyUI 工作流"
    />
    <Flow
      name="scenes"
      t={t}
      kicker="① 产出"
      headline="一次生成整套场景"
      src="img/ui-assets.jpg"
      path="localhost:3013/drama/1/episode/1"
      ratio={RATIO_UI}
      zoom={1.16}
      focusX={0.42}
      scrollY={0.62}
      cardH={570}
      note="角色 + 场景 · 风格统一"
    />
    <Flow
      name="edit"
      t={t}
      kicker="② 图生图"
      headline="不满意，直接重绘"
      src="img/ui-assets.jpg"
      path="localhost:3013/drama/1/episode/1"
      ratio={RATIO_UI}
      zoom={2.15}
      focusX={0.14}
      scrollY={0.72}
      cardH={570}
      note="单张场景可单独重绘"
    />
    <Flow
      name="prompt"
      t={t}
      kicker="③ 参考图生视频"
      headline="提示词自动写"
      src="img/ui-videos.jpg"
      path="localhost:3013/drama/1/episode/1"
      ratio={RATIO_UI}
      zoom={1.62}
      focusX={0.36}
      scrollY={0.24}
      cardH={570}
      note="每个分镜单独一条提示词"
    />
    <Flow
      name="ref"
      t={t}
      kicker="③ 出片段"
      headline="参考图变视频"
      src="img/ui-videos.jpg"
      path="localhost:3013/drama/1/episode/1"
      ratio={RATIO_UI}
      zoom={2.35}
      focusX={0.93}
      scrollY={0.02}
      cardH={570}
      note="角色 + 场景 双参考 · 生成成功"
    />
    <ClipBurst name="clips1" t={t} clips={["clip/s1.mp4", "clip/s2.mp4", "clip/s3.mp4"]} />
    <ClipBurst name="clips2" t={t} clips={["clip/s4.mp4", "clip/s5.mp4", "clip/s6.mp4"]} />
    <ExportScene t={t} />
    <FilmRun name="filmA" t={t} srcStart={5.5} note="成片 · AI 生成" />
    <FilmRun name="filmB" t={t} srcStart={13.6} />
    <Result t={t} />
    <Cost t={t} />
    <Insight t={t} />
    <Cta t={t} />
    <End t={t} />
  </>
);
