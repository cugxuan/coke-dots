const engines = new Set(['model', 'pi', 'dsh']);

// Used at both ends of the cloud boundary so recoverable schema errors reach
// Pi's bounded formatting pass before the control plane applies permissions.
export function parseDelegations(status, value, options = {}) {
  if (status !== 'delegating') {
    if (value !== undefined && (!Array.isArray(value) || value.length)) throw new Error('非委派状态不能包含子任务');
    return undefined;
  }
  if (options.allowDelegation === false) throw new Error('子任务不能继续委派');
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error('代理子任务数量无效：需要 1–3 项');
  return value.map((child, index) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error(`代理子任务内容无效：第 ${index + 1} 项必须是对象`);
    const title = typeof child.title === 'string' ? child.title.trim() : '';
    // Accept this unambiguous field alias without a model call or losing work.
    // A supplied but invalid instruction must still be repaired, never replaced.
    const body = child.instruction === undefined ? child.description : child.instruction;
    const instruction = typeof body === 'string' ? body.trim() : '';
    if (!title || title.length > 120 || !instruction || instruction.length > 5000) {
      throw new Error(`代理子任务内容无效：第 ${index + 1} 项需要 title（1–120 字符）和 instruction（1–5000 字符）`);
    }
    if (child.engine !== undefined && (!engines.has(child.engine) || (options.availableEngines && !options.availableEngines.includes(child.engine)))) {
      throw new Error(`代理子任务选择了不可用的内核：第 ${index + 1} 项`);
    }
    return { title, instruction, ...(child.engine === undefined ? {} : { engine: child.engine }) };
  });
}
