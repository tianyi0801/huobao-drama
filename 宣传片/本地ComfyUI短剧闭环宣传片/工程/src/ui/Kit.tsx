import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { EASE, ramp } from "../lib/anim";
import { C, FONT, SAFE } from "../lib/theme";

/** 竖屏安全区容器：上下各留 220px 给平台 UI，左右 60px */
export const Stage: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <AbsoluteFill
    style={{
      paddingTop: SAFE.top,
      paddingBottom: SAFE.bottom,
      paddingLeft: SAFE.side,
      paddingRight: SAFE.side,
      ...style,
    }}
  >
    {children}
  </AbsoluteFill>
);

export const Grid: React.FC<{ opacity?: number }> = ({ opacity = 0.05 }) => (
  <AbsoluteFill
    style={{
      backgroundImage: `linear-gradient(rgba(255,255,255,${opacity}) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,${opacity}) 1px, transparent 1px)`,
      backgroundSize: "72px 72px",
    }}
  />
);

export const Glow: React.FC<{ color: string; x: number; y: number; size: number; opacity?: number }> = ({
  color,
  x,
  y,
  size,
  opacity = 0.5,
}) => (
  <div
    style={{
      position: "absolute",
      left: x - size / 2,
      top: y - size / 2,
      width: size,
      height: size,
      borderRadius: "50%",
      background: color,
      filter: `blur(${Math.round(size * 0.28)}px)`,
      opacity,
    }}
  />
);

/** 场景小标签，等宽字 + 字距 */
export const Kicker: React.FC<{ children: React.ReactNode; t?: number; at?: number; color?: string }> = ({
  children,
  t = 99,
  at = 0,
  color = C.purple,
}) => {
  const p = ramp(t, [at, at + 0.5]);
  return (
    <div
      style={{
        fontFamily: FONT.mono,
        fontSize: 21,
        letterSpacing: "0.22em",
        color,
        opacity: p,
        transform: `translateY(${(1 - p) * 14}px)`,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
};

export type Line = { text: string; at: number; accent?: 1 | 2 | 3; size?: number };

/** 逐行出现的大字标题；accent 1=紫青渐变 2=红 3=暗 */
export const Head: React.FC<{ lines: Line[]; t: number; size?: number; weight?: number }> = ({
  lines,
  t,
  size = 104,
  weight = 600,
}) => (
  <div>
    {lines.map((ln, i) => {
      const p = ramp(t, [ln.at, ln.at + 0.42]);
      const grad =
        ln.accent === 1
          ? `linear-gradient(96deg, ${C.purple}, ${C.cyan})`
          : ln.accent === 2
            ? `linear-gradient(96deg, ${C.red}, #FF9A3D)`
            : undefined;
      return (
        <div
          key={i}
          style={{
            fontFamily: FONT.display,
            fontSize: ln.size ?? size,
            fontWeight: weight,
            lineHeight: 1.3,
            letterSpacing: "-0.02em",
            color: grad ? "transparent" : ln.accent === 3 ? C.dim : C.fg,
            backgroundImage: grad,
            WebkitBackgroundClip: grad ? "text" : undefined,
            textShadow: grad ? undefined : "0 4px 26px rgba(0,0,0,0.55)",
            clipPath: `inset(0 ${(1 - p) * 100}% 0 0)`,
            opacity: p > 0 ? 1 : 0,
            transform: `translateY(${(1 - p) * 26}px)`,
            marginBottom: Math.round((ln.size ?? size) * 0.1),
          }}
        >
          {ln.text}
        </div>
      );
    })}
  </div>
);

export const Pill: React.FC<{ children: React.ReactNode; t?: number; at?: number; tone?: "purple" | "cyan" | "ghost" }> = ({
  children,
  t = 99,
  at = 0,
  tone = "ghost",
}) => {
  const p = ramp(t, [at, at + 0.4]);
  const map = {
    purple: { bd: C.purple, bg: "rgba(139,92,246,0.16)", fg: "#D9CFFF" },
    cyan: { bd: C.cyan, bg: "rgba(34,211,238,0.14)", fg: "#C4F4FB" },
    ghost: { bd: "rgba(255,255,255,0.22)", bg: "rgba(255,255,255,0.06)", fg: "rgba(255,255,255,0.82)" },
  }[tone];
  return (
    <div
      style={{
        fontFamily: FONT.mono,
        fontSize: 22,
        padding: "10px 20px",
        borderRadius: 999,
        border: `1px solid ${map.bd}`,
        background: map.bg,
        color: map.fg,
        opacity: p,
        transform: `translateY(${(1 - p) * 16}px)`,
        whiteSpace: "nowrap",
        alignSelf: "flex-start",
      }}
    >
      {children}
    </div>
  );
};

/**
 * 真实界面截图卡片：深色窗框 + 顶部路径条，可按 zoom/focusX/scrollY 放大聚焦局部。
 * 图片永远按原比例缩放，不会被压扁。
 */
export const ShotCard: React.FC<{
  src: string;
  path: string;
  ratio: number;
  t: number;
  at: number;
  width?: number;
  height?: number;
  zoom?: number;
  focusX?: number;
  scrollY?: number;
  style?: React.CSSProperties;
}> = ({ src, path, ratio, t, at, width = 960, height = 520, zoom = 1, focusX = 0.5, scrollY = 0, style }) => {
  const p = ramp(t, [at, at + 0.55]);
  const bar = 44;
  const viewH = height - bar;
  const imgW = width * zoom;
  const imgH = imgW / ratio;
  const left = -(imgW - width) * focusX;
  const top = -Math.max(0, imgH - viewH) * scrollY;
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 18,
        overflow: "hidden",
        background: "#0E0D18",
        border: `1px solid ${C.line}`,
        boxShadow: "0 40px 90px rgba(0,0,0,0.55), 0 0 0 1px rgba(139,92,246,0.18)",
        opacity: p,
        transform: `translateY(${(1 - p) * 44}px) scale(${0.965 + p * 0.035})`,
        ...style,
      }}
    >
      <div
        style={{
          height: bar,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 18px",
          background: "#15131f",
          borderBottom: `1px solid ${C.line}`,
        }}
      >
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <div key={c} style={{ width: 11, height: 11, borderRadius: 99, background: c, opacity: 0.85 }} />
        ))}
        <div
          style={{
            marginLeft: 12,
            fontFamily: FONT.mono,
            fontSize: 17,
            color: "rgba(255,255,255,0.42)",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {path}
        </div>
      </div>
      <div style={{ position: "relative", width, height: viewH, overflow: "hidden" }}>
        <Img
          src={staticFile(src)}
          style={{ position: "absolute", left, top, width: imgW, height: imgH, maxWidth: "none" }}
        />
      </div>
    </div>
  );
};

/** 标注框 + 引线 + 说明文字（代码绘制，用于放大强调截图里的某处） */
export const Mark: React.FC<{
  t: number;
  at: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  side?: "left" | "right";
}> = ({ t, at, x, y, w, h, text, side = "right" }) => {
  const p = ramp(t, [at, at + 0.4]);
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, opacity: p }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: `2px solid ${C.cyan}`,
          borderRadius: 10,
          boxShadow: `0 0 24px rgba(34,211,238,0.55), inset 0 0 12px rgba(34,211,238,0.15)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: -34,
          ...(side === "right" ? { left: 0 } : { right: 0 }),
          fontFamily: FONT.mono,
          fontSize: 19,
          padding: "4px 12px",
          borderRadius: 6,
          background: C.cyan,
          color: "#04212a",
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** 全屏影像：cover 铺满 + 上下渐黑，确保文字可读 */
export const Film: React.FC<{
  src?: string;
  clip?: React.ReactNode;
  t: number;
  at: number;
  out?: number;
  dim?: number;
}> = ({ src, clip, t, at, out = 99, dim = 0.55 }) => {
  const pin = ramp(t, [at, at + 0.3]);
  const pout = 1 - ramp(t, [out - 0.3, out], [0, 1], EASE.in);
  return (
    <AbsoluteFill style={{ opacity: pin * pout }}>
      {clip ?? <Img src={staticFile(src!)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, rgba(6,6,10,0.92) 0%, rgba(6,6,10,${dim * 0.25}) 22%, rgba(6,6,10,${dim * 0.25}) 46%, rgba(6,6,10,0.95) 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
