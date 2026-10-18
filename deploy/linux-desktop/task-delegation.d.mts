export function parseDelegations(status: string, value: unknown, options?: {
  allowDelegation?: boolean;
  availableEngines?: readonly ('model' | 'pi' | 'dsh')[];
}): { title: string; instruction: string; engine?: 'model' | 'pi' | 'dsh' }[] | undefined;
