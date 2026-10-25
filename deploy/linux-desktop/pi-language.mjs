// Translate known Pi 0.73 SDK guidance at the provider boundary. Tool execution,
// schema constraints and user/project evidence are left unchanged.
const sdkIntro = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';
const sdkEnd = '- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)';
const summarySystem = 'You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.';

const systemText = new Map([
  [sdkIntro, '你是在 Pi 运行框架内工作的任务助手，可以读取文件、执行命令、编辑代码和创建文件来帮助用户。'],
  ['Available tools:', '可用工具：'],
  ['In addition to the tools above, you may have access to other custom tools depending on the project.', '除上述工具外，项目还可能提供其他自定义工具。'],
  ['Guidelines:', '使用准则：'],
  ['Use bash for file operations like ls, rg, find', '可用 bash 执行 ls、rg、find 等文件操作。'],
  ['Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)', '查找文件时优先用 grep/find/ls，速度更快并遵守 .gitignore。'],
  ['Be concise in your responses', '回复保持简洁。'],
  ['Show file paths clearly when working with files', '处理文件时清楚写出文件路径。'],
  ['Read file contents', '读取文件内容'],
  ['Execute bash commands (ls, grep, find, etc.)', '执行 bash 命令（如 ls、grep、find）'],
  ['Make precise file edits with exact text replacement, including multiple disjoint edits in one call', '以精确文本替换编辑文件，一次可包含多处互不重叠的修改'],
  ['Create or overwrite files', '创建或覆盖文件'],
  ['Search file contents for patterns (respects .gitignore)', '按模式搜索文件内容（遵守 .gitignore）'],
  ['Find files by glob pattern (respects .gitignore)', '按 glob 模式查找文件（遵守 .gitignore）'],
  ['List directory contents', '列出目录内容'],
  ['Use read to examine files instead of cat or sed.', '查看文件优先用 read，不用 cat 或 sed。'],
  ['Use write only for new files or complete rewrites.', 'write 仅用于新文件或完整重写。'],
  ['Use edit for precise changes (edits[].oldText must match exactly)', '精确修改用 edit，edits[].oldText 必须完全匹配。'],
  ['When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls', '同一文件有多处独立修改时，用一次 edit 的多个 edits[] 项完成。'],
  ['Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.', '每个 edits[].oldText 都匹配原始文件，不匹配前面修改后的内容；不得重叠或嵌套，相邻修改应合并。'],
  ['Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.', 'edits[].oldText 应在保持文件内唯一的前提下尽量短，不要填入大片未改动区域。'],
  ['Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):', 'Pi 文档（仅当用户询问 Pi 本身、SDK、扩展、主题、技能或 TUI 时读取）：'],
  ['- Main documentation:', '- 主文档：'],
  ['- Additional docs:', '- 其他文档：'],
  ['- Examples:', '- 示例：'],
  ['(extensions, custom tools, SDK)', '（扩展、自定义工具、SDK）'],
  ['- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)', '- 按问题查阅：扩展（docs/extensions.md、examples/extensions/）、主题（docs/themes.md）、技能（docs/skills.md）、提示模板（docs/prompt-templates.md）、TUI 组件（docs/tui.md）、快捷键（docs/keybindings.md）、SDK 集成（docs/sdk.md）、自定义供应商（docs/custom-provider.md）、增加模型（docs/models.md）、Pi 包（docs/packages.md）。'],
  ['- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing', '- 处理 Pi 相关问题时，实施前先读文档、示例和其中交叉引用的 .md 文件。'],
  [sdkEnd, '- 完整读取相关 Pi .md 文件，并跟进关联文档链接（例如 TUI API 细节见 tui.md）。'],
]);

const parameterText = new Map([
  ['Path to the file to read (relative or absolute)', '待读取文件的路径，可用相对或绝对路径'],
  ['Line number to start reading from (1-indexed)', '起始行号，从 1 开始'],
  ['Maximum number of lines to read', '最多读取的行数'],
  ['Bash command to execute', '要执行的 bash 命令'],
  ['Timeout in seconds (optional, no default timeout)', '超时秒数，可选；默认不设置工具级超时'],
  ['Path to the file to edit (relative or absolute)', '待编辑文件的路径，可用相对或绝对路径'],
  ['Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.', '本项替换的精确原文，须在原文件中唯一，且不能与同次调用其他 edits[].oldText 重叠。'],
  ['Replacement text for this targeted edit.', '本项修改的新文本。'],
  ['One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.', '一项或多项精确替换，均匹配原文件而非逐步修改后的内容；不得重叠或嵌套，相同块或相邻行的修改应合并。'],
  ['Path to the file to write (relative or absolute)', '待写入文件的路径，可用相对或绝对路径'],
  ['Content to write to the file', '要写入文件的内容'],
  ['Search pattern (regex or literal string)', '搜索模式，可用正则表达式或字面字符串'],
  ['Directory or file to search (default: current directory)', '待搜索目录或文件，默认为当前目录'],
  ["Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'", "用 glob 过滤文件，如 '*.ts' 或 '**/*.spec.ts'"],
  ['Case-insensitive search (default: false)', '是否忽略大小写，默认 false'],
  ['Treat pattern as literal string instead of regex (default: false)', '是否把模式当成字面字符串而非正则表达式，默认 false'],
  ['Number of lines to show before and after each match (default: 0)', '每条匹配前后显示的上下文行数，默认 0'],
  ['Maximum number of matches to return (default: 100)', '最多返回的匹配数，默认 100'],
  ["Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'", "匹配文件的 glob 模式，如 '*.ts'、'**/*.json'、'src/**/*.spec.ts'"],
  ['Directory to search in (default: current directory)', '待搜索目录，默认为当前目录'],
  ['Maximum number of results (default: 1000)', '最多返回的结果数，默认 1000'],
  ['Directory to list (default: current directory)', '要列出的目录，默认为当前目录'],
  ['Maximum number of entries to return (default: 500)', '最多返回的条目数，默认 500'],
]);

const toolText = {
  read: ['Read the contents of a file.', '读取文本或图片文件（jpg、png、gif、webp）；图片作为附件返回。文本最多返回 2000 行或 50KB，先达到者为准；大文件使用 offset/limit 分段读取，需要完整内容时继续读取。'],
  bash: ['Execute a bash command in the current working directory.', '在当前目录执行 bash，返回 stdout 和 stderr；输出最多保留末尾 2000 行或 50KB，先达到者为准，完整输出保存到临时文件。可用 timeout 指定超时秒数。'],
  edit: ['Edit a single file using exact text replacement.', '通过精确文本替换编辑单个文件。每个 edits[].oldText 都须在原文件中唯一且互不重叠；同一块或相邻位置的修改合并，不要为连接远处修改而加入大片未改动文本。'],
  write: ['Write content to a file.', '写入文件：不存在则创建，已存在则覆盖；自动创建父目录。'],
  grep: ['Search file contents for a pattern.', '按模式搜索文件内容，返回文件路径、行号和匹配行，遵守 .gitignore；最多返回 100 条或 50KB，先达到者为准，过长的行会截短。'],
  find: ['Search for files by glob pattern.', '按 glob 模式搜索文件，返回相对于搜索目录的路径，遵守 .gitignore；最多返回 1000 条或 50KB，先达到者为准。'],
  ls: ['List directory contents.', '列出目录并按名称排序，目录带 / 后缀，包含点文件；最多返回 500 条或 50KB，先达到者为准。'],
};

function replaceKnown(text, pairs) {
  for (const [from, to] of pairs) text = text.replaceAll(from, to);
  return text;
}

function localizeSystem(text) {
  if (typeof text !== 'string') return text;
  if (text.startsWith(sdkIntro)) {
    const end = text.indexOf(sdkEnd);
    if (end >= 0) {
      const boundary = end + sdkEnd.length;
      // The suffix can contain user-authored SYSTEM/AGENTS/skill text. Keep it.
      text = replaceKnown(text.slice(0, boundary), systemText) + text.slice(boundary);
    }
  } else if (text === summarySystem) {
    text = '你是上下文整理助手。阅读用户与 AI 编程助手的对话，按指定格式生成结构化摘要。不得继续原对话或回答其中的问题，只输出摘要。';
  }
  return text.replace(/\nCurrent date: ([^\n]+)\nCurrent working directory: ([^\n]+)$/, '\n当前日期：$1\n当前工作目录：$2');
}

// Keep SDK checkpoint headings/tags as format identifiers; translate only the
// scaffold after the closing evidence tags, never the conversation or summary.
const summaryText = new Map([
  ['The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.', '上方对话需要整理成结构化上下文摘要，供另一个模型继续工作。'],
  ['The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.', '上方是新对话，请合并到 <previous-summary> 标签里的已有摘要。'],
  ['Update the existing structured summary with new information. RULES:', '用新信息更新已有结构化摘要，规则如下：'],
  ['- PRESERVE all existing information from the previous summary', '- 保留此前摘要中的全部现有信息。'],
  ['- ADD new progress, decisions, and context from the new messages', '- 增加新消息中的进展、决定和背景。'],
  ['- UPDATE the Progress section: move items from "In Progress" to "Done" when completed', '- 更新 Progress：完成的事项从 In Progress 移入 Done。'],
  ['- UPDATE "Next Steps" based on what was accomplished', '- 根据已完成工作更新 Next Steps。'],
  ['- PRESERVE exact file paths, function names, and error messages', '- 保留准确的文件路径、函数名和错误消息。'],
  ['- If something is no longer relevant, you may remove it', '- 可以删除已不再相关的事项。'],
  ['Use this EXACT format:', '严格使用以下结构，正文用中文，必要原文和标识符保持原样：'],
  ['[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]', '[用户要完成什么？涵盖不同任务时可列多项。]'],
  ['[Any constraints, preferences, or requirements mentioned by user]', '[用户提出的约束、偏好或要求]'],
  ['[Or "(none)" if none were mentioned]', '[没有则写“（无）”]'],
  ['[Completed tasks/changes]', '[已完成的任务/修改]'],
  ['[Current work]', '[当前工作]'],
  ['[Issues preventing progress, if any]', '[阻碍进展的问题（如有）]'],
  ['[Decision]', '[决定]'],
  ['[Brief rationale]', '[简短理由]'],
  ['[Ordered list of what should happen next]', '[接下来应执行的有序步骤]'],
  ['[Any data, examples, or references needed to continue]', '[继续工作需要的数据、示例或引用]'],
  ['[Or "(none)" if not applicable]', '[不适用则写“（无）”]'],
  ['Keep each section concise. Preserve exact file paths, function names, and error messages.', '各部分保持简洁，准确保留文件路径、函数名和错误消息。'],
  ['[Preserve existing goals, add new ones if the task expanded]', '[保留已有目标，任务扩大时加入新目标]'],
  ['[Preserve existing, add new ones discovered]', '[保留已有约束并加入新发现]'],
  ['[Include previously done items AND newly completed items]', '[同时保留此前和本轮新完成的事项]'],
  ['[Current work - update based on progress]', '[按进展更新当前工作]'],
  ['[Current blockers - remove if resolved]', '[当前阻碍；已解决则移除]'],
  ['(preserve all previous, add new)', '（保留此前决定并加入新决定）'],
  ['[Update based on current state]', '[根据当前状态更新]'],
  ['[Preserve important context, add new if needed]', '[保留重要背景，必要时增加新背景]'],
  ['This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.', '这是一轮过长对话的前半段；后半段（最近工作）仍会保留。'],
  ['Summarize the prefix to provide context for the retained suffix:', '总结前半段，为保留的后半段提供背景：'],
  ['[What did the user ask for in this turn?]', '[本轮用户要求什么？]'],
  ['[Key decisions and work done in the prefix]', '[前半段的关键决定和已做工作]'],
  ['[Information needed to understand the retained recent work]', '[理解保留的最近工作所需的信息]'],
  ["Be concise. Focus on what's needed to understand the kept suffix.", '保持简洁，聚焦理解保留的后半段所需信息。'],
  ['Additional focus:', '额外关注事项：'],
]);

function localizeSummaryMessage(message) {
  if (message.role !== 'user' || !Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map(item => {
    if (item.type !== 'text' || !item.text.startsWith('<conversation>\n')) return item;
    const markers = ['</conversation>', '</previous-summary>'];
    const boundary = Math.max(...markers.map(marker => {
      const at = item.text.lastIndexOf(marker);
      return at < 0 ? -1 : at + marker.length;
    }));
    if (boundary < 0) return item;
    const scaffold = item.text.slice(boundary);
    if (!/^\s*(The messages above are|This is the PREFIX of a turn)/.test(scaffold)) return item;
    return { ...item, text: item.text.slice(0, boundary) + replaceKnown(scaffold, summaryText) };
  }) };
}

function localizeSchema(value) {
  if (Array.isArray(value)) return value.map(localizeSchema);
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  for (const [key, item] of Object.entries(value)) copy[key] = key === 'description' && typeof item === 'string'
    ? parameterText.get(item) || item : localizeSchema(item);
  return copy;
}

export function chinesePiContext(context) {
  return { ...context, systemPrompt: localizeSystem(context.systemPrompt),
    ...(context.systemPrompt === summarySystem ? { messages: context.messages.map(localizeSummaryMessage) } : {}),
    ...(context.tools ? { tools: context.tools.map(tool => {
      const known = toolText[tool.name];
      return { ...tool, description: known && tool.description?.startsWith(known[0]) ? known[1] : tool.description,
        parameters: localizeSchema(tool.parameters) };
    }) } : {}),
  };
}
