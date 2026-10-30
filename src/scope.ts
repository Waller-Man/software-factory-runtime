import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TypertLookup } from '@deepseek-ai/dsh-typert-protocol';
/** Host resolves a real live Session; clients send only this routing selector. */
export type RuntimeSessionId = string;
export interface RuntimeSession { readonly agent: Agent }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap { runtimeSession: TypertLookup<RuntimeSession, RuntimeSessionId> }
}
