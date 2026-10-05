/** Normalize common model-written save acknowledgements; only application receipts assert persistence. */
export function normalizeMemorySaveClaims(answer: string): string {
  let fence: string | undefined;
  return answer.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) { fence = fence ? undefined : marker[0]; return line; }
    if (fence || /^\s*>/u.test(line)) return line;
    // Examples, quoted user text and code are data, not an acknowledgement by the assistant.
    return line.split(/(`+[^`]*`+|“[^”]*”|‘[^’]*’|「[^」]*」|"[^"]*")/gu).map((part, index) => index % 2 ? part : part
      .replace(/(?:我)?(?:已经|已)(?:成功)?(?:更新(?:了)?(?:您|你|我)?的?(?:身份背景|身份信息|身份|个人画像|用户画像|长期记忆)|(?:永久)?记住(?:了)?|保存(?:了)?(?:到|至|进)(?:您|你)?的?长期记忆)/gu,
        '本轮按你的最新陈述回答；长期记忆的保存状态以应用回执为准')
      .replace(/\bI(?:'ve| have) (?:permanently remembered|saved (?:this|that|it) (?:to|in) (?:your |my )?long[- ]term memory|updated your (?:profile|identity))\b/giu,
        'I will use your latest statement for this reply; the application receipt shows the memory save status'))
      .join('');
  }).join('\n');
}
