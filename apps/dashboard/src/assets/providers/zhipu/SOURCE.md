# Zhipu (Z.ai) provider mark

- Asset: the inline "Z" glyph in `src/shared/ui/provider-brand-mark.tsx`
  (`data-provider-mark="zhipu"`).
- Source: the three filled shapes of the "Z" from z.ai's own logo file,
  served from z-cdn.chatglm.cn/z-ai/static/logo.svg (the exact asset the
  z.ai homepage references), retrieved 2026-09-03. The rounded tile
  background of that file is dropped and the three glyph shapes are merged
  into one filled path so the mark inherits `currentColor`; the geometry is
  otherwise unmodified (verified side-by-side against a render of the
  original file).
- Colors: brand blue `#1F63EC` on light surfaces — the blue defined inside
  the official logo file itself — and a `#8AA9F5` tint on dark surfaces,
  following the DeepSeek mark's light-tint convention.
- License: the Z.ai logo is a trademark of Zhipu AI; it is used in LXE Agent
  solely to identify the Zhipu provider and is not relicensed as part of
  LXE Agent.
