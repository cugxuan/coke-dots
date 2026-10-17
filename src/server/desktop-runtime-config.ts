/** Both transports use the same Debian desktop/Agent protocol. */
export function usesCloudComputer(environment: NodeJS.ProcessEnv = process.env) {
  return ['linux-desktop', 'ssh-docker'].includes(environment.DOTS_COMPUTER_BACKEND || '');
}

export function isPinnedDesktopImageReference(reference: string) {
  const value = reference.trim();
  if (!value || /\s/.test(value)) return false;
  const digestSeparator = value.lastIndexOf('@');
  if (digestSeparator >= 0) {
    const imageName = value.slice(0, digestSeparator);
    return Boolean(imageName) && /^sha256:[a-f0-9]{64}$/i.test(value.slice(digestSeparator + 1));
  }
  const lastSlash = value.lastIndexOf('/');
  const lastColon = value.lastIndexOf(':');
  const tag = lastColon > lastSlash ? value.slice(lastColon + 1) : '';
  return /^sha-[a-f0-9]{40}$/i.test(tag);
}

export function configuredDesktopImage(environment = process.env.NODE_ENV, configured = process.env.DOTS_LINUX_DESKTOP_IMAGE) {
  const image = configured?.trim() || 'coke-dots-linux-desktop:dev';
  if (environment === 'production' && !isPinnedDesktopImageReference(image)) {
    throw new Error('生产环境的 Linux 云电脑必须配置固定镜像摘要，或使用 coke-dots-linux-desktop:sha-<40位Git提交>');
  }
  return image;
}
