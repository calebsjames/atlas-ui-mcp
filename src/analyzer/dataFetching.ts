/**
 * Detect a component/hook's data-fetching pattern from its hook list and source.
 */
export function detectDataFetchingPattern(
  content: string,
  hooks: string[]
): string | undefined {
  if (
    hooks.includes("useQuery") ||
    hooks.includes("useMutation") ||
    hooks.includes("useQueryClient")
  ) {
    return "react-query";
  }

  if (hooks.includes("useSWR")) {
    return "swr";
  }

  if (hooks.includes("useEffect")) {
    if (/useEffect[^}]*\bfetch\s*\(/s.test(content)) {
      return "useEffect-fetch";
    }
    if (/useEffect[^}]*\baxios\./s.test(content)) {
      return "useEffect-axios";
    }
  }

  // Vue: onMounted/watchEffect with service/adapter calls
  if (content.includes("onMounted") || content.includes("watchEffect")) {
    if (/(?:Service|Adapter)\.\w+\s*\(/.test(content)) {
      return "lifecycle-service-call";
    }
  }

  const dataHooks = hooks.filter(
    (h) =>
      h.startsWith("use") &&
      (h.toLowerCase().includes("fetch") ||
        h.toLowerCase().includes("load") ||
        h.toLowerCase().includes("get") ||
        h.toLowerCase().includes("data") ||
        /^use[A-Z][a-z]+s$/.test(h))
  );

  if (dataHooks.length > 0) {
    return `custom-composable: ${dataHooks[0]}`;
  }

  return undefined;
}
