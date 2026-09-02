import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ProviderBrandMark,
  providerBrandKind,
} from "../../src/shared/ui/provider-brand-mark";

describe("ProviderBrandMark", () => {
  test("normalizes supported provider aliases", () => {
    expect(providerBrandKind("kimi_coding")).toBe("kimi");
    expect(providerBrandKind("kimi-coding")).toBe("kimi");
    expect(providerBrandKind("deep_seek")).toBe("deepseek");
    expect(providerBrandKind("deep-seek")).toBe("deepseek");
    expect(providerBrandKind("openrouter")).toBe("openrouter");
    expect(providerBrandKind("open-router")).toBe("openrouter");
    expect(providerBrandKind("zhipuai")).toBe("zhipu");
    expect(providerBrandKind("zhipuai-coding-plan")).toBe("zhipu");
    expect(providerBrandKind("z-ai")).toBe("zhipu");
    expect(providerBrandKind("unknown_provider")).toBe("generic");
    expect(providerBrandKind("unknown-provider")).toBe("generic");
  });

  test("renders the bundled Kimi icon with local vectors and a generic fallback", () => {
    const kimi = renderToStaticMarkup(<ProviderBrandMark provider="kimi_coding" />);
    const deepseek = renderToStaticMarkup(<ProviderBrandMark provider="deepseek" />);
    const openrouter = renderToStaticMarkup(<ProviderBrandMark provider="openrouter" />);
    const zhipu = renderToStaticMarkup(<ProviderBrandMark provider="zhipuai" />);
    const fallback = renderToStaticMarkup(<ProviderBrandMark provider="unknown_provider" />);

    expect(kimi).toContain('data-provider-mark="kimi"');
    expect(kimi).toContain('aria-hidden="true"');
    expect(kimi).toContain("<img");
    expect(kimi).toContain("kimi-icon-round.png");
    expect(kimi).not.toContain("provider-brand-orbit");
    expect(kimi).not.toContain("provider-brand-scan");
    expect(deepseek).toContain('data-provider-mark="deepseek"');
    expect(openrouter).toContain('data-provider-mark="openrouter"');
    expect(openrouter).toContain('viewBox="0 0 401.4 293.7"');
    expect(zhipu).toContain('data-provider-mark="zhipu"');
    expect(zhipu).toContain('viewBox="0 0 30 30"');
    expect(fallback).toContain('data-provider-mark="generic"');
    expect(fallback).toContain("lucide-brain");
    expect(`${kimi}${deepseek}${openrouter}${zhipu}`).not.toMatch(/https?:\/\//u);
  });

  test("keeps the Kimi icon scalable at compact status sizes", () => {
    for (const size of [16, 20, 24]) {
      const kimi = renderToStaticMarkup(<ProviderBrandMark provider="kimi-code" size={size} />);

      expect(kimi).toContain(`width:${size}px`);
      expect(kimi).toContain(`height:${size}px`);
      expect(kimi).toContain("<img");
    }
  });
});
