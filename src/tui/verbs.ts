const VERBS = [
  "Imagining",
  "Thinking",
  "Composing",
  "Drafting",
  "Pondering",
  "Weaving",
  "Sketching",
  "Musing",
];

const COMPLETIONS = ["Done", "Ready", "Wrapped up", "All set", "Finished"];

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0] ?? "";
}

export function randomVerb(): string {
  return pick(VERBS);
}

export function randomCompletionVerb(): string {
  return pick(COMPLETIONS);
}
