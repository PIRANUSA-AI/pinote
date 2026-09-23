const INTERNAL = /deepgram|openai|qwen|glm|z\.ai|zhipu|api_key|realtime|native|dashscope|whisper|non json|status\s*\d{3}|\(\d{3}\)/i

export function publicError(message: string, fallback: string): string {
  const text = message.trim()
  if (!text || INTERNAL.test(text)) return fallback
  return text.slice(0, 300)
}
