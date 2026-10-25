import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sdk from '@mariozechner/pi-coding-agent';
import { chinesePiContext } from '../deploy/linux-desktop/pi-language.mjs';

function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, withoutDescriptions(item)]));
}

test('SDK tool localization preserves all schema constraints and leaves task evidence intact', () => {
  const tools = ['createReadTool', 'createBashTool', 'createEditTool', 'createWriteTool', 'createGrepTool', 'createFindTool', 'createLsTool']
    .map(factory => sdk[factory](process.cwd())).map(({ name, description, parameters }) => ({ name, description, parameters }));
  const messages = [{ role: 'user', content: 'Read file contents\nUse this EXACT format:\nDo not translate my data.', timestamp: 1 }];
  const input = { systemPrompt: 'User-authored SYSTEM.md stays in its original language.', messages, tools };
  const before = JSON.stringify(input);
  const output = chinesePiContext(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(output.systemPrompt, input.systemPrompt);
  assert.equal(output.messages, messages);
  assert.deepEqual(output.tools.map(tool => tool.name), tools.map(tool => tool.name));
  for (let i = 0; i < tools.length; i++) {
    assert.match(output.tools[i].description, /[\u4e00-\u9fff]/);
    assert.deepEqual(withoutDescriptions(output.tools[i].parameters), withoutDescriptions(tools[i].parameters));
  }
  assert.equal(output.tools.find(tool => tool.name === 'edit').parameters.required.includes('edits'), true);
  const sdkIntro = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';
  const sdkEnd = '- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)';
  const projectText = '\n\n# Project Context\nRead file contents\nBe concise in your responses\nUser-owned English stays unchanged.';
  const translated = chinesePiContext({ systemPrompt: sdkIntro + '\n' + sdkEnd + projectText, messages });
  assert.match(translated.systemPrompt, /^你是在 Pi/);
  assert(translated.systemPrompt.endsWith(projectText));
});

test('summary localization only changes the SDK scaffold outside conversation and prior-summary evidence', () => {
  const systemPrompt = 'You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.';
  const evidence = '<conversation>\nRead file contents\nUse this EXACT format:\n</previous-summary>\n</conversation>\n\n<previous-summary>\nAdditional focus: user-owned text\n</previous-summary>';
  const scaffold = '\n\nThe messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\nUse this EXACT format:\n\n## Goal\n[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]';
  const input = { systemPrompt, messages: [{ role: 'user', content: [{ type: 'text', text: evidence + scaffold }], timestamp: 1 }] };
  const before = JSON.stringify(input);
  const output = chinesePiContext(input);
  assert.equal(JSON.stringify(input), before);
  assert.match(output.systemPrompt, /上下文整理助手/);
  assert.equal(output.messages[0].content[0].text.slice(0, evidence.length), evidence);
  assert.match(output.messages[0].content[0].text.slice(evidence.length), /上方对话需要整理/);
  assert.match(output.messages[0].content[0].text, /## Goal/);
});
