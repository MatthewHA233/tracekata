// ══════════════════════════════════════════════
// 行级 diff — 工具调用的代码改动渲染（Claude Code 式红删绿增）
//   · diffLines：LCS 动态规划，old/new 文本 → ctx/add/del 行序列
//   · patchToRows：Codex apply_patch 补丁原文（自带 +/- 前缀）→ 行序列
// ══════════════════════════════════════════════

export type DiffRow = {
  type: "ctx" | "add" | "del" | "meta";
  text: string;
};

/** old/new 文本做行级 LCS diff。超大输入退化为整删整增（避免 O(n·m) 爆炸）。 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  if (a.length === 0) return b.map((text) => ({ type: "add" as const, text }));
  if (b.length === 0) return a.map((text) => ({ type: "del" as const, text }));
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }

  const m = a.length;
  const n = b.length;
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) rows.push({ type: "del", text: a[i++] });
  while (j < n) rows.push({ type: "add", text: b[j++] });
  return rows;
}

/** Codex apply_patch 补丁原文 → 行序列（*** 头部行标记为 meta） */
export function patchToRows(patch: string): DiffRow[] {
  return patch
    .split("\n")
    .filter((line) => line !== "*** Begin Patch" && line !== "*** End Patch")
    .map((line) => {
      if (line.startsWith("***")) return { type: "meta" as const, text: line.replace(/^\*+\s*/, "") };
      if (line.startsWith("+")) return { type: "add" as const, text: line.slice(1) };
      if (line.startsWith("-")) return { type: "del" as const, text: line.slice(1) };
      return { type: "ctx" as const, text: line.startsWith(" ") ? line.slice(1) : line };
    });
}
