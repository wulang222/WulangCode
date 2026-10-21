import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderConfig } from "../config/config.js";
import { brand, symbols } from "./styles.js";

interface ProviderSelectProps {
  providers: ProviderConfig[];
  onSelect: (provider: ProviderConfig) => void;
}

/** 多 provider 时的方向键列表。Enter 选定。 */
export function ProviderSelect({ providers, onSelect }: ProviderSelectProps) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((value) => Math.min(providers.length - 1, value + 1));
      return;
    }
    if (key.return) {
      const selected = providers[cursor];
      if (selected) onSelect(selected);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{brand.primary("选择 provider")}</Text>
      {providers.map((provider, index) => {
        const active = index === cursor;
        const line = `${active ? symbols.prompt : " "} ${provider.name} (${provider.protocol} ${symbols.arrow} ${provider.model})`;
        return (
          <Text key={`${provider.name}-${provider.model}-${index}`} dimColor={!active} color={active ? "#a78bfa" : undefined}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
