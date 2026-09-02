import { Brain } from "lucide-react";

import kimiIconRound from "../../assets/providers/kimi/kimi-icon-round.png";

export type ProviderBrandKind = "kimi" | "deepseek" | "openrouter" | "zhipu" | "generic";

export function providerBrandKind(provider: string | null | undefined): ProviderBrandKind {
  const normalized = String(provider || "").trim().toLowerCase().replaceAll("-", "_");
  if (["kimi", "kimi_coding", "kimi_code"].includes(normalized)) return "kimi";
  if (["deepseek", "deep_seek"].includes(normalized)) return "deepseek";
  if (["openrouter", "open_router"].includes(normalized)) return "openrouter";
  if (["zhipu", "zhipuai", "zhipuai_coding_plan", "z_ai"].includes(normalized)) return "zhipu";
  return "generic";
}

export function ProviderBrandMark({
  className = "",
  provider,
  size = 20,
}: {
  className?: string;
  provider: string | null | undefined;
  size?: number;
}) {
  const kind = providerBrandKind(provider);
  const classes = className ? `provider-brand-mark ${className}` : "provider-brand-mark";

  return (
    <span
      aria-hidden="true"
      className={classes}
      data-provider-mark={kind}
      style={{ width: size, height: size }}
    >
      {kind === "kimi" ? (
        <img alt="" draggable={false} src={kimiIconRound} />
      ) : kind === "deepseek" ? (
        // Official DeepSeek whale silhouette (single filled path) from the
        // Simple Icons "deepseek" glyph (CC0 1.0), retrieved 2026-07-27; see
        // assets/providers/deepseek/SOURCE.md for provenance and brand terms.
        <svg fill="currentColor" focusable="false" viewBox="0 0 24 24">
          <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
        </svg>
      ) : kind === "openrouter" ? (
        // Official OpenRouter brand v2 glyph (single filled path) from
        // openrouter.ai/brand/v2/openrouter-glyph-light.svg, retrieved
        // 2026-08-24; see assets/providers/openrouter/SOURCE.md for provenance
        // and brand terms. The path data is unmodified.
        <svg fill="currentColor" focusable="false" viewBox="0 0 401.4 293.7">
          <path d="M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z" />
        </svg>
      ) : kind === "zhipu" ? (
        // Official Z.ai "Z" glyph: the three filled shapes from
        // z-cdn.chatglm.cn/z-ai/static/logo.svg (the exact file the z.ai
        // homepage serves) merged into one filled path and recolored through
        // currentColor. Retrieved 2026-09-03; see
        // assets/providers/zhipu/SOURCE.md for provenance and brand terms.
        <svg fill="currentColor" focusable="false" viewBox="0 0 30 30">
          <path d="M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z M24.3,7.1 L13.14,22.91 H5.7 L16.86,7.1 Z M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z" />
        </svg>
      ) : (
        <Brain focusable="false" size={size} strokeWidth={1.8} />
      )}
    </span>
  );
}
