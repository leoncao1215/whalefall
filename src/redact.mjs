/**
 * 入库前脱敏。
 *
 * 立场：记忆属于用户，但**不该把凭据也记下来**。这里只做保守的高置信匹配，
 * 宁可漏掉一些，也不要误伤正常句子（误伤会让摘要变得莫名其妙）。
 * 真正的隐私边界仍在"谁能读这个库"，脱敏只是把明显的坑填掉。
 */

const RULES = [
  {
    name: 'sk-key',
    regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => '[REDACTED:key]',
  },
  {
    name: 'bearer',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: () => 'Bearer [REDACTED]',
  },
  {
    name: 'kv-secret',
    regex: /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|authorization)\b(\s*[:=：]\s*)([^\s,;，。]{3,})/gi,
    replace: (_m, key, sep) => `${key}${sep}[REDACTED]`,
  },
  {
    name: 'cn-secret',
    regex: /(密码|口令|验证码|身份证号|银行卡号)(\s*[:：]\s*)([^\s,;，。]{2,})/g,
    replace: (_m, key, sep) => `${key}${sep}[REDACTED]`,
  },
];

/**
 * @param {string} text
 * @returns {{text: string, hits: string[]}}
 */
export function redactSecrets(text) {
  let out = String(text ?? '');
  const hits = [];
  for (const rule of RULES) {
    // 每次新建正则，避免 /g 的 lastIndex 在多次调用间残留
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    if (re.test(out)) {
      hits.push(rule.name);
      out = out.replace(re, rule.replace);
    }
  }
  return { text: out, hits };
}

/** 只判断要不要报警，不改文本。 */
export function containsSecret(text) {
  return RULES.some((rule) => {
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    return re.test(String(text ?? ''));
  });
}
