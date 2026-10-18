/**
 * Optional hook: enrich an outbound prompt before it is delivered.
 *
 * The upstream (private) tree wires this to a personal memory/recall digest.
 * That module is intentionally NOT part of this repository — a public bridge
 * should not depend on one operator's memory layout. The default below is an
 * identity function, so behaviour is unchanged: the prompt is sent verbatim.
 *
 * If you want enrichment, implement it here (or replace this file) and keep the
 * signature `(prompt, target) => string`. Any thrown error is caught by the
 * caller and the prompt is sent unmodified, so this can never block delivery.
 */
export function enrichDispatchPrompt(prompt: string, _target?: string): string {
  return prompt;
}
