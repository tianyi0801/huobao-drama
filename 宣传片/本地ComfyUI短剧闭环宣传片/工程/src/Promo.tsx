import React from "react";
import { Audio } from "@remotion/media";
import { AbsoluteFill, Html5Audio, staticFile } from "remotion";
import "./lib/fonts";
import { useTime } from "./lib/anim";
import { C } from "./lib/theme";
import { Scenes } from "./scenes/Scenes";

export type PromoProps = { withAudio: boolean; webMode?: boolean };

/** 每个场景接收绝对时间 t（秒），在自己的时间窗外返回 null */
export const Promo: React.FC<PromoProps> = ({ withAudio, webMode = false }) => {
  const t = useTime();
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Scenes t={t} />
      {withAudio &&
        (webMode ? (
          // @remotion/media 在浏览器跑不满帧时会重复排程音频块，叠成多重回音；网页版改用 <audio> 元素
          <Html5Audio src={staticFile("audio/mix.wav")} />
        ) : (
          <Audio src={staticFile("audio/mix.wav")} />
        ))}
    </AbsoluteFill>
  );
};
