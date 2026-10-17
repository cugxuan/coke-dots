import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function dictateAndSend(ctx: UiScenarioContext) {
  await ctx.alphaPage!.getByRole('button', { name: '新聊天', exact: true }).click();
  await ctx.alphaPage!.getByTestId('chat-home').waitFor({ state: 'visible' });
  const dictationMockScript = [
    '(() => {',
    '  class FakeSpeechRecognition {',
    '    constructor() { this.onresult = null; this.onerror = null; this.onend = null; }',
    '    start() { window.__dotsFakeDictation = this; }',
    '    stop() { this.onend?.(); }',
    '    abort() {}',
    '    emit(text) { const result = Object.assign([{ transcript: text }], { isFinal: true }); const event = Object.assign(new Event("result"), { resultIndex: 0, results: [result] }); this.onresult?.(event); }',
    '    deny() { const event = Object.assign(new Event("error"), { error: "not-allowed" }); this.onerror?.(event); }',
    '  }',
    '  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeSpeechRecognition });',
    '})()',
  ].join('\n');
  await ctx.alphaPage!.evaluate((script: string) => window.eval(script), dictationMockScript);
  const speechApi = await ctx.alphaPage!.evaluate(() => typeof (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition);
  assert.equal(speechApi, 'function', 'The E2E speech-recognition mock must be installed before clicking the microphone');
  const draft = 'Please prepare';
  const composer = ctx.alphaPage!.getByTestId('task-composer');
  await composer.fill(draft);
  assert.equal(await ctx.alphaPage!.locator('.composer').evaluate(element => Math.round(element.getBoundingClientRect().height)), 40, 'Focusing the landing draft must not shift the adjacent controls before a pointer click');
  await composer.evaluate(element => {
    const textarea = element as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  await ctx.alphaPage!.getByTestId('dictation-button').click();
  await ctx.alphaPage!.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__dotsFakeDictation));
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="dictation-button"]')?.getAttribute('aria-pressed') === 'true');
  await ctx.screenshot(ctx.alphaPage!, 'dictation-listening');
  await ctx.alphaPage!.evaluate(() => {
    const fake = (window as unknown as { __dotsFakeDictation?: { emit(text: string): void; onend: (() => void) | null } }).__dotsFakeDictation;
    fake?.emit('a Friday launch agenda');
    fake?.onend?.();
  });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-testid="task-composer"]')?.value === 'Please prepare a Friday launch agenda');
  assert.equal(await ctx.alphaPage!.locator('.timeline .message.user').count(), 0, 'Dictation only edits the draft; it must not dispatch work before the user sends it');
  await composer.fill('Please prepare a Friday launch agenda for the team.');
  await ctx.alphaPage!.locator('button.send').click();
  await ctx.alphaPage!.locator('.timeline .message.user p').filter({ hasText: 'Please prepare a Friday launch agenda for the team.' }).waitFor({ state: 'visible', timeout: 10_000 });

  await ctx.alphaPage!.getByTestId('dictation-button').click();
  await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsFakeDictation?: { deny(): void } }).__dotsFakeDictation?.deny());
  const error = ctx.alphaPage!.getByRole('alert').filter({ hasText: '麦克风权限未开启' });
  await error.waitFor({ state: 'visible' });
  await error.getByRole('button').click();
  await ctx.alphaPage!.getByRole('button', { name: '新聊天', exact: true }).click();
  await ctx.alphaPage!.getByTestId('chat-home').waitFor({ state: 'visible' });
}
