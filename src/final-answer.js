/** Pure presentation rules shared by terminal and browser. Original replies stay intact. */
function handlingSection(lines) {
  let fence = null,
    section = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        code &&
        code[1][0] === fence[0] &&
        code[1].length >= fence.length &&
        !code[2].trim()
      )
        fence = null;
      continue;
    }
    if (code) {
      fence = code[1];
      continue;
    }
    if (section?.kind === "details") {
      if (/^ {0,3}<details(?:[ \t]+open)?[ \t]*>[ \t]*$/i.test(line))
        section.depth++;
      if (/^ {0,3}<\/details>[ \t]*$/i.test(line) && --section.depth === 0) {
        section.contentEnd = index;
        section.end = index + 1;
        break;
      }
      continue;
    }
    if (
      !section &&
      /^ {0,3}<details(?:[ \t]+open)?[ \t]*>[ \t]*$/i.test(line)
    ) {
      let summaryIndex = index + 1;
      while (summaryIndex < lines.length && !lines[summaryIndex].trim())
        summaryIndex++;
      const summary =
        /^ {0,3}<summary>[ \t]*(.*?)[ \t]*<\/summary>[ \t]*$/i.exec(
          lines[summaryIndex] ?? "",
        );
      const title = summary?.[1]
        .replace(/^#{1,6}[ \t]+/, "")
        .replace(/^\*\*(.*?)\*\*$/, "$1")
        .replace(/[：:]$/, "");
      if (title === "对评审意见的处理说明") {
        section = {
          kind: "details",
          start: index,
          end: null,
          depth: 1,
          contentStart: summaryIndex + 1,
        };
        index = summaryIndex;
        continue;
      }
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const title = (
      heading ? heading[2] : (/^ {0,3}(\S.*?)[ \t]*$/.exec(line)?.[1] ?? "")
    )
      .replace(/^\*\*(.*?)\*\*$/, "$1")
      .replace(/[：:]$/, "");
    if (section && heading && heading[1].length <= section.level) {
      section.end = section.contentEnd = index;
      break;
    }
    if (!section && title === "对评审意见的处理说明") {
      section = {
        start: index,
        end: lines.length,
        contentStart: index + 1,
        contentEnd: lines.length,
        level: heading ? heading[1].length : 6,
      };
    }
  }
  return section;
}
function splitReply(text) {
  const lines = text.split(/\r?\n/),
    section = handlingSection(lines);
  if (!section || section.end === null) return null;
  const before = lines.slice(0, section.start).join("\n").trimEnd();
  // Never turn an answerless or malformed response into an empty delivery.
  if (!before.trim()) return null;
  const after = lines.slice(section.end).join("\n").trimStart();
  return {
    answer: before + (after ? "\n\n" + after : ""),
    explanation: lines
      .slice(section.contentStart, section.contentEnd)
      .join("\n")
      .trim(),
  };
}
export function finalAnswerText(text) {
  return splitReply(text)?.answer ?? text;
}
export function revisionExplanation(text) {
  return splitReply(text)?.explanation ?? null;
}
